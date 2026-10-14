import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertShipmentMayBeReceived } from '../src/allocation-decision-gate.js';

import {
  AllocationDecisionActionRetiredError,
  AllocationDecisionConflictError,
  AllocationDecisionForbiddenError,
  allocationLines,
  allocationResultDecisions,
  allocationRuns,
  applyWarehouseMovement,
  auditLogs,
  closeDatabase,
  db,
  dailyPriorityOffers,
  getAllocationDecision,
  htkdAssignments,
  IdempotencyConflictError,
  inventorySnapshots,
  listAllocationDecisions,
  listHeldAllocationStock,
  listSessionDocuments,
  listWaitTickets,
  listStoreReceiptSources,
  mergedOrderItems,
  mergedOrders,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  orderSessions,
  outboundRequestLines,
  outboundRequests,
  products,
  publishAllocationDecisionsInTransaction,
  reservations,
  respondAllocationDecision,
  storeGroups,
  storeInventoryBags,
  storeReceipts,
  stores,
  users,
  cancelWaitTicket,
  previewWaitTicketCancellation,
  WaitTicketPreviewRequiredError,
  WaitTicketPreviewStaleError,
  allocationLineDispositions,
  reshareOrders,
  waitTicketSources,
  waitTickets,
  warehouseBalances,
  warehouseLedgerEntries,
  warehouseShortageChecks,
  withSerializableTransaction,
} from '../src/index.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

type Fixture = Awaited<ReturnType<typeof createFixture>>;

