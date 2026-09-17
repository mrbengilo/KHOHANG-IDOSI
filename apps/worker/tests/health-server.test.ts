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
  public async listDueSessions(_query: DueSessionQuery) {
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
});
