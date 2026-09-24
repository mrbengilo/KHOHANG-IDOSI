import { randomUUID } from 'node:crypto';

import { IdosiOrderStatisticsPayloadSchema, type IdosiStatisticsScope } from '@idosi/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import {
  auditLogs,
  closeDatabase,
  db,
  idempotencyKeys,
  idosiStatisticsSyncAttempts,
  pruneOperationalHistory,
  recordIdosiStatisticsFailure,
  recordIdosiStatisticsSuccess,
  sessions,
  storeGroups,
  stores,
  users,
} from '../src/index.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1_000;

const emptyBucket = {
  actualKg: 0,
  estimatedKg: 0,
  knownKg: 0,
  totalKg: 0,
  isComplete: true,
  missingFactorLines: 0,
  invalidLines: 0,
  unclassifiedOrders: 0,
};
const weight = {
  ...emptyBucket,
  schemaVersion: 1,
  unit: 'KG' as const,
  tableVersion: 'maintenance',
  byRevenueType: { NORMAL: emptyBucket, SALE_KG: emptyBucket, SALE_PIECE: emptyBucket },
};

function payload(code: string, scope: IdosiStatisticsScope, at: string, orders: number) {
  return IdosiOrderStatisticsPayloadSchema.parse({
    ok: true,
    apiVersion: 1,
    storeId: code,
    store: { id: code, name: code },
    currency: 'VND',
    timezone: 'Asia/Ho_Chi_Minh',
    revenueBasis: 'ACTIVE_ORDER_AMOUNT',
    generatedAt: at,
    serverTime: at,
    requestId: randomUUID(),
    filters: { period: scope.period, date: null, shiftId: null, paymentMethod: null },
    totals: {
      orders,
      cash: 0,
      transfer: 0,
      revenue: 0,
      cashOrders: 0,
      transferOrders: 0,
      revenueByType: { NORMAL: 0, SALE_KG: 0, SALE_PIECE: 0 },
      unclassifiedRevenue: 0,
      unclassifiedOrders: 0,
      weight,
    },
    products: {
      totalQuantity: 0,
      salePieceQuantity: 0,
      totalWeightKg: 0,
      productTypes: 0,
      ordersWithItems: 0,
      unclassifiedOrders: 0,
      items: [],
      weight,
      weightByProduct: [],
    },
    groups: { shift: [], day: [], month: [] },
  });
}

describePostgres('operational history retention', () => {
  afterAll(() => closeDatabase());

  it('prunes expired sessions and idempotency records, never sync attempts', async () => {
    const now = new Date();
    const token = randomUUID().replaceAll('-', '');
    const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
    const long = new Date(now.getTime() - 200 * DAY);
    const [oldSession, liveSession] = await db
      .insert(sessions)
      .values([
        {
          userId: admin!.id,
          tokenHash: `old-${token}`.padEnd(64, '0'),
          userTokenVersion: 0,
          createdAt: long,
          lastSeenAt: long,
          expiresAt: new Date(long.getTime() + DAY),
        },
        {
          userId: admin!.id,
          tokenHash: `live-${token}`.padEnd(64, '0'),
          userTokenVersion: 0,
          expiresAt: new Date(now.getTime() + DAY),
        },
      ])
      .returning();
    const [oldKey, liveKey] = await db
      .insert(idempotencyKeys)
      .values([
        {
          scope: 'maintenance-test',
          key: `old-${token}`,
          requestHash: 'hash',
          lockedUntil: long,
          createdAt: long,
          expiresAt: new Date(long.getTime() + DAY),
        },
        {
          scope: 'maintenance-test',
          key: `live-${token}`,
          requestHash: 'hash',
          lockedUntil: now,
          expiresAt: new Date(now.getTime() + DAY),
        },
      ])
      .returning();

    const [group] = await db
      .insert(storeGroups)
      .values({ code: `M${token.slice(0, 12)}`, name: 'Maintenance' })
      .returning();
    const [store] = await db
      .insert(stores)
      .values({ groupId: group!.id, code: `M${token.slice(0, 12)}`, name: 'Maintenance store' })
      .returning();
    const scope: IdosiStatisticsScope = {
      storeId: store!.id,
      period: '2026-01',
      date: null,
      shiftId: null,
      paymentMethod: null,
    };
    const context = {
      actor: { userId: null, role: null, storeId: null },
      requestId: randomUUID(),
      ipAddress: null,
      userAgent: null,
    };
    const target = { storeId: store!.id, storeCode: store!.code, storeName: store!.name };
    const fail = (at: Date) =>
      recordIdosiStatisticsFailure(db, {
        target,
        scope,
        source: 'SCHEDULED',
        errorCode: 'IDOSI_REQUEST_FAILED',
        errorMessage: 'IDOSI unavailable',
        startedAt: at,
        completedAt: at,
        context,
      });
    await fail(new Date(now.getTime() - 120 * DAY));
    await fail(new Date(now.getTime() - 100 * DAY));

    // Repeated scheduled failures with the same cause are audited once.
    const failureAudits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'IDOSI_STATISTICS_SYNC_FAILED'),
          eq(auditLogs.entityType, 'idosi_statistics_sync_attempt'),
          inArray(
            auditLogs.entityId,
            (
              await db
                .select({ id: idosiStatisticsSyncAttempts.id })
                .from(idosiStatisticsSyncAttempts)
                .where(eq(idosiStatisticsSyncAttempts.storeId, store!.id))
            ).map((row) => row.id),
          ),
        ),
      );
    expect(failureAudits).toHaveLength(1);

    // Scheduled successes are audited when the figures change, not on every refresh.
    const succeed = (at: Date, orders: number) =>
      recordIdosiStatisticsSuccess(db, {
        target,
        scope,
        payload: payload(store!.code, scope, at.toISOString(), orders),
        source: 'SCHEDULED',
        startedAt: at,
        completedAt: at,
        context,
      });
    await succeed(new Date(now.getTime() - 95 * DAY), 3);
    await succeed(new Date(now.getTime() - 94 * DAY), 3);
    await succeed(new Date(now.getTime() - 93 * DAY), 4);
    const successAudits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'IDOSI_STATISTICS_SYNC_SUCCEEDED'));
    expect(
      successAudits.filter(
        (row) => (row.after as { storeCode?: string } | null)?.storeCode === store!.code,
      ),
    ).toHaveLength(2);

    await pruneOperationalHistory(db, now);

    const remainingSessions = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.id, [oldSession!.id, liveSession!.id]));
    expect(remainingSessions.map((row) => row.id)).toEqual([liveSession!.id]);
    const remainingKeys = await db
      .select({ id: idempotencyKeys.id })
      .from(idempotencyKeys)
      .where(inArray(idempotencyKeys.id, [oldKey!.id, liveKey!.id]));
    expect(remainingKeys.map((row) => row.id)).toEqual([liveKey!.id]);
    // Sync attempts are append-only evidence and survive retention.
    const attempts = await db
      .select()
      .from(idosiStatisticsSyncAttempts)
      .where(eq(idosiStatisticsSyncAttempts.storeId, store!.id));
    expect(attempts).toHaveLength(5);
  });
});
