import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  allocationLines,
  allocationRuns,
  applyWarehouseMovement,
  auditLogs,
  closeDatabase,
  dailyPriorityOffers,
  createReceiptAdjustment,
  createReceiptReturn,
  createStoreOutbound,
  db,
  declareStoreReceipt,
  dispatchStrandedAllocationOutbounds,
  finalizeStoreReceipt,
  getReceiptAdjustment,
  getReceiptAdjustmentContext,
  htkdAssignments,
  inventorySnapshots,
  loadMonthlyOperationalReport,
  mergedOrderItems,
  mergedOrders,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  orderSessions,
  outboundRequestLines,
  outboundRequests,
  products,
  receiptAdjustmentMoneySummary,
  receiptShortageEntitlements,
  ReceiptAdjustmentAuthorizationError,
  ReceiptAdjustmentBlockedError,
  reservations,
  resolveWarehouseShortageCheck,
  reviewStoreOutbound,
  storeGroups,
  storeInventoryBags,
  storeInventoryLedgerEntries,
  storeReceiptAdjustments,
  storeReceiptBags,
  storeReceiptLines,
  storeReceiptReturns,
  storeReceipts,
  stores,
  submitStoreReceipt,
  transitionReceiptAdjustment,
  transitionReceiptReturn,
  users,
  waitTickets,
  warehouseBalances,
  warehouseShortageChecks,
  withSerializableTransaction,
  type ReceiptAdjustmentTransitionInput,
  type ReceiptReturnTransitionInput,
} from '../src/index.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

interface Fixture {
  readonly storeId: string;
  readonly dressId: string;
  readonly jeansId: string;
  readonly coatId: string;
  readonly storeUserId: string;
  readonly htkdId: string;
  readonly orderItemId: string;
  readonly receiptId: string;
  readonly bags: readonly { readonly receiptBagId: string; readonly inventoryBagId: string }[];
}

