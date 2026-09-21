import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { formatInboundReceiptNumber } from '@idosi/contracts';
import { afterAll, describe, expect, it } from 'vitest';

import {
  auditLogs,
  calculateWeightedCostVnd,
  cancelSupplierInbound,
  updateSupplierInboundVat,
  receiptCosts,
  closeDatabase,
  confirmSupplierInboundCosts,
  db,
  loadWarehouseBalancesAt,
  products,
  receiptBagWeights,
  receiptItems,
  receipts,
  receiveSupplierInbound,
  SupplierInboundAuthorizationError,
  users,
  warehouseBalances,
  warehouseLedgerEntries,
  withTransaction,
} from '../src/index.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('supplier inbound PostgreSQL lifecycle', () => {
  afterAll(async () => closeDatabase());

  it('skips generated numbers already claimed by a legacy client', async () => {
    const fixture = await loadFixture();
    const sequence = await db.execute<{ value: string }>(
      sql`SELECT nextval('supplier_receipt_number_seq')::text AS value`,
    );
    const claimed = formatInboundReceiptNumber(
      (BigInt(sequence.rows[0]!.value) + 1n).toString(),
      new Date(),
    );
    const makeInput = (referenceCode: string | undefined) => {
      const key = randomUUID();
      return {
        referenceCode,
        supplierName: 'Legacy numbering',
        receivedAt: new Date(),
        bags: [{ productId: fixture.productId, bagCode: key, weightKg: null }],
        receivedByUserId: fixture.actorId,
        actorRole: 'admin' as const,
        idempotencyKey: key,
        requestHash: key,
      };
    };
    await receiveSupplierInbound(db, makeInput(claimed));
    const result = await receiveSupplierInbound(db, makeInput(undefined));
    if (result.replayed) throw new Error('Expected new receipt');
    const [row] = await db.select().from(receipts).where(eq(receipts.id, result.value.receiptId));
    expect(row!.receiptNumber).not.toBe(claimed);
    expect(row!.receiptNumber).toMatch(/^PN\d{5,}-\d{2}\/\d{2}\/\d{4}$/);
  });

  it('generates distinct PN numbers concurrently and replays without a second receipt', async () => {
    const fixture = await loadFixture();
    const inputs = [1, 2].map(() => {
      const key = randomUUID();
      return {
        referenceCode: undefined,
        supplierName: 'Auto numbered',
        receivedAt: new Date(),
        bags: [1, 2, 3].map((n) => ({
          productId: fixture.productId,
          bagCode: `${key}-${n}`,
          weightKg: null,
        })),
        receivedByUserId: fixture.actorId,
        actorRole: 'admin' as const,
        idempotencyKey: key,
        requestHash: key,
      };
    });
    const results = await Promise.all(inputs.map((input) => receiveSupplierInbound(db, input)));
    const numbers: string[] = [];
    for (const [index, result] of results.entries()) {
      if (result.replayed) throw new Error('Expected new receipt');
      const [row] = await db.select().from(receipts).where(eq(receipts.id, result.value.receiptId));
      expect(row!.receiptNumber).toMatch(/^PN\d{5,}-\d{2}\/\d{2}\/\d{4}$/);
      numbers.push(row!.receiptNumber);
      const replay = await receiveSupplierInbound(db, inputs[index]!);
      expect(replay.replayed).toBe(true);
      expect(replay.resourceId).toBe(result.value.receiptId);
    }
    expect(new Set(numbers).size).toBe(2);
  });

  it('persists unknown and mixed weights as null totals while counting stock exactly once', async () => {
    const fixture = await loadFixture();
    const before = await balanceFor(fixture.productId);
    const suffix = randomUUID();
    const input = {
      referenceCode: `UNKNOWN-${suffix}`,
      supplierName: 'Supplier',
      receivedAt: new Date(),
      bags: [
        { productId: fixture.productId, bagCode: `UNKNOWN-${suffix}`, weightKg: null },
        { productId: fixture.productId, bagCode: `KNOWN-${suffix}`, weightKg: '2.333' },
      ],
      receivedByUserId: fixture.actorId,
      actorRole: 'admin' as const,
      idempotencyKey: suffix,
      requestHash: suffix,
    };
    const result = await receiveSupplierInbound(db, input);
    if (result.replayed) throw new Error('Expected new receipt');
    expect(result.value.totalWeightKg).toBeNull();
    expect((await receiveSupplierInbound(db, input)).replayed).toBe(true);
    expect((await balanceFor(fixture.productId)).onHandQuantity).toBe(before.onHandQuantity + 2);
    const [item] = await db
      .select()
      .from(receiptItems)
      .where(eq(receiptItems.receiptId, result.value.receiptId));
    expect(item!.totalNetWeightKg).toBeNull();
    const bags = await db
      .select()
      .from(receiptBagWeights)
      .where(eq(receiptBagWeights.receiptItemId, item!.id));
    expect(bags.map((bag) => bag.netWeightKg)).toEqual(expect.arrayContaining([null, '2.333']));
    await expect(
      confirmSupplierInboundCosts(db, {
        receiptId: result.value.receiptId,
        expectedVersion: 0,
        productCosts: [{ productId: fixture.productId, priceVndPerKg: 10000n }],
        transportationFeeVnd: 0n,
        handlingFeeVnd: 0n,
        confirmedByUserId: fixture.actorId,
        actorRole: 'admin',
        idempotencyKey: `cost-${suffix}`,
        requestHash: `cost-${suffix}`,
      }),
    ).rejects.toThrow('khối lượng');
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, result.value.receiptId));
    expect(receipt!.status).toBe('submitted');
    expect(receipt!.version).toBe(0);
    const costInput = {
      receiptId: result.value.receiptId,
      expectedVersion: 0,
      productCosts: [],
      invoiceGoodsCostVnd: 1234567n,
      transportationFeeVnd: 10000n,
      handlingFeeVnd: 5000n,
      confirmedByUserId: fixture.actorId,
      actorRole: 'admin' as const,
      idempotencyKey: `invoice-${suffix}`,
      requestHash: `invoice-${suffix}`,
    };
    const priced = await confirmSupplierInboundCosts(db, costInput);
    if (priced.replayed) throw new Error('Expected new confirmation');
    expect(priced.value.goodsCostVnd).toBe(1234567n);
    expect(priced.value.totalCostVnd).toBeNull();
    expect((await confirmSupplierInboundCosts(db, costInput)).replayed).toBe(true);
    const costs = await db
      .select()
      .from(receiptCosts)
      .where(eq(receiptCosts.receiptId, result.value.receiptId));
    expect(costs.filter((cost) => cost.costType === 'goods')).toEqual([
      expect.objectContaining({ receiptItemId: null, amountVnd: 1234567n }),
    ]);
    expect((await balanceFor(fixture.productId)).onHandQuantity).toBe(before.onHandQuantity + 2);
  });

  it('makes a fresh-database receipt visible to the canonical snapshot projection exactly once', async () => {
    const fixture = await loadFixture();
    const balanceBefore = await balanceFor(fixture.productId);
    const suffix = randomUUID();
    const receivedAt = new Date(Date.now() - 1_000);
    const input = {
      referenceCode: `IN-${suffix}`,
      supplierName: 'Nhà cung cấp integration',
      receivedAt,
      bags: [
        {
          productId: fixture.productId,
          bagCode: `BAG-${suffix}`,
          weightKg: '1.234',
        },
      ],
      receivedByUserId: fixture.actorId,
      actorRole: 'admin' as const,
      idempotencyKey: `receive-${suffix}`,
      requestHash: `hash-${suffix}`,
      requestId: `test-${suffix}`,
    };

    const first = await receiveSupplierInbound(db, input);
    expect(first.replayed).toBe(false);
    if (first.replayed) throw new Error('Expected the first receipt command to execute.');
    expect(first.value.productBalances).toEqual([
      expect.objectContaining({
        productId: fixture.productId,
        receivedQuantity: 1,
        onHandQuantity: balanceBefore.onHandQuantity + 1,
      }),
    ]);

    const replay = await receiveSupplierInbound(db, input);
    expect(replay.replayed).toBe(true);
    expect(replay.resourceId).toBe(first.value.receiptId);
    expect((await balanceFor(fixture.productId)).onHandQuantity).toBe(
      balanceBefore.onHandQuantity + 1,
    );

    const snapshotBalances = await withTransaction(
      db,
      (tx) => loadWarehouseBalancesAt(tx, new Date(Date.now() + 1_000)),
      { accessMode: 'read only' },
    );
    expect(snapshotBalances.find((balance) => balance.productId === fixture.productId)).toEqual(
      expect.objectContaining({
        onHand: balanceBefore.onHandQuantity + 1,
        productId: fixture.productId,
      }),
    );
    const movements = await db
      .select({ id: warehouseLedgerEntries.id })
      .from(warehouseLedgerEntries)
      .where(
        and(
          eq(warehouseLedgerEntries.sourceType, 'supplier_receipt'),
          eq(warehouseLedgerEntries.sourceId, first.value.receiptId),
        ),
      );
    expect(movements).toHaveLength(1);
  });

  it('rejects a mismatched or inactive warehouse actor inside the database boundary', async () => {
    const fixture = await loadFixture();
    const suffix = randomUUID();
    await expect(
      receiveSupplierInbound(db, {
        referenceCode: `FORBIDDEN-${suffix}`,
        supplierName: 'Nhà cung cấp unauthorized',
        receivedAt: new Date(),
        bags: [
          {
            productId: fixture.productId,
            bagCode: `FORBIDDEN-BAG-${suffix}`,
            weightKg: '1.000',
          },
        ],
        receivedByUserId: fixture.actorId,
        actorRole: 'htkd',
        idempotencyKey: `forbidden-${suffix}`,
        requestHash: `forbidden-hash-${suffix}`,
      }),
    ).rejects.toBeInstanceOf(SupplierInboundAuthorizationError);
  });

  it('confirms exact per-bag VND costs with a version check and immutable audit evidence', async () => {
    const fixture = await loadFixture();
    const suffix = randomUUID();
    const received = await receiveSupplierInbound(db, {
      referenceCode: `COST-${suffix}`,
      supplierName: 'Nhà cung cấp cost',
      vat: { amountVnd: 1_000_000n, ratePercent: 8 },
      receivedAt: new Date(),
      bags: [
        {
          productId: fixture.productId,
          bagCode: `COST-BAG-${suffix}`,
          weightKg: '1.234',
        },
      ],
      receivedByUserId: fixture.actorId,
      actorRole: 'admin',
      idempotencyKey: `receive-cost-${suffix}`,
      requestHash: `receive-cost-hash-${suffix}`,
    });
    if (received.replayed) throw new Error('Expected a new supplier receipt.');

    const priceVndPerKg = 10_001n;
    const goodsCostVnd = calculateWeightedCostVnd('1.234', priceVndPerKg);
    const confirmed = await confirmSupplierInboundCosts(db, {
      receiptId: received.value.receiptId,
      expectedVersion: received.value.version,
      productCosts: [{ productId: fixture.productId, priceVndPerKg }],
      transportationFeeVnd: 100_000n,
      handlingFeeVnd: 20_000n,
      confirmedByUserId: fixture.actorId,
      actorRole: 'admin',
      idempotencyKey: `confirm-cost-${suffix}`,
      requestHash: `confirm-cost-hash-${suffix}`,
      requestId: `confirm-test-${suffix}`,
    });
    expect(confirmed.replayed).toBe(false);
    if (confirmed.replayed) throw new Error('Expected cost confirmation to execute.');
    expect(confirmed.value).toMatchObject({
      goodsCostVnd,
      totalCostVnd: goodsCostVnd + 1_120_000n,
      version: received.value.version + 1,
    });

    const [persisted] = await db
      .select({
        status: receipts.status,
        version: receipts.version,
        goodsCostVnd: receipts.totalGoodsCostVnd,
        shippingCostVnd: receipts.totalShippingCostVnd,
        handlingCostVnd: receipts.totalHandlingCostVnd,
        vatAmountVnd: receipts.vatAmountVnd,
        vatRatePercent: receipts.vatRatePercent,
        bagCostVnd: receiptBagWeights.goodsCostVnd,
      })
      .from(receipts)
      .innerJoin(receiptItems, eq(receiptItems.receiptId, receipts.id))
      .innerJoin(receiptBagWeights, eq(receiptBagWeights.receiptItemId, receiptItems.id))
      .where(eq(receipts.id, received.value.receiptId));
    expect(persisted).toMatchObject({
      status: 'confirmed',
      version: received.value.version + 1,
      goodsCostVnd,
      shippingCostVnd: 100_000n,
      handlingCostVnd: 20_000n,
      vatAmountVnd: 1_000_000n,
      vatRatePercent: 8,
      bagCostVnd: goodsCostVnd,
    });
    const [audit] = await db
      .select({ action: auditLogs.action, after: auditLogs.after })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, received.value.receiptId),
          eq(auditLogs.action, 'SUPPLIER_INBOUND_COST_CONFIRMED'),
        ),
      );
    expect(audit?.after).toMatchObject({ goodsCostVnd: goodsCostVnd.toString() });
  });

  it('adds deferred VAT after confirmation with optimistic locking, replay and no stock mutation', async () => {
    const fixture = await loadFixture();
    const suffix = randomUUID();
    const received = await receiveSupplierInbound(db, {
      referenceCode: `VAT-LATER-${suffix}`,
      supplierName: 'VAT test',
      receivedAt: new Date(),
      bags: [{ productId: fixture.productId, bagCode: `VAT-${suffix}`, weightKg: '2.000' }],
      receivedByUserId: fixture.actorId,
      actorRole: 'admin',
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    });
    if (received.replayed) throw new Error('Unexpected replay');
    const receiptId = received.value.receiptId;
    const unknownVatConfirmation = await confirmSupplierInboundCosts(db, {
      receiptId,
      expectedVersion: 0,
      productCosts: [{ productId: fixture.productId, priceVndPerKg: 1000n }],
      transportationFeeVnd: 0n,
      handlingFeeVnd: 0n,
      confirmedByUserId: fixture.actorId,
      actorRole: 'admin',
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    });
    const before = await balanceFor(fixture.productId);
    expect(unknownVatConfirmation.replayed).toBe(false);
    if (!unknownVatConfirmation.replayed) {
      expect(unknownVatConfirmation.value.totalCostVnd).toBeNull();
    }
    const input = {
      receiptId,
      expectedVersion: 1,
      vat: { amountVnd: 1000000n, ratePercent: 8 as const },
      reason: 'Bổ sung hóa đơn VAT',
      actorUserId: fixture.actorId,
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    };
    const attempts = await Promise.allSettled([
      updateSupplierInboundVat(db, input),
      updateSupplierInboundVat(db, { ...input, idempotencyKey: randomUUID() }),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const [receipt] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(receipt).toMatchObject({
      vatAmountVnd: 1000000n,
      vatRatePercent: 8,
      version: 2,
      status: 'confirmed',
    });
    const costs = await db
      .select()
      .from(receiptCosts)
      .where(and(eq(receiptCosts.receiptId, receiptId), eq(receiptCosts.costType, 'vat')));
    expect(costs).toHaveLength(1);
    expect(costs[0]!.amountVnd).toBe(1000000n);
    const correction = {
      ...input,
      expectedVersion: 2,
      vat: { amountVnd: 0n, ratePercent: 8 as const },
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    };
    await updateSupplierInboundVat(db, correction);
    expect((await updateSupplierInboundVat(db, correction)).replayed).toBe(true);
    expect(await balanceFor(fixture.productId)).toEqual(before);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, receiptId),
          eq(auditLogs.action, 'SUPPLIER_INBOUND_VAT_UPDATED'),
        ),
      );
    expect(audits).toHaveLength(2);
    expect(audits.map((audit) => audit.before)).toContainEqual(
      expect.objectContaining({ amountVnd: null }),
    );
  });

  it('serializes concurrent receipts and reverses only uncommitted pending stock', async () => {
    const fixture = await loadFixture();
    const balanceBefore = await balanceFor(fixture.productId);
    const suffix = randomUUID();
    const command = (sequence: number) =>
      receiveSupplierInbound(db, {
        referenceCode: `CONCURRENT-${sequence}-${suffix}`,
        supplierName: 'Nhà cung cấp concurrent',
        receivedAt: new Date(),
        bags: [
          {
            productId: fixture.productId,
            bagCode: `CONCURRENT-BAG-${sequence}-${suffix}`,
            weightKg: '2.000',
          },
        ],
        receivedByUserId: fixture.actorId,
        actorRole: 'admin' as const,
        idempotencyKey: `concurrent-${sequence}-${suffix}`,
        requestHash: `concurrent-hash-${sequence}-${suffix}`,
      });
    const [first, second] = await Promise.all([command(1), command(2)]);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
    if (first.replayed || second.replayed) throw new Error('Expected two new supplier receipts.');
    expect((await balanceFor(fixture.productId)).onHandQuantity).toBe(
      balanceBefore.onHandQuantity + 2,
    );

    const cancelled = await cancelSupplierInbound(db, {
      receiptId: first.value.receiptId,
      expectedVersion: first.value.version,
      reason: 'Nhà cung cấp giao nhầm lô hàng',
      cancelledByUserId: fixture.actorId,
      actorRole: 'admin',
      idempotencyKey: `cancel-${suffix}`,
      requestHash: `cancel-hash-${suffix}`,
    });
    expect(cancelled.replayed).toBe(false);
    expect((await balanceFor(fixture.productId)).onHandQuantity).toBe(
      balanceBefore.onHandQuantity + 1,
    );
  });
});

async function loadFixture(): Promise<{ actorId: string; productId: string }> {
  const [actor] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active')))
    .limit(1);
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.isActive, true))
    .limit(1);
  if (!actor || !product) {
    throw new Error('PostgreSQL integration fixture requires seeded products and an active admin.');
  }
  return { actorId: actor.id, productId: product.id };
}

async function balanceFor(productId: string) {
  const [balance] = await db
    .select()
    .from(warehouseBalances)
    .where(eq(warehouseBalances.productId, productId));
  if (!balance) throw new Error('Seeded product is missing its warehouse balance.');
  return balance;
}