describePostgres('store decisions on published allocation results', () => {
  let fx: Fixture;
  const sessionIds: string[] = [];

  beforeAll(async () => {
    fx = await createFixture();
  });
  afterAll(async () => {
    for (const id of sessionIds) {
      await db.update(orderSessions).set({ deletedAt: new Date() }).where(eq(orderSessions.id, id));
    }
    await closeDatabase();
  });

  it('publishes one decision per store in the run transaction, once', async () => {
    const result = await publishResult({
      storeId: fx.storeA.id,
      grants: [
        { productId: fx.productA, quantity: 2 },
        { productId: fx.productB, quantity: 1 },
      ],
      waitlistedStores: [fx.storeB.id],
    });
    const decisions = await db
      .select()
      .from(allocationResultDecisions)
      .where(eq(allocationResultDecisions.allocationRunId, result.runId));
    expect(
      decisions
        .map((row) => ({ storeId: row.storeId, status: row.status, granted: row.grantedQuantity }))
        .sort((a, b) => a.storeId.localeCompare(b.storeId)),
    ).toEqual(
      [
        { storeId: fx.storeA.id, status: 'pending', granted: 3 },
        // Granted nothing: shown as a result, but there is nothing to accept.
        { storeId: fx.storeB.id, status: 'not_required', granted: 0 },
      ].sort((a, b) => a.storeId.localeCompare(b.storeId)),
    );
    // A retried publication (worker catch-up) creates neither a second decision nor audit.
    await withSerializableTransaction(db, (tx) =>
      publishAllocationDecisionsInTransaction(tx, {
        allocationRunId: result.runId,
        orderSessionId: result.sessionId,
        publishedAt: new Date(),
      }),
    );
    expect(
      await db
        .select({ value: sql<number>`count(*)`.mapWith(Number) })
        .from(allocationResultDecisions)
        .where(eq(allocationResultDecisions.allocationRunId, result.runId)),
    ).toEqual([{ value: 2 }]);
    expect(
      await db
        .select({ value: sql<number>`count(*)`.mapWith(Number) })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, 'ALLOCATION_RESULT_PUBLISHED'),
            inArray(
              auditLogs.entityId,
              decisions.map((row) => row.id),
            ),
          ),
        ),
    ).toEqual([{ value: 2 }]);

    const detail = await getAllocationDecision(db, result.decisionId);
    expect(detail).toMatchObject({
      status: 'pending',
      version: 1,
      grantedQuantity: 3,
      heldQuantity: 0,
      shipment: { outboundRequestId: result.outboundId, status: 'reserved', receiptId: null },
    });
    // Lines are ordered by product id; compare as a set.
    expect(detail.lines).toHaveLength(2);
    expect(detail.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: fx.productA, allocatedQuantity: 2 }),
        expect.objectContaining({ productId: fx.productB, allocatedQuantity: 1 }),
      ]),
    );
    expect(detail.sources).toHaveLength(2);
  });

  it('conserves stock: moving A to waiting releases exactly its 10, B keeps its 7, on-hand untouched', async () => {
    const product = await createProduct();
    await openingStock(product, 100);
    const a = await publishResult({
      storeId: fx.storeA.id,
      grants: [{ productId: product, quantity: 10 }],
    });
    const b = await publishResult({
      storeId: fx.storeB.id,
      grants: [{ productId: product, quantity: 7 }],
    });
    expect(await balanceOf(product)).toEqual({ onHand: 100, reserved: 17 });

    const rejected = await respond(a.decisionId, fx.storeA.userId, 'WAITLIST');
    expect(rejected).toMatchObject({
      replayed: false,
      value: {
        status: 'waitlisted',
        version: 2,
        releasedQuantity: 10,
        keptHeldQuantity: 0,
        cancelledOutboundRequestId: a.outboundId,
        requeued: [{ productId: product, quantity: 10, mode: 'ADD_DEMAND', createdTicket: true }],
      },
    });
    expect(await balanceOf(product)).toEqual({ onHand: 100, reserved: 7 });
    const ledger = await db
      .select()
      .from(warehouseLedgerEntries)
      .where(
        and(
          eq(warehouseLedgerEntries.productId, product),
          eq(warehouseLedgerEntries.sourceType, 'allocation_line_disposition'),
        ),
      );
    expect(ledger).toEqual([
      expect.objectContaining({
        eventType: 'reservation_release',
        onHandDelta: 0,
        reservedDelta: -10,
      }),
    ]);
    // The 10 bags wait again for store A on one active ticket, with the result as its source.
    const tickets = await db
      .select()
      .from(waitTickets)
      .where(and(eq(waitTickets.storeId, fx.storeA.id), eq(waitTickets.productId, product)));
    expect(tickets).toEqual([
      expect.objectContaining({ status: 'active', originalQuantity: 10, remainingQuantity: 10 }),
    ]);
    await expectBalanceMatchesLedger(product);
    await expectReservedMatchesActiveReservations(product);

    const detail = await getAllocationDecision(db, a.decisionId);
    expect(detail).toMatchObject({
      status: 'waitlisted',
      responseReason: null,
      respondedByUserId: fx.storeA.userId,
      releasedQuantity: 10,
      revokedQuantity: 10,
      heldQuantity: 0,
      shipment: { status: 'cancelled' },
    });
    // The result itself and its history stay for lookup; nothing is hard-deleted.
    expect(detail.lines).toEqual([
      expect.objectContaining({ productId: product, allocatedQuantity: 10 }),
    ]);
    // Moving to waiting is not a short receipt: no receipt, no shortage check, no store stock.
    expect(
      await db
        .select()
        .from(storeReceipts)
        .where(eq(storeReceipts.outboundRequestId, a.outboundId!)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(warehouseShortageChecks)
        .where(eq(warehouseShortageChecks.productId, product)),
    ).toEqual([]);
    expect(
      await db.select().from(storeInventoryBags).where(eq(storeInventoryBags.productId, product)),
    ).toEqual([]);
    expect(
      (await listStoreReceiptSources(db, { storeId: fx.storeA.id })).data.map((row) => row.id),
    ).not.toContain(a.outboundId);
    const actions = await auditActions(a.decisionId);
    expect(actions).toEqual(['ALLOCATION_RESULT_PUBLISHED', 'ALLOCATION_RESULT_WAITLISTED']);
    expect(await auditActions(a.outboundId!)).toContain('OUTBOUND_REQUEST_CANCELLED');

    // B accepts: its RE order issues the 7 bags out of on-hand and out of reserved at once;
    // availability (93) is unchanged and the store's stock does not grow before its receipt.
    const accepted = await respond(b.decisionId, fx.storeB.userId, 'ACCEPT');
    expect(accepted).toMatchObject({
      value: { status: 'accepted', dispatchedOutboundRequestId: b.outboundId },
    });
    expect(accepted.replayed ? null : accepted.value.reshareOrderCode).toMatch(/^RE-\d{6}$/u);
    expect(await balanceOf(product)).toEqual({ onHand: 93, reserved: 0 });
    expect(
      await db.select().from(storeInventoryBags).where(eq(storeInventoryBags.productId, product)),
    ).toEqual([]);
    const [shipment] = await db
      .select()
      .from(outboundRequests)
      .where(eq(outboundRequests.id, b.outboundId!));
    expect(shipment).toMatchObject({ status: 'dispatched', version: 1 });
    expect(
      (await listStoreReceiptSources(db, { storeId: fx.storeB.id })).data.map((row) => row.id),
    ).toContain(b.outboundId);
    await expectBalanceMatchesLedger(product);
    await expectReservedMatchesActiveReservations(product);
  });

  it('replays a retried answer without a second effect and refuses reuse or stale versions', async () => {
    const product = await createProduct();
    await openingStock(product, 20);
    const result = await publishResult({
      storeId: fx.storeA.id,
      grants: [{ productId: product, quantity: 4 }],
    });
    const key = randomUUID();
    const first = await respond(result.decisionId, fx.storeA.userId, 'WAITLIST', { key });
    const replay = await respond(result.decisionId, fx.storeA.userId, 'WAITLIST', { key });
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, resourceId: result.decisionId });
    expect(await balanceOf(product)).toEqual({ onHand: 20, reserved: 0 });
    expect(await auditActions(result.decisionId)).toEqual([
      'ALLOCATION_RESULT_PUBLISHED',
      'ALLOCATION_RESULT_WAITLISTED',
    ]);
    // The demand was queued once, not twice.
    expect(
      await db
        .select({ remaining: waitTickets.remainingQuantity })
        .from(waitTickets)
        .where(
          and(
            eq(waitTickets.storeId, fx.storeA.id),
            eq(waitTickets.productId, product),
            eq(waitTickets.status, 'active'),
          ),
        ),
    ).toEqual([{ remaining: 4 }]);
    await expect(
      respond(result.decisionId, fx.storeA.userId, 'ACCEPT', { key }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    // A new key on an answered result: refused with the current state, never a flip.
    const conflict = await respond(result.decisionId, fx.storeA.userId, 'ACCEPT', {
      expectedVersion: 2,
    }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(AllocationDecisionConflictError);
    expect(conflict).toMatchObject({
      reason: 'ALREADY_ANSWERED',
      currentStatus: 'WAITLISTED',
      currentVersion: 2,
    });

    // A different product: the store now waits for `product`, so a new order item for it is
    // refused by the one-active-wait rule.
    const otherProduct = await createProduct();
    await openingStock(otherProduct, 5);
    const other = await publishResult({
      storeId: fx.storeA.id,
      grants: [{ productId: otherProduct, quantity: 1 }],
    });
    await expect(
      respond(other.decisionId, fx.storeA.userId, 'ACCEPT', { expectedVersion: 7 }),
    ).rejects.toMatchObject({ reason: 'STALE_VERSION' });
  });

  it('lets exactly one of two concurrent tabs win, and never releases goods after an acceptance', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const product = await createProduct();
      await openingStock(product, 30);
      const result = await publishResult({
        storeId: fx.storeA.id,
        grants: [{ productId: product, quantity: 5 }],
      });
      const outcomes = await Promise.allSettled([
        respond(result.decisionId, fx.storeA.userId, 'ACCEPT'),
        respond(result.decisionId, fx.storeA.userId, 'WAITLIST'),
      ]);
      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        AllocationDecisionConflictError,
      );
      const [decision] = await db
        .select()
        .from(allocationResultDecisions)
        .where(eq(allocationResultDecisions.id, result.decisionId));
      const [shipment] = await db
        .select()
        .from(outboundRequests)
        .where(eq(outboundRequests.id, result.outboundId!));
      if (decision!.status === 'accepted') {
        expect(await balanceOf(product)).toEqual({ onHand: 25, reserved: 0 });
        expect(shipment!.status).toBe('dispatched');
      } else {
        expect(decision!.status).toBe('waitlisted');
        expect(await balanceOf(product)).toEqual({ onHand: 30, reserved: 0 });
        expect(shipment!.status).toBe('cancelled');
      }
      expect(decision!.version).toBe(2);
      await expectBalanceMatchesLedger(product);
      await expectReservedMatchesActiveReservations(product);
    }

    // Two moves to waiting with different keys release the goods and queue the demand once.
    const product = await createProduct();
    await openingStock(product, 9);
    const result = await publishResult({
      storeId: fx.storeA.id,
      grants: [{ productId: product, quantity: 9 }],
    });
    const twice = await Promise.allSettled([
      respond(result.decisionId, fx.storeA.userId, 'WAITLIST'),
      respond(result.decisionId, fx.storeA.userId, 'WAITLIST'),
    ]);
    expect(twice.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(product)).toEqual({ onHand: 9, reserved: 0 });
    expect(
      await db
        .select({ remaining: waitTickets.remainingQuantity })
        .from(waitTickets)
        .where(and(eq(waitTickets.productId, product), eq(waitTickets.status, 'active'))),
    ).toEqual([{ remaining: 9 }]);
    await expectBalanceMatchesLedger(product);
  });

  it('enforces the receiving side server-side, before any replay', async () => {
    const product = await createProduct();
    await openingStock(product, 10);
    const result = await publishResult({
      storeId: fx.storeA.id,
      grants: [{ productId: product, quantity: 2 }],
    });
    for (const actor of [fx.storeB.userId, fx.htkdId, fx.adminId, fx.wholesaleUserId]) {
      await expect(respond(result.decisionId, actor, 'ACCEPT')).rejects.toBeInstanceOf(
        AllocationDecisionForbiddenError,
      );
    }
    const key = randomUUID();
    await respond(result.decisionId, fx.storeA.userId, 'ACCEPT', { key });
    // Locking the account takes effect immediately, even for a replay of its own earlier key.
    await db.update(users).set({ status: 'locked' }).where(eq(users.id, fx.storeA.userId));
    try {
      await expect(
        respond(result.decisionId, fx.storeA.userId, 'ACCEPT', { key }),
      ).rejects.toBeInstanceOf(AllocationDecisionForbiddenError);
    } finally {
      await db.update(users).set({ status: 'active' }).where(eq(users.id, fx.storeA.userId));
    }
    expect(await auditActions(result.decisionId)).toEqual([
      'ALLOCATION_RESULT_PUBLISHED',
      'ALLOCATION_RESULT_ACCEPTED',
    ]);

    // The wholesale desk answers for wholesale stores (it is their receiving party).
    const wholesaleResult = await publishResult({
      storeId: fx.wholesaleStore.id,
      grants: [{ productId: product, quantity: 1 }],
    });
    await expect(
      respond(wholesaleResult.decisionId, fx.storeA.userId, 'ACCEPT'),
    ).rejects.toBeInstanceOf(AllocationDecisionForbiddenError);
    await expect(
      respond(wholesaleResult.decisionId, fx.wholesaleUserId, 'ACCEPT'),
    ).resolves.toMatchObject({ value: { status: 'accepted' } });
  });

  it('keeps carried goods of an accepted earlier result held when the new result moves to waiting', async () => {
    const product = await createProduct();
    const otherProduct = await createProduct();
    await openingStock(product, 50);
    await openingStock(otherProduct, 50);
    // Earlier session: priority goods only, accepted, so they are held for the next order.
    const earlier = await publishResult({
      storeId: fx.storeA.id,
      grants: [
        { productId: product, quantity: 2 },
        { productId: otherProduct, quantity: 1 },
      ],
      shipment: false,
    });
    expect(await respond(earlier.decisionId, fx.storeA.userId, 'ACCEPT')).toMatchObject({
      value: { status: 'accepted', dispatchedOutboundRequestId: null },
    });
    const carriedRows = await db
      .select()
      .from(reservations)
      .where(inArray(reservations.allocationLineId, earlier.lineIds));
    // Next session: an ordinary order of the same SKU; its shipment carries the held goods.
    const next = await publishResult({
      storeId: fx.storeA.id,
      grants: [{ productId: product, quantity: 3 }],
      carry: carriedRows.map((row) => row.id),
    });
    const before = await getAllocationDecision(db, next.decisionId);
    expect(
      before.carried
        .map((row) => [row.quantity, row.sourceDecisionStatus])
        .sort((a, b) => Number(b[0]) - Number(a[0])),
    ).toEqual([
      [2, 'accepted'],
      [1, 'accepted'],
    ]);
    // The earlier 2 bags were issued with its RE order; only the new 3 are still reserved.
    expect(await balanceOf(product)).toEqual({ onHand: 48, reserved: 3 });

    const rejected = await respond(next.decisionId, fx.storeA.userId, 'WAITLIST');
    expect(rejected).toMatchObject({
      value: {
        releasedQuantity: 3,
        keptHeldQuantity: 3,
        cancelledOutboundRequestId: next.outboundId,
      },
    });
    // Only the new grant goes back; the earlier accepted goods stay issued for the store.
    expect(await balanceOf(product)).toEqual({ onHand: 48, reserved: 0 });
    expect(await balanceOf(otherProduct)).toEqual({ onHand: 49, reserved: 0 });
    const held = await listHeldAllocationStock(db, { storeIds: [fx.storeA.id] });
    expect(held.filter((row) => [product, otherProduct].includes(row.productId))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: product, heldQuantity: 2 }),
        expect.objectContaining({ productId: otherProduct, heldQuantity: 1 }),
      ]),
    );
    const earlierAfter = await getAllocationDecision(db, earlier.decisionId);
    expect(earlierAfter).toMatchObject({ status: 'accepted', heldQuantity: 3 });
    // Issued holds keep their row (it is the RE source identity): still issued, unlinked from
    // the cancelled shipment so the next ordinary shipment carries them. Audit keeps the path.
    const lineage = await db
      .select()
      .from(reservations)
      .where(inArray(reservations.allocationLineId, earlier.lineIds));
    expect(lineage).toHaveLength(2);
    expect(lineage.every((row) => row.status === 'issued')).toBe(true);
    expect(lineage.every((row) => row.outboundRequestLineId === null)).toBe(true);
    for (const row of lineage) {
      const original = carriedRows.find((old) => old.id === row.id)!;
      expect(row.quantity).toBe(original.quantity);
    }
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, next.decisionId),
          eq(auditLogs.action, 'ALLOCATION_RESULT_WAITLISTED'),
        ),
      );
    expect(audit!.metadata).toMatchObject({ revokedNow: 3, keptHeldQuantity: 3 });
    await expectBalanceMatchesLedger(product);
    await expectReservedMatchesActiveReservations(product);
    await expectReservedMatchesActiveReservations(otherProduct);
  });

  it('holds accepted priority-only goods, releases waitlisted ones, and never answers twice', async () => {
    const product = await createProduct();
    await openingStock(product, 10);
    const kept = await publishResult({
      storeId: fx.storeA.id,
      grants: [{ productId: product, quantity: 2 }],
      shipment: false,
    });
    const dropped = await publishResult({
      storeId: fx.storeB.id,
      grants: [{ productId: product, quantity: 3 }],
      shipment: false,
    });
    await respond(kept.decisionId, fx.storeA.userId, 'ACCEPT');
    const rejected = await respond(dropped.decisionId, fx.storeB.userId, 'WAITLIST');
    expect(rejected).toMatchObject({
      value: { releasedQuantity: 3, cancelledOutboundRequestId: null },
    });
    // The accepted 2 left with their RE order (no shipment yet: they wait for the next ordinary
    // order); the waitlisted 3 went back to availability and wait again for store B.
    expect(await balanceOf(product)).toEqual({ onHand: 8, reserved: 0 });
    expect(await outboundCount(fx.storeA.id, kept.runId)).toBe(0);
  });

  it('refuses answers for results with nothing to answer and protects answered rows', async () => {
    const product = await createProduct();
    await openingStock(product, 5);
    const zero = await publishResult({
      storeId: fx.storeA.id,
      grants: [],
      waitlistedStores: [fx.storeA.id],
      shipment: false,
    });
    expect(zero.decisionStatus).toBe('not_required');
    await expect(respond(zero.decisionId, fx.storeA.userId, 'ACCEPT')).rejects.toMatchObject({
      reason: 'NOT_ANSWERABLE',
    });
    const legacy = await publishResult({
      storeId: fx.storeA.id,
      grants: [{ productId: product, quantity: 1 }],
      shipment: false,
      legacy: true,
    });
    await expect(respond(legacy.decisionId, fx.storeA.userId, 'WAITLIST')).rejects.toMatchObject({
      reason: 'NOT_ANSWERABLE',
    });
    // The retired rejection is refused before anything is read or written.
    await expect(respond(legacy.decisionId, fx.storeA.userId, 'REJECT')).rejects.toBeInstanceOf(
      AllocationDecisionActionRetiredError,
    );
    // The database itself keeps an answer final and the decision rows undeletable.
    const answered = await publishResult({
      storeId: fx.storeA.id,
      grants: [{ productId: product, quantity: 1 }],
    });
    await respond(answered.decisionId, fx.storeA.userId, 'ACCEPT');
    await expect(
      db
        .update(allocationResultDecisions)
        .set({ status: 'rejected', version: 3 })
        .where(eq(allocationResultDecisions.id, answered.decisionId)),
    ).rejects.toThrow();
    await expect(
      db
        .delete(allocationResultDecisions)
        .where(eq(allocationResultDecisions.id, answered.decisionId)),
    ).rejects.toThrow();
  });

  it('cannot complete a run that lacks a decision for a store it allocated to', async () => {
    const product = await createProduct();
    const { runId } = await createRunWithLine(fx.storeA.id, product, 1, { status: 'running' });
    await expect(
      db.update(allocationRuns).set({ status: 'completed' }).where(eq(allocationRuns.id, runId)),
    ).rejects.toThrow();
  });

  it('pages and filters by decision header without truncating SKUs or multiplying totals', async () => {
    const a = await publishResult({
      storeId: fx.storeB.id,
      grants: [
        { productId: fx.productA, quantity: 1 },
        { productId: fx.productB, quantity: 1 },
      ],
    });
    const pending = await listAllocationDecisions(db, {
      page: 1,
      pageSize: 1,
      storeIds: [fx.storeB.id],
      status: 'pending',
    });
    expect(pending.data).toHaveLength(1);
    expect(pending.pagination.totalItems).toBeGreaterThanOrEqual(1);
    const newest = pending.data[0]!;
    expect(newest.id).toBe(a.decisionId);
    expect(newest.lines).toHaveLength(2);
    expect(newest.lines.reduce((total, line) => total + line.allocatedQuantity, 0)).toBe(2);
    const otherStore = await listAllocationDecisions(db, {
      page: 1,
      pageSize: 100,
      storeIds: [fx.storeA.id],
    });
    expect(otherStore.data.map((row) => row.id)).not.toContain(a.decisionId);
    expect(await listAllocationDecisions(db, { page: 1, pageSize: 5, storeIds: [] })).toMatchObject(
      { data: [], pagination: { totalItems: 0 } },
    );

    const documents = await listSessionDocuments(db, {
      page: 1,
      pageSize: 5,
      sessionId: a.sessionId,
      includeDecision: true,
    });
    expect(documents.data).toHaveLength(1);
    expect(documents.data[0]).toMatchObject({
      decision: { id: a.decisionId, status: 'pending', grantedQuantity: 2 },
    });
    const withoutDecision = await listSessionDocuments(db, {
      page: 1,
      pageSize: 5,
      sessionId: a.sessionId,
    });
    expect(withoutDecision.data[0]).not.toHaveProperty('decision');
    expect(
      (
        await listSessionDocuments(db, {
          page: 1,
          pageSize: 5,
          sessionId: a.sessionId,
          decisionStatus: 'rejected',
        })
      ).data,
    ).toEqual([]);
  });

  it('fails closed for a dispatched allocation shipment without a decision', async () => {
    const { sessionId, runId } = await createRun();
    const [shipment] = await db
      .insert(outboundRequests)
      .values({
        requestNumber: '',
        storeId: fx.storeA.id,
        orderSessionId: sessionId,
        allocationRunId: runId,
        status: 'dispatched',
        requestedByUserId: fx.adminId,
        dispatchedAt: new Date(),
      })
      .returning();
    await db.insert(outboundRequestLines).values({
      outboundRequestId: shipment!.id,
      productId: fx.productA,
      requestedQuantity: 1,
      approvedQuantity: 1,
      reservedQuantity: 1,
      dispatchedQuantity: 1,
    });
    await expect(
      withSerializableTransaction(db, (tx) => assertShipmentMayBeReceived(tx, shipment!)),
    ).rejects.toMatchObject({ reason: 'DECISION_MISSING' });
    const sources = await listStoreReceiptSources(db, { storeId: fx.storeA.id, pageSize: 100 });
    expect(sources.data.map((row) => row.id)).not.toContain(shipment!.id);
    // Only an explicit legacy classification allows old allocation shipments through.
    await db.insert(allocationResultDecisions).values({
      allocationRunId: runId,
      orderSessionId: sessionId,
      storeId: fx.storeA.id,
      status: 'legacy',
      origin: 'legacy_backfill',
      grantedQuantity: 0,
    });
    await withSerializableTransaction(db, (tx) => assertShipmentMayBeReceived(tx, shipment!));
    const legacySources = await listStoreReceiptSources(db, {
      storeId: fx.storeA.id,
      pageSize: 100,
    });
    expect(legacySources.data.map((row) => row.id)).toContain(shipment!.id);
  });

  it('requested 10, granted 6, worker queued 4: moving to waiting leaves 10 waiting, not 14', async () => {
    const product = await createProduct();
    await openingStock(product, 50);
    const result = await publishResult({
      storeId: fx.storeB.id,
      grants: [{ productId: product, quantity: 6 }],
      shipment: false,
    });
    // The worker queued the unallocated 4 on the store's active ticket in the run itself.
    const ticket = await createTicket(fx.storeB.id, product, 4);
    const moved = await respond(result.decisionId, fx.storeB.userId, 'WAITLIST');
    expect(moved.replayed ? null : moved.value.requeued).toEqual([
      {
        waitTicketId: ticket.id,
        productId: product,
        quantity: 6,
        mode: 'ADD_DEMAND',
        createdTicket: false,
      },
    ]);
    expect(await ticketRow(ticket.id)).toMatchObject({
      status: 'active',
      originalQuantity: 10,
      remainingQuantity: 10,
      fulfilledQuantity: 0,
    });
    expect(await activeTickets(fx.storeB.id, product)).toHaveLength(1);
    expect(await balanceOf(product)).toEqual({ onHand: 50, reserved: 0 });
    const sources = await db
      .select()
      .from(waitTicketSources)
      .where(eq(waitTicketSources.waitTicketId, ticket.id));
    expect(sources).toEqual([
      expect.objectContaining({
        kind: 'result_waitlisted',
        quantity: 6,
        allocationDecisionId: result.decisionId,
        orderSessionId: result.sessionId,
        actorUserId: fx.storeB.userId,
      }),
    ]);
    // A replay with a new key is refused; the same line can never be requeued twice.
    await expect(
      respond(result.decisionId, fx.storeB.userId, 'WAITLIST', { expectedVersion: 2 }),
    ).rejects.toMatchObject({ reason: 'ALREADY_ANSWERED' });
    expect((await ticketRow(ticket.id)).remainingQuantity).toBe(10);
  });

  it('merges X into the existing ticket (3 + 2 = 5), creates one ticket for Y (4), and is retry safe', async () => {
    const productX = await createProduct();
    const productY = await createProduct();
    await openingStock(productX, 20);
    await openingStock(productY, 20);
    const result = await publishResult({
      storeId: fx.storeA.id,
      grants: [
        { productId: productX, quantity: 2 },
        { productId: productY, quantity: 4 },
      ],
    });
    const ticketX = await createTicket(fx.storeA.id, productX, 3);
    const key = randomUUID();
    await respond(result.decisionId, fx.storeA.userId, 'WAITLIST', { key });
    await respond(result.decisionId, fx.storeA.userId, 'WAITLIST', { key });
    expect(await ticketRow(ticketX.id)).toMatchObject({
      remainingQuantity: 5,
      originalQuantity: 5,
    });
    const ticketsY = await activeTickets(fx.storeA.id, productY);
    expect(ticketsY).toEqual([
      expect.objectContaining({ remainingQuantity: 4, originalQuantity: 4, fulfilledQuantity: 0 }),
    ]);
    expect(ticketsY[0]!.code).toMatch(/^PC-\d{7}$/u);
    expect(await balanceOf(productX)).toEqual({ onHand: 20, reserved: 0 });
    expect(await balanceOf(productY)).toEqual({ onHand: 20, reserved: 0 });
    const detail = await getAllocationDecision(db, result.decisionId);
    expect(detail).toMatchObject({ status: 'waitlisted', revokedQuantity: 6 });
    expect(detail.requeued).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ waitTicketId: ticketX.id, quantity: 2, createdTicket: false }),
        expect.objectContaining({ productId: productY, quantity: 4, createdTicket: true }),
      ]),
    );
    await expectBalanceMatchesLedger(productX);
    await expectReservedMatchesActiveReservations(productY);
  });

  it('restores bags granted from the active ticket instead of adding the demand twice', async () => {
    const product = await createProduct();
    await openingStock(product, 20);
    const ticket = await createTicket(fx.storeA.id, product, 5);
    const result = await publishResult({
      storeId: fx.storeA.id,
      grants: [{ productId: product, quantity: 2, waitTicketId: ticket.id }],
      shipment: false,
    });
    expect(await ticketRow(ticket.id)).toMatchObject({
      remainingQuantity: 3,
      fulfilledQuantity: 2,
    });
    await respond(result.decisionId, fx.storeA.userId, 'WAITLIST');
    // Back to 5 waiting, original unchanged: the 2 bags moved from fulfilled to remaining.
    expect(await ticketRow(ticket.id)).toMatchObject({
      status: 'active',
      originalQuantity: 5,
      remainingQuantity: 5,
      fulfilledQuantity: 0,
    });
    const [source] = await db
      .select()
      .from(waitTicketSources)
      .where(eq(waitTicketSources.waitTicketId, ticket.id));
    expect(source).toMatchObject({
      kind: 'result_restored',
      quantity: 2,
      sourceWaitTicketId: ticket.id,
    });
  });

  it('cancelling ticket A revokes only A from a result shared with ticket B and an ordinary order', async () => {
    const product = await createProduct();
    const productB = await createProduct();
    await openingStock(product, 40);
    await openingStock(productB, 40);
    const ticketA = await createTicket(fx.storeA.id, product, 3);
    const ticketB = await createTicket(fx.storeA.id, productB, 2);
    const orderProduct = await createProduct();
    await openingStock(orderProduct, 40);
    const result = await publishResult({
      storeId: fx.storeA.id,
      grants: [
        { productId: orderProduct, quantity: 4 },
        { productId: product, quantity: 3, waitTicketId: ticketA.id },
        { productId: productB, quantity: 2, waitTicketId: ticketB.id },
      ],
    });
    expect(await ticketRow(ticketA.id)).toMatchObject({ status: 'fulfilled' });
    // A fulfilled ticket whose grant has no RE yet is still "not processed" and cancellable.
    const preview = await previewWaitTicketCancellation(db, {
      actorUserId: fx.storeA.userId,
      waitTicketId: ticketA.id,
    });
    expect(preview.scope.plan).toMatchObject({ ok: true, cancelledQuantity: 3 });
    expect(preview.scope.lines).toEqual([
      expect.objectContaining({
        kind: 'REVOCABLE',
        quantity: 3,
        allocationDecisionId: result.decisionId,
      }),
    ]);
    // Revoking goods needs the confirmed preview.
    await expect(
      cancel(ticketA.id, fx.storeA.userId, { fingerprint: null }),
    ).rejects.toBeInstanceOf(WaitTicketPreviewRequiredError);
    await expect(
      cancel(ticketA.id, fx.storeA.userId, { fingerprint: 'f'.repeat(64) }),
    ).rejects.toBeInstanceOf(WaitTicketPreviewStaleError);
    await cancel(ticketA.id, fx.storeA.userId);

    expect(await ticketRow(ticketA.id)).toMatchObject({
      status: 'cancelled',
      remainingQuantity: 3,
      fulfilledQuantity: 0,
      cancellationKind: 'store_cancelled',
    });
    expect(await ticketRow(ticketB.id)).toMatchObject({
      status: 'fulfilled',
      fulfilledQuantity: 2,
    });
    expect(await balanceOf(product)).toEqual({ onHand: 40, reserved: 0 });
    expect(await balanceOf(productB)).toEqual({ onHand: 40, reserved: 2 });
    const [decision] = await db
      .select()
      .from(allocationResultDecisions)
      .where(eq(allocationResultDecisions.id, result.decisionId));
    expect(decision).toMatchObject({
      status: 'pending',
      version: 2,
      grantedQuantity: 9,
      revokedQuantity: 3,
    });
    // The shipment lost exactly the revoked line; the others still ship.
    const lines = await db
      .select()
      .from(outboundRequestLines)
      .where(eq(outboundRequestLines.outboundRequestId, result.outboundId!));
    expect(lines.map((line) => [line.productId, line.approvedQuantity]).sort()).toEqual(
      [
        [orderProduct, 4],
        [productB, 2],
      ].sort(),
    );
    // The old version is refused; the actionable rest is confirmed with one RE of 6 bags.
    await expect(respond(result.decisionId, fx.storeA.userId, 'ACCEPT')).rejects.toMatchObject({
      reason: 'STALE_VERSION',
    });
    const accepted = await respond(result.decisionId, fx.storeA.userId, 'ACCEPT', {
      expectedVersion: 2,
    });
    expect(accepted).toMatchObject({
      value: { status: 'accepted', dispatchedOutboundRequestId: result.outboundId },
    });
    const [order] = await db
      .select()
      .from(reshareOrders)
      .where(eq(reshareOrders.allocationDecisionId, result.decisionId));
    expect(order).toMatchObject({ totalQuantity: 6 });
    expect(await balanceOf(product)).toEqual({ onHand: 40, reserved: 0 });
    expect(await balanceOf(productB)).toEqual({ onHand: 38, reserved: 0 });
    expect(await balanceOf(orderProduct)).toEqual({ onHand: 36, reserved: 0 });
    for (const id of [product, productB, orderProduct]) {
      await expectBalanceMatchesLedger(id);
      await expectReservedMatchesActiveReservations(id);
    }
    // After the RE, B's goods are protected: B can no longer be cancelled.
    const previewB = await previewWaitTicketCancellation(db, {
      actorUserId: fx.storeA.userId,
      waitTicketId: ticketB.id,
    });
    expect(previewB.scope.plan).toEqual({ ok: false, reason: 'NOTHING_CANCELLABLE' });
    expect(previewB.scope.lines).toEqual([
      expect.objectContaining({ kind: 'RESHARE_ORDER', reshareOrderCode: order!.code }),
    ]);
    // The database refuses an RE source for the revoked line whatever code tries.
    const [disposition] = await db
      .select()
      .from(allocationLineDispositions)
      .where(eq(allocationLineDispositions.allocationDecisionId, result.decisionId));
    expect(disposition).toMatchObject({
      kind: 'wait_ticket_cancelled',
      quantity: 3,
      waitTicketId: ticketA.id,
    });
  });

  it('closes a result whose every bag is cancelled and keeps carried goods for the store', async () => {
    const product = await createProduct();
    await openingStock(product, 30);
    const ticket = await createTicket(fx.storeB.id, product, 4);
    const result = await publishResult({
      storeId: fx.storeB.id,
      grants: [{ productId: product, quantity: 4, waitTicketId: ticket.id }],
    });
    await cancel(ticket.id, fx.storeB.userId);
    const detail = await getAllocationDecision(db, result.decisionId);
    expect(detail).toMatchObject({
      status: 'cancelled',
      revokedQuantity: 4,
      shipment: { status: 'cancelled' },
      revocations: [expect.objectContaining({ kind: 'wait_ticket_cancelled', quantity: 4 })],
    });
    expect(await balanceOf(product)).toEqual({ onHand: 30, reserved: 0 });
    await expect(
      respond(result.decisionId, fx.storeB.userId, 'ACCEPT', { expectedVersion: 2 }),
    ).rejects.toMatchObject({ reason: 'NOT_ANSWERABLE' });
    // Not in the pending notice any more; nothing is issued for it.
    const pending = await listAllocationDecisions(db, {
      page: 1,
      pageSize: 100,
      storeIds: [fx.storeB.id],
      status: 'pending',
    });
    expect(pending.data.map((row) => row.id)).not.toContain(result.decisionId);
    // A cancelled ticket is final: a new key is refused, nothing changes.
    await expect(cancel(ticket.id, fx.storeB.userId, { fingerprint: null })).rejects.toThrow();
  });

  it('serializes cancellation and acceptance: exactly one consistent outcome', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const product = await createProduct();
      await openingStock(product, 10);
      const ticket = await createTicket(fx.storeA.id, product, 2);
      const result = await publishResult({
        storeId: fx.storeA.id,
        grants: [{ productId: product, quantity: 2, waitTicketId: ticket.id }],
        shipment: false,
      });
      const preview = await previewWaitTicketCancellation(db, {
        actorUserId: fx.storeA.userId,
        waitTicketId: ticket.id,
      });
      const outcomes = await Promise.allSettled([
        respond(result.decisionId, fx.storeA.userId, 'ACCEPT'),
        cancel(ticket.id, fx.storeA.userId, { fingerprint: preview.scope.fingerprint }),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const [decision] = await db
        .select()
        .from(allocationResultDecisions)
        .where(eq(allocationResultDecisions.id, result.decisionId));
      if (decision!.status === 'accepted') {
        // ACCEPT won: the RE protects the goods; the stale preview was refused.
        expect(await balanceOf(product)).toEqual({ onHand: 8, reserved: 0 });
        expect((await ticketRow(ticket.id)).status).toBe('fulfilled');
      } else {
        expect(decision!.status).toBe('cancelled');
        expect(await balanceOf(product)).toEqual({ onHand: 10, reserved: 0 });
        expect(
          await db
            .select()
            .from(reshareOrders)
            .where(eq(reshareOrders.allocationDecisionId, result.decisionId)),
        ).toEqual([]);
      }
      await expectBalanceMatchesLedger(product);
      await expectReservedMatchesActiveReservations(product);
    }
  });

  it('lets an assigned HTKD move a result to waiting, never an unassigned one', async () => {
    const product = await createProduct();
    await openingStock(product, 10);
    const result = await publishResult({
      storeId: fx.storeA.id,
      grants: [{ productId: product, quantity: 1 }],
      shipment: false,
    });
    await expect(respond(result.decisionId, fx.htkdId, 'WAITLIST')).rejects.toBeInstanceOf(
      AllocationDecisionForbiddenError,
    );
    await db.insert(htkdAssignments).values({ userId: fx.htkdId, storeId: fx.storeA.id });
    try {
      const moved = await respond(result.decisionId, fx.htkdId, 'WAITLIST');
      expect(moved).toMatchObject({ value: { status: 'waitlisted' } });
      const [audit] = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, result.decisionId),
            eq(auditLogs.action, 'ALLOCATION_RESULT_WAITLISTED'),
          ),
        );
      expect(audit).toMatchObject({ actorUserId: fx.htkdId, actorRole: 'htkd' });
    } finally {
      await db
        .update(htkdAssignments)
        .set({ revokedAt: new Date() })
        .where(eq(htkdAssignments.userId, fx.htkdId));
    }
  });

  it('lists tickets with three labels filtered before paging, proven sessions and cancel capability', async () => {
    const product = await createProduct();
    await openingStock(product, 20);
    const pendingTicket = await createTicket(fx.storeB.id, product, 2);
    // Granted in full by a result still waiting: "fulfilled" in the database, "Chưa xử lý" on screen.
    const result = await publishResult({
      storeId: fx.storeB.id,
      grants: [{ productId: product, quantity: 2, waitTicketId: pendingTicket.id }],
      shipment: false,
    });
    const other = await createProduct();
    const waiting = await createTicket(fx.storeB.id, other, 3);
    const list = (displayStatus?: 'UNPROCESSED' | 'PROCESSED' | 'CANCELLED') =>
      listWaitTickets(db, {
        actorUserId: fx.storeB.userId,
        pageSize: 100,
        includeLineage: true,
        ...(displayStatus ? { displayStatus } : {}),
      });
    const unprocessed = await list('UNPROCESSED');
    const ids = unprocessed.data.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([pendingTicket.id, waiting.id]));
    expect(unprocessed.pagination.totalItems).toBe(unprocessed.data.length);
    const row = unprocessed.data.find((item) => item.id === pendingTicket.id)!;
    expect(row.status).toBe('fulfilled');
    expect(row.lineage).toMatchObject({
      displayStatus: 'UNPROCESSED',
      displayDetail: 'PENDING_DECISION',
      pendingDecisionQuantity: 2,
      canCancel: true,
    });
    expect(row.lineage!.sessions[0]).toMatchObject({ origin: true });
    expect((await list('PROCESSED')).data.map((item) => item.id)).not.toContain(pendingTicket.id);

    // After the result is confirmed (RE), the ticket is processed and no longer cancellable.
    await respond(result.decisionId, fx.storeB.userId, 'ACCEPT');
    const processed = await list('PROCESSED');
    const after = processed.data.find((item) => item.id === pendingTicket.id)!;
    expect(after.lineage).toMatchObject({
      displayStatus: 'PROCESSED',
      pendingDecisionQuantity: 0,
      canCancel: false,
    });
    expect((await list('UNPROCESSED')).data.map((item) => item.id)).not.toContain(pendingTicket.id);
    // Search by product name, server-side.
    const [named] = await db.select().from(products).where(eq(products.id, other));
    const searched = await listWaitTickets(db, {
      actorUserId: fx.storeB.userId,
      q: named!.name,
      pageSize: 100,
    });
    expect(searched.data.map((item) => item.id)).toEqual([waiting.id]);
    // Another store's account never sees them.
    expect(
      (await listWaitTickets(db, { actorUserId: fx.storeA.userId, pageSize: 100 })).data.map(
        (item) => item.id,
      ),
    ).not.toContain(waiting.id);
  });

  // ------------------------------------------------------------------------------------------
  // Fixture helpers: build exactly what the 09:00 worker persists.
  // ------------------------------------------------------------------------------------------

  async function respond(
    decisionId: string,
    actorUserId: string,
    action: 'ACCEPT' | 'WAITLIST' | 'REJECT',
    options: { key?: string; expectedVersion?: number } = {},
  ) {
    const key = options.key ?? randomUUID();
    return respondAllocationDecision(db, {
      decisionId,
      action,
      expectedVersion: options.expectedVersion ?? 1,
      actorUserId,
      idempotencyKey: key,
      requestHash: `${action}:${options.expectedVersion ?? 1}`,
    });
  }

  async function publishResult(input: {
    readonly storeId: string;
    readonly grants: readonly { productId: string; quantity: number; waitTicketId?: string }[];
    readonly waitlistedStores?: readonly string[];
    readonly shipment?: boolean;
    readonly carry?: readonly string[];
    readonly legacy?: boolean;
  }) {
    const { sessionId, runId } = await createRun();
    const now = new Date();
    const lineIds: string[] = [];
    const reservationIds: string[] = [];
    let sequence = 0;
    for (const grant of input.grants) {
      sequence += 1;
      const lineId = grant.waitTicketId
        ? await insertTicketLine(sessionId, runId, input.storeId, grant, sequence)
        : await insertOrderLine(sessionId, runId, input.storeId, grant.productId, {
            allocated: grant.quantity,
            waitlisted: 0,
            sequence,
          });
      lineIds.push(lineId);
      const [reservation] = await db
        .insert(reservations)
        .values({
          productId: grant.productId,
          storeId: input.storeId,
          allocationLineId: lineId,
          quantity: grant.quantity,
          createdAt: now,
        })
        .returning({ id: reservations.id });
      reservationIds.push(reservation!.id);
      await withSerializableTransaction(db, (tx) =>
        applyWarehouseMovement(tx, {
          productId: grant.productId,
          eventType: 'reservation',
          onHandDelta: 0,
          reservedDelta: grant.quantity,
          sourceType: 'allocation_run',
          sourceId: runId,
          eventSequence: sequence,
        }),
      );
    }
    for (const storeId of input.waitlistedStores ?? []) {
      sequence += 1;
      await insertOrderLine(sessionId, runId, storeId, fx.productA, {
        allocated: 0,
        waitlisted: 1,
        sequence,
      });
    }
    if (input.legacy) {
      await db.insert(allocationResultDecisions).values({
        allocationRunId: runId,
        orderSessionId: sessionId,
        storeId: input.storeId,
        status: 'legacy',
        origin: 'legacy_backfill',
        grantedQuantity: input.grants.reduce((total, grant) => total + grant.quantity, 0),
      });
    }
    await withSerializableTransaction(db, (tx) =>
      publishAllocationDecisionsInTransaction(tx, {
        allocationRunId: runId,
        orderSessionId: sessionId,
        publishedAt: now,
      }),
    );
    let outboundId: string | null = null;
    if (input.shipment !== false && input.grants.length > 0) {
      const [outbound] = await db
        .insert(outboundRequests)
        .values({
          requestNumber: '',
          storeId: input.storeId,
          orderSessionId: sessionId,
          allocationRunId: runId,
          status: 'reserved',
          requestedByUserId: fx.adminId,
          submittedAt: now,
          approvedAt: now,
        })
        .returning({ id: outboundRequests.id });
      outboundId = outbound!.id;
      const carried = input.carry?.length
        ? await db
            .select()
            .from(reservations)
            .where(inArray(reservations.id, [...input.carry]))
        : [];
      const productsOnShipment = [
        ...new Set([...input.grants.map((g) => g.productId), ...carried.map((c) => c.productId)]),
      ];
      for (const productId of productsOnShipment) {
        const ownIndexes = input.grants
          .map((grant, index) => ({ grant, index }))
          .filter(({ grant }) => grant.productId === productId);
        const carriedRows = carried.filter((row) => row.productId === productId);
        const quantity =
          ownIndexes.reduce((total, { grant }) => total + grant.quantity, 0) +
          carriedRows.reduce((total, row) => total + row.quantity, 0);
        const [line] = await db
          .insert(outboundRequestLines)
          .values({
            outboundRequestId: outboundId,
            productId,
            allocationLineId: ownIndexes[0]
              ? lineIds[ownIndexes[0].index]!
              : carriedRows[0]!.allocationLineId,
            requestedQuantity: quantity,
            approvedQuantity: quantity,
            reservedQuantity: quantity,
          })
          .returning({ id: outboundRequestLines.id });
        await db
          .update(reservations)
          .set({ outboundRequestLineId: line!.id })
          .where(
            inArray(reservations.id, [
              ...ownIndexes.map(({ index }) => reservationIds[index]!),
              ...carriedRows.map((row) => row.id),
            ]),
          );
      }
    }
    await db
      .update(allocationRuns)
      .set({ status: 'completed' })
      .where(eq(allocationRuns.id, runId));
    const [decision] = await db
      .select()
      .from(allocationResultDecisions)
      .where(
        and(
          eq(allocationResultDecisions.allocationRunId, runId),
          eq(allocationResultDecisions.storeId, input.storeId),
        ),
      );
    return {
      sessionId,
      runId,
      lineIds,
      outboundId,
      decisionId: decision!.id,
      decisionStatus: decision!.status,
    };
  }

  async function createRun(status: 'running' | 'completed' = 'running') {
    const token = randomUUID().replaceAll('-', '');
    const date = '2026-10-05';
    const [session] = await db
      .insert(orderSessions)
      .values({
        code: `DEC-${token}`,
        kind: 'manual',
        businessDate: date,
        status: 'completed',
        openedAt: new Date(`${date}T00:00:00+07:00`),
        inventorySnapshotDueAt: new Date(`${date}T08:00:00+07:00`),
        requestDeadlineAt: new Date(`${date}T09:00:00+07:00`),
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
        createdByUserId: fx.adminId,
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
        capturedAt: new Date(),
        completedAt: new Date(),
        balanceVersion: 0,
      })
      .returning();
    const [run] = await db
      .insert(allocationRuns)
      .values({
        orderSessionId: session!.id,
        inventorySnapshotId: snapshot!.id,
        runNumber: 1,
        status,
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
        idempotencyKey: randomUUID(),
      })
      .returning();
    return { sessionId: session!.id, runId: run!.id };
  }

  async function createRunWithLine(
    storeId: string,
    productId: string,
    quantity: number,
    options: { status: 'running' },
  ) {
    const { sessionId, runId } = await createRun(options.status);
    await insertOrderLine(sessionId, runId, storeId, productId, {
      allocated: quantity,
      waitlisted: 0,
      sequence: 1,
    });
    return { sessionId, runId };
  }

  /** A priority (P0A) line granted from a wait ticket, as the worker writes it. */
  async function insertTicketLine(
    sessionId: string,
    runId: string,
    storeId: string,
    grant: { productId: string; quantity: number; waitTicketId?: string },
    sequence: number,
  ) {
    const [ticket] = await db
      .select()
      .from(waitTickets)
      .where(eq(waitTickets.id, grant.waitTicketId!));
    // The store accepted the priority offer for these bags before the run allocated them.
    const [offer] = await db
      .insert(dailyPriorityOffers)
      .values({
        businessDate: '2026-10-05',
        orderSessionId: sessionId,
        storeId,
        productId: grant.productId,
        waitTicketId: grant.waitTicketId!,
        priorityLevel: 'P0A',
        offeredQuantity: grant.quantity,
        eligibleQuantityAtOffer: ticket!.remainingQuantity,
        acceptedQuantity: grant.quantity,
        status: 'accepted',
        responseDeadlineAt: new Date('2026-10-05T02:00:00Z'),
        respondedAt: new Date('2026-10-05T01:30:00Z'),
        createdAt: new Date('2026-10-05T01:00:00Z'),
      })
      .returning({ id: dailyPriorityOffers.id });
    const [line] = await db
      .insert(allocationLines)
      .values({
        allocationRunId: runId,
        storeId,
        productId: grant.productId,
        waitTicketId: grant.waitTicketId!,
        priorityOfferId: offer!.id,
        priorityLevel: 'P0A',
        roundNumber: 1,
        sequenceInRound: sequence,
        requestedQuantity: grant.quantity,
        allocatedQuantity: grant.quantity,
        waitlistedQuantity: 0,
        status: 'allocated',
        reasonCode: 'TEST_DECISION',
      })
      .returning({ id: allocationLines.id });
    const remaining = ticket!.remainingQuantity - grant.quantity;
    await db
      .update(waitTickets)
      .set({
        remainingQuantity: remaining,
        fulfilledQuantity: ticket!.fulfilledQuantity + grant.quantity,
        status: remaining === 0 ? 'fulfilled' : 'active',
        resolvedAt: remaining === 0 ? new Date() : null,
      })
      .where(eq(waitTickets.id, ticket!.id));
    return line!.id;
  }

  /** An active wait ticket of `quantity` bags, opened by an order of its own session. */
  async function createTicket(storeId: string, productId: string, quantity: number) {
    const { sessionId } = await createRun('completed');
    const [order] = await db
      .insert(orderRequests)
      .values({
        orderSessionId: sessionId,
        storeId,
        requestNumber: 1,
        status: 'waitlisted',
        submittedAt: new Date(),
        requestedByUserId: fx.adminId,
      })
      .returning();
    const [item] = await db
      .insert(orderRequestItems)
      .values({ orderRequestId: order!.id, productId, requestedQuantity: quantity })
      .returning();
    const [ticket] = await db
      .insert(waitTickets)
      .values({
        storeId,
        productId,
        sourceOrderRequestItemId: item!.id,
        status: 'active',
        priorityLevel: 'P0B',
        originalQuantity: quantity,
        remainingQuantity: quantity,
        fulfilledQuantity: 0,
      })
      .returning();
    return ticket!;
  }

  async function ticketRow(id: string) {
    const [row] = await db.select().from(waitTickets).where(eq(waitTickets.id, id));
    return row!;
  }

  async function activeTickets(storeId: string, productId: string) {
    return db
      .select()
      .from(waitTickets)
      .where(
        and(
          eq(waitTickets.storeId, storeId),
          eq(waitTickets.productId, productId),
          eq(waitTickets.status, 'active'),
        ),
      );
  }

  async function cancel(
    waitTicketId: string,
    actorUserId: string,
    options: { fingerprint?: string | null; key?: string } = {},
  ) {
    const fingerprint =
      options.fingerprint === undefined
        ? (await previewWaitTicketCancellation(db, { actorUserId, waitTicketId })).scope.fingerprint
        : (options.fingerprint ?? undefined);
    return cancelWaitTicket(db, {
      waitTicketId,
      actorUserId,
      reason: 'Không cần nữa',
      ...(fingerprint ? { expectedFingerprint: fingerprint } : {}),
      idempotencyKey: options.key ?? randomUUID(),
      requestHash: `cancel:${waitTicketId}:${fingerprint ?? ''}`,
    });
  }

  async function insertOrderLine(
    sessionId: string,
    runId: string,
    storeId: string,
    productId: string,
    amounts: { allocated: number; waitlisted: number; sequence: number },
  ) {
    const requested = amounts.allocated + amounts.waitlisted;
    const [order] = await db
      .insert(orderRequests)
      .values({
        orderSessionId: sessionId,
        storeId,
        requestNumber: 1,
        status: 'allocated',
        submittedAt: new Date(),
        requestedByUserId: fx.adminId,
      })
      .onConflictDoNothing()
      .returning();
    const [existingOrder] = order
      ? [order]
      : await db
          .select()
          .from(orderRequests)
          .where(
            and(eq(orderRequests.orderSessionId, sessionId), eq(orderRequests.storeId, storeId)),
          )
          .limit(1);
    const [item] = await db
      .insert(orderRequestItems)
      .values({ orderRequestId: existingOrder!.id, productId, requestedQuantity: requested })
      .returning();
    const [merged] = await db
      .insert(mergedOrders)
      .values({ orderSessionId: sessionId, storeId, status: 'allocated', requestCount: 1 })
      .onConflictDoNothing()
      .returning();
    const [existingMerged] = merged
      ? [merged]
      : await db
          .select()
          .from(mergedOrders)
          .where(and(eq(mergedOrders.orderSessionId, sessionId), eq(mergedOrders.storeId, storeId)))
          .limit(1);
    const [mergedItem] = await db
      .insert(mergedOrderItems)
      .values({
        mergedOrderId: existingMerged!.id,
        productId,
        requestedQuantity: requested,
        priorityLevel: 'P1',
      })
      .returning();
    await db.insert(mergedOrderSources).values({
      mergedOrderItemId: mergedItem!.id,
      orderRequestItemId: item!.id,
      requestedQuantity: requested,
    });
    const [line] = await db
      .insert(allocationLines)
      .values({
        allocationRunId: runId,
        mergedOrderId: existingMerged!.id,
        storeId,
        productId,
        orderRequestItemId: item!.id,
        priorityLevel: 'P1',
        roundNumber: 1,
        sequenceInRound: amounts.sequence,
        requestedQuantity: requested,
        allocatedQuantity: amounts.allocated,
        waitlistedQuantity: amounts.waitlisted,
        status: amounts.allocated === 0 ? 'waitlisted' : 'allocated',
        reasonCode: 'TEST_DECISION',
      })
      .returning({ id: allocationLines.id });
    return line!.id;
  }

  async function createProduct() {
    const token = randomUUID().replaceAll('-', '');
    const [product] = await db
      .insert(products)
      .values({ sku: `DEC-${token}`, slug: `dec-${token}`, name: `Decision ${token.slice(0, 6)}` })
      .returning({ id: products.id });
    return product!.id;
  }

  async function openingStock(productId: string, quantity: number) {
    await withSerializableTransaction(db, (tx) =>
      applyWarehouseMovement(tx, {
        productId,
        eventType: 'opening_balance',
        onHandDelta: quantity,
        reservedDelta: 0,
        sourceType: 'decision_test_opening',
        sourceId: randomUUID(),
      }),
    );
  }

  async function balanceOf(productId: string) {
    const [row] = await db
      .select()
      .from(warehouseBalances)
      .where(eq(warehouseBalances.productId, productId));
    return { onHand: row?.onHandQuantity ?? 0, reserved: row?.reservedQuantity ?? 0 };
  }

  async function expectBalanceMatchesLedger(productId: string) {
    const [ledger] = await db
      .select({
        onHand: sql<number>`coalesce(sum(${warehouseLedgerEntries.onHandDelta}), 0)`.mapWith(
          Number,
        ),
        reserved: sql<number>`coalesce(sum(${warehouseLedgerEntries.reservedDelta}), 0)`.mapWith(
          Number,
        ),
      })
      .from(warehouseLedgerEntries)
      .where(eq(warehouseLedgerEntries.productId, productId));
    expect(await balanceOf(productId)).toEqual(ledger);
  }

  async function expectReservedMatchesActiveReservations(productId: string) {
    const [active] = await db
      .select({ value: sql<number>`coalesce(sum(${reservations.quantity}), 0)`.mapWith(Number) })
      .from(reservations)
      .where(and(eq(reservations.productId, productId), eq(reservations.status, 'active')));
    expect((await balanceOf(productId)).reserved).toBe(active!.value);
  }

  async function auditActions(entityId: string) {
    const rows = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.entityId, entityId))
      .orderBy(auditLogs.createdAt);
    return rows.map((row) => row.action);
  }

  async function outboundCount(storeId: string, runId: string) {
    const rows = await db
      .select({ id: outboundRequests.id })
      .from(outboundRequests)
      .where(
        and(eq(outboundRequests.storeId, storeId), eq(outboundRequests.allocationRunId, runId)),
      );
    return rows.length;
  }
});

