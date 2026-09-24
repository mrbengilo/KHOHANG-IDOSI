import { afterEach, describe, expect, it } from 'vitest';

import { startHealthServer, type HealthServer } from '../src/health-server.js';
import type {
  AllocationJobRepository,
  DueSessionQuery,
  JobExecutionResult,
  ScheduledAllocationSession,
} from '../src/types.js';
import { AllocationWorker } from '../src/worker.js';

class EmptyRepository implements AllocationJobRepository {
  public async listDueSessions(
    _query: DueSessionQuery,
  ): Promise<readonly ScheduledAllocationSession[]> {
    return [];
  }

  public async captureSnapshotAndCreateOffers(
    _session: ScheduledAllocationSession,
    _processedAt: Date,
  ): Promise<JobExecutionResult> {
    throw new Error('not expected');
  }

  public async expireOffersAndFinalizeAllocation(
    _session: ScheduledAllocationSession,
    _processedAt: Date,
  ): Promise<JobExecutionResult> {
    throw new Error('not expected');
  }

  public async ping(): Promise<void> {}

  public async close(): Promise<void> {}
}

let health: HealthServer | undefined;

afterEach(async () => {
  await health?.close();
  health = undefined;
});

describe('worker health server', () => {
  it('separates liveness from readiness', async () => {
    const now = new Date('2026-09-10T03:00:00.000Z');
    const worker = new AllocationWorker(new EmptyRepository(), {
      catchUpDays: 0,
      timeZone: 'Asia/Ho_Chi_Minh',
      now: () => now,
    });
    health = await startHealthServer(worker, { host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${health.port}`;

    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/ready`)).status).toBe(503);

    await worker.runOnce(now);
    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({ ok: true, database: true });
  });

  it('stays ready while a scheduled job fails, and reports the failure as degraded', async () => {
    let now = new Date('2026-09-10T03:00:00.000Z');
    const session: ScheduledAllocationSession = {
      id: 'broken-session',
      businessDate: '2026-09-10',
      snapshotDueAt: new Date('2026-09-10T01:00:00.000Z'),
      finalDueAt: new Date('2026-09-10T02:00:00.000Z'),
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
    };
    class BrokenSessionRepository extends EmptyRepository {
      public override async listDueSessions(_query: DueSessionQuery) {
        return [session];
      }

      public override async captureSnapshotAndCreateOffers(): Promise<JobExecutionResult> {
        throw new Error('snapshot data is inconsistent');
      }
    }
    const worker = new AllocationWorker(new BrokenSessionRepository(), {
      catchUpDays: 0,
      timeZone: 'Asia/Ho_Chi_Minh',
      now: () => now,
      readinessMaxAgeMs: 60_000,
    });
    health = await startHealthServer(worker, { host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${health.port}`;

    await expect(worker.runOnce(now)).rejects.toThrow('snapshot data is inconsistent');
    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({
      ok: true,
      degraded: true,
      state: {
        failingJobs: [
          { kind: 'snapshot-0800', status: 'failed', error: 'snapshot data is inconsistent' },
          { kind: 'finalize-0900', status: 'blocked' },
        ],
      },
    });

    // A loop that stopped ticking is not ready, whatever its last outcome was.
    now = new Date(now.getTime() + 120_000);
    expect((await fetch(`${base}/ready`)).status).toBe(503);
  });

  it('is not ready when the due-session query itself fails', async () => {
    const now = new Date('2026-09-10T03:00:00.000Z');
    class UnreachableRepository extends EmptyRepository {
      public override async listDueSessions(): Promise<never> {
        throw new Error('connection refused');
      }
    }
    const worker = new AllocationWorker(new UnreachableRepository(), {
      catchUpDays: 0,
      timeZone: 'Asia/Ho_Chi_Minh',
      now: () => now,
    });
    await expect(worker.runOnce(now)).rejects.toThrow('connection refused');
    expect(worker.isReady(now)).toBe(false);
  });
});
