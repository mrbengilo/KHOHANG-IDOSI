import { randomUUID } from 'node:crypto';

import { IdosiOrderStatisticsPayloadSchema } from '@idosi/contracts';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import {
  auditLogs,
  closeDatabase,
  createStorePartnerInbound,
  db,
  idosiProductLinks,
  loadIdosiProductMatching,
  openStoreInventoryBag,
  products,
  recordIdosiStatisticsSuccess,
  setIdosiProductLink,
  storeGroups,
  storeInventoryBags,
  stores,
  users,
} from '../src/index.js';
import { uniqueProductForName } from '../src/store-sale-sync.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describe('automatic IDOSI product linking', () => {
  const candidate = (id: string, name: string, isActive = true) => ({ id, name, isActive });

  it('links only when exactly one warehouse product carries the name', () => {
    expect(uniqueProductForName([candidate('a', 'Áo nữ')], '  áo   NỮ ')).toBe('a');
    expect(uniqueProductForName([candidate('a', 'Áo nữ'), candidate('b', 'Áo nữ')], 'Áo nữ')).toBe(
      null,
    );
    expect(uniqueProductForName([candidate('a', 'Đầm')], 'Áo nữ')).toBe(null);
  });

  it('prefers the active product and falls back to a single retired one', () => {
    expect(
      uniqueProductForName([candidate('old', 'Áo nữ', false), candidate('new', 'Áo nữ')], 'Áo nữ'),
    ).toBe('new');
    expect(uniqueProductForName([candidate('old', 'Áo nữ', false)], 'Áo nữ')).toBe('old');
    expect(
      uniqueProductForName(
        [candidate('x', 'Áo nữ', false), candidate('y', 'Áo nữ', false)],
        'Áo nữ',
      ),
    ).toBe(null);
  });
});

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
  tableVersion: 'links-integration',
  byRevenueType: { NORMAL: emptyBucket, SALE_KG: emptyBucket, SALE_PIECE: emptyBucket },
};

