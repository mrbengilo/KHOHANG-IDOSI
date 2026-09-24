import { WORKER_HEARTBEAT_STALE_AFTER_MS, type WorkerStatus } from '@idosi/contracts';

export interface WorkerHeartbeatSnapshot {
  readonly worker: string;
  readonly lastTickStartedAt: Date | null;
  readonly lastTickCompletedAt: Date | null;
  readonly lastSuccessfulTickAt: Date | null;
  readonly lastError: string | null;
  readonly failingJobs: readonly {
    readonly kind: string;
    readonly sessionId: string;
    readonly scheduledFor: string;
    readonly status: 'failed' | 'blocked';
    readonly error: string | null;
  }[];
  readonly updatedAt: Date;
}

/** Classifies the last heartbeat of a worker loop for Admin screens. */
export function workerStatusDto(
  worker: string,
  heartbeat: WorkerHeartbeatSnapshot | null,
  now: Date,
): WorkerStatus {
  if (!heartbeat) {
    return {
      worker,
      status: 'UNKNOWN',
      lastTickStartedAt: null,
      lastTickCompletedAt: null,
      lastSuccessfulTickAt: null,
      lastError: null,
      failingJobs: [],
      updatedAt: null,
    };
  }
  const stale = now.getTime() - heartbeat.updatedAt.getTime() > WORKER_HEARTBEAT_STALE_AFTER_MS;
  const failingJobs = heartbeat.failingJobs.map((job) => ({
    kind: job.kind,
    sessionId: job.sessionId,
    scheduledFor: job.scheduledFor,
    status: job.status === 'blocked' ? ('BLOCKED' as const) : ('FAILED' as const),
    error: job.error,
  }));
  return {
    worker,
    status: stale
      ? 'STALE'
      : failingJobs.length > 0 || heartbeat.lastError !== null
        ? 'DEGRADED'
        : 'HEALTHY',
    lastTickStartedAt: heartbeat.lastTickStartedAt?.toISOString() ?? null,
    lastTickCompletedAt: heartbeat.lastTickCompletedAt?.toISOString() ?? null,
    lastSuccessfulTickAt: heartbeat.lastSuccessfulTickAt?.toISOString() ?? null,
    lastError: heartbeat.lastError,
    failingJobs,
    updatedAt: heartbeat.updatedAt.toISOString(),
  };
}
