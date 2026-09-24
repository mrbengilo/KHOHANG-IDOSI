import { randomUUID } from 'node:crypto';

import { IdosiOrderStatisticsPayloadSchema, type IdosiStatisticsScope } from '@idosi/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  db,
  idosiStatisticsSnapshots,
  listIdosiPeriodClosingTargets,
  loadIdosiStatisticsState,
  loadIdosiStatisticsStates,
  recordIdosiStatisticsFailure,
  recordIdosiStatisticsSuccess,
  storeGroups,
  stores,
} from '../src/index.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;
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
  tableVersion: 'integration',
  byRevenueType: { NORMAL: emptyBucket, SALE_KG: emptyBucket, SALE_PIECE: emptyBucket },
};

function payload(
  storeCode: string,
  scope: IdosiStatisticsScope,
  generatedAt: string,
  revenue: number,
) {
  return IdosiOrderStatisticsPayloadSchema.parse({
    ok: true,
    apiVersion: 1,
    storeId: storeCode,
    store: { id: storeCode, name: storeCode },
    currency: 'VND',
    timezone: 'Asia/Ho_Chi_Minh',
    revenueBasis: 'ACTIVE_ORDER_AMOUNT',
    generatedAt,
    serverTime: generatedAt,
    requestId: randomUUID(),
    filters: {
      period: scope.period,
      date: scope.date,
      shiftId: scope.shiftId,
      paymentMethod: scope.paymentMethod,
    },
    totals: {
      orders: 1,
      cash: revenue,
      transfer: 0,
      revenue,
      cashOrders: 1,
      transferOrders: 0,
      revenueByType: { NORMAL: 0, SALE_KG: 0, SALE_PIECE: revenue },
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
      unclassifiedOrders: 1,
      items: [],
      weight,
      weightByProduct: [],
    },
    groups: { shift: [], day: [], month: [] },
  });
}