function normalPayload(period: string, at: Date, idosiId: string, name: string, kg: number) {
  const bucket = { ...emptyBucket, estimatedKg: kg, knownKg: kg, totalKg: kg };
  const item = {
    productId: idosiId,
    productName: name,
    quantity: kg * 5,
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
  return IdosiOrderStatisticsPayloadSchema.parse({
    ok: true,
    apiVersion: 1,
    storeId: 'LINK_TEST',
    store: { id: 'LINK_TEST', name: 'Link test' },
    currency: 'VND',
    timezone: 'Asia/Ho_Chi_Minh',
    revenueBasis: 'ACTIVE_ORDER_AMOUNT',
    generatedAt: at.toISOString(),
    serverTime: at.toISOString(),
    requestId: randomUUID(),
    filters: { period, date: null, shiftId: null, paymentMethod: null },
    totals: {
      orders: 1,
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
      totalQuantity: item.quantity,
      salePieceQuantity: 0,
      totalWeightKg: 0,
      productTypes: 1,
      ordersWithItems: 1,
      unclassifiedOrders: 0,
      items: [item],
      weight: emptyWeight,
      weightByProduct: [],
    },
    groups: { shift: [], day: [], month: [] },
  });
}

describePostgres('IDOSI product links in PostgreSQL', () => {
  afterAll(() => closeDatabase());

  it('never charges an ambiguous name, and charges the product an Admin links', async () => {
    const token = randomUUID().replaceAll('-', '');
    const name = `Áo liên kết ${token.slice(0, 8)}`;
    const idosiId = `IDOSI-LINK-${token}`;
    const [first, second] = await db
      .insert(products)
      .values([
        { sku: `L1${token}`, slug: `l1-${token}`, name },
        { sku: `L2${token}`, slug: `l2-${token}`, name },
      ])
      .returning();
    const [group] = await db
      .insert(storeGroups)
      .values({ code: `L${token}`, name: 'Link integration' })
      .returning();
    const [store] = await db
      .insert(stores)
      .values({ groupId: group!.id, code: `L${token}`, name: 'Link store' })
      .returning();
    const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
    const [actor] = await db
      .insert(users)
      .values({
        email: `link.${token}@example.invalid`,
        displayName: 'Link test',
        role: 'store',
        status: 'active',
        storeId: store!.id,
        passwordHash: admin?.passwordHash ?? 'test-hash-placeholder-long-enough',
      })
      .returning();
    const inbound = await createStorePartnerInbound(db, {
      storeId: store!.id,
      partnerName: 'Link partner',
      note: null,
      receivedAt: new Date(),
      lines: [
        { productId: first!.id, quantity: 1, bagWeightsKg: ['20.000'] },
        { productId: second!.id, quantity: 1, bagWeightsKg: ['20.000'] },
      ],
      createdByUserId: actor!.id,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    });
    if (inbound.replayed) throw new Error('Unexpected inbound replay');
    const bags = await db
      .select()
      .from(storeInventoryBags)
      .where(eq(storeInventoryBags.storeId, store!.id));
    for (const bag of bags) {
      await openStoreInventoryBag(db, {
        bagId: bag.id,
        storeId: store!.id,
        expectedVersion: bag.version,
        actorUserId: actor!.id,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
        requestId: randomUUID(),
      });
    }
    const now = new Date();
    const period = new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 7);
    const sync = async (kg: number, offsetSeconds: number) => {
      const at = new Date(now.getTime() + offsetSeconds * 1000);
      await recordIdosiStatisticsSuccess(db, {
        target: { storeId: store!.id, storeCode: store!.code, storeName: store!.name },
        scope: { storeId: store!.id, period, date: null, shiftId: null, paymentMethod: null },
        payload: normalPayload(period, at, idosiId, name, kg),
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
    const weightOf = async (productId: string) => {
      const [bag] = await db
        .select()
        .from(storeInventoryBags)
        .where(
          and(
            eq(storeInventoryBags.storeId, store!.id),
            eq(storeInventoryBags.productId, productId),
          ),
        );
      return bag!.currentWeightKg;
    };

    // Two warehouse products share the name: nothing is linked and no bag is charged.
    await sync(5, 0);
    await sync(8, 1);
    expect(
      await db
        .select()
        .from(idosiProductLinks)
        .where(eq(idosiProductLinks.idosiProductId, idosiId)),
    ).toEqual([]);
    expect([await weightOf(first!.id), await weightOf(second!.id)]).toEqual(['20.000', '20.000']);
    const matching = await loadIdosiProductMatching(db, period);
    expect(matching.unmatched.find((item) => item.idosiProductId === idosiId)).toMatchObject({
      reason: 'AMBIGUOUS',
      storeCount: 1,
    });
    expect(
      [
        ...matching.unmatched.find((item) => item.idosiProductId === idosiId)!.candidateProductIds,
      ].sort(),
    ).toEqual([first!.id, second!.id].sort());

    // The Admin decides; the decision is audited and the next syncs charge that product only.
    const linked = await setIdosiProductLink(db, {
      idosiProductId: idosiId,
      idosiProductName: name,
      productId: second!.id,
      reason: 'Hai mặt hàng trùng tên, chọn mặt hàng đang bán',
      actorUserId: admin!.id,
      requestId: randomUUID(),
      ipAddress: null,
      userAgent: null,
    });
    expect(linked).toMatchObject({ productId: second!.id, firstSeenName: name });
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'IDOSI_PRODUCT_LINK_CREATED'))
      .orderBy(auditLogs.createdAt);
    expect(audit).toBeDefined();
    await sync(8, 2); // tracking starts: the 8 kg already sold are the baseline
    await sync(11, 3); // 3 kg more sold
    expect([await weightOf(first!.id), await weightOf(second!.id)]).toEqual(['20.000', '17.000']);
    expect(
      (await loadIdosiProductMatching(db, period)).unmatched.some(
        (item) => item.idosiProductId === idosiId,
      ),
    ).toBe(false);
  });
});
