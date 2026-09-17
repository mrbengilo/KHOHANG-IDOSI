import type {
  AllocationJobRepository,
  JobReport,
  ScheduledAllocationSession,
  WorkerLogger,
  WorkerRuntimeState,
  WorkerTickReport,
} from './types.js';

export interface AllocationWorkerOptions {
  readonly catchUpDays: number;
  readonly timeZone: string;
  readonly maxSessionsPerTick?: number;
  readonly logger?: WorkerLogger;
  readonly now?: () => Date;
}

export class AllocationWorker {
  readonly #repository: AllocationJobRepository;
  readonly #catchUpDays: number;
  readonly #timeZone: string;
  readonly #maxSessionsPerTick: number;
  readonly #logger: WorkerLogger | undefined;
  readonly #now: () => Date;
  readonly #startedAt: string;
  #stopping = false;
  #running = false;
  #inFlight: Promise<WorkerTickReport> | null = null;
  #lastTickStartedAt: string | null = null;
  #lastTickCompletedAt: string | null = null;
  #lastSuccessfulTickAt: string | null = null;
  #lastError: string | null = null;

  public constructor(repository: AllocationJobRepository, options: AllocationWorkerOptions) {
    assertNonNegativeInteger(options.catchUpDays, 'catchUpDays');
    this.#maxSessionsPerTick = options.maxSessionsPerTick ?? 50;
    assertPositiveInteger(this.#maxSessionsPerTick, 'maxSessionsPerTick');
    validateTimeZone(options.timeZone);
    this.#repository = repository;
    this.#catchUpDays = options.catchUpDays;
    this.#timeZone = options.timeZone;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#startedAt = this.#now().toISOString();
  }

  public state(): WorkerRuntimeState {
    return {
      startedAt: this.#startedAt,
      stopping: this.#stopping,
      running: this.#running,
      lastTickStartedAt: this.#lastTickStartedAt,
      lastTickCompletedAt: this.#lastTickCompletedAt,
      lastSuccessfulTickAt: this.#lastSuccessfulTickAt,
      lastError: this.#lastError,
    };
  }

  public isReady(): boolean {
    return !this.#stopping && this.#lastSuccessfulTickAt !== null;
  }

  public async ping(): Promise<void> {
    await this.#repository.ping();
  }

  /** Prevents overlapping ticks inside one process; database advisory locks protect across replicas. */
  public runOnce(now = this.#now()): Promise<WorkerTickReport> {
    if (this.#stopping) return Promise.reject(new Error('Allocation worker is stopping.'));
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#runTick(now).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#inFlight) {
      try {
        await this.#inFlight;
      } catch {
        // The failed tick is already recorded; shutdown must still release resources.
      }
    }
  }

  async #runTick(now: Date): Promise<WorkerTickReport> {
    const startedAt = new Date(now);
    assertValidDate(startedAt, 'now');
    this.#running = true;
    this.#lastTickStartedAt = startedAt.toISOString();
    const earliestBusinessDate = subtractBusinessDays(
      businessDateAt(startedAt, this.#timeZone),
      this.#catchUpDays,
    );
    const jobs: JobReport[] = [];

    try {
      const sessions = await this.#repository.listDueSessions({
        now: startedAt,
        earliestBusinessDate,
        limit: this.#maxSessionsPerTick,
      });

      for (const session of sessions) {
        const snapshot = await this.#executeSnapshot(session, startedAt);
        jobs.push(snapshot);

        if (session.finalDueAt.getTime() <= startedAt.getTime()) {
          if (snapshot.status === 'failed') {
            jobs.push({
              kind: 'finalize-0900',
              sessionId: session.id,
              scheduledFor: session.finalDueAt.toISOString(),
              status: 'blocked',
              error: 'The 08:00 snapshot job did not complete.',
            });
          } else {
            jobs.push(await this.#executeFinal(session, startedAt));
          }
        }
      }

      const failed = jobs.find((job) => job.status === 'failed');
      if (failed) throw new Error(failed.error ?? `Job ${failed.kind} failed.`);

      const completedAt = this.#now().toISOString();
      this.#lastTickCompletedAt = completedAt;
      this.#lastSuccessfulTickAt = completedAt;
      this.#lastError = null;
      return { startedAt: startedAt.toISOString(), completedAt, earliestBusinessDate, jobs };
    } catch (error) {
      this.#lastTickCompletedAt = this.#now().toISOString();
      this.#lastError = errorMessage(error);
      throw error;
    } finally {
      this.#running = false;
    }
  }

