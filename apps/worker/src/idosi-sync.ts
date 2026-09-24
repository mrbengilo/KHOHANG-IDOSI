import { randomUUID } from 'node:crypto';

import {
  fetchIdosiOrderStatistics,
  idosiFetchStore,
  IdosiGatewayError,
  type IdosiFetch,
  type IdosiOrderStatisticsPayload,
} from '@idosi/contracts';
import {
  listDueIdosiStatisticsTargets,
  listIdosiPeriodClosingTargets,
  recordIdosiStatisticsFailure,
  recordIdosiStatisticsSuccess,
  type Database,
  type DueIdosiStatisticsTarget,
} from '@idosi/database';

import type { WorkerLogger } from './types.js';

export interface ScheduledIdosiSyncRepository {
  listDue(period: string, now: Date, limit: number): Promise<readonly DueIdosiStatisticsTarget[]>;
  /** Stores whose closed `period` has had no successful sync since `settledAfter`. */
  listClosing(
    period: string,
    settledAfter: Date,
    now: Date,
    limit: number,
  ): Promise<readonly DueIdosiStatisticsTarget[]>;
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
    const periods = idosiSyncPeriods(now, this.#options.timeZone);
    const period = periods[0]!;
    const targets: DueIdosiStatisticsTarget[] = [];
    for (const candidate of periods) {
      const remaining = this.#options.maxStoresPerTick - targets.length;
      if (remaining <= 0) break;
      targets.push(...(await this.#repository.listDue(candidate, now, remaining)));
    }
    // After the grace days, a store whose previous month never synced since they ended (IDOSI
    // was down, or the store was unreachable) keeps being retried until one sync succeeds.
    const closingRoom = this.#options.maxStoresPerTick - targets.length;
    if (periods.length === 1 && closingRoom > 0) {
      targets.push(
        ...(await this.#repository.listClosing(
          previousBusinessMonth(period),
          closingSyncSettledAfter(period, this.#options.timeZone),
          now,
          closingRoom,
        )),
      );
    }
    let succeeded = 0;
    let failed = 0;
    for (const target of targets) {
      const startedAt = (this.#options.now ?? (() => new Date()))();
      const requestId = `idosi-scheduled-${randomUUID()}`;
      try {
        const payload = await fetchIdosiOrderStatistics({
          endpoint: this.#options.endpoint,
          secret: this.#options.secret,
          ...idosiFetchStore(target, this.#options.storeIdMap),
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
          { storeCode: target.storeCode, period: target.scope.period },
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
          { errorCode: failure.code, storeCode: target.storeCode, period: target.scope.period },
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

  public listClosing(period: string, settledAfter: Date, now: Date, limit: number) {
    return listIdosiPeriodClosingTargets(this.database, period, settledAfter, now, limit);
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

/** Days into a new month during which the previous month is still re-synced. */
export const PREVIOUS_MONTH_SYNC_DAYS = 3;

/**
 * The current month always, plus the previous month for the first few days: sales rung up
 * after the last sync of a month, and IDOSI corrections made just after it closes, still
 * have to reach the Sale pool and the store bags.
 */
export function idosiSyncPeriods(instant: Date, timeZone: string): readonly string[] {
  const current = businessMonthAt(instant, timeZone);
  const day = Number(
    new Intl.DateTimeFormat('en-US', { timeZone, day: '2-digit' })
      .formatToParts(instant)
      .find((part) => part.type === 'day')?.value,
  );
  if (!Number.isSafeInteger(day) || day > PREVIOUS_MONTH_SYNC_DAYS) return [current];
  return [current, previousBusinessMonth(current)];
}

export function previousBusinessMonth(period: string): string {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

/**
 * Midnight after the grace days of `period` (e.g. 2026-09-04 00:00 in Vietnam for 2026-09): a
 * previous-month sync completed from then on reflects the month after it closed.
 */
export function closingSyncSettledAfter(period: string, timeZone: string): Date {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return startOfBusinessDay(year, month, PREVIOUS_MONTH_SYNC_DAYS + 1, timeZone);
}

/** The instant a calendar day starts in `timeZone` (exact for zones without mid-day shifts). */
export function startOfBusinessDay(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcGuess));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const zonedAsUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );
  return new Date(utcGuess - (zonedAsUtc - utcGuess));
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
