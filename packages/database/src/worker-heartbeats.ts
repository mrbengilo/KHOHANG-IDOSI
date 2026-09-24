import { asc } from 'drizzle-orm';

import type { Database } from './client.js';
import { workerHeartbeats, type JsonValue } from './schema.js';

export interface WorkerHeartbeatFailingJob {
  readonly kind: string;
  readonly sessionId: string;
  readonly scheduledFor: string;
  readonly status: 'failed' | 'blocked';
  readonly error: string | null;
}

export interface WorkerHeartbeatInput {
  readonly worker: string;
  readonly lastTickStartedAt: Date | null;
  readonly lastTickCompletedAt: Date | null;
  readonly lastSuccessfulTickAt: Date | null;
  readonly lastError: string | null;
  readonly failingJobs: readonly WorkerHeartbeatFailingJob[];
  readonly updatedAt: Date;
}

export type WorkerHeartbeatRecord = WorkerHeartbeatInput;

const MAX_ERROR_LENGTH = 1_000;
const MAX_FAILING_JOBS = 50;

/** Upsert of one row per worker loop; bounded so a repeated failure cannot grow the table. */
export async function recordWorkerHeartbeat(
  database: Database,
  input: WorkerHeartbeatInput,
): Promise<void> {
  const failingJobs = input.failingJobs.slice(0, MAX_FAILING_JOBS).map((job) => ({
    kind: job.kind,
    sessionId: job.sessionId,
    scheduledFor: job.scheduledFor,
    status: job.status,
    error: job.error === null ? null : job.error.slice(0, MAX_ERROR_LENGTH),
  })) satisfies JsonValue;
  const values = {
    worker: input.worker,
    lastTickStartedAt: input.lastTickStartedAt,
    lastTickCompletedAt: input.lastTickCompletedAt,
    lastSuccessfulTickAt: input.lastSuccessfulTickAt,
    lastError: input.lastError === null ? null : input.lastError.slice(0, MAX_ERROR_LENGTH),
    failingJobs,
    updatedAt: input.updatedAt,
  };
  await database
    .insert(workerHeartbeats)
    .values(values)
    .onConflictDoUpdate({ target: workerHeartbeats.worker, set: values });
}

export async function loadWorkerHeartbeats(
  database: Database,
): Promise<readonly WorkerHeartbeatRecord[]> {
  const rows = await database.select().from(workerHeartbeats).orderBy(asc(workerHeartbeats.worker));
  return rows.map((row) => ({
    worker: row.worker,
    lastTickStartedAt: row.lastTickStartedAt,
    lastTickCompletedAt: row.lastTickCompletedAt,
    lastSuccessfulTickAt: row.lastSuccessfulTickAt,
    lastError: row.lastError,
    failingJobs: Array.isArray(row.failingJobs)
      ? (row.failingJobs as unknown as WorkerHeartbeatFailingJob[])
      : [],
    updatedAt: row.updatedAt,
  }));
}
