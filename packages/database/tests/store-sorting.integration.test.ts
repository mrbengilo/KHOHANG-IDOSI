import { randomUUID } from 'node:crypto';

import { IdosiOrderStatisticsPayloadSchema } from '@idosi/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  createStorePartnerInbound,
  createStoreSorting,
  db,
  exportCharity,
  listStoreSortedStocks,
  moveCharityToSale,
  products,
  recordIdosiStatisticsSuccess,
  storeGroups,
  storeInventoryBags,
  storeSaleSyncProgress,
  storeSortingEvents,
  stores,
  users,
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
const emptyWeight = {
  ...emptyBucket,
  schemaVersion: 1,
  unit: 'KG' as const,
  tableVersion: 'sorting-integration',
  byRevenueType: { NORMAL: emptyBucket, SALE_KG: emptyBucket, SALE_PIECE: emptyBucket },
};

function saleItem(name: string, type: 'SALE_KG' | 'SALE_PIECE', quantity: number, kg: number) {
  const bucket =
    type === 'SALE_KG'
      ? { ...emptyBucket, actualKg: kg, knownKg: kg, totalKg: kg }
      : { ...emptyBucket, estimatedKg: kg, knownKg: kg, totalKg: kg };
  return {
    productId: name,
    productName: name,
    quantity,
    unit: type === 'SALE_KG' ? ('KG' as const) : ('PIECE' as const),
    revenueType: type,
    classification: type,
    orders: 1,
    weight: {
      ...emptyWeight,
      ...bucket,
      byRevenueType: {
        NORMAL: emptyBucket,
        SALE_KG: type === 'SALE_KG' ? bucket : emptyBucket,
        SALE_PIECE: type === 'SALE_PIECE' ? bucket : emptyBucket,
      },
    },
  };
}

function payload(period: string, at: Date, malePieces: number, dressKg: number) {
  const items =
    malePieces === 0 && dressKg === 0
      ? []
      : [
          saleItem('Đồ nam', 'SALE_PIECE', malePieces, malePieces / 3),
          saleItem('Đầm', 'SALE_KG', dressKg, dressKg),
        ];
  return IdosiOrderStatisticsPayloadSchema.parse({
    ok: true,
    apiVersion: 1,
    storeId: 'SM_TNV_TEST',
    store: { id: 'SM_TNV_TEST', name: 'SM TNV test' },
    currency: 'VND',
    timezone: 'Asia/Ho_Chi_Minh',
    revenueBasis: 'ACTIVE_ORDER_AMOUNT',
    generatedAt: at.toISOString(),
    serverTime: at.toISOString(),
    requestId: randomUUID(),
    filters: { period, date: null, shiftId: null, paymentMethod: null },
    totals: {
      orders: items.length,
      cash: 0,
      transfer: 0,
      revenue: 0,
      cashOrders: 0,
      transferOrders: 0,
      revenueByType: { NORMAL: 0, SALE_KG: 0, SALE_PIECE: 0 },
      unclassifiedRevenue: 0,
      unclassifiedOrders: 0,
      weight: emptyWeight,
    },
    products: {
      totalQuantity: malePieces,
      salePieceQuantity: malePieces,
      totalWeightKg: dressKg,
      productTypes: items.length,
      ordersWithItems: items.length,
      unclassifiedOrders: 0,
      items,
      weight: emptyWeight,
      weightByProduct: [],
    },
    groups: { shift: [], day: [], month: [] },
  });
}

