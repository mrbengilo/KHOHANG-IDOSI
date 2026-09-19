import { randomUUID } from 'node:crypto';

import {
  fetchIdosiOrderStatistics,
  IdosiGatewayError,
  type IdosiFetch,
  type IdosiOrderStatisticsPayload,
} from '@idosi/contracts';
import {
  listDueIdosiStatisticsTargets,
  recordIdosiStatisticsFailure,
  recordIdosiStatisticsSuccess,
  type Database,
  type DueIdosiStatisticsTarget,
} from '@idosi/database';

import type { WorkerLogger } from './types.js';

export interface ScheduledIdosiSyncRepository {
  listDue(period: string, now: Date, limit: number): Promise<readonly DueIdosiStatisticsTarget[]>;
  recordSuccess(
    target: DueIdosiStatisticsTarget,
    payload: IdosiOrderStatisticsPayload,
    startedAt: Date,
    completedAt: Date,
    requestId: string,
  ): Promise<void>;
  recordFailure(
    target: DueIdosiStatisticsTarget,
    errorCode: string,
    errorMessage: string,
    startedAt: Date,
    completedAt: Date,
    requestId: string,
  ): Promise<void>;
}

export interface IdosiSyncWorkerOptions {
  readonly endpoint: string;
  readonly secret: string;
  readonly storeIdMap?: Readonly<Record<string, string>>;
  readonly timeZone: string;
  readonly maxStoresPerTick: number;
  readonly fetch?: IdosiFetch;
  readonly logger?: WorkerLogger;
  readonly now?: () => Date;
}

export interface IdosiSyncTickReport {
  readonly period: string;
  readonly due: number;
  readonly succeeded: number;
  readonly failed: number;
}

export class IdosiStatisticsSyncWorker {
  readonly #repository: ScheduledIdosiSyncRepository;
  readonly #options: IdosiSyncWorkerOptions;
  #stopping = false;
  #inFlight: Promise<IdosiSyncTickReport> | null = null;

  public constructor(repository: ScheduledIdosiSyncRepository, options: IdosiSyncWorkerOptions) {
    if (!options.secret.trim()) throw new TypeError('IDOSI scheduler secret is required');
    if (!Number.isSafeInteger(options.maxStoresPerTick) || options.maxStoresPerTick <= 0) {
      throw new RangeError('maxStoresPerTick must be a positive safe integer');
    }
    validateTimeZone(options.timeZone);
    this.#repository = repository;
    this.#options = options;
  }

  public runOnce(now = (this.#options.now ?? (() => new Date()))()): Promise<IdosiSyncTickReport> {
    if (this.#stopping) return Promise.reject(new Error('IDOSI sync worker is stopping.'));
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#runTick(now).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    await this.#inFlight;
  }

  async #runTick(now: Date): Promise<IdosiSyncTickReport> {
    if (Number.isNaN(now.getTime())) throw new TypeError('IDOSI scheduler instant is invalid');
    const period = businessMonthAt(now, this.#options.timeZone);
    const targets = await this.#repository.listDue(period, now, this.#options.maxStoresPerTick);
    let succeeded = 0;
    let failed = 0;
    for (const target of targets) {
      const startedAt = (this.#options.now ?? (() => new Date()))();
      const requestId = `idosi-scheduled-${randomUUID()}`;
      try {
        const payload = await fetchIdosiOrderStatistics({
          endpoint: this.#options.endpoint,
          secret: this.#options.secret,
          storeCode: target.storeCode,
          ...(this.#options.storeIdMap ? { storeIdMap: this.#options.storeIdMap } : {}),
          scope: {
            period: target.scope.period,
            date: target.scope.date,
            shiftId: target.scope.shiftId,
            paymentMethod: target.scope.paymentMethod,
          },
          requestId,
          ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
        });
        await this.#repository.recordSuccess(
          target,
          payload,
          startedAt,
          (this.#options.now ?? (() => new Date()))(),
          requestId,
        );
        succeeded += 1;
        this.#options.logger?.info(
          { storeCode: target.storeCode, period },
          'scheduled IDOSI statistics sync succeeded',
        );
      } catch (error) {
        const failure = safeFailure(error);
        await this.#repository.recordFailure(
          target,
          failure.code,
          failure.message,
          startedAt,
          (this.#options.now ?? (() => new Date()))(),
          requestId,
        );
        failed += 1;
        this.#options.logger?.warn(
          { errorCode: failure.code, storeCode: target.storeCode, period },
          'scheduled IDOSI statistics sync failed',
        );
      }
    }
    return { period, due: targets.length, succeeded, failed };
  }
}

export class PostgresScheduledIdosiSyncRepository implements ScheduledIdosiSyncRepository {
  public constructor(private readonly database: Database) {}

  public listDue(period: string, now: Date, limit: number) {
    return listDueIdosiStatisticsTargets(this.database, period, now, limit);
  }

  public recordSuccess(
    target: DueIdosiStatisticsTarget,
    payload: IdosiOrderStatisticsPayload,
    startedAt: Date,
    completedAt: Date,
    requestId: string,
  ): Promise<void> {
    return recordIdosiStatisticsSuccess(this.database, {
      target,
      scope: target.scope,
      payload,
      source: 'SCHEDULED',
      startedAt,
      completedAt,
      context: systemContext(requestId),
    });
  }

  public recordFailure(
    target: DueIdosiStatisticsTarget,
    errorCode: string,
    errorMessage: string,
    startedAt: Date,
    completedAt: Date,
    requestId: string,
  ): Promise<void> {
    return recordIdosiStatisticsFailure(this.database, {
      target,
      scope: target.scope,
      source: 'SCHEDULED',
      errorCode,
      errorMessage,
      startedAt,
      completedAt,
      context: systemContext(requestId),
    });
  }
}

export interface IdosiSyncPollingLoop {
  stop(): Promise<void>;
}

export function startIdosiSyncPolling(
  worker: IdosiStatisticsSyncWorker,
  pollMs: number,
): IdosiSyncPollingLoop {
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0) {
    throw new RangeError('IDOSI polling interval must be a positive safe integer');
  }
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
      // The allocation polling loop remains independent; the next bounded poll retries this job.
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

export function businessMonthAt(instant: Date, timeZone: string): string {
  if (Number.isNaN(instant.getTime())) throw new TypeError('Invalid business month instant');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(instant);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) throw new Error('Unable to resolve IDOSI business month');
  return `${year}-${month}`;
}

function systemContext(requestId: string) {
  return {
    actor: { userId: null, role: null, storeId: null },
    requestId,
    ipAddress: null,
    userAgent: 'idosi-statistics-worker',
  } as const;
}

function safeFailure(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof IdosiGatewayError) return { code: error.code, message: error.message };
  return {
    code: 'IDOSI_SYNC_INTERNAL',
    message: 'Worker không thể hoàn tất đồng bộ IDOSI.',
  };
}

function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid IDOSI scheduler time zone ${timeZone}.`);
  }
}
