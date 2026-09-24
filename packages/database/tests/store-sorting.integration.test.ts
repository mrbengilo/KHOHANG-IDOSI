import { randomUUID } from 'node:crypto';

import { IdosiOrderStatisticsPayloadSchema } from '@idosi/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  createStorePartnerInbound,
  createStoreSorting,
  createCharityExport,
  createSortedSaleTransfer,
  db,
  listCharityExports,
  listStoreSortedStocks,
  listSortedSaleTransfers,
  moveProductCharityToSale,
  products,
  recordIdosiStatisticsSuccess,
  receiveSortedSaleTransfer,
  storeGroups,
  storeInventoryBags,
  storeNormalSaleProgress,
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

/** Regular-price lines are sold by the piece; IDOSI converts them to kg with its norms. */
function normalItem(name: string, kg: number, idosiProductId = name) {
  const bucket = { ...emptyBucket, estimatedKg: kg, knownKg: kg, totalKg: kg };
  return {
    productId: idosiProductId,
    productName: name,
    quantity: kg * 3,
    unit: 'PIECE' as const,
    revenueType: 'NORMAL' as const,
    classification: 'NORMAL' as const,
    orders: 1,
    weight: {
      ...emptyWeight,
      ...bucket,
      byRevenueType: { NORMAL: bucket, SALE_KG: emptyBucket, SALE_PIECE: emptyBucket },
    },
  };
}

