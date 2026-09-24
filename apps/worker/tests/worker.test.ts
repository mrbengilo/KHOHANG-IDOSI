import { describe, expect, it } from 'vitest';

import type {
  AllocationJobRepository,
  DueSessionQuery,
  JobExecutionResult,
  ScheduledAllocationSession,
  WorkerHeartbeat,
} from '../src/types.js';
import { AllocationWorker } from '../src/worker.js';

const TODAY: ScheduledAllocationSession = {
  id: 'session-today',
  businessDate: '2026-09-10',
  snapshotDueAt: new Date('2026-09-10T01:00:00.000Z'),
  finalDueAt: new Date('2026-09-10T02:00:00.000Z'),
  policyVersion: 'idosi-round-robin-p0a-p3-v1',
};
const YESTERDAY: ScheduledAllocationSession = {
  id: 'session-yesterday',
  businessDate: '2026-09-09',
  snapshotDueAt: new Date('2026-09-09T01:00:00.000Z'),
  finalDueAt: new Date('2026-09-09T02:00:00.000Z'),
  policyVersion: 'idosi-round-robin-p0a-p3-v1',
};
const NOW = new Date('2026-09-10T03:00:00.000Z');

class FakeRepository implements AllocationJobRepository {
  readonly events: string[] = [];
  readonly created = new Map<string, number>();
  readonly #sessions: readonly ScheduledAllocationSession[];
  readonly #completed = new Set<string>();
  #tail: Promise<void> = Promise.resolve();
  failFinalOnce = false;

  public constructor(sessions: readonly ScheduledAllocationSession[]) {
    this.#sessions = sessions;
  }

  public async listDueSessions(query: DueSessionQuery) {
    return this.#sessions
      .filter(
        (session) =>
          session.businessDate >= query.earliestBusinessDate &&
          session.snapshotDueAt.getTime() <= query.now.getTime(),
      )
      .slice(0, query.limit);
  }

  public captureSnapshotAndCreateOffers(session: ScheduledAllocationSession) {
    return this.#execute(`snapshot:${session.id}`);
  }

  public expireOffersAndFinalizeAllocation(session: ScheduledAllocationSession) {
    return this.#execute(`final:${session.id}`, true);
  }

  public async ping(): Promise<void> {}

  public async close(): Promise<void> {}

  async #execute(key: string, isFinal = false): Promise<JobExecutionResult> {
    const previous = this.#tail;
    let release = (): void => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.#completed.has(key)) {
        this.events.push(`replay:${key}`);
        return { replayed: true, resourceId: key, affectedRows: 0 };
      }
      if (isFinal && this.failFinalOnce) {
        this.failFinalOnce = false;
        this.events.push(`failure:${key}`);
        throw new Error('transient final failure');
      }
      await Promise.resolve();
      this.#completed.add(key);
      this.created.set(key, (this.created.get(key) ?? 0) + 1);
      this.events.push(`create:${key}`);
      return { replayed: false, resourceId: key, affectedRows: 1 };
    } finally {
      release();
    }
  }
}

function worker(repository: AllocationJobRepository, catchUpDays = 0): AllocationWorker {
  return new AllocationWorker(repository, {
    catchUpDays,
    timeZone: 'Asia/Ho_Chi_Minh',
    now: () => NOW,
  });
}

describe('AllocationWorker idempotency and catch-up', () => {
  it('serializes concurrent replicas through repository idempotency without duplicate effects', async () => {
    const repository = new FakeRepository([TODAY]);
    const [left, right] = await Promise.all([
      worker(repository).runOnce(NOW),
      worker(repository).runOnce(NOW),
    ]);

    expect(repository.created.get(`snapshot:${TODAY.id}`)).toBe(1);
    expect(repository.created.get(`final:${TODAY.id}`)).toBe(1);
    expect([...left.jobs, ...right.jobs].filter((job) => job.status === 'replayed')).toHaveLength(
      2,
    );
    expect(repository.events.indexOf(`create:snapshot:${TODAY.id}`)).toBeLessThan(
      repository.events.indexOf(`create:final:${TODAY.id}`),
    );
  });

  it('retries a failed final job while replaying its already committed snapshot', async () => {
    const repository = new FakeRepository([TODAY]);
    repository.failFinalOnce = true;
    const allocationWorker = worker(repository);

    await expect(allocationWorker.runOnce(NOW)).rejects.toThrow('transient final failure');
    const retry = await allocationWorker.runOnce(NOW);

    expect(retry.jobs.map((job) => job.status)).toEqual(['replayed', 'executed']);
    expect(repository.created.get(`snapshot:${TODAY.id}`)).toBe(1);
    expect(repository.created.get(`final:${TODAY.id}`)).toBe(1);
  });

  it('bounds catch-up by business date and always executes 08:00 before 09:00', async () => {
    const noCatchUpRepository = new FakeRepository([YESTERDAY, TODAY]);
    const noCatchUp = await worker(noCatchUpRepository, 0).runOnce(NOW);
    expect(new Set(noCatchUp.jobs.map((job) => job.sessionId))).toEqual(new Set([TODAY.id]));

    const catchUpRepository = new FakeRepository([YESTERDAY, TODAY]);
    const catchUp = await worker(catchUpRepository, 1).runOnce(NOW);
    expect(catchUp.jobs.map((job) => `${job.sessionId}:${job.kind}`)).toEqual([
      `${YESTERDAY.id}:snapshot-0800`,
      `${YESTERDAY.id}:finalize-0900`,
      `${TODAY.id}:snapshot-0800`,
      `${TODAY.id}:finalize-0900`,
    ]);
  });

  it('keeps processing other sessions when one fails and records a heartbeat', async () => {
    const heartbeats: WorkerHeartbeat[] = [];
    class OneBrokenSession extends FakeRepository {
      public override captureSnapshotAndCreateOffers(session: ScheduledAllocationSession) {
        if (session.id === YESTERDAY.id) return Promise.reject(new Error('broken yesterday'));
        return super.captureSnapshotAndCreateOffers(session);
      }

      public async recordHeartbeat(heartbeat: WorkerHeartbeat): Promise<void> {
        heartbeats.push(heartbeat);
      }
    }
    const repository = new OneBrokenSession([YESTERDAY, TODAY]);
    const allocationWorker = worker(repository, 1);

    await expect(allocationWorker.runOnce(NOW)).rejects.toThrow('broken yesterday');

    expect(repository.created.get(`final:${TODAY.id}`)).toBe(1);
    expect(allocationWorker.isReady(NOW)).toBe(true);
    expect(allocationWorker.isDegraded()).toBe(true);
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]!.lastError).toBe('broken yesterday');
    expect(heartbeats[0]!.failingJobs.map((job) => `${job.sessionId}:${job.status}`)).toEqual([
      `${YESTERDAY.id}:failed`,
      `${YESTERDAY.id}:blocked`,
    ]);
  });
});