  async #executeSnapshot(session: ScheduledAllocationSession, now: Date): Promise<JobReport> {
    try {
      const result = await this.#repository.captureSnapshotAndCreateOffers(session, now);
      const status = result.replayed ? 'replayed' : 'executed';
      this.#logger?.info(
        { kind: 'snapshot-0800', sessionId: session.id, status },
        'allocation job completed',
      );
      return {
        kind: 'snapshot-0800',
        sessionId: session.id,
        scheduledFor: session.snapshotDueAt.toISOString(),
        status,
        resourceId: result.resourceId,
        affectedRows: result.affectedRows,
      };
    } catch (error) {
      const message = errorMessage(error);
      this.#logger?.error(
        { error: message, kind: 'snapshot-0800', sessionId: session.id },
        'allocation job failed',
      );
      return {
        kind: 'snapshot-0800',
        sessionId: session.id,
        scheduledFor: session.snapshotDueAt.toISOString(),
        status: 'failed',
        error: message,
      };
    }
  }

  async #executeFinal(session: ScheduledAllocationSession, now: Date): Promise<JobReport> {
    try {
      const result = await this.#repository.expireOffersAndFinalizeAllocation(session, now);
      const status = result.replayed ? 'replayed' : 'executed';
      this.#logger?.info(
        { kind: 'finalize-0900', sessionId: session.id, status },
        'allocation job completed',
      );
      return {
        kind: 'finalize-0900',
        sessionId: session.id,
        scheduledFor: session.finalDueAt.toISOString(),
        status,
        resourceId: result.resourceId,
        affectedRows: result.affectedRows,
      };
    } catch (error) {
      const message = errorMessage(error);
      this.#logger?.error(
        { error: message, kind: 'finalize-0900', sessionId: session.id },
        'allocation job failed',
      );
      return {
        kind: 'finalize-0900',
        sessionId: session.id,
        scheduledFor: session.finalDueAt.toISOString(),
        status: 'failed',
        error: message,
      };
    }
  }
}

export interface PollingLoop {
  stop(): Promise<void>;
}

export function startPolling(worker: AllocationWorker, pollMs: number): PollingLoop {
  assertPositiveInteger(pollMs, 'pollMs');
  let stopped = false;
  let timeout: NodeJS.Timeout | null = null;
  let active = Promise.resolve();

  const schedule = (): void => {
    if (stopped) return;
    timeout = setTimeout(() => {
      active = tick();
    }, pollMs);
    timeout.unref();
  };
  const tick = async (): Promise<void> => {
    try {
      await worker.runOnce();
    } catch {
      // AllocationWorker records and logs the failure; the next bounded poll retries it.
    } finally {
      schedule();
    }
  };
  active = tick();

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timeout) clearTimeout(timeout);
      await worker.stop();
      await active;
    },
  };
}

export function businessDateAt(instant: Date, timeZone: string): string {
  assertValidDate(instant, 'instant');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) throw new Error('Unable to resolve the business date.');
  return `${year}-${month}-${day}`;
}

function subtractBusinessDays(businessDate: string, days: number): string {
  const [year, month, day] = businessDate.split('-').map(Number);
  if (!year || !month || !day) throw new Error(`Invalid business date ${businessDate}.`);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid time zone ${timeZone}.`);
  }
}

function assertValidDate(value: Date, name: string): void {
  if (Number.isNaN(value.getTime())) throw new Error(`${name} must be a valid Date.`);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