describePostgres('IDOSI snapshot PostgreSQL isolation', () => {
  afterAll(async () => closeDatabase());

  it('replaces one store/scope without accumulation or warehouse ledger writes', async () => {
    const suffix = randomUUID();
    const [group] = await db
      .insert(storeGroups)
      .values({ code: `I${suffix}`, name: 'IDOSI test' })
      .returning();
    if (!group) throw new Error('Missing test store group');
    const createdStores = await db
      .insert(stores)
      .values([
        { groupId: group.id, code: `A${suffix}`, name: 'Test A' },
        { groupId: group.id, code: `B${suffix}`, name: 'Test B' },
      ])
      .returning();
    const [storeA, storeB] = createdStores;
    if (!storeA || !storeB) throw new Error('Missing test stores');
    const month = (storeId: string): IdosiStatisticsScope => ({
      storeId,
      period: '2026-09',
      date: null,
      shiftId: null,
      paymentMethod: null,
    });
    const day: IdosiStatisticsScope = { ...month(storeA.id), date: '2026-09-17' };
    const shift: IdosiStatisticsScope = { ...day, shiftId: 'ca-1' };
    const stockBefore = await db.execute<{ ledger: string; balances: string }>(sql`
      SELECT (SELECT count(*) FROM warehouse_ledger_entries)::text AS ledger,
             (SELECT count(*) FROM warehouse_balances)::text AS balances
    `);
    const save = async (scope: IdosiStatisticsScope, code: string, at: string, revenue: number) => {
      const completedAt = new Date(at);
      await recordIdosiStatisticsSuccess(db, {
        target: { storeId: scope.storeId, storeCode: code, storeName: code },
        scope,
        payload: payload(code, scope, at, revenue),
        source: 'MANUAL',
        startedAt: completedAt,
        completedAt,
        context: {
          actor: { userId: null, role: null, storeId: null },
          requestId: randomUUID(),
          ipAddress: null,
          userAgent: null,
        },
      });
    };
    await save(month(storeA.id), storeA.code, '2026-09-17T01:00:00.000Z', 100);
    const first = await loadIdosiStatisticsState(db, month(storeA.id));
    await save(month(storeA.id), storeA.code, '2026-09-17T02:00:00.000Z', 130);
    await save(day, storeA.code, '2026-09-17T02:00:00.000Z', 40);
    await save(shift, storeA.code, '2026-09-17T02:00:00.000Z', 25);
    await save(month(storeB.id), storeB.code, '2026-09-17T02:00:00.000Z', 70);
    const second = await loadIdosiStatisticsState(db, month(storeA.id));
    expect(second.snapshot?.id).toBe(first.snapshot?.id);
    expect(second.snapshot?.payload.totals.revenue).toBe(130);
    expect(second.snapshot?.payload.totals.revenueByType.SALE_PIECE).toBe(130);
    expect((await loadIdosiStatisticsState(db, day)).snapshot?.payload.totals.revenue).toBe(40);
    expect((await loadIdosiStatisticsState(db, shift)).snapshot?.payload.totals.revenue).toBe(25);
    expect(
      (await loadIdosiStatisticsState(db, month(storeB.id))).snapshot?.payload.totals.revenue,
    ).toBe(70);
    const states = await loadIdosiStatisticsStates(db, [storeA.id, storeB.id], '2026-09');
    expect(states.map((state) => state.snapshot?.payload.totals.revenue)).toEqual([130, 70]);
    const rows = await db
      .select()
      .from(idosiStatisticsSnapshots)
      .where(eq(idosiStatisticsSnapshots.storeId, storeA.id));
    expect(rows).toHaveLength(3);
    const stockAfter = await db.execute<{ ledger: string; balances: string }>(sql`
        SELECT (SELECT count(*) FROM warehouse_ledger_entries)::text AS ledger,
               (SELECT count(*) FROM warehouse_balances)::text AS balances
      `);
    expect(stockAfter.rows).toEqual(stockBefore.rows);
  });

  it('keeps a closed month due until one sync succeeds after its grace days', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const [group] = await db
      .insert(storeGroups)
      .values({ code: `C${suffix}`, name: 'Closing sync test' })
      .returning();
    const [store] = await db
      .insert(stores)
      .values({ groupId: group!.id, code: `C${suffix}`, name: 'Closing store' })
      .returning();
    const scope: IdosiStatisticsScope = {
      storeId: store!.id,
      period: '2026-08',
      date: null,
      shiftId: null,
      paymentMethod: null,
    };
    const settledAfter = new Date('2026-09-03T17:00:00.000Z');
    const now = new Date('2026-09-17T03:00:00.000Z');
    const due = async () =>
      (await listIdosiPeriodClosingTargets(db, '2026-08', settledAfter, now, 1_000)).some(
        (target) => target.storeId === store!.id,
      );
    const context = {
      actor: { userId: null, role: null, storeId: null },
      requestId: randomUUID(),
      ipAddress: null,
      userAgent: null,
    };
    const succeed = (completedAt: string) =>
      recordIdosiStatisticsSuccess(db, {
        target: { storeId: store!.id, storeCode: store!.code, storeName: store!.name },
        scope,
        payload: payload(store!.code, scope, completedAt, 10),
        source: 'SCHEDULED',
        startedAt: new Date(completedAt),
        completedAt: new Date(completedAt),
        context,
      });

    expect(await due()).toBe(true);
    // Synced during the grace days only: IDOSI may still have corrected the month afterwards.
    await succeed('2026-09-02T03:00:00.000Z');
    expect(await due()).toBe(true);
    // A failure moments ago waits for the regular interval before the next try.
    await recordIdosiStatisticsFailure(db, {
      target: { storeId: store!.id, storeCode: store!.code, storeName: store!.name },
      scope,
      source: 'SCHEDULED',
      errorCode: 'IDOSI_REQUEST_FAILED',
      errorMessage: 'IDOSI unavailable',
      startedAt: new Date('2026-09-17T02:55:00.000Z'),
      completedAt: new Date('2026-09-17T02:55:00.000Z'),
      context,
    });
    expect(await due()).toBe(false);
    // One success after the grace days closes the month for good.
    await succeed('2026-09-10T03:00:00.000Z');
    expect(
      (
        await listIdosiPeriodClosingTargets(
          db,
          '2026-08',
          settledAfter,
          new Date('2026-09-30T03:00:00.000Z'),
          1_000,
        )
      ).some((target) => target.storeId === store!.id),
    ).toBe(false);
  });
});