describePostgres('sorted sale and charity stock with IDOSI reconciliation', () => {
  afterAll(() => closeDatabase());

  it('deducts 27 male pieces as 9 kg and 9 dress kg once, then handles corrections and charity', async () => {
    const token = randomUUID().replaceAll('-', '');
    const [group] = await db
      .insert(storeGroups)
      .values({ code: `S${token}`, name: 'Sorting integration' })
      .returning();
    const [store] = await db
      .insert(stores)
      .values({ groupId: group!.id, code: `S${token}`, name: 'SM TNV test' })
      .returning();
    const [admin] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.role, 'admin'))
      .limit(1);
    const [actor] = await db
      .insert(users)
      .values({
        email: `sort.${token}@example.invalid`,
        displayName: 'Sorting test',
        role: 'store',
        status: 'active',
        storeId: store!.id,
        passwordHash: admin!.passwordHash,
      })
      .returning();
    const [male, dress] = await Promise.all([
      db.select().from(products).where(eq(products.sku, 'DO_NAM')).limit(1),
      db.select().from(products).where(eq(products.sku, 'DAM')).limit(1),
    ]);
    const maleProduct = male[0]!;
    const dressProduct = dress[0]!;
    const now = new Date();
    const period = new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 7);
    const saveSnapshot = async (
      malePieces: number,
      dressKg: number,
      offsetSeconds: number,
      snapshotPeriod = period,
    ) => {
      const at = new Date(now.getTime() + offsetSeconds * 1000);
      await recordIdosiStatisticsSuccess(db, {
        target: { storeId: store!.id, storeCode: store!.code, storeName: store!.name },
        scope: {
          storeId: store!.id,
          period: snapshotPeriod,
          date: null,
          shiftId: null,
          paymentMethod: null,
        },
        payload: payload(snapshotPeriod, at, malePieces, dressKg),
        source: 'MANUAL',
        startedAt: at,
        completedAt: at,
        context: {
          actor: { userId: null, role: null, storeId: null },
          requestId: randomUUID(),
          ipAddress: null,
          userAgent: null,
        },
      });
    };
    await saveSnapshot(0, 0, 0);
    const receipt = await createStorePartnerInbound(db, {
      storeId: store!.id,
      partnerName: 'Sorting integration partner',
      note: null,
      receivedAt: now,
      lines: [
        { productId: maleProduct.id, quantity: 1, bagWeightsKg: ['30.000'] },
        { productId: dressProduct.id, quantity: 2, bagWeightsKg: ['40.000', '5.000'] },
      ],
      createdByUserId: actor!.id,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    });
    if (receipt.replayed) throw new Error('Unexpected inbound replay');
    const bagRows = await db
      .select()
      .from(storeInventoryBags)
      .where(eq(storeInventoryBags.storeId, store!.id));
    const maleBag = bagRows.find((bag) => bag.productId === maleProduct.id)!;
    const dressBag = bagRows.find(
      (bag) => bag.productId === dressProduct.id && bag.currentWeightKg === '40.000',
    )!;
    const charityBag = bagRows.find(
      (bag) => bag.productId === dressProduct.id && bag.currentWeightKg === '5.000',
    )!;
    const sort = (bag: typeof maleBag, reason: 'SALE' | 'CHARITY', weightKg: string) =>
      createStoreSorting(db, {
        storeId: store!.id,
        inventoryBagId: bag.id,
        expectedInventoryVersion: bag.version,
        reason,
        weightKg,
        actorUserId: actor!.id,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
      });
    await sort(maleBag, 'SALE', '30.000');
    await sort(dressBag, 'SALE', '40.000');
    await sort(charityBag, 'CHARITY', '5.000');
    await saveSnapshot(27, 9, 1);
    let stocks = await listStoreSortedStocks(db, store!.id);
    expect(stocks.find((stock) => stock.inventoryLotId === maleBag.id)?.saleWeightKg).toBe(
      '21.000',
    );
    expect(stocks.find((stock) => stock.inventoryLotId === dressBag.id)?.saleWeightKg).toBe(
      '31.000',
    );
    await saveSnapshot(27, 9, 2);
    stocks = await listStoreSortedStocks(db, store!.id);
    expect(stocks.find((stock) => stock.inventoryLotId === maleBag.id)?.saleWeightKg).toBe(
      '21.000',
    );
    await saveSnapshot(18, 9, 3);
    stocks = await listStoreSortedStocks(db, store!.id);
    expect(stocks.find((stock) => stock.inventoryLotId === maleBag.id)?.saleWeightKg).toBe(
      '24.000',
    );
    const charity = stocks.find((stock) => stock.inventoryLotId === charityBag.id)!;
    await moveCharityToSale(db, {
      stockId: charity.id,
      storeId: store!.id,
      expectedVersion: charity.version,
      weightKg: '2.000',
      actorUserId: actor!.id,
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    });
    const moved = (await listStoreSortedStocks(db, store!.id)).find(
      (stock) => stock.id === charity.id,
    )!;
    expect(moved.saleWeightKg).toBe('2.000');
    expect(moved.charityWeightKg).toBe('3.000');
    await exportCharity(db, {
      stockId: charity.id,
      storeId: store!.id,
      expectedVersion: moved.version,
      weightKg: '3.000',
      actorUserId: actor!.id,
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    });
    const finished = (await listStoreSortedStocks(db, store!.id)).find(
      (stock) => stock.id === charity.id,
    )!;
    expect(finished.charityWeightKg).toBe('0.000');
    const progress = await db
      .select()
      .from(storeSaleSyncProgress)
      .where(eq(storeSaleSyncProgress.storeId, store!.id));
    expect(
      progress
        .filter((row) => row.appliedGrams > 0n)
        .map((row) => row.appliedGrams)
        .sort(),
    ).toEqual([6_000n, 9_000n]);
    const events = await db
      .select()
      .from(storeSortingEvents)
      .where(eq(storeSortingEvents.storeId, store!.id));
    expect(events.filter((event) => event.action === 'idosi_sale_piece')).toHaveLength(1);
    expect(events.filter((event) => event.action === 'idosi_sale_correction')).toHaveLength(1);
    const previousPeriod = new Date(
      Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 2, 1),
    )
      .toISOString()
      .slice(0, 7);
    await saveSnapshot(100, 0, 4, previousPeriod);
    const afterHistorySync = await listStoreSortedStocks(db, store!.id);
    expect(
      afterHistorySync.find((stock) => stock.inventoryLotId === maleBag.id)?.saleWeightKg,
    ).toBe('24.000');
  });
});