async function createFixture() {
  const token = randomUUID().replaceAll('-', '');
  const [retailGroup] = await db
    .insert(storeGroups)
    .values({ code: `DEC-R-${token}`, name: `Decision retail ${token.slice(0, 6)}` })
    .returning();
  const [wholesaleGroup] = await db
    .insert(storeGroups)
    .values({ code: `DEC-W-${token}`, name: `Decision wholesale ${token.slice(0, 6)}` })
    .returning();
  const createStore = async (suffix: string, groupId: string, kind: 'retail' | 'wholesale') => {
    const [store] = await db
      .insert(stores)
      .values({ code: `DEC-${suffix}-${token}`, name: `Decision ${suffix}`, groupId, kind })
      .returning();
    return store!;
  };
  const createUser = async (
    suffix: string,
    role: 'admin' | 'htkd' | 'store' | 'wholesale',
    storeId: string | null,
  ) => {
    const [user] = await db
      .insert(users)
      .values({
        email: `dec-${suffix}-${token}@example.test`,
        passwordHash: 'decision-test-password-hash-placeholder',
        displayName: `Decision ${suffix}`,
        role,
        storeId,
      })
      .returning({ id: users.id });
    return user!.id;
  };
  const storeA = await createStore('A', retailGroup!.id, 'retail');
  const storeB = await createStore('B', retailGroup!.id, 'retail');
  const wholesaleStore = await createStore('W', wholesaleGroup!.id, 'wholesale');
  const [productA] = await db
    .insert(products)
    .values({ sku: `DEC-PA-${token}`, slug: `dec-pa-${token}`, name: 'Decision product A' })
    .returning({ id: products.id });
  const [productB] = await db
    .insert(products)
    .values({ sku: `DEC-PB-${token}`, slug: `dec-pb-${token}`, name: 'Decision product B' })
    .returning({ id: products.id });
  for (const productId of [productA!.id, productB!.id]) {
    await withSerializableTransaction(db, (tx) =>
      applyWarehouseMovement(tx, {
        productId,
        eventType: 'opening_balance',
        onHandDelta: 100,
        reservedDelta: 0,
        sourceType: 'decision_test_opening',
        sourceId: randomUUID(),
      }),
    );
  }
  return {
    storeA: { id: storeA.id, userId: await createUser('store-a', 'store', storeA.id) },
    storeB: { id: storeB.id, userId: await createUser('store-b', 'store', storeB.id) },
    wholesaleStore: { id: wholesaleStore.id },
    wholesaleUserId: await createUser('wholesale', 'wholesale', null),
    htkdId: await createUser('htkd', 'htkd', null),
    adminId: await createUser('admin', 'admin', null),
    productA: productA!.id,
    productB: productB!.id,
  };
}