describePostgres('post-finalization receipt discrepancy adjustments', () => {
  const sessionIds: string[] = [];
  let adminId = '';

  beforeAll(async () => {
    let [admin] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active')))
      .limit(1);
    if (!admin) {
      [admin] = await db
        .insert(users)
        .values({
          email: `adjust-admin-${randomUUID()}@example.test`,
          passwordHash: 'integration-test-placeholder-hash',
          displayName: 'Adjustment admin',
          role: 'admin',
        })
        .returning({ id: users.id });
    }
    adminId = admin!.id;
  });

  afterAll(async () => {
    for (const id of sessionIds) {
      await db.update(orderSessions).set({ deletedAt: new Date() }).where(eq(orderSessions.id, id));
    }
    await closeDatabase();
  });

  it('keep branch: 2 dresses + 1 jeans, money changes at apply, one P0B dress wait, jeans sellable', async () => {
    const fx = await createFinalizedReceipt();
    const [target, untouched] = fx.bags;
    const other = await bagRow(untouched!.inventoryBagId);

    const created = await report(fx, [target!], 'keep');
    const reported = await getReceiptAdjustment(db, created);
    expect(reported).toMatchObject({
      status: 'pending_htkd',
      code: expect.stringMatching(/^PSL-/),
    });
    // Only the reported bag is held; the rest keep trading and no money or demand moved yet.
    expect((await bagRow(target!.inventoryBagId)).status).toBe('quarantined');
    expect((await bagRow(untouched!.inventoryBagId)).status).toBe(other.status);
    expect(await activeWaits(fx)).toEqual([]);
    expect((await summary(fx)).effective.goodsVnd).toBe(3_000_000n);

    const verified = await verify(fx, created, 0, { pricePerKgVnd: 40_000n });
    expect(verified.status).toBe('pending_admin');
    const pending = await getReceiptAdjustment(db, created);
    expect(pending?.money.after?.goodsVnd).toBe(2_800_000n);
    expect((await summary(fx)).effective.goodsVnd).toBe(3_000_000n);

    await applyAdjustment(created, 1);
    const applied = await getReceiptAdjustment(db, created);
    expect(applied).toMatchObject({ status: 'applied', appliedSequence: 1 });
    expect(applied?.money).toMatchObject({
      before: expect.objectContaining({ goodsVnd: 3_000_000n }),
      after: expect.objectContaining({ goodsVnd: 2_800_000n }),
    });
    expect((await summary(fx)).effective.goodsVnd).toBe(2_800_000n);
    // The finalized receipt itself is untouched.
    const [receipt] = await db
      .select()
      .from(storeReceipts)
      .where(eq(storeReceipts.id, fx.receiptId));
    expect(receipt).toMatchObject({ goodsCostVnd: 3_000_000n, status: 'finalized' });

    const bag = await bagRow(target!.inventoryBagId);
    expect(bag).toMatchObject({
      productId: fx.jeansId,
      costVnd: 800_000n,
      status: 'available',
      currentWeightKg: '20.000',
    });
    expect(await storeProductWeights(fx)).toEqual({
      [fx.dressId]: 40_000n,
      [fx.jeansId]: 20_000n,
    });
    await expectLedgerMatchesBags(fx);

    const waits = await activeWaits(fx);
    expect(waits).toEqual([
      expect.objectContaining({
        productId: fx.dressId,
        priorityLevel: 'P0B',
        originalQuantity: 1,
        remainingQuantity: 1,
        sourceOrderRequestItemId: fx.orderItemId,
      }),
    ]);
    expect(applied?.lines[0]?.entitlement).toMatchObject({
      waitTicketId: waits[0]!.id,
      waitMode: 'created',
      quantity: 1,
      heldQuantity: 0,
    });

    // Jeans can be sold only now that the hold is gone.
    const outbound = await createStoreOutbound(db, {
      storeId: fx.storeId,
      inventoryBagId: bag.id,
      expectedInventoryVersion: bag.version,
      weightKg: '1.000',
      reason: 'sale_kg',
      revenueVnd: 50_000n,
      createdByUserId: fx.storeUserId,
      idempotencyKey: `sale-${randomUUID()}`,
      requestHash: 'sale',
    });
    expect(outbound.replayed).toBe(false);
  });

  it('return branch: P0B wait at apply, stock leaves store at handover, warehouse only on confirmed receipt', async () => {
    const fx = await createFinalizedReceipt();
    const target = fx.bags[0]!;
    const created = await report(fx, [target], 'return');
    await verify(fx, created, 0, { pricePerKgVnd: 40_000n });
    const jeansBefore = await balance(fx.jeansId);
    await applyAdjustment(created, 1);

    expect(await activeWaits(fx)).toHaveLength(1);
    const bag = await bagRow(target.inventoryBagId);
    expect(bag).toMatchObject({ productId: fx.jeansId, status: 'quarantined' });
    const [returned] = await db
      .select()
      .from(storeReceiptReturns)
      .where(eq(storeReceiptReturns.storeInventoryBagId, bag.id));
    expect(returned).toMatchObject({
      status: 'pending_handover',
      productId: fx.jeansId,
      costVnd: 800_000n,
      code: expect.stringMatching(/^PTH-/),
    });
    expect(await balance(fx.jeansId)).toEqual(jeansBefore);
    await expect(
      createStoreOutbound(db, {
        storeId: fx.storeId,
        inventoryBagId: bag.id,
        expectedInventoryVersion: bag.version,
        weightKg: '1.000',
        reason: 'sale_kg',
        revenueVnd: 1n,
        createdByUserId: fx.storeUserId,
        idempotencyKey: `sale-${randomUUID()}`,
        requestHash: 'sale',
      }),
    ).rejects.toThrow();

    await returnAction(fx.storeUserId, returned!.id, 0, { action: 'HANDOVER' });
    const handedOver = await bagRow(bag.id);
    expect(handedOver).toMatchObject({ status: 'returned', currentWeightKg: '0.000' });
    expect(await balance(fx.jeansId)).toEqual(jeansBefore);
    await expectLedgerMatchesBags(fx);

    // A short arrival never books stock by itself; it opens a reconciliation.
    await returnAction(adminId, returned!.id, 1, {
      action: 'RECEIVE',
      outcome: 'NOT_RECEIVED',
      note: 'Xe về không có bao',
    });
    expect((await returnRow(returned!.id)).status).toBe('disputed');
    expect(await balance(fx.jeansId)).toEqual(jeansBefore);

    const resolveKey = `resolve-${randomUUID()}`;
    const resolve: ReceiptReturnTransitionInput = {
      returnId: returned!.id,
      expectedVersion: 2,
      actorUserId: adminId,
      action: 'RESOLVE',
      outcome: 'RECEIVED',
      note: 'Tìm thấy bao ở xe sau',
      idempotencyKey: resolveKey,
      requestHash: resolveKey,
    };
    const [first, again] = await Promise.all([
      transitionReceiptReturn(db, resolve),
      transitionReceiptReturn(db, resolve),
    ]);
    expect([first.replayed, again.replayed].sort()).toEqual([false, true]);
    expect((await returnRow(returned!.id)).status).toBe('received');
    expect(await balance(fx.jeansId)).toEqual({
      onHand: jeansBefore.onHand + 1,
      reserved: jeansBefore.reserved,
    });
    // The dress right was never touched by the return flow.
    expect(await activeWaits(fx)).toHaveLength(1);
  });

  it('switching keep ↔ return keeps the one dress right and is audited', async () => {
    const fx = await createFinalizedReceipt();
    const target = fx.bags[0]!;
    const created = await report(fx, [target], 'return');
    await verify(fx, created, 0, { pricePerKgVnd: 40_000n });
    await applyAdjustment(created, 1);
    const [pending] = await db
      .select()
      .from(storeReceiptReturns)
      .where(eq(storeReceiptReturns.storeInventoryBagId, target.inventoryBagId));
    await returnAction(fx.storeUserId, pending!.id, 0, {
      action: 'CANCEL',
      note: 'Cửa hàng quyết định giữ bán',
    });
    expect((await bagRow(target.inventoryBagId)).status).toBe('available');

    const adjustment = await getReceiptAdjustment(db, created);
    const key = `return-again-${randomUUID()}`;
    const again = await createReceiptReturn(db, {
      adjustmentId: created,
      adjustmentLineId: adjustment!.lines[0]!.id,
      actorUserId: fx.storeUserId,
      reason: 'Hàng không bán được, trả kho',
      idempotencyKey: key,
      requestHash: key,
    });
    expect(again.replayed).toBe(false);
    expect((await bagRow(target.inventoryBagId)).status).toBe('quarantined');
    const waits = await activeWaits(fx);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ originalQuantity: 1, remainingQuantity: 1 });
    expect(
      await db
        .select({ id: receiptShortageEntitlements.id })
        .from(receiptShortageEntitlements)
        .where(eq(receiptShortageEntitlements.storeReceiptBagId, target.receiptBagId)),
    ).toHaveLength(1);
    const actions = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.entityType, 'store_receipt_return'))
      .orderBy(asc(auditLogs.createdAt));
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining(['STORE_RECEIPT_RETURN_CANCELLED', 'STORE_RECEIPT_RETURN_CREATED']),
    );
  });

  it('concurrent or retried approval applies once: no duplicate stock, money or wait', async () => {
    const fx = await createFinalizedReceipt();
    const created = await report(fx, [fx.bags[0]!], 'keep');
    await verify(fx, created, 0, { pricePerKgVnd: 40_000n });
    const attempts = await Promise.allSettled([
      applyAdjustment(created, 1, 'key-a'),
      applyAdjustment(created, 1, 'key-b'),
      applyAdjustment(created, 1, 'key-c'),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    // Replaying the successful key returns the stored response without writing again.
    const winner = ['key-a', 'key-b', 'key-c'][
      attempts.findIndex((attempt) => attempt.status === 'fulfilled')
    ]!;
    const replay = await applyAdjustment(created, 1, winner);
    expect(replay.replayed).toBe(true);
    expect(await activeWaits(fx)).toHaveLength(1);
    expect((await summary(fx)).effective.goodsVnd).toBe(2_800_000n);
    const moves = await db
      .select({ id: storeInventoryLedgerEntries.id })
      .from(storeInventoryLedgerEntries)
      .where(eq(storeInventoryLedgerEntries.storeInventoryBagId, fx.bags[0]!.inventoryBagId));
    expect(moves).toHaveLength(5); // receive, hold, reclassify out/in, release
    await expect(applyAdjustment(created, 2, 'key-d')).rejects.toThrow();
  });

  it('adjusts twice from the latest effective result without granting the dress twice', async () => {
    const fx = await createFinalizedReceipt();
    const [first, second] = fx.bags;
    const a = await report(fx, [first!], 'keep');
    const b = await report(fx, [second!], 'keep');
    await verify(fx, a, 0, { pricePerKgVnd: 40_000n });
    await verify(fx, b, 0, { pricePerKgVnd: 45_000n });
    await applyAdjustment(a, 1);
    // b was verified against a base that no longer holds: it must be re-verified.
    await expect(applyAdjustment(b, 1)).rejects.toThrow(/xác minh lại/);
    await transition({
      adjustmentId: b,
      expectedVersion: 1,
      actorUserId: adminId,
      action: 'RETURN_TO_VERIFIER',
      note: 'Phiếu đã có điều chỉnh khác',
    });
    await verify(fx, b, 2, { pricePerKgVnd: 45_000n });
    await applyAdjustment(b, 3);
    expect((await summary(fx)).effective.goodsVnd).toBe(2_700_000n);
    expect(await activeWaits(fx)).toEqual([
      expect.objectContaining({ originalQuantity: 2, remainingQuantity: 2, priorityLevel: 'P0B' }),
    ]);
    const sequences = await db
      .select({ sequence: storeReceiptAdjustments.appliedSequence })
      .from(storeReceiptAdjustments)
      .where(eq(storeReceiptAdjustments.storeReceiptId, fx.receiptId))
      .orderBy(asc(storeReceiptAdjustments.appliedSequence));
    expect(sequences.map((row) => row.sequence)).toEqual([1, 2]);

    // Jeans turns out to be a coat: money moves again, no new dress right.
    const c = await report(fx, [first!], 'keep', fx.coatId);
    const cVerified = await verify(fx, c, 0, {
      pricePerKgVnd: 45_000n,
      actualProductId: fx.coatId,
    });
    expect(cVerified.status).toBe('pending_admin');
    await applyAdjustment(c, 1);
    expect((await summary(fx)).effective.goodsVnd).toBe(2_800_000n);
    expect(await activeWaits(fx)).toEqual([expect.objectContaining({ originalQuantity: 2 })]);
    expect((await bagRow(first!.inventoryBagId)).productId).toBe(fx.coatId);
    await expectLedgerMatchesBags(fx);

    // Going back to the approved SKU after its right exists is refused.
    await expect(report(fx, [first!], 'keep', fx.dressId)).rejects.toThrow(/quyền chờ bù/);
  });

  it('merges into an existing active wait and keeps the store visible progress', async () => {
    const fx = await createFinalizedReceipt();
    const [existing] = await db
      .insert(waitTickets)
      .values({
        storeId: fx.storeId,
        productId: fx.dressId,
        sourceOrderRequestItemId: fx.orderItemId,
        status: 'active',
        priorityLevel: 'P2',
        originalQuantity: 2,
        remainingQuantity: 2,
      })
      .returning();
    const created = await report(fx, [fx.bags[0]!], 'keep');
    await verify(fx, created, 0, { pricePerKgVnd: 40_000n });
    await applyAdjustment(created, 1);
    expect(await activeWaits(fx)).toEqual([
      expect.objectContaining({
        id: existing!.id,
        originalQuantity: 3,
        remainingQuantity: 3,
        priorityLevel: 'P0B',
      }),
    ]);
    const record = await getReceiptAdjustment(db, created);
    expect(record?.lines[0]?.entitlement).toMatchObject({ waitMode: 'merged', quantity: 1 });
  });

  it('resupply of the owed dress books stock and money once and settles the right; 3.0M → 2.8M → 3.8M', async () => {
    const fx = await createFinalizedReceipt();
    const created = await report(fx, [fx.bags[0]!], 'keep');
    await verify(fx, created, 0, { pricePerKgVnd: 40_000n });
    await applyAdjustment(created, 1);
    const [wait] = await activeWaits(fx);

    // Allocation of the P0B wait (what the worker does) ships one dress on a new outbound.
    const resupply = await createFinalizedReceipt({
      reuse: fx,
      quantity: 1,
      waitTicketId: wait!.id,
    });
    const record = await getReceiptAdjustment(db, created);
    expect(record?.lines[0]?.entitlement).toMatchObject({ receivedQuantity: 1 });
    const firstMoney = await summary(fx);
    const resupplyMoney = await summary(resupply);
    expect(firstMoney.effective.goodsVnd).toBe(2_800_000n);
    expect(resupplyMoney.effective.goodsVnd).toBe(1_000_000n);
    expect(firstMoney.effective.goodsVnd + resupplyMoney.effective.goodsVnd).toBe(3_800_000n);
    expect(await storeProductWeights(fx)).toEqual({
      [fx.dressId]: 60_000n,
      [fx.jeansId]: 20_000n,
    });
    expect(
      await db
        .select({ status: waitTickets.status })
        .from(waitTickets)
        .where(eq(waitTickets.id, wait!.id)),
    ).toEqual([{ status: 'fulfilled' }]);
  });

  it('blocks application for a partly sold bag, and rejection frees only its own hold', async () => {
    const fx = await createFinalizedReceipt();
    const target = fx.bags[0]!;
    const bag = await bagRow(target.inventoryBagId);
    const sale = await createStoreOutbound(db, {
      storeId: fx.storeId,
      inventoryBagId: bag.id,
      expectedInventoryVersion: bag.version,
      weightKg: '5.000',
      reason: 'sale_kg',
      revenueVnd: 100_000n,
      createdByUserId: fx.storeUserId,
      idempotencyKey: `sale-${randomUUID()}`,
      requestHash: 'sale',
    });
    if (sale.replayed) throw new Error('unexpected replay');
    await reviewStoreOutbound(db, {
      outboundId: sale.value.outboundId,
      expectedVersion: sale.value.version,
      reviewedByUserId: adminId,
      decision: 'approve',
      idempotencyKey: `review-${randomUUID()}`,
      requestHash: 'review',
    });
    const created = await report(fx, [target], 'keep');
    expect((await bagRow(bag.id)).status).toBe('quarantined');
    const context = await getReceiptAdjustmentContext(db, fx.receiptId);
    expect(context?.bags.find((row) => row.receiptBagId === target.receiptBagId)).toMatchObject({
      openAdjustmentId: created,
    });
    await verify(fx, created, 0, { pricePerKgVnd: 40_000n });
    const blocked = await applyAdjustment(created, 1).catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(ReceiptAdjustmentBlockedError);
    expect((blocked as ReceiptAdjustmentBlockedError).blockers[target.receiptBagId]).toEqual([
      'BAG_PARTIALLY_CONSUMED',
      'BAG_SOLD',
    ]);
    expect(await activeWaits(fx)).toEqual([]);
    expect((await summary(fx)).effective.goodsVnd).toBe(3_000_000n);

    await transition({
      adjustmentId: created,
      expectedVersion: 1,
      actorUserId: adminId,
      action: 'REJECT',
      note: 'Cần đối soát giá vốn đã bán thủ công',
    });
    expect((await bagRow(bag.id)).status).toBe('opened');
    expect((await bagRow(fx.bags[1]!.inventoryBagId)).status).toBe('available');
  });

  it('a report racing a sale approval leaves one consistent outcome and a balanced ledger', async () => {
    const fx = await createFinalizedReceipt();
    const target = fx.bags[0]!;
    const bag = await bagRow(target.inventoryBagId);
    const sale = await createStoreOutbound(db, {
      storeId: fx.storeId,
      inventoryBagId: bag.id,
      expectedInventoryVersion: bag.version,
      weightKg: '2.000',
      reason: 'sale_kg',
      revenueVnd: 10_000n,
      createdByUserId: fx.storeUserId,
      idempotencyKey: `sale-${randomUUID()}`,
      requestHash: 'sale',
    });
    if (sale.replayed) throw new Error('unexpected replay');
    const [reported, approved] = await Promise.allSettled([
      report(fx, [target], 'keep'),
      reviewStoreOutbound(db, {
        outboundId: sale.value.outboundId,
        expectedVersion: sale.value.version,
        reviewedByUserId: adminId,
        decision: 'approve',
        idempotencyKey: `review-${randomUUID()}`,
        requestHash: 'review',
      }),
    ]);
    expect(reported.status).toBe('fulfilled');
    const after = await bagRow(bag.id);
    expect(after.status).toBe('quarantined');
    // Either the sale landed before the hold (bag now 18 kg, apply will be blocked) or the
    // hold won and the sale was refused; never both a sale and an intact bag.
    if (approved.status === 'fulfilled') expect(after.currentWeightKg).toBe('18.000');
    else expect(after.currentWeightKg).toBe('20.000');
    await expectLedgerMatchesBags(fx);
  });

  it('enforces STORE/HTKD/ADMIN scope and revoked or locked accounts server-side', async () => {
    const fx = await createFinalizedReceipt();
    const outsider = await createFinalizedReceipt();
    await expect(
      report({ ...fx, storeUserId: outsider.storeUserId }, [fx.bags[0]!], 'keep'),
    ).rejects.toBeInstanceOf(ReceiptAdjustmentAuthorizationError);
    await expect(
      report({ ...fx, storeUserId: fx.htkdId }, [fx.bags[0]!], 'keep'),
    ).rejects.toBeInstanceOf(ReceiptAdjustmentAuthorizationError);

    const created = await report(fx, [fx.bags[0]!], 'keep');
    await expect(
      verify({ ...fx, htkdId: outsider.htkdId }, created, 0, { pricePerKgVnd: 1n }),
    ).rejects.toBeInstanceOf(ReceiptAdjustmentAuthorizationError);
    await expect(
      verify({ ...fx, htkdId: fx.storeUserId }, created, 0, { pricePerKgVnd: 1n }),
    ).rejects.toBeInstanceOf(ReceiptAdjustmentAuthorizationError);
    await verify(fx, created, 0, { pricePerKgVnd: 40_000n });
    await expect(
      transition({
        adjustmentId: created,
        expectedVersion: 1,
        actorUserId: fx.htkdId,
        action: 'APPLY',
        note: null,
      }),
    ).rejects.toBeInstanceOf(ReceiptAdjustmentAuthorizationError);

    // Stale version is refused before anything is written.
    await expect(applyAdjustment(created, 0)).rejects.toThrow(/đã thay đổi/);

    const second = await report(fx, [fx.bags[1]!], 'keep');
    await db
      .update(htkdAssignments)
      .set({ revokedAt: new Date() })
      .where(and(eq(htkdAssignments.userId, fx.htkdId), eq(htkdAssignments.storeId, fx.storeId)));
    await expect(verify(fx, second, 0, { pricePerKgVnd: 40_000n })).rejects.toBeInstanceOf(
      ReceiptAdjustmentAuthorizationError,
    );
    await db.update(users).set({ status: 'locked' }).where(eq(users.id, fx.storeUserId));
    await expect(report(fx, [fx.bags[2]!], 'keep')).rejects.toBeInstanceOf(
      ReceiptAdjustmentAuthorizationError,
    );
  });

  it('refuses a second open report on the same bag and invented legacy VAT', async () => {
    const fx = await createFinalizedReceipt();
    await db
      .update(storeReceipts)
      .set({ vatAmountVnd: null, vatRatePercent: null })
      .where(eq(storeReceipts.id, fx.receiptId));
    const created = await report(fx, [fx.bags[0]!], 'keep');
    const reports = await Promise.allSettled([
      report(fx, [fx.bags[1]!], 'keep'),
      report(fx, [fx.bags[1]!], 'keep'),
    ]);
    expect(reports.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(report(fx, [fx.bags[0]!], 'keep')).rejects.toThrow(/đang nằm trong hồ sơ/);
    await expect(
      verify(fx, created, 0, { pricePerKgVnd: 40_000n, vatDeltaVnd: 100n }),
    ).rejects.toThrow(/chưa ghi nhận VAT/);
    await verify(fx, created, 0, { pricePerKgVnd: 40_000n });
    const record = await getReceiptAdjustment(db, created);
    expect(record?.money.after).toMatchObject({ vatVnd: null, totalVnd: null });
  });

  it('warehouse mispick: shipped SKU leaves warehouse on-hand, approved unit held for a shelf check', async () => {
    const fx = await createFinalizedReceipt();
    const created = await report(fx, [fx.bags[0]!], 'keep');
    const dressBefore = await balance(fx.dressId);
    const jeansBefore = await balance(fx.jeansId);
    await verify(fx, created, 0, { pricePerKgVnd: 40_000n, cause: 'warehouse_mispick' });
    await applyAdjustment(created, 1);
    expect(await balance(fx.jeansId)).toEqual({
      onHand: jeansBefore.onHand - 1,
      reserved: jeansBefore.reserved,
    });
    expect(await balance(fx.dressId)).toEqual({
      onHand: dressBefore.onHand + 1,
      reserved: dressBefore.reserved + 1,
    });
    const [check] = await db
      .select()
      .from(warehouseShortageChecks)
      .where(eq(warehouseShortageChecks.productId, fx.dressId))
      .orderBy(sql`${warehouseShortageChecks.createdAt} desc`)
      .limit(1);
    expect(check).toMatchObject({ status: 'pending', quantity: 1 });
    expect(check?.storeReceiptAdjustmentLineId).not.toBeNull();
    const key = `check-${randomUUID()}`;
    await resolveWarehouseShortageCheck(db, {
      checkId: check!.id,
      decision: 'returned_to_stock',
      reason: 'Tìm thấy bao đầm trên kệ',
      expectedVersion: 0,
      actorUserId: adminId,
      idempotencyKey: key,
      requestHash: key,
    });
    expect(await balance(fx.dressId)).toEqual({
      onHand: dressBefore.onHand + 1,
      reserved: dressBefore.reserved,
    });
  });

  it('keeps the monthly report on original documents and shows adjustments on their own date', async () => {
    const fx = await createFinalizedReceipt();
    const created = await report(fx, [fx.bags[0]!], 'keep');
    await verify(fx, created, 0, { pricePerKgVnd: 40_000n });
    await applyAdjustment(created, 1);
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
    });
    const [year, month] = formatter.format(now).split('-').map(Number);
    const monthly = await loadMonthlyOperationalReport(db, {
      year: year!,
      month: month!,
      scope: { kind: 'STORE', id: fx.storeId },
    });
    expect(monthly.totals.inboundGoodsCostVnd.value).toBe(3_000_000n);
    expect(monthly.adjustments).toMatchObject({
      appliedCount: 1,
      goodsDeltaVnd: -200_000n,
      totalDeltaVnd: -200_000n,
    });
    expect(monthly.adjustments.adjustedLandedInboundCostVnd).toBe(2_800_000n);
    expect(monthly.products.find((row) => row.productId === fx.jeansId)).toMatchObject({
      adjustmentWeightDeltaGrams: 20_000n,
      adjustmentGoodsDeltaVnd: 800_000n,
    });
  });

  // ---------------------------------------------------------------------------------------------

  async function report(
    fx: Fixture,
    bags: readonly Fixture['bags'][number][],
    disposition: 'keep' | 'return',
    actualProductId = fx.jeansId,
  ): Promise<string> {
    const key = `report-${randomUUID()}`;
    const result = await createReceiptAdjustment(db, {
      receiptId: fx.receiptId,
      actorUserId: fx.storeUserId,
      reason: 'Khui bao thấy là jeans',
      evidenceNote: 'Ảnh lưu trong nhóm Zalo cửa hàng',
      discoveredAt: new Date(),
      lines: bags.map((bag) => ({
        receiptBagId: bag.receiptBagId,
        actualProductId,
        disposition,
      })),
      idempotencyKey: key,
      requestHash: key,
    });
    if (result.replayed) throw new Error('unexpected replay');
    return result.value.adjustmentId;
  }

  async function verify(
    fx: Fixture,
    adjustmentId: string,
    expectedVersion: number,
    options: {
      readonly pricePerKgVnd: bigint;
      readonly actualProductId?: string;
      readonly vatDeltaVnd?: bigint;
      readonly cause?: 'source_misclassification' | 'warehouse_mispick';
    },
  ) {
    const record = await getReceiptAdjustment(db, adjustmentId);
    const result = await transition({
      adjustmentId,
      expectedVersion,
      actorUserId: fx.htkdId,
      action: 'VERIFY',
      cause: options.cause ?? 'source_misclassification',
      note: 'Đã kiểm tra ảnh và cân lại',
      lines: record!.lines.map((line) => ({
        receiptBagId: line.receiptBagId,
        actualProductId: options.actualProductId ?? line.actualProductId,
        weightKg: line.recordedWeightKg,
        pricePerKgVnd: options.pricePerKgVnd,
        weightChangeNote: null,
      })),
      freightDeltaVnd: 0n,
      handlingDeltaVnd: 0n,
      vatDeltaVnd: options.vatDeltaVnd ?? 0n,
    });
    if (result.replayed) throw new Error('unexpected replay');
    return result.value;
  }

  async function applyAdjustment(adjustmentId: string, expectedVersion: number, key?: string) {
    return transition(
      {
        adjustmentId,
        expectedVersion,
        actorUserId: adminId,
        action: 'APPLY',
        note: null,
      },
      key,
    );
  }

  async function transition(
    input: DistributiveOmit<ReceiptAdjustmentTransitionInput, 'idempotencyKey' | 'requestHash'>,
    key = `transition-${randomUUID()}`,
  ) {
    return transitionReceiptAdjustment(db, {
      ...input,
      idempotencyKey: key,
      requestHash: `${input.action}:${input.adjustmentId}:${input.expectedVersion}`,
    } as ReceiptAdjustmentTransitionInput);
  }

  async function returnAction(
    actorUserId: string,
    returnId: string,
    expectedVersion: number,
    action: DistributiveOmit<
      ReceiptReturnTransitionInput,
      'idempotencyKey' | 'requestHash' | 'returnId' | 'expectedVersion' | 'actorUserId'
    >,
  ) {
    const key = `return-${randomUUID()}`;
    return transitionReceiptReturn(db, {
      ...action,
      returnId,
      expectedVersion,
      actorUserId,
      idempotencyKey: key,
      requestHash: key,
    } as ReceiptReturnTransitionInput);
  }

  async function summary(fx: { readonly receiptId: string }) {
    const [receipt] = await db
      .select()
      .from(storeReceipts)
      .where(eq(storeReceipts.id, fx.receiptId));
    return receiptAdjustmentMoneySummary(db, receipt!);
  }

  async function bagRow(id: string) {
    const [bag] = await db.select().from(storeInventoryBags).where(eq(storeInventoryBags.id, id));
    if (!bag) throw new Error('bag missing');
    return bag;
  }

  async function returnRow(id: string) {
    const [row] = await db.select().from(storeReceiptReturns).where(eq(storeReceiptReturns.id, id));
    return row!;
  }

  async function activeWaits(fx: Fixture) {
    return db
      .select()
      .from(waitTickets)
      .where(and(eq(waitTickets.storeId, fx.storeId), eq(waitTickets.status, 'active')));
  }

  async function balance(productId: string) {
    const [row] = await db
      .select({
        onHand: warehouseBalances.onHandQuantity,
        reserved: warehouseBalances.reservedQuantity,
      })
      .from(warehouseBalances)
      .where(eq(warehouseBalances.productId, productId));
    return row ?? { onHand: 0, reserved: 0 };
  }

  async function storeProductWeights(fx: Fixture): Promise<Record<string, bigint>> {
    const rows = await db
      .select({
        productId: storeInventoryBags.productId,
        grams: sql<string>`sum(${storeInventoryBags.currentWeightKg} * 1000)::bigint`,
      })
      .from(storeInventoryBags)
      .where(eq(storeInventoryBags.storeId, fx.storeId))
      .groupBy(storeInventoryBags.productId);
    return Object.fromEntries(
      rows.filter((row) => BigInt(row.grams) > 0n).map((row) => [row.productId, BigInt(row.grams)]),
    );
  }

  /** Per-SKU ledger movements must add up to the weights the store's bags hold now. */
  async function expectLedgerMatchesBags(fx: Fixture) {
    const ledger = await db
      .select({
        productId: storeInventoryLedgerEntries.productId,
        grams: sql<string>`sum((${storeInventoryLedgerEntries.weightAfterKg} - ${storeInventoryLedgerEntries.weightBeforeKg}) * 1000)::bigint`,
      })
      .from(storeInventoryLedgerEntries)
      .where(eq(storeInventoryLedgerEntries.storeId, fx.storeId))
      .groupBy(storeInventoryLedgerEntries.productId);
    const fromLedger = Object.fromEntries(
      ledger
        .filter((row) => BigInt(row.grams) !== 0n)
        .map((row) => [row.productId, BigInt(row.grams)]),
    );
    expect(fromLedger).toEqual(await storeProductWeights(fx));
  }

  async function createFinalizedReceipt(
    options: {
      readonly reuse?: Fixture;
      readonly quantity?: number;
      readonly waitTicketId?: string;
    } = {},
  ): Promise<Fixture> {
    const quantity = options.quantity ?? 3;
    const token = randomUUID().replaceAll('-', '');
    const [group] = await db.select().from(storeGroups).limit(1);
    if (!group) throw new Error('Reference seed required.');
    let base = options.reuse;
    if (!base) {
      const [store] = await db
        .insert(stores)
        .values({ code: `ADJ-${token.slice(0, 20)}`, name: 'Adjustment store', groupId: group.id })
        .returning();
      const newProduct = async (name: string) =>
        (
          await db
            .insert(products)
            .values({ sku: `${name}-${token}`, slug: `${name}-${token}`.toLowerCase(), name })
            .returning()
        )[0]!;
      const dress = await newProduct('DAM');
      const jeans = await newProduct('JEANS');
      const coat = await newProduct('COAT');
      const [storeUser] = await db
        .insert(users)
        .values({
          storeId: store!.id,
          email: `adj-store-${token}@example.test`,
          passwordHash: 'integration-test-placeholder-hash',
          displayName: 'Adjustment store user',
          role: 'store',
        })
        .returning();
      const [htkd] = await db
        .insert(users)
        .values({
          email: `adj-htkd-${token}@example.test`,
          passwordHash: 'integration-test-placeholder-hash',
          displayName: 'Adjustment HTKD',
          role: 'htkd',
        })
        .returning();
      await db.insert(htkdAssignments).values({ userId: htkd!.id, storeId: store!.id });
      // Jeans already on the warehouse books, so a mispick correction has stock to remove.
      await withSerializableTransaction(db, (tx) =>
        applyWarehouseMovement(tx, {
          productId: jeans.id,
          eventType: 'receipt',
          onHandDelta: 5,
          reservedDelta: 0,
          sourceType: 'adjustment-fixture',
          sourceId: randomUUID(),
        }),
      );
      base = {
        storeId: store!.id,
        dressId: dress.id,
        jeansId: jeans.id,
        coatId: coat.id,
        storeUserId: storeUser!.id,
        htkdId: htkd!.id,
        orderItemId: '',
        receiptId: '',
        bags: [],
      };
    }
    const now = new Date();
    const day = new Date(Date.UTC(2040 + Math.floor(Math.random() * 50), 0, 1));
    day.setUTCDate(day.getUTCDate() + Math.floor(Math.random() * 360));
    const date = day.toISOString().slice(0, 10);
    const [session] = await db
      .insert(orderSessions)
      .values({
        code: `ADJ-${token.slice(0, 8)}`,
        businessDate: date,
        status: 'completed',
        inventorySnapshotDueAt: new Date(`${date}T08:00:00+07:00`),
        requestDeadlineAt: new Date(`${date}T09:00:00+07:00`),
        completedAt: now,
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
        createdByUserId: adminId,
      })
      .returning();
    sessionIds.push(session!.id);
    const [snapshot] = await db
      .insert(inventorySnapshots)
      .values({
        orderSessionId: session!.id,
        businessDate: date,
        snapshotType: 'manual',
        status: 'completed',
        capturedAt: now,
        completedAt: now,
        balanceVersion: 0,
      })
      .returning();
    const [run] = await db
      .insert(allocationRuns)
      .values({
        orderSessionId: session!.id,
        inventorySnapshotId: snapshot!.id,
        runNumber: 1,
        status: 'completed',
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
        idempotencyKey: randomUUID(),
      })
      .returning();
    if (options.waitTicketId) {
      // What the allocation worker records when it serves the wait.
      await db
        .update(waitTickets)
        .set({
          remainingQuantity: sql`${waitTickets.remainingQuantity} - ${quantity}`,
          fulfilledQuantity: sql`${waitTickets.fulfilledQuantity} + ${quantity}`,
          status: sql`CASE WHEN ${waitTickets.remainingQuantity} = ${quantity} THEN 'fulfilled'::wait_ticket_status ELSE 'active'::wait_ticket_status END`,
          resolvedAt: sql`CASE WHEN ${waitTickets.remainingQuantity} = ${quantity} THEN now() ELSE NULL END`,
        })
        .where(eq(waitTickets.id, options.waitTicketId));
    }
    const [order] = await db
      .insert(orderRequests)
      .values({
        orderSessionId: session!.id,
        storeId: base.storeId,
        requestNumber: 1,
        status: 'allocated',
        submittedAt: now,
        requestedByUserId: adminId,
      })
      .returning();
    const [orderItem] = await db
      .insert(orderRequestItems)
      .values({ orderRequestId: order!.id, productId: base.dressId, requestedQuantity: quantity })
      .returning();
    const [merged] = await db
      .insert(mergedOrders)
      .values({
        orderSessionId: session!.id,
        storeId: base.storeId,
        status: 'allocated',
        requestCount: 1,
      })
      .returning();
    const [mergedItem] = await db
      .insert(mergedOrderItems)
      .values({
        mergedOrderId: merged!.id,
        productId: base.dressId,
        requestedQuantity: quantity,
        priorityLevel: options.waitTicketId ? 'P0B' : 'P1',
      })
      .returning();
    await db.insert(mergedOrderSources).values({
      mergedOrderItemId: mergedItem!.id,
      orderRequestItemId: orderItem!.id,
      requestedQuantity: quantity,
    });
    let offerId: string | null = null;
    if (options.waitTicketId) {
      // The P0B wait is offered, the store accepts, and the allocation serves the accepted offer.
      const [offer] = await db
        .insert(dailyPriorityOffers)
        .values({
          businessDate: date,
          storeId: base.storeId,
          productId: base.dressId,
          waitTicketId: options.waitTicketId,
          priorityLevel: 'P0B',
          offeredQuantity: quantity,
          acceptedQuantity: quantity,
          status: 'accepted',
          responseDeadlineAt: new Date(`${date}T09:00:00+07:00`),
          respondedAt: now,
        })
        .returning({ id: dailyPriorityOffers.id });
      offerId = offer!.id;
    }
    const [allocationLine] = await db
      .insert(allocationLines)
      .values({
        allocationRunId: run!.id,
        mergedOrderId: merged!.id,
        storeId: base.storeId,
        productId: base.dressId,
        ...(options.waitTicketId
          ? { waitTicketId: options.waitTicketId, priorityOfferId: offerId }
          : { orderRequestItemId: orderItem!.id }),
        priorityLevel: options.waitTicketId ? 'P0A' : 'P1',
        roundNumber: 1,
        sequenceInRound: 1,
        requestedQuantity: quantity,
        allocatedQuantity: quantity,
        status: 'allocated',
        reasonCode: 'TEST_ADJUSTMENT',
      })
      .returning();
    const [outbound] = await db
      .insert(outboundRequests)
      .values({
        requestNumber: `ADJ-${token.slice(0, 20)}`,
        storeId: base.storeId,
        orderSessionId: session!.id,
        allocationRunId: run!.id,
        status: 'reserved',
        requestedByUserId: adminId,
        submittedAt: now,
        approvedAt: now,
      })
      .returning();
    const [line] = await db
      .insert(outboundRequestLines)
      .values({
        outboundRequestId: outbound!.id,
        productId: base.dressId,
        allocationLineId: allocationLine!.id,
        requestedQuantity: quantity,
        approvedQuantity: quantity,
        reservedQuantity: quantity,
      })
      .returning();
    await db.insert(reservations).values({
      allocationLineId: allocationLine!.id,
      outboundRequestLineId: line!.id,
      storeId: base.storeId,
      productId: base.dressId,
      quantity,
    });
    await withSerializableTransaction(db, async (tx) => {
      await applyWarehouseMovement(tx, {
        productId: base.dressId,
        eventType: 'receipt',
        onHandDelta: quantity,
        reservedDelta: quantity,
        sourceType: 'adjustment-fixture',
        sourceId: randomUUID(),
      });
    });
    await dispatchStrandedAllocationOutbounds(db, { apply: true });
    const lines = [
      { productId: base.dressId, approvedQuantity: quantity, receivedQuantity: quantity },
    ];
    const declared = await declareStoreReceipt(db, {
      outboundRequestId: outbound!.id,
      storeId: base.storeId,
      declaredByUserId: base.storeUserId,
      lines,
      idempotencyKey: `declare-${token}`,
      requestHash: `declare-${token}`,
    });
    if (declared.replayed) throw new Error('unexpected replay');
    const submitted = await submitStoreReceipt(db, {
      receiptId: declared.value.receiptId,
      expectedVersion: declared.value.version,
      submittedByUserId: base.storeUserId,
      lines,
      idempotencyKey: `submit-${token}`,
      requestHash: `submit-${token}`,
    });
    if (submitted.replayed) throw new Error('unexpected replay');
    await finalizeStoreReceipt(db, {
      receiptId: declared.value.receiptId,
      expectedVersion: submitted.value.version,
      reviewedByUserId: base.htkdId,
      freightVnd: 0n,
      handlingVnd: 0n,
      vat: { amountVnd: 0n, ratePercent: 8 },
      lines: [
        {
          productId: base.dressId,
          pricePerKgVnd: 50_000n,
          bagWeightsKg: Array.from({ length: quantity }, () => '20.000'),
        },
      ],
      idempotencyKey: `finalize-${token}`,
      requestHash: `finalize-${token}`,
    });
    const bagRows = await db
      .select({ receiptBagId: storeReceiptBags.id, inventoryBagId: storeInventoryBags.id })
      .from(storeReceiptBags)
      .innerJoin(storeReceiptLines, eq(storeReceiptLines.id, storeReceiptBags.storeReceiptLineId))
      .innerJoin(
        storeInventoryBags,
        eq(storeInventoryBags.sourceStoreReceiptBagId, storeReceiptBags.id),
      )
      .where(eq(storeReceiptLines.storeReceiptId, declared.value.receiptId))
      .orderBy(asc(storeReceiptBags.bagNumber));
    return {
      ...base,
      orderItemId: options.reuse ? base.orderItemId : orderItem!.id,
      receiptId: declared.value.receiptId,
      bags: bagRows,
    };
  }
});

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
