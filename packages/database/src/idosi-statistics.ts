import type {
  IdosiOrderStatisticsPayload,
  IdosiStatisticsAttempt,
  IdosiStatisticsScope,
  IdosiStatisticsSnapshot,
} from '@idosi/contracts';
import { and, desc, eq, inArray, isNull, max } from 'drizzle-orm';

import type { Database } from './client.js';
import {
  auditLogs,
  idosiStatisticsSnapshots,
  idosiStatisticsSyncAttempts,
  operationalSettingsVersions,
  stores,
  type JsonObject,
} from './schema.js';
import { withAdvisoryLock } from './transaction.js';

export interface IdosiStatisticsTarget {
  readonly storeId: string;
  readonly storeCode: string;
  readonly storeName: string;
}

export interface IdosiStatisticsAuditActor {
  readonly userId: string | null;
  readonly role: 'admin' | 'htkd' | 'store' | 'wholesale_account' | null;
  readonly storeId: string | null;
}

export interface IdosiStatisticsAuditContext {
  readonly actor: IdosiStatisticsAuditActor;
  readonly requestId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface StoredIdosiStatisticsState {
  readonly snapshot: IdosiStatisticsSnapshot | null;
  readonly latestAttempt: IdosiStatisticsAttempt | null;
}

export interface RecordIdosiStatisticsSuccessInput {
  readonly target: IdosiStatisticsTarget;
  readonly scope: IdosiStatisticsScope;
  readonly payload: IdosiOrderStatisticsPayload;
  readonly source: 'MANUAL' | 'SCHEDULED';
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly context: IdosiStatisticsAuditContext;
}

export interface RecordIdosiStatisticsFailureInput {
  readonly target: IdosiStatisticsTarget;
  readonly scope: IdosiStatisticsScope;
  readonly source: 'MANUAL' | 'SCHEDULED';
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly context: IdosiStatisticsAuditContext;
}

export interface DueIdosiStatisticsTarget extends IdosiStatisticsTarget {
  readonly scope: IdosiStatisticsScope;
  readonly intervalMinutes: 15 | 30;
}

export function idosiStatisticsScopeKey(
  scope: Pick<IdosiStatisticsScope, 'period' | 'date' | 'shiftId' | 'paymentMethod'>,
): string {
  return JSON.stringify([
    scope.period,
    scope.date ?? null,
    scope.shiftId ?? null,
    scope.paymentMethod ?? null,
  ]);
}

export async function loadIdosiStatisticsState(
  database: Database,
  scope: IdosiStatisticsScope,
): Promise<StoredIdosiStatisticsState> {
  const scopeKey = idosiStatisticsScopeKey(scope);
  const [snapshotRow, attemptRow] = await Promise.all([
    database.query.idosiStatisticsSnapshots.findFirst({
      where: and(
        eq(idosiStatisticsSnapshots.storeId, scope.storeId),
        eq(idosiStatisticsSnapshots.scopeKey, scopeKey),
      ),
    }),
    database.query.idosiStatisticsSyncAttempts.findFirst({
      where: and(
        eq(idosiStatisticsSyncAttempts.storeId, scope.storeId),
        eq(idosiStatisticsSyncAttempts.scopeKey, scopeKey),
      ),
      orderBy: [
        desc(idosiStatisticsSyncAttempts.completedAt),
        desc(idosiStatisticsSyncAttempts.id),
      ],
    }),
  ]);
  return {
    snapshot: snapshotRow ? snapshotDto(snapshotRow) : null,
    latestAttempt: attemptRow ? attemptDto(attemptRow) : null,
  };
}

/** Two bounded reads, irrespective of the number of stores on a page. */
export async function loadIdosiStatisticsStates(
  database: Database,
  storeIds: readonly string[],
  period: string,
): Promise<StoredIdosiStatisticsState[]> {
  if (storeIds.length === 0) return [];
  const scopeKey = idosiStatisticsScopeKey({
    period,
    date: null,
    shiftId: null,
    paymentMethod: null,
  });
  const [snapshots, attempts] = await Promise.all([
    database
      .select()
      .from(idosiStatisticsSnapshots)
      .where(
        and(
          inArray(idosiStatisticsSnapshots.storeId, [...storeIds]),
          eq(idosiStatisticsSnapshots.scopeKey, scopeKey),
        ),
      ),
    database
      .selectDistinctOn([idosiStatisticsSyncAttempts.storeId])
      .from(idosiStatisticsSyncAttempts)
      .where(
        and(
          inArray(idosiStatisticsSyncAttempts.storeId, [...storeIds]),
          eq(idosiStatisticsSyncAttempts.scopeKey, scopeKey),
        ),
      )
      .orderBy(
        idosiStatisticsSyncAttempts.storeId,
        desc(idosiStatisticsSyncAttempts.completedAt),
        desc(idosiStatisticsSyncAttempts.id),
      ),
  ]);
  const snapshotByStore = new Map(snapshots.map((row) => [row.storeId, snapshotDto(row)]));
  const attemptByStore = new Map(attempts.map((row) => [row.storeId, attemptDto(row)]));
  return storeIds.map((id) => ({
    snapshot: snapshotByStore.get(id) ?? null,
    latestAttempt: attemptByStore.get(id) ?? null,
  }));
}

export async function recordIdosiStatisticsSuccess(
  database: Database,
  input: RecordIdosiStatisticsSuccessInput,
): Promise<void> {
  validateAttemptTimes(input.startedAt, input.completedAt);
  const scopeKey = idosiStatisticsScopeKey(input.scope);
  await database.transaction((tx) =>
    withAdvisoryLock(
      tx,
      'idosi-statistics-snapshot',
      `${input.scope.storeId}:${scopeKey}`,
      async () => {
        const [existing] = await tx
          .select()
          .from(idosiStatisticsSnapshots)
          .where(
            and(
              eq(idosiStatisticsSnapshots.storeId, input.scope.storeId),
              eq(idosiStatisticsSnapshots.scopeKey, scopeKey),
            ),
          )
          .limit(1);
        const sourceGeneratedAt = new Date(input.payload.generatedAt);
        let snapshotId: string;
        if (!existing) {
          const [created] = await tx
            .insert(idosiStatisticsSnapshots)
            .values({
              storeId: input.scope.storeId,
              scopeKey,
              period: input.scope.period,
              filterDate: input.scope.date,
              shiftId: input.scope.shiftId,
              paymentMethod: input.scope.paymentMethod,
              payload: input.payload as unknown as JsonObject,
              sourceGeneratedAt,
              sourceRequestId: input.payload.requestId,
              firstSyncedAt: input.completedAt,
              lastSyncedAt: input.completedAt,
              syncedByUserId: input.context.actor.userId,
            })
            .returning({ id: idosiStatisticsSnapshots.id });
          if (!created) throw new Error('IDOSI snapshot insert did not return a row');
          snapshotId = created.id;
        } else {
          snapshotId = existing.id;
          if (sourceGeneratedAt >= existing.sourceGeneratedAt) {
            await tx
              .update(idosiStatisticsSnapshots)
              .set({
                payload: input.payload as unknown as JsonObject,
                sourceGeneratedAt,
                sourceRequestId: input.payload.requestId,
                lastSyncedAt: input.completedAt,
                syncedByUserId: input.context.actor.userId,
              })
              .where(eq(idosiStatisticsSnapshots.id, existing.id));
          }
        }

        const [attempt] = await tx
          .insert(idosiStatisticsSyncAttempts)
          .values({
            storeId: input.scope.storeId,
            snapshotId,
            scopeKey,
            period: input.scope.period,
            source: databaseSource(input.source),
            status: 'succeeded',
            actorUserId: input.context.actor.userId,
            requestId: input.context.requestId,
            startedAt: input.startedAt,
            completedAt: input.completedAt,
          })
          .returning({ id: idosiStatisticsSyncAttempts.id });
        if (!attempt) throw new Error('IDOSI success attempt insert did not return a row');

        await tx.insert(auditLogs).values({
          requestId: input.context.requestId,
          actorUserId: input.context.actor.userId,
          actorRole: input.context.actor.role,
          actorStoreId: input.context.actor.storeId,
          action: 'IDOSI_STATISTICS_SYNC_SUCCEEDED',
          entityType: 'idosi_statistics_snapshot',
          entityId: snapshotId,
          before: null,
          after: {
            storeCode: input.target.storeCode,
            scopeKey,
            source: input.source,
            sourceGeneratedAt: input.payload.generatedAt,
            orders: input.payload.totals.orders,
            revenueVnd: input.payload.totals.revenue,
          },
          metadata: { attemptId: attempt.id },
          ipAddress: input.context.ipAddress,
          userAgent: input.context.userAgent,
        });
      },
    ),
  );
}

export async function recordIdosiStatisticsFailure(
  database: Database,
  input: RecordIdosiStatisticsFailureInput,
): Promise<void> {
  validateAttemptTimes(input.startedAt, input.completedAt);
  const scopeKey = idosiStatisticsScopeKey(input.scope);
  const errorCode = boundedText(input.errorCode, 100, 'IDOSI_SYNC_FAILED');
  const errorMessage = boundedText(input.errorMessage, 1_000, 'Đồng bộ IDOSI thất bại.');
  await database.transaction(async (tx) => {
    const [attempt] = await tx
      .insert(idosiStatisticsSyncAttempts)
      .values({
        storeId: input.scope.storeId,
        snapshotId: null,
        scopeKey,
        period: input.scope.period,
        source: databaseSource(input.source),
        status: 'failed',
        errorCode,
        errorMessage,
        actorUserId: input.context.actor.userId,
        requestId: input.context.requestId,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
      })
      .returning({ id: idosiStatisticsSyncAttempts.id });
    if (!attempt) throw new Error('IDOSI failure attempt insert did not return a row');
    await tx.insert(auditLogs).values({
      requestId: input.context.requestId,
      actorUserId: input.context.actor.userId,
      actorRole: input.context.actor.role,
      actorStoreId: input.context.actor.storeId,
      action: 'IDOSI_STATISTICS_SYNC_FAILED',
      entityType: 'idosi_statistics_sync_attempt',
      entityId: attempt.id,
      before: null,
      after: { storeCode: input.target.storeCode, scopeKey, source: input.source, errorCode },
      metadata: {},
      ipAddress: input.context.ipAddress,
      userAgent: input.context.userAgent,
    });
  });
}

export async function listDueIdosiStatisticsTargets(
  database: Database,
  period: string,
  now: Date,
  limit: number,
): Promise<readonly DueIdosiStatisticsTarget[]> {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(period)) throw new TypeError('Invalid IDOSI period');
  if (Number.isNaN(now.getTime())) throw new TypeError('Invalid scheduler instant');
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('Invalid scheduler limit');
  const [settings] = await database
    .select({ interval: operationalSettingsVersions.idosiSyncIntervalMinutes })
    .from(operationalSettingsVersions)
    .orderBy(desc(operationalSettingsVersions.version))
    .limit(1);
  if (!settings || (settings.interval !== 15 && settings.interval !== 30)) {
    throw new Error('Operational settings have not initialized a valid IDOSI interval');
  }
  const intervalMinutes = settings.interval as 15 | 30;
  const scopeTemplate = { period, date: null, shiftId: null, paymentMethod: null } as const;
  const scopeKey = idosiStatisticsScopeKey(scopeTemplate);
  const activeStores = await database
    .select({ id: stores.id, code: stores.code, name: stores.name })
    .from(stores)
    .where(and(eq(stores.isActive, true), eq(stores.kind, 'retail'), isNull(stores.deletedAt)))
    .orderBy(stores.code);
  if (activeStores.length === 0) return [];
  const latestAttempts = await database
    .select({
      storeId: idosiStatisticsSyncAttempts.storeId,
      completedAt: max(idosiStatisticsSyncAttempts.completedAt),
    })
    .from(idosiStatisticsSyncAttempts)
    .where(
      and(
        inArray(
          idosiStatisticsSyncAttempts.storeId,
          activeStores.map((store) => store.id),
        ),
        eq(idosiStatisticsSyncAttempts.scopeKey, scopeKey),
      ),
    )
    .groupBy(idosiStatisticsSyncAttempts.storeId);
  const latestByStore = new Map(
    latestAttempts.map((attempt) => [attempt.storeId, attempt.completedAt] as const),
  );
  const dueBefore = new Date(now.getTime() - intervalMinutes * 60_000);
  return activeStores
    .filter((store) => {
      const latest = latestByStore.get(store.id);
      return latest === undefined || latest === null || latest <= dueBefore;
    })
    .slice(0, limit)
    .map((store) => ({
      storeId: store.id,
      storeCode: store.code,
      storeName: store.name,
      scope: { storeId: store.id, ...scopeTemplate },
      intervalMinutes,
    }));
}

