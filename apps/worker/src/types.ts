export type AllocationJobKind = 'snapshot-0800' | 'finalize-0900';

export interface ScheduledAllocationSession {
  readonly id: string;
  readonly businessDate: string;
  readonly snapshotDueAt: Date;
  readonly finalDueAt: Date;
  readonly policyVersion: string;
}

export interface DueSessionQuery {
  readonly now: Date;
  readonly earliestBusinessDate: string;
  readonly limit: number;
}

export interface JobExecutionResult {
  readonly replayed: boolean;
  readonly resourceId: string;
  readonly affectedRows: number;
}

export interface AllocationJobRepository {
  listDueSessions(query: DueSessionQuery): Promise<readonly ScheduledAllocationSession[]>;
  captureSnapshotAndCreateOffers(
    session: ScheduledAllocationSession,
    processedAt: Date,
  ): Promise<JobExecutionResult>;
  expireOffersAndFinalizeAllocation(
    session: ScheduledAllocationSession,
    processedAt: Date,
  ): Promise<JobExecutionResult>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface WorkerLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export type JobReportStatus = 'executed' | 'replayed' | 'failed' | 'blocked';

export interface JobReport {
  readonly kind: AllocationJobKind;
  readonly sessionId: string;
  readonly scheduledFor: string;
  readonly status: JobReportStatus;
  readonly resourceId?: string;
  readonly affectedRows?: number;
  readonly error?: string;
}

export interface WorkerTickReport {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly earliestBusinessDate: string;
  readonly jobs: readonly JobReport[];
}

export interface WorkerRuntimeState {
  readonly startedAt: string;
  readonly stopping: boolean;
  readonly running: boolean;
  readonly lastTickStartedAt: string | null;
  readonly lastTickCompletedAt: string | null;
  readonly lastSuccessfulTickAt: string | null;
  readonly lastError: string | null;
}
