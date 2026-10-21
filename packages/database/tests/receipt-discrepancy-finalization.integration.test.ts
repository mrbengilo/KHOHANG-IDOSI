import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyWarehouseMovement,
  auditLogs,
  cancelWaitTicket,
  closeDatabase,
  db,
  declareStoreReceipt,
  finalizeStoreReceipt,
  finalizeStoreReceiptInTransaction,
  operationalSettingsVersions,
  storeInventoryBags,
  storeReceipts,
  submitStoreReceipt,
  supplierSourceProducts,
  waitTickets,
  warehouseShortageChecks,
  withSerializableTransaction,
} from '../src/index.js';
import {
  activeHeld,
  balanceOf,
  createProduct,
  ledgerTotals,
  openingStock,
  publishPendingResult,
  respond,
} from './fixtures/reshare.js';
import {
  createSupplierFixture,
  mapProduct,
  observe,
  type SupplierFixture,
} from './fixtures/supplier.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

/**
 * A receipt with a discrepancy (excess, shortage or a wrong SKU: one short, another excess) is
 * finalized by HTKD with prices and fees. The database trigger must accept every state the
 * application legitimately writes, and keep rejecting the ones it never writes.
 */
describePostgres('finalizing a receipt with a declared discrepancy', () => {
  let fx: SupplierFixture;

  beforeAll(async () => {
    fx = await createSupplierFixture();
  });
  afterAll(async () => {
    await closeDatabase();
  });

  async function expectLedgerConsistent(productId: string) {
    expect(await balanceOf(productId)).toEqual(await ledgerTotals(productId));
    expect((await balanceOf(productId)).reserved).toBe(await activeHeld(productId));
  }

  /** A reconciled SKU: mapped to the Reshare source with a confirmed baseline. */
  async function reconciledProduct(name: string, stock: number) {
    const product = await createProduct(name);
    await openingStock(product, stock);
    await mapProduct(fx, product);
    await observe(fx, [{ productId: product, observedQuantity: stock }]);
    const [mapping] = await db
      .select({ status: supplierSourceProducts.status })
      .from(supplierSourceProducts)
      .where(eq(supplierSourceProducts.productId, product));
    expect(mapping!.status).toBe('active');
    return product;
  }

  /** Accepted RE shipment of `granted` bags of `product`, declared and submitted by the store. */
  async function submittedReceipt(input: {
    readonly product: string;
    readonly granted: number;
    readonly received: number;
    readonly excess?: readonly { readonly productId: string; readonly quantity: number }[];
  }) {
    const result = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId: input.product, quantity: input.granted }],
    });
    await respond(result.decisionId, fx.storeUserA, 'ACCEPT');
    const token = randomUUID();
    const lines = [
      {
        productId: input.product,
        approvedQuantity: input.granted,
        receivedQuantity: input.received,
      },
    ];
    const unexpectedItems = input.excess ?? [];
    const discrepancyNote = 'Khui bao thấy sai lệch so với phiếu';
    const declared = await declareStoreReceipt(db, {
      outboundRequestId: result.outboundId!,
      storeId: fx.storeA,
      declaredByUserId: fx.storeUserA,
      lines,
      unexpectedItems,
      discrepancyNote,
      idempotencyKey: `declare-${token}`,
      requestHash: `declare-${token}`,
    });
    if (declared.replayed) throw new Error('Unexpected declaration replay.');
    const submitted = await submitStoreReceipt(db, {
      receiptId: declared.value.receiptId,
      expectedVersion: declared.value.version,
      submittedByUserId: fx.storeUserA,
      lines,
      unexpectedItems,
      discrepancyNote,
      idempotencyKey: `submit-${token}`,
      requestHash: `submit-${token}`,
    });
    if (submitted.replayed) throw new Error('Unexpected submission replay.');
    const vatVersion = Math.max(
      ...(await db.select().from(operationalSettingsVersions)).map((row) => row.version),
    );
    return {
      receiptId: declared.value.receiptId,
      finalizeInput: {
        receiptId: declared.value.receiptId,
        expectedVersion: submitted.value.version,
        reviewedByUserId: fx.htkdId,
        freightVnd: 120_000n,
        handlingVnd: 30_000n,
        expectedVatSettingsVersion: vatVersion,
        lines: [
          {
            productId: input.product,
            pricePerKgVnd: input.received > 0 ? 50_000n : null,
            bagWeightsKg: Array.from({ length: input.received }, () => '10.000'),
          },
        ],
        unexpectedItems: unexpectedItems.map((item) => ({
          productId: item.productId,
          pricePerKgVnd: 40_000n,
          bagWeightsKg: Array.from({ length: item.quantity }, () => '5.000'),
        })),
      },
    };
  }

  async function finalize(input: Awaited<ReturnType<typeof submittedReceipt>>['finalizeInput']) {
    const key = randomUUID();
    return finalizeStoreReceipt(db, { ...input, idempotencyKey: key, requestHash: key });
  }

  async function receiptOf(receiptId: string) {
    const [receipt] = await db.select().from(storeReceipts).where(eq(storeReceipts.id, receiptId));
    return receipt!;
  }

  async function waitsOf(productId: string) {
    return db
      .select()
      .from(waitTickets)
      .where(and(eq(waitTickets.storeId, fx.storeA), eq(waitTickets.productId, productId)));
  }

  it('books excess of a Reshare-reconciled SKU without deducting A and flags it for observation', async () => {
    const kids = await createProduct('Trẻ em');
    await openingStock(kids, 10);
    const coat = await reconciledProduct('Áo khoác', 10);
    const blanket = await reconciledProduct('Chăn ga', 10);
    const receipt = await submittedReceipt({
      product: kids,
      granted: 2,
      received: 2,
      excess: [
        { productId: coat, quantity: 1 },
        { productId: blanket, quantity: 2 },
      ],
    });

    await finalize(receipt.finalizeInput);

    const finalized = await receiptOf(receipt.receiptId);
    expect(finalized.status).toBe('finalized');
    // 2 × 10 kg × 50,000 + 3 × 5 kg × 40,000; fees stay out of goods cost.
    expect(finalized.goodsCostVnd).toBe(1_600_000n);
    expect(finalized.totalCostVnd).toBe(1_750_000n);
    for (const [product, bags] of [
      [coat, 1],
      [blanket, 2],
    ] as const) {
      // B already counted the bags: A neither deducts nor holds them.
      expect(await balanceOf(product)).toEqual({ onHand: 10, reserved: 0 });
      await expectLedgerConsistent(product);
      const [mapping] = await db
        .select({ status: supplierSourceProducts.status })
        .from(supplierSourceProducts)
        .where(eq(supplierSourceProducts.productId, product));
      expect(mapping!.status).toBe('needs_reconciliation');
      const storeBags = await db
        .select()
        .from(storeInventoryBags)
        .where(eq(storeInventoryBags.productId, product));
      expect(storeBags).toHaveLength(bags);
    }
    expect(await balanceOf(kids)).toEqual({ onHand: 8, reserved: 0 });
    await expectLedgerConsistent(kids);
  });

  it('wrong SKU on a reconciled pair: shortage queued once, excess booked without double deduction', async () => {
    const dress = await reconciledProduct('Đầm', 10);
    const jeans = await reconciledProduct('Quần Jeans', 10);
    const receipt = await submittedReceipt({
      product: dress,
      granted: 2,
      received: 1,
      excess: [{ productId: jeans, quantity: 1 }],
    });

    await finalize(receipt.finalizeInput);

    expect((await receiptOf(receipt.receiptId)).status).toBe('finalized');
    const active = (await waitsOf(dress)).filter((wait) => wait.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ priorityLevel: 'P0B', remainingQuantity: 1 });
    const [check] = await db
      .select()
      .from(warehouseShortageChecks)
      .where(eq(warehouseShortageChecks.storeReceiptId, receipt.receiptId));
    expect(check).toMatchObject({ stockMode: 'issued', quantity: 1, status: 'pending' });
    expect(await balanceOf(jeans)).toEqual({ onHand: 10, reserved: 0 });
    await expectLedgerConsistent(dress);
    await expectLedgerConsistent(jeans);
  });

  it('still deducts excess of an unreconciled SKU from A exactly once', async () => {
    const kids = await createProduct('Trẻ em');
    const shoes = await createProduct('Giày dép');
    await openingStock(kids, 10);
    await openingStock(shoes, 10);
    const receipt = await submittedReceipt({
      product: kids,
      granted: 1,
      received: 1,
      excess: [{ productId: shoes, quantity: 2 }],
    });

    await finalize(receipt.finalizeInput);

    expect(await balanceOf(shoes)).toEqual({ onHand: 8, reserved: 0 });
    await expectLedgerConsistent(shoes);
    const flagged = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, receipt.receiptId),
          eq(auditLogs.action, 'SUPPLIER_RECEIPT_EXCESS_NEEDS_RECONCILIATION'),
        ),
      );
    expect(flagged).toEqual([]);
  });

  it('finalizes a shortage whose wait the store cancelled before HTKD review, without reviving it', async () => {
    const kids = await createProduct('Trẻ em');
    await openingStock(kids, 10);
    const receipt = await submittedReceipt({ product: kids, granted: 1, received: 0 });
    const [queued] = (await waitsOf(kids)).filter((wait) => wait.status === 'active');
    expect(queued).toMatchObject({ priorityLevel: 'P0B', remainingQuantity: 1 });
    await cancelWaitTicket(db, {
      waitTicketId: queued!.id,
      actorUserId: fx.storeUserA,
      reason: 'Cửa hàng không cần nữa',
      idempotencyKey: randomUUID(),
      requestHash: 'cancel-shortage-wait',
    });

    await finalize(receipt.finalizeInput);

    expect((await receiptOf(receipt.receiptId)).status).toBe('finalized');
    // Cancelled demand stays cancelled: finalizing never queues the shortage a second time.
    expect((await waitsOf(kids)).map((wait) => wait.status)).toEqual(['cancelled']);
    await expectLedgerConsistent(kids);
  });

  it('finalizes a shortage whose wait was already allocated before HTKD review', async () => {
    const kids = await createProduct('Trẻ em');
    await openingStock(kids, 10);
    const receipt = await submittedReceipt({ product: kids, granted: 2, received: 1 });
    const [queued] = (await waitsOf(kids)).filter((wait) => wait.status === 'active');
    // The next run served the whole wait (its own result and shipment are out of this test).
    await db
      .update(waitTickets)
      .set({
        status: 'fulfilled',
        remainingQuantity: 0,
        fulfilledQuantity: queued!.originalQuantity,
        resolvedAt: new Date(),
      })
      .where(eq(waitTickets.id, queued!.id));

    await finalize(receipt.finalizeInput);

    expect((await receiptOf(receipt.receiptId)).status).toBe('finalized');
    expect((await waitsOf(kids)).map((wait) => wait.status)).toEqual(['fulfilled']);
    await expectLedgerConsistent(kids);
  });

  it('still rejects a reconciled excess that was also deducted from A', async () => {
    const kids = await createProduct('Trẻ em');
    await openingStock(kids, 10);
    const coat = await reconciledProduct('Áo khoác', 10);
    const receipt = await submittedReceipt({
      product: kids,
      granted: 1,
      received: 1,
      excess: [{ productId: coat, quantity: 1 }],
    });

    await expect(
      withSerializableTransaction(db, async (tx) => {
        await applyWarehouseMovement(tx, {
          productId: coat,
          eventType: 'outbound',
          onHandDelta: -1,
          reservedDelta: 0,
          sourceType: 'store_receipt_excess',
          sourceId: receipt.receiptId,
        });
        await finalizeStoreReceiptInTransaction(tx, receipt.finalizeInput);
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: '23514' }),
    });
    expect((await receiptOf(receipt.receiptId)).status).toBe('pending_htkd');
  });

  it('still rejects a shortage that never reached the store waitlist', async () => {
    const kids = await createProduct('Trẻ em');
    await openingStock(kids, 10);
    const receipt = await submittedReceipt({ product: kids, granted: 1, received: 0 });

    await expect(
      withSerializableTransaction(db, async (tx) => {
        await tx
          .update(waitTickets)
          .set({ deletedAt: new Date() })
          .where(and(eq(waitTickets.storeId, fx.storeA), eq(waitTickets.productId, kids)));
        await finalizeStoreReceiptInTransaction(tx, receipt.finalizeInput);
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: '23514' }),
    });
    expect((await receiptOf(receipt.receiptId)).status).toBe('pending_htkd');
  });
});
