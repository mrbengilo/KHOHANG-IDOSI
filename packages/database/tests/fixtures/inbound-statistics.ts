import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  applyWarehouseMovement,
  storeInventoryLedgerEntries,
  createStorePartnerInbound,
  type Database,
  outboundRequestLines,
  outboundRequests,
  products,
  storeGroups,
  storeInventoryBags,
  storeReceiptBags,
  storeReceiptLines,
  storeReceipts,
  stores,
  users,
} from '../../src/index.js';

/** Test-only source documents. Never invoked by seed or production entry points. */
export async function createInboundStatisticsFixture(db: Database, month = '2026-09') {
  const suffix = randomUUID().replaceAll('-', '');
  const [group] = await db
    .insert(storeGroups)
    .values({ code: `STAT-${suffix}`, name: 'Statistics fixture' })
    .returning();
  const [admin] = await db
    .insert(users)
    .values({
      email: `stat-${suffix}`,
      passwordHash: 'integration-test-placeholder-hash',
      displayName: 'Statistics fixture',
      role: 'admin',
    })
    .returning();
  const storeRows = await db
    .insert(stores)
    .values(
      ['A', 'B', 'C'].map((code, i) => ({
        code: `STAT-${code}-${suffix}`,
        name: `Cửa hàng ${code}`,
        groupId: group!.id,
        kind: i === 2 ? ('wholesale' as const) : ('retail' as const),
      })),
    )
    .returning();
  const productRows = await db
    .insert(products)
    .values(
      ['Đồ nam', 'Đồ nữ', 'Áo vest'].map((name, i) => ({
        sku: `STAT-${i}-${suffix}`,
        slug: `stat-${i}-${suffix}`,
        name: `${name} STAT ${suffix}`,
      })),
    )
    .returning();
  const at = new Date(`${month}-15T05:00:00Z`);
  const receipts: (typeof storeReceipts.$inferSelect)[] = [];
  const bags: (typeof storeReceiptBags.$inferSelect)[] = [];
  const inventory: (typeof storeInventoryBags.$inferSelect)[] = [];
  const lines: (typeof storeReceiptLines.$inferSelect)[] = [];
  const weights = (count: number, kg: number) => {
    const grams = BigInt(Math.round(kg * 1000)),
      base = grams / BigInt(count);
    return Array.from({ length: count }, (_, i) => {
      const weight = base + (i === count - 1 ? grams % BigInt(count) : 0n);
      return `${weight / 1000n}.${String(weight % 1000n).padStart(3, '0')}`;
    });
  };
  async function warehouse(
    storeIndex: number,
    entries: number[][],
    date = at,
    status: 'finalized' | 'draft' = 'finalized',
  ) {
    const store = storeRows[storeIndex]!;
    const [outbound] = await db
      .insert(outboundRequests)
      .values({
        requestNumber: '',
        storeId: store.id,
        status: 'dispatched',
        requestedByUserId: admin!.id,
        dispatchedByUserId: admin!.id,
        dispatchedAt: date,
      })
      .returning();
    const [receipt] = await db
      .insert(storeReceipts)
      .values({
        receiptNumber: `STAT-${randomUUID()}`,
        outboundRequestId: outbound!.id,
        storeId: store.id,
        status: 'draft',
        discrepancyNote: 'Fixture received quantities',
        unexpectedItems: entries
          .filter((entry) => (entry[3] ?? 0) > 0)
          .map((entry) => ({ productId: productRows[entry[0]!]!.id, quantity: entry[3]! })),
        declaredByUserId: admin!.id,
        reviewedByUserId: admin!.id,
        submittedAt: date,
        finalizedAt: status === 'finalized' ? date : null,
      })
      .returning();
    receipts.push(receipt!);
    for (const entry of entries) {
      const [productIndex, count, kg, excess = 0] = entry as [number, number, number, number?];
      const [outLine] =
        count === excess
          ? []
          : await db
              .insert(outboundRequestLines)
              .values({
                outboundRequestId: outbound!.id,
                productId: productRows[productIndex]!.id,
                requestedQuantity: count - excess,
                approvedQuantity: count - excess,
                reservedQuantity: count - excess,
                dispatchedQuantity: count - excess,
                receivedQuantity: count - excess,
              })
              .returning();
      const [line] = await db
        .insert(storeReceiptLines)
        .values({
          storeReceiptId: receipt!.id,
          outboundRequestLineId: outLine?.id ?? null,
          productId: productRows[productIndex]!.id,
          approvedQuantity: count - excess,
          receivedQuantity: count - excess,
          excessQuantity: excess,
          pricePerKgVnd: 0n,
        })
        .returning();
      lines.push(line!);
      const inserted = await db
        .insert(storeReceiptBags)
        .values(
          weights(count, kg).map((weightKg, i) => ({
            storeReceiptLineId: line!.id,
            bagNumber: i + 1,
            bagCode: `STAT-${randomUUID()}`,
            weightKg,
            pricePerKgVnd: 0n,
            goodsCostVnd: 0n,
          })),
        )
        .returning();
      bags.push(...inserted);
      const inventoryRows = await db
        .insert(storeInventoryBags)
        .values(
          inserted.map((bag) => ({
            bagCode: bag.bagCode,
            storeId: store.id,
            productId: line!.productId,
            sourceStoreReceiptBagId: bag.id,
            initialWeightKg: bag.weightKg,
            currentWeightKg: bag.weightKg,
            costVnd: 0n,
            receivedAt: date,
          })),
        )
        .returning();
      inventory.push(...inventoryRows);
      await db.insert(storeInventoryLedgerEntries).values(
        inventoryRows.map((bag) => ({
          storeInventoryBagId: bag.id,
          storeId: store.id,
          productId: bag.productId,
          eventType: 'receive' as const,
          reason: 'Statistics fixture receipt',
          weightBeforeKg: '0.000',
          weightAfterKg: bag.initialWeightKg,
          sourceType: 'store_receipt_bag',
          sourceId: bag.sourceStoreReceiptBagId!,
          actorUserId: admin!.id,
          occurredAt: date,
        })),
      );
      await db.transaction(async (tx) => {
        await applyWarehouseMovement(tx, {
          productId: line!.productId,
          eventType: 'opening_balance',
          onHandDelta: count,
          reservedDelta: count - excess,
          sourceType: 'statistics_fixture',
          sourceId: randomUUID(),
        });
        if (count > excess)
          await applyWarehouseMovement(tx, {
            productId: line!.productId,
            eventType: 'outbound',
            onHandDelta: -(count - excess),
            reservedDelta: -(count - excess),
            sourceType: 'store_receipt',
            sourceId: receipt!.id,
          });
        if (excess > 0)
          await applyWarehouseMovement(tx, {
            productId: line!.productId,
            eventType: 'outbound',
            onHandDelta: -excess,
            reservedDelta: 0,
            sourceType: 'store_receipt_excess',
            sourceId: receipt!.id,
          });
      });
    }
    if (status === 'finalized')
      await db.update(storeReceipts).set({ status }).where(eq(storeReceipts.id, receipt!.id));
    return receipt!;
  }
  async function partner(storeIndex: number, entries: number[][], date = at, key = randomUUID()) {
    return createStorePartnerInbound(db, {
      storeId: storeRows[storeIndex]!.id,
      partnerName: 'Đối tác fixture',
      note: null,
      receivedAt: date,
      lines: entries.map(([productIndex, count, kg]) => ({
        productId: productRows[productIndex!]!.id,
        quantity: count!,
        bagWeightsKg: weights(count!, kg!),
      })),
      createdByUserId: admin!.id,
      requestId: randomUUID(),
      idempotencyKey: key,
      requestHash: key,
    });
  }
  await warehouse(0, [
    [0, 30, 430],
    [1, 19, 125],
    [2, 1, 45],
  ]);
  await warehouse(1, [
    [0, 10, 150],
    [2, 5, 100],
  ]);
  await warehouse(2, [
    [0, 20, 300],
    [1, 10, 200],
  ]);
  await partner(0, [
    [0, 5, 70],
    [1, 3, 30],
  ]);
  await partner(1, [[2, 2, 40]]);
  return {
    stores: storeRows,
    products: productRows,
    admin: admin!,
    at,
    receipts,
    bags,
    inventory,
    lines,
    warehouse,
    partner,
  };
}
