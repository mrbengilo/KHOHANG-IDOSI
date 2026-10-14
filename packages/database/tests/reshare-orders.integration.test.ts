import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AllocationDecisionActionRetiredError,
  cancelWaitTicket,
  waitTickets,
  AllocationDecisionConflictError,
  AllocationDecisionForbiddenError,
  allocationResultDecisions,
  auditLogs,
  closeDatabase,
  db,
  htkdAssignments,
  listReshareOrderHistory,
  loadSupplierProductFacts,
  outboundRequests,
  previewSupplierStockObservation,
  confirmSupplierStockObservation,
  reservations,
  reshareOrderLines,
  reshareOrderSources,
  reshareOrders,
  ReshareOrderStockError,
  resolveWarehouseShortageCheck,
  storeInventoryBags,
  stores,
  users,
  warehouseLedgerEntries,
  warehouseShortageChecks,
  withSerializableTransaction,
  applyWarehouseMovement,
} from '../src/index.js';
import {
  activeHeld,
  balanceOf,
  createProduct,
  ledgerTotals,
  openingStock,
  publishPendingResult,
  receive,
  respond,
} from './fixtures/reshare.js';
import { createSupplierFixture, mapProduct, type SupplierFixture } from './fixtures/supplier.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('RE orders issue accepted goods out of the central warehouse', () => {
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

  async function storeBags(productId: string) {
    return db.select().from(storeInventoryBags).where(eq(storeInventoryBags.productId, productId));
  }

  async function orderOf(decisionId: string) {
    const [order] = await db
      .select()
      .from(reshareOrders)
      .where(eq(reshareOrders.allocationDecisionId, decisionId));
    return order ?? null;
  }

  it('10/4/6: accepting creates one RE, issues 4 at once, and a full receipt does not deduct again', async () => {
    const product = await createProduct('Quần dài nữ');
    await openingStock(product, 10);
    const result = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId: product, quantity: 4 }],
    });
    expect(await balanceOf(product)).toEqual({ onHand: 10, reserved: 4 });
    expect(await orderOf(result.decisionId)).toBeNull();

    const accepted = await respond(result.decisionId, fx.storeUserA, 'ACCEPT');
    if (accepted.replayed) throw new Error('unexpected replay');
    expect(accepted.value.reshareOrderCode).toMatch(/^RE-\d{6}$/u);
    expect(await balanceOf(product)).toEqual({ onHand: 6, reserved: 0 });
    // The store's stock does not grow before its receipt.
    expect(await storeBags(product)).toEqual([]);

    const order = await orderOf(result.decisionId);
    expect(order).toMatchObject({
      code: accepted.value.reshareOrderCode,
      status: 'ordered',
      storeId: fx.storeA,
      totalQuantity: 4,
      actorUserId: fx.storeUserA,
      actorRole: 'store',
    });
    const lines = await db
      .select()
      .from(reshareOrderLines)
      .where(eq(reshareOrderLines.reshareOrderId, order!.id));
    expect(lines).toEqual([expect.objectContaining({ productId: product, quantity: 4 })]);
    const [entry] = await db
      .select()
      .from(warehouseLedgerEntries)
      .where(eq(warehouseLedgerEntries.id, lines[0]!.issueLedgerEntryId));
    expect(entry).toMatchObject({
      sourceType: 'reshare_order',
      sourceId: order!.id,
      onHandDelta: -4,
      reservedDelta: -4,
      reason: `Xuất theo đơn ${order!.code}`,
    });
    const [hold] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, result.reservationIds[0]!));
    expect(hold!.status).toBe('issued');
    const [shipment] = await db
      .select()
      .from(outboundRequests)
      .where(eq(outboundRequests.id, result.outboundId!));
    expect(shipment!.status).toBe('dispatched');
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, order!.id), eq(auditLogs.action, 'RESHARE_ORDER_CREATED')));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: fx.storeUserA, actorRole: 'store' });
    await expectLedgerConsistent(product);

    const receiptId = await receive(fx, {
      outboundId: result.outboundId!,
      storeId: fx.storeA,
      storeUserId: fx.storeUserA,
      lines: [{ productId: product, approvedQuantity: 4, receivedQuantity: 4 }],
    });
    expect(await balanceOf(product)).toEqual({ onHand: 6, reserved: 0 });
    expect(await storeBags(product)).toHaveLength(4);
    expect(
      await db
        .select()
        .from(warehouseLedgerEntries)
        .where(
          and(
            eq(warehouseLedgerEntries.sourceType, 'store_receipt'),
            eq(warehouseLedgerEntries.sourceId, receiptId),
          ),
        ),
    ).toEqual([]);
    const [source] = await db
      .select()
      .from(reshareOrderSources)
      .where(eq(reshareOrderSources.reservationId, result.reservationIds[0]!));
    expect(source).toMatchObject({
      settledStoreReceiptId: receiptId,
      receivedQuantity: 4,
      shortageQuantity: 0,
      shortageCheckId: null,
    });
    const [settledHold] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, result.reservationIds[0]!));
    expect(settledHold).toMatchObject({ status: 'consumed', consumedQuantity: 4 });
    await expectLedgerConsistent(product);
  });

  it('short receipt of issued goods: shortage recorded without holding stock; lost deducts nothing, found comes back once', async () => {
    for (const decision of ['lost', 'returned_to_stock'] as const) {
      const product = await createProduct('Áo');
      await openingStock(product, 10);
      const result = await publishPendingResult(fx, {
        storeId: fx.storeA,
        grants: [{ productId: product, quantity: 4 }],
      });
      await respond(result.decisionId, fx.storeUserA, 'ACCEPT');
      const receiptId = await receive(fx, {
        outboundId: result.outboundId!,
        storeId: fx.storeA,
        storeUserId: fx.storeUserA,
        lines: [{ productId: product, approvedQuantity: 4, receivedQuantity: 3 }],
      });
      expect(await balanceOf(product)).toEqual({ onHand: 6, reserved: 0 });
      expect(await storeBags(product)).toHaveLength(3);
      const [check] = await db
        .select()
        .from(warehouseShortageChecks)
        .where(eq(warehouseShortageChecks.storeReceiptId, receiptId));
      expect(check).toMatchObject({ stockMode: 'issued', quantity: 1, status: 'pending' });
      const [source] = await db
        .select()
        .from(reshareOrderSources)
        .where(eq(reshareOrderSources.reservationId, result.reservationIds[0]!));
      expect(source).toMatchObject({
        receivedQuantity: 3,
        shortageQuantity: 1,
        shortageCheckId: check!.id,
      });
      await expectLedgerConsistent(product);

      await resolveWarehouseShortageCheck(db, {
        checkId: check!.id,
        decision,
        reason: 'Đã kiểm kệ kho',
        expectedVersion: check!.version,
        actorUserId: fx.adminId,
        idempotencyKey: randomUUID(),
        requestHash: decision,
      });
      expect(await balanceOf(product)).toEqual(
        decision === 'lost' ? { onHand: 6, reserved: 0 } : { onHand: 7, reserved: 0 },
      );
      await expectLedgerConsistent(product);
    }
  });

  it('groups several holds of one result into one RE with one line per product and the exact total', async () => {
    const pants = await createProduct('Quần dài nữ');
    const shirt = await createProduct('Áo');
    await openingStock(pants, 20);
    await openingStock(shirt, 20);
    const result = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [
        { productId: pants, quantity: 1 },
        { productId: shirt, quantity: 3 },
        { productId: pants, quantity: 1 },
      ],
    });
    await respond(result.decisionId, fx.storeUserA, 'ACCEPT');
    const order = await orderOf(result.decisionId);
    expect(order!.totalQuantity).toBe(5);
    const lines = await db
      .select()
      .from(reshareOrderLines)
      .where(eq(reshareOrderLines.reshareOrderId, order!.id));
    expect(
      lines
        .map((line) => [line.productId, line.quantity])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual(
      [
        [pants, 2],
        [shirt, 3],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    const sources = await db
      .select()
      .from(reshareOrderSources)
      .where(eq(reshareOrderSources.reshareOrderId, order!.id));
    expect(sources).toHaveLength(3);
    expect(await balanceOf(pants)).toEqual({ onHand: 18, reserved: 0 });
    expect(await balanceOf(shirt)).toEqual({ onHand: 17, reserved: 0 });

    // History: one row, both lines, total once (not multiplied by the number of lines).
    const history = await listReshareOrderHistory(db, {
      page: 1,
      pageSize: 10,
      storeIds: [fx.storeA],
      code: order!.code,
    });
    expect(history.data).toHaveLength(1);
    expect(history.data[0]).toMatchObject({ status: 'ordered', totalQuantity: 5 });
    expect(history.data[0]!.lines).toHaveLength(2);
    // Filtering by one product still returns the whole order and its total.
    const byProduct = await listReshareOrderHistory(db, {
      page: 1,
      pageSize: 10,
      storeIds: [fx.storeA],
      productId: shirt,
      code: order!.code,
    });
    expect(byProduct.data[0]!.lines).toHaveLength(2);
    expect(byProduct.data[0]!.totalQuantity).toBe(5);
  });

  it('two sessions of one store and one session of two stores give separate RE codes; pending shows not ordered', async () => {
    const product = await createProduct('Phiên');
    await openingStock(product, 30);
    const first = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId: product, quantity: 2 }],
    });
    const second = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId: product, quantity: 3 }],
    });
    await respond(first.decisionId, fx.storeUserA, 'ACCEPT');
    await respond(second.decisionId, fx.storeUserA, 'ACCEPT');
    const a = await orderOf(first.decisionId);
    const b = await orderOf(second.decisionId);
    expect(a!.code).not.toBe(b!.code);
    expect(Number(b!.code.slice(3))).toBeGreaterThan(Number(a!.code.slice(3)));

    const pending = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId: product, quantity: 1 }],
    });
    const history = await listReshareOrderHistory(db, {
      page: 1,
      pageSize: 5,
      storeIds: [fx.storeA],
      decisionId: pending.decisionId,
    });
    expect(history.data[0]).toMatchObject({ status: 'not_ordered', order: null, totalQuantity: 1 });
    // Server-side status filter and scope.
    const notOrdered = await listReshareOrderHistory(db, {
      page: 1,
      pageSize: 100,
      storeIds: [fx.storeA],
      status: 'not_ordered',
    });
    expect(notOrdered.data.every((row) => row.order === null)).toBe(true);
    const otherScope = await listReshareOrderHistory(db, {
      page: 1,
      pageSize: 100,
      storeIds: [fx.storeB],
      decisionId: first.decisionId,
    });
    expect(otherScope.data).toEqual([]);
  });

  it('an assigned HTKD may accept (audited as HTKD); nobody may use the retired reject; unassigned, revoked or locked HTKD cannot', async () => {
    const product = await createProduct('HTKD');
    await openingStock(product, 30);
    const forReject = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId: product, quantity: 1 }],
    });
    await expect(respond(forReject.decisionId, fx.htkdId, 'REJECT')).rejects.toBeInstanceOf(
      AllocationDecisionActionRetiredError,
    );
    await expect(respond(forReject.decisionId, fx.otherHtkdId, 'ACCEPT')).rejects.toBeInstanceOf(
      AllocationDecisionForbiddenError,
    );
    await expect(respond(forReject.decisionId, fx.adminId, 'ACCEPT')).rejects.toBeInstanceOf(
      AllocationDecisionForbiddenError,
    );
    const accepted = await respond(forReject.decisionId, fx.htkdId, 'ACCEPT', { key: 'htkd-key' });
    if (accepted.replayed) throw new Error('unexpected replay');
    const order = await orderOf(forReject.decisionId);
    expect(order).toMatchObject({ actorUserId: fx.htkdId, actorRole: 'htkd' });
    const [decision] = await db
      .select()
      .from(allocationResultDecisions)
      .where(eq(allocationResultDecisions.id, forReject.decisionId));
    expect(decision).toMatchObject({ status: 'accepted', respondedByUserId: fx.htkdId });

    // A replay with the same key returns the same answer while the HTKD keeps the right...
    const replay = await respond(forReject.decisionId, fx.htkdId, 'ACCEPT', { key: 'htkd-key' });
    expect(replay.replayed).toBe(true);
    expect(
      await db
        .select({ value: sql<number>`count(*)`.mapWith(Number) })
        .from(reshareOrders)
        .where(eq(reshareOrders.allocationDecisionId, forReject.decisionId)),
    ).toEqual([{ value: 1 }]);
    // ...and is refused once the assignment is revoked.
    await db
      .update(htkdAssignments)
      .set({ revokedAt: new Date() })
      .where(and(eq(htkdAssignments.userId, fx.htkdId), eq(htkdAssignments.storeId, fx.storeA)));
    await expect(
      respond(forReject.decisionId, fx.htkdId, 'ACCEPT', { key: 'htkd-key' }),
    ).rejects.toBeInstanceOf(AllocationDecisionForbiddenError);
    await db.insert(htkdAssignments).values({
      userId: fx.htkdId,
      storeId: fx.storeA,
      assignedByUserId: fx.adminId,
    });

    const locked = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId: product, quantity: 1 }],
    });
    await db.update(users).set({ status: 'locked' }).where(eq(users.id, fx.htkdId));
    try {
      await expect(respond(locked.decisionId, fx.htkdId, 'ACCEPT')).rejects.toBeInstanceOf(
        AllocationDecisionForbiddenError,
      );
    } finally {
      await db.update(users).set({ status: 'active' }).where(eq(users.id, fx.htkdId));
    }
    // Inactive store: nobody answers.
    await db.update(stores).set({ isActive: false }).where(eq(stores.id, fx.storeA));
    try {
      await expect(respond(locked.decisionId, fx.htkdId, 'ACCEPT')).rejects.toBeInstanceOf(
        AllocationDecisionForbiddenError,
      );
    } finally {
      await db.update(stores).set({ isActive: true }).where(eq(stores.id, fx.storeA));
      // Deactivation disabled the store's own account; restore it for the next scenarios.
      await db.update(users).set({ status: 'active' }).where(eq(users.id, fx.storeUserA));
    }
    await expectLedgerConsistent(product);
  });

  it('store and HTKD accepting at once on separate connections: one answer, one RE, one issue', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const product = await createProduct('Race');
      await openingStock(product, 10);
      const result = await publishPendingResult(fx, {
        storeId: fx.storeA,
        grants: [{ productId: product, quantity: 4 }],
      });
      const outcomes = await Promise.allSettled([
        respond(result.decisionId, fx.storeUserA, 'ACCEPT'),
        respond(result.decisionId, fx.htkdId, 'ACCEPT'),
        respond(result.decisionId, fx.storeUserA, 'WAITLIST'),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      for (const outcome of outcomes.filter((row) => row.status === 'rejected')) {
        expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(
          AllocationDecisionConflictError,
        );
      }
      const orders = await db
        .select()
        .from(reshareOrders)
        .where(eq(reshareOrders.allocationDecisionId, result.decisionId));
      const issued = await db
        .select()
        .from(warehouseLedgerEntries)
        .where(
          and(
            eq(warehouseLedgerEntries.productId, product),
            eq(warehouseLedgerEntries.sourceType, 'reshare_order'),
          ),
        );
      const [decision] = await db
        .select()
        .from(allocationResultDecisions)
        .where(eq(allocationResultDecisions.id, result.decisionId));
      if (decision!.status === 'accepted') {
        expect(orders).toHaveLength(1);
        expect(issued).toHaveLength(1);
        expect(await balanceOf(product)).toEqual({ onHand: 6, reserved: 0 });
      } else {
        expect(orders).toHaveLength(0);
        expect(issued).toHaveLength(0);
        expect(await balanceOf(product)).toEqual({ onHand: 10, reserved: 0 });
      }
      await expectLedgerConsistent(product);
    }
  });

  it('rolls the whole acceptance back when the warehouse cannot issue (no partial RE, no gap in codes)', async () => {
    const product = await createProduct('Thiếu');
    await openingStock(product, 5);
    const result = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId: product, quantity: 4 }],
    });
    // Damage the books so the hold is no longer covered by reserved stock.
    await withSerializableTransaction(db, (tx) =>
      applyWarehouseMovement(tx, {
        productId: product,
        eventType: 'reservation_release',
        onHandDelta: 0,
        reservedDelta: -2,
        sourceType: 'reshare_test_damage',
        sourceId: randomUUID(),
      }),
    );
    const [counterBefore] = await db
      .execute<{ last_number: number }>(
        sql`select coalesce((select last_number from document_code_counters where prefix = 'RE'), 0) as last_number`,
      )
      .then((res) => res.rows);
    await expect(respond(result.decisionId, fx.storeUserA, 'ACCEPT')).rejects.toBeInstanceOf(
      ReshareOrderStockError,
    );
    const [decision] = await db
      .select()
      .from(allocationResultDecisions)
      .where(eq(allocationResultDecisions.id, result.decisionId));
    expect(decision!.status).toBe('pending');
    expect(await orderOf(result.decisionId)).toBeNull();
    const [counterAfter] = await db
      .execute<{ last_number: number }>(
        sql`select coalesce((select last_number from document_code_counters where prefix = 'RE'), 0) as last_number`,
      )
      .then((res) => res.rows);
    expect(Number(counterAfter!.last_number)).toBe(Number(counterBefore!.last_number));
    const [hold] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, result.reservationIds[0]!));
    expect(hold!.status).toBe('active');
  });

  it('formats RE codes with six digits and refuses to wrap after RE-999999', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`insert into document_code_counters(prefix, last_number) values ('RE', 999998)
              on conflict (prefix) do update set last_number = 999998`,
        );
        const rows = await tx.execute<{ code: string }>(
          sql`select next_reshare_order_code() as code`,
        );
        expect(rows.rows[0]!.code).toBe('RE-999999');
        await tx.execute(sql`select next_reshare_order_code()`);
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'IDR01' }) });
  });

  it('carries legacy and issued holds on one shipment and deducts only the legacy part at receipt', async () => {
    const product = await createProduct('Ghép');
    await openingStock(product, 20);
    // Held before RE orders existed (legacy result): stays on-hand until receipt.
    const legacy = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId: product, quantity: 2 }],
      shipment: false,
      legacy: true,
    });
    const next = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId: product, quantity: 3 }],
      carry: legacy.reservationIds,
    });
    expect(await balanceOf(product)).toEqual({ onHand: 20, reserved: 5 });
    await respond(next.decisionId, fx.storeUserA, 'ACCEPT');
    expect(await balanceOf(product)).toEqual({ onHand: 17, reserved: 2 });
    const receiptId = await receive(fx, {
      outboundId: next.outboundId!,
      storeId: fx.storeA,
      storeUserId: fx.storeUserA,
      lines: [{ productId: product, approvedQuantity: 5, receivedQuantity: 4 }],
    });
    // Legacy 2 settled first (received 2, deducted now); issued 3 → received 2, short 1.
    expect(await balanceOf(product)).toEqual({ onHand: 15, reserved: 0 });
    const entries = await db
      .select()
      .from(warehouseLedgerEntries)
      .where(
        and(
          eq(warehouseLedgerEntries.sourceType, 'store_receipt'),
          eq(warehouseLedgerEntries.sourceId, receiptId),
        ),
      );
    expect(entries).toEqual([expect.objectContaining({ onHandDelta: -2, reservedDelta: -2 })]);
    const checks = await db
      .select()
      .from(warehouseShortageChecks)
      .where(eq(warehouseShortageChecks.storeReceiptId, receiptId));
    expect(checks).toEqual([expect.objectContaining({ stockMode: 'issued', quantity: 1 })]);
    await expectLedgerConsistent(product);
  });

  it('refuses direct SQL that bypasses the RE document, its ledger entry or its history', async () => {
    const product = await createProduct('Bypass');
    await openingStock(product, 10);
    const result = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId: product, quantity: 2 }],
    });
    // Accepting without an RE order cannot commit.
    await expect(
      db
        .update(allocationResultDecisions)
        .set({
          status: 'accepted',
          version: 2,
          respondedAt: new Date(),
          respondedByUserId: fx.storeUserA,
        })
        .where(eq(allocationResultDecisions.id, result.decisionId)),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'IDR06' }) });
    // Marking a hold issued without its RE source cannot commit.
    await expect(
      db
        .update(reservations)
        .set({ status: 'issued' })
        .where(eq(reservations.id, result.reservationIds[0]!)),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'IDR05' }) });

    await respond(result.decisionId, fx.storeUserA, 'ACCEPT');
    const order = await orderOf(result.decisionId);
    await expect(
      db.delete(reshareOrders).where(eq(reshareOrders.id, order!.id)),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'IDR03' }) });
    await expect(
      db.update(reshareOrders).set({ totalQuantity: 9 }).where(eq(reshareOrders.id, order!.id)),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'IDR03' }) });
    // A hold cannot leave issued without its receipt settlement.
    await expect(
      db
        .update(reservations)
        .set({ status: 'released' })
        .where(eq(reservations.id, result.reservationIds[0]!)),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'IDR05' }) });
    // A second line with a forged ledger entry is refused.
    const [otherEntry] = await db
      .select()
      .from(warehouseLedgerEntries)
      .where(eq(warehouseLedgerEntries.productId, product))
      .limit(1);
    await expect(
      db.insert(reshareOrderLines).values({
        reshareOrderId: order!.id,
        productId: await createProduct('Forged'),
        productNameSnapshot: 'x',
        productSkuSnapshot: 'x',
        quantity: 1,
        issueLedgerEntryId: otherEntry!.id,
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'IDR04' }) });
  });

  it('Reshare SKU: issuing keeps F, a stale observation cannot re-grant, and a declared reflection is not deducted twice', async () => {
    const product = await createProduct('Reshare');
    await mapProduct(fx, product);
    const observeAt = async (quantity: number, reflected: { lineId: string; q: number }[] = []) => {
      const input = {
        actorUserId: fx.adminId,
        sourceId: fx.sourceId,
        observedAt: new Date(),
        lines: [{ productId: product, observedQuantity: quantity }],
        eventCoverage: [],
        attestUnlinkedAsNotOrdered: true,
        reshareCoverage: reflected.map((row) => ({
          reshareOrderLineId: row.lineId,
          quantity: row.q,
        })),
      };
      const preview = await previewSupplierStockObservation(db, input);
      await confirmSupplierStockObservation(db, {
        ...input,
        expectedRevision: preview.revision,
        idempotencyKey: randomUUID(),
        requestHash: JSON.stringify(input.reshareCoverage) + quantity,
      });
      return preview;
    };
    const position = async () =>
      (await withSerializableTransaction(db, (tx) => loadSupplierProductFacts(tx, [product]))).get(
        product,
      )!;
    await observeAt(10);
    const result = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId: product, quantity: 4 }],
    });
    expect((await position()).position).toMatchObject({ freeQuantity: 6 });
    const before = await balanceOf(product);
    await respond(result.decisionId, fx.storeUserA, 'ACCEPT');
    const afterIssue = await position();
    expect(afterIssue.position).toMatchObject({
      freeQuantity: 6,
      issuedUnreflectedQuantity: 4,
      unorderedCommitmentQuantity: 4,
      projectionMismatch: false,
    });
    expect(await balanceOf(product)).toEqual({
      onHand: before.onHand - 4,
      reserved: before.reserved - 4,
    });
    // Observing the same 10 again (Reshare not yet ordered) never frees the 4 again.
    await observeAt(10);
    expect((await position()).position.freeQuantity).toBe(6);
    // Reshare now shows 6 and the person states the RE order is already deducted: F stays 6.
    const lineId = afterIssue.issuedOrders[0]!.lineId;
    const preview = await observeAt(6, [{ lineId, q: 4 }]);
    expect(preview.lines[0]!.issuedOrders[0]).toMatchObject({ declaredReflectedQuantity: 4 });
    const reflected = await position();
    expect(reflected.position).toMatchObject({
      freeQuantity: 6,
      issuedUnreflectedQuantity: 0,
    });
    expect(reflected.issuedOrders).toEqual([]);
    const [line] = await db
      .select()
      .from(reshareOrderLines)
      .where(eq(reshareOrderLines.id, lineId));
    expect(line!.supplierReflectedQuantity).toBe(4);
    // Declaring more than remains is refused.
    await expect(observeAt(6, [{ lineId, q: 1 }])).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await balanceOf(product)).toEqual(await ledgerTotals(product));
  });

  it('receipt sources and the move to waiting never pick up an issued hold twice', async () => {
    const product = await createProduct('Ưu tiên');
    await openingStock(product, 20);
    // Priority-only result accepted without a shipment: issued now, waits for the next order.
    const priority = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId: product, quantity: 2 }],
      shipment: false,
    });
    await respond(priority.decisionId, fx.storeUserA, 'ACCEPT');
    expect(await balanceOf(product)).toEqual({ onHand: 18, reserved: 0 });
    const next = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId: product, quantity: 3 }],
      carry: priority.reservationIds,
    });
    await respond(next.decisionId, fx.storeUserA, 'WAITLIST');
    // Only the new grant went back; the issued 2 stay issued and unlinked for the next order.
    expect(await balanceOf(product)).toEqual({ onHand: 18, reserved: 0 });
    const rows = await db
      .select()
      .from(reservations)
      .where(inArray(reservations.id, priority.reservationIds));
    expect(rows.every((row) => row.status === 'issued' && row.outboundRequestLineId === null)).toBe(
      true,
    );
    expect(await orderOf(next.decisionId)).toBeNull();
    // The 3 bags wait again on a ticket; the store drops that demand before ordering anew
    // (a new order item is refused while an active ticket waits for the same product).
    const [waiting] = await db
      .select({ id: waitTickets.id })
      .from(waitTickets)
      .where(
        and(
          eq(waitTickets.storeId, fx.storeA),
          eq(waitTickets.productId, product),
          eq(waitTickets.status, 'active'),
        ),
      );
    expect(waiting).toBeDefined();
    await cancelWaitTicket(db, {
      waitTicketId: waiting!.id,
      actorUserId: fx.storeUserA,
      reason: 'Đặt lại bằng đơn mới',
      idempotencyKey: randomUUID(),
      requestHash: 'cancel-requeued',
    });
    const third = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId: product, quantity: 1 }],
      carry: priority.reservationIds,
    });
    await respond(third.decisionId, fx.storeUserA, 'ACCEPT');
    // Only the third result's own bag is issued now; the carried 2 keep their first RE.
    expect(await balanceOf(product)).toEqual({ onHand: 17, reserved: 0 });
    await receive(fx, {
      outboundId: third.outboundId!,
      storeId: fx.storeA,
      storeUserId: fx.storeUserA,
      lines: [{ productId: product, approvedQuantity: 3, receivedQuantity: 3 }],
    });
    expect(await balanceOf(product)).toEqual({ onHand: 17, reserved: 0 });
    expect(await storeBags(product)).toHaveLength(3);
    await expectLedgerConsistent(product);
  });
});
