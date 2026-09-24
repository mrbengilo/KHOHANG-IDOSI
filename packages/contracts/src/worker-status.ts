import { z } from 'zod';

import { IsoDateTimeSchema } from './common.js';

/** How long a worker may go without a tick before Admin screens call it stopped. */
export const WORKER_HEARTBEAT_STALE_AFTER_MS = 10 * 60 * 1_000;

export const WorkerFailingJobSchema = z
  .object({
    kind: z.string().trim().min(1).max(40),
    sessionId: z.string().trim().min(1).max(128),
    scheduledFor: IsoDateTimeSchema,
    status: z.enum(['FAILED', 'BLOCKED']),
    error: z.string().max(1_000).nullable(),
  })
  .strict();
export type WorkerFailingJob = z.infer<typeof WorkerFailingJobSchema>;

export const WorkerStatusSchema = z
  .object({
    worker: z.string().trim().min(1).max(60),
    /**
     * HEALTHY: last tick finished every job. DEGRADED: the loop runs but some job failed.
     * STALE: no heartbeat for WORKER_HEARTBEAT_STALE_AFTER_MS. UNKNOWN: never reported.
     */
    status: z.enum(['HEALTHY', 'DEGRADED', 'STALE', 'UNKNOWN']),
    lastTickStartedAt: IsoDateTimeSchema.nullable(),
    lastTickCompletedAt: IsoDateTimeSchema.nullable(),
    lastSuccessfulTickAt: IsoDateTimeSchema.nullable(),
    lastError: z.string().max(1_000).nullable(),
    failingJobs: z.array(WorkerFailingJobSchema).max(50),
    updatedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();
export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;

export const WorkerStatusResponseSchema = z.object({ data: WorkerStatusSchema }).strict();