function normalPayload(period: string, at: Date, items: ReturnType<typeof normalItem>[]) {
  const base = payload(period, at, 0, 0);
  return IdosiOrderStatisticsPayloadSchema.parse({
    ...base,
    products: { ...base.products, items, productTypes: items.length },
  });
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
        passwordHash: admin?.passwordHash ?? 'test-hash-placeholder-long-enough',
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
    const charityCommand = {
      storeId: store!.id,
      productId: dressProduct.id,
      actorUserId: actor!.id,
      requestHash: randomUUID(),
    };
    await moveProductCharityToSale(db, {
      ...charityCommand,
      weightKg: '2.000',
      idempotencyKey: randomUUID(),
    });
    const moved = (await listStoreSortedStocks(db, store!.id)).find(
      (stock) => stock.id === charity.id,
    )!;
    expect(moved.saleWeightKg).toBe('2.000');
    expect(moved.charityWeightKg).toBe('3.000');
    await expect(
      createCharityExport(db, {
        ...charityCommand,
        bagWeightsKg: ['2.000', '1.001'],
        note: null,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/exceeds the charity stock/u);
    await createCharityExport(db, {
      ...charityCommand,
      bagWeightsKg: ['1', '0.5'],
      note: null,
      idempotencyKey: randomUUID(),
    });
    const partial = (await listStoreSortedStocks(db, store!.id)).find(
      (stock) => stock.id === charity.id,
    )!;
    expect(partial.charityWeightKg).toBe('1.500');
    await createCharityExport(db, {
      ...charityCommand,
      bagWeightsKg: ['1.500'],
      note: null,
      idempotencyKey: randomUUID(),
    });
    const finished = (await listStoreSortedStocks(db, store!.id)).find(
      (stock) => stock.id === charity.id,
    )!;
    expect(finished.charityWeightKg).toBe('0.000');
    const charityExports = await listCharityExports(db, [store!.id]);
    expect(
      charityExports.map((row) => [row.bagQuantity, row.weightKg, row.bagWeightsKg]).sort(),
    ).toEqual([
      [1, '1.500', ['1.500']],
      [2, '1.500', ['1.000', '0.500']],
    ]);
    expect(charityExports.every((row) => row.exportNumber.startsWith('PTT-'))).toBe(true);
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

  it('takes regular-price IDOSI sales out of the store bags from the first tracked month', async () => {
    const token = randomUUID().replaceAll('-', '');
    const [group] = await db
      .insert(storeGroups)
      .values({ code: `N${token}`, name: 'Normal sale integration' })
      .returning();
    const [store] = await db
      .insert(stores)
      .values({ groupId: group!.id, code: `N${token}`, name: 'Normal sale store' })
      .returning();
    const [admin] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.role, 'admin'))
      .limit(1);
    const [actor] = await db
      .insert(users)
      .values({
        email: `normal.${token}@example.invalid`,
        displayName: 'Normal sale test',
        role: 'store',
        status: 'active',
        storeId: store!.id,
        passwordHash: admin?.passwordHash ?? 'test-hash-placeholder-long-enough',
      })
      .returning();
    const [dress] = await db.select().from(products).where(eq(products.sku, 'DAM')).limit(1);
    const now = new Date();
    const period = new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 7);
    const save = async (
      dressKg: number | null,
      offsetSeconds: number,
      snapshotPeriod = period,
      idosiName = dress!.name,
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
        payload: normalPayload(
          snapshotPeriod,
          at,
          dressKg === null ? [] : [normalItem(idosiName, dressKg, `IDOSI-${token}`)],
        ),
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
    const inbound = await createStorePartnerInbound(db, {
      storeId: store!.id,
      partnerName: 'Normal sale partner',
      note: null,
      receivedAt: now,
      lines: [{ productId: dress!.id, quantity: 2, bagWeightsKg: ['4.000', '10.000'] }],
      createdByUserId: actor!.id,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    });
    if (inbound.replayed) throw new Error('Unexpected inbound replay');
    // Both bags arrive at the same instant, so only the total left is deterministic.
    const weights = async () =>
      (
        await db.select().from(storeInventoryBags).where(eq(storeInventoryBags.storeId, store!.id))
      ).reduce((total, bag) => total + Math.round(Number(bag.currentWeightKg) * 1000), 0);

    // 3 kg sold before tracking started is the baseline, not a deduction.
    await save(3, 0);
    expect(await weights()).toBe(14_000);
    // 7 kg more leaves the bags; a bag that runs empty is marked depleted.
    await save(10, 1);
    expect(await weights()).toBe(7_000);
    await save(10, 2);
    expect(await weights()).toBe(7_000);
    // IDOSI corrects the month down by 2 kg: the weight goes back to the bags.
    await save(8, 3);
    expect(await weights()).toBe(9_000);
    // IDOSI renames the product; its IDOSI id still points at the same bags.
    await save(9, 4, period, 'Đầm dáng dài');
    expect(await weights()).toBe(8_000);
    // An older month opened for inspection is never charged to today's bags.
    const olderPeriod = new Date(
      Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 3, 1),
    )
      .toISOString()
      .slice(0, 7);
    await save(50, 5, olderPeriod);
    expect(await weights()).toBe(8_000);
    const progress = await db
      .select()
      .from(storeNormalSaleProgress)
      .where(eq(storeNormalSaleProgress.storeId, store!.id));
    expect(progress.map((row) => [row.period, row.baselineGrams, row.appliedGrams])).toEqual([
      [period, 3_000n, 6_000n],
    ]);
  });

  it('transfers sorted bags once and caps later IDOSI corrections at the source', async () => {
    const token = randomUUID().replaceAll('-', '');
    const [group] = await db
      .insert(storeGroups)
      .values({ code: `T${token}`, name: 'Transfer integration' })
      .returning();
    const [source, destination] = await db
      .insert(stores)
      .values([
        { groupId: group!.id, code: `TS${token}`, name: 'Source Sale' },
        { groupId: group!.id, code: `TD${token}`, name: 'Destination Sale' },
      ])
      .returning();
    const [admin] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.role, 'admin'))
      .limit(1);
    const [sourceUser, destinationUser] = await db
      .insert(users)
      .values([
        {
          email: `source.${token}@example.invalid`,
          displayName: 'Source',
          role: 'store',
          status: 'active',
          storeId: source!.id,
          passwordHash: admin?.passwordHash ?? 'test-hash-placeholder-long-enough',
        },
        {
          email: `destination.${token}@example.invalid`,
          displayName: 'Destination',
          role: 'store',
          status: 'active',
          storeId: destination!.id,
          passwordHash: admin?.passwordHash ?? 'test-hash-placeholder-long-enough',
        },
      ])
      .returning();
    const [product] = await db.select().from(products).where(eq(products.sku, 'DO_NAM')).limit(1);
    const now = new Date();
    const period = new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 7);
    const snapshot = async (store: typeof source, pieces: number, offsetSeconds: number) => {
      const at = new Date(now.getTime() + offsetSeconds * 1000);
      await recordIdosiStatisticsSuccess(db, {
        target: { storeId: store!.id, storeCode: store!.code, storeName: store!.name },
        scope: { storeId: store!.id, period, date: null, shiftId: null, paymentMethod: null },
        payload: payload(period, at, pieces, 0),
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
    await snapshot(source, 0, 0);
    await snapshot(destination, 0, 0);
    await createStorePartnerInbound(db, {
      storeId: source!.id,
      partnerName: 'Transfer source',
      note: null,
      receivedAt: now,
      lines: [{ productId: product!.id, quantity: 1, bagWeightsKg: ['9.000'] }],
      createdByUserId: sourceUser!.id,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    });
    const [bag] = await db
      .select()
      .from(storeInventoryBags)
      .where(eq(storeInventoryBags.storeId, source!.id));
    await createStoreSorting(db, {
      storeId: source!.id,
      inventoryBagId: bag!.id,
      expectedInventoryVersion: bag!.version,
      reason: 'SALE',
      weightKg: '9.000',
      actorUserId: sourceUser!.id,
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    });
    const [stock] = await listStoreSortedStocks(db, source!.id);
    expect(stock?.saleWeightKg).toBe('9.000');
    await expect(
      createSortedSaleTransfer(db, {
        sourceStoreId: source!.id,
        destinationStoreId: destination!.id,
        productId: product!.id,
        bagWeightsKg: ['5.000', '4.001'],
        note: null,
        actorUserId: sourceUser!.id,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
      }),
    ).rejects.toThrow(/exceeds the Sale stock/u);
    const command = () =>
      createSortedSaleTransfer(db, {
        sourceStoreId: source!.id,
        destinationStoreId: destination!.id,
        productId: product!.id,
        bagWeightsKg: ['2.5', '3.500'],
        note: null,
        actorUserId: sourceUser!.id,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
      });
    const attempts = await Promise.allSettled([command(), command()]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    const [transfer] = await listSortedSaleTransfers(db, [source!.id]);
    expect([
      transfer?.status,
      transfer?.bagQuantity,
      transfer?.weightKg,
      transfer?.bagWeightsKg,
    ]).toEqual(['in_transit', 2, '6.000', ['2.500', '3.500']]);
    expect(await listStoreSortedStocks(db, destination!.id)).toHaveLength(0);
    const [sourceAfter] = await listStoreSortedStocks(db, source!.id);
    expect(sourceAfter?.saleWeightKg).toBe('3.000');
    await receiveSortedSaleTransfer(db, {
      transferId: transfer!.id,
      expectedVersion: 0,
      actorUserId: destinationUser!.id,
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    });
    const [received] = await listStoreSortedStocks(db, destination!.id);
    expect(received?.saleWeightKg).toBe('6.000');
    await snapshot(source, 9, 1);
    const [sold] = await listStoreSortedStocks(db, source!.id);
    expect(sold?.saleWeightKg).toBe('0.000');
    await snapshot(source, 0, 2);
    const [corrected] = await listStoreSortedStocks(db, source!.id);
    expect(corrected?.saleWeightKg).toBe('3.000');
  });
});