function snapshotDto(row: typeof idosiStatisticsSnapshots.$inferSelect): IdosiStatisticsSnapshot {
  return {
    id: row.id,
    storeId: row.storeId,
    scopeKey: row.scopeKey,
    payload: row.payload as unknown as IdosiOrderStatisticsPayload,
    firstSyncedAt: row.firstSyncedAt.toISOString(),
    lastSyncedAt: row.lastSyncedAt.toISOString(),
  };
}

function attemptDto(row: typeof idosiStatisticsSyncAttempts.$inferSelect): IdosiStatisticsAttempt {
  return {
    id: row.id,
    source: row.source === 'scheduled' ? 'SCHEDULED' : 'MANUAL',
    status: row.status === 'succeeded' ? 'SUCCEEDED' : 'FAILED',
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt.toISOString(),
  };
}

function databaseSource(source: 'MANUAL' | 'SCHEDULED'): 'manual' | 'scheduled' {
  return source === 'SCHEDULED' ? 'scheduled' : 'manual';
}

function validateAttemptTimes(startedAt: Date, completedAt: Date): void {
  if (
    Number.isNaN(startedAt.getTime()) ||
    Number.isNaN(completedAt.getTime()) ||
    completedAt < startedAt
  ) {
    throw new RangeError('IDOSI sync attempt timestamps are invalid');
  }
}

function boundedText(value: string, maximum: number, fallback: string): string {
  const normalized = value.trim() || fallback;
  return normalized.slice(0, maximum);
}
