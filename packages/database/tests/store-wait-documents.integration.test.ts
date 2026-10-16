import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  allocationLines,
  allocationResultDecisions,
  allocationRuns,
  applyWarehouseMovement,
  cancelStoreWaitDocument,
  cancelWaitTicket,
  closeDatabase,
  dailyPriorityOffers,
  db,
  getStoreWaitDocument,
  htkdAssignments,
  inventorySnapshots,
  listSessionDocuments,
  listStoreWaitDocuments,
  mergedOrderItems,
  mergedOrders,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  orderSessions,
  previewStoreWaitDocumentCancellation,
  previewWaitTicketCancellation,
  products,
  publishAllocationDecisionsInTransaction,
  reconcileStoreWaitDocumentsInTransaction,
  reservations,
  respondAllocationDecision,
  reshareOrders,
  storeGroups,
  stores,
  StoreWaitDocumentNotFoundError,
  StoreWaitDocumentSupersededError,
  storeWaitDocumentEvents,
  storeWaitDocumentLines,
  storeWaitDocuments,
  syncAllStoreWaitDocuments,
  users,
  waitTickets,
  WaitTicketPreviewStaleError,
  warehouseBalances,
  withSerializableTransaction,
  withTransaction,
} from '../src/index.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

type Fixture = Awaited<ReturnType<typeof createFixture>>;

describePostgres('store wait documents (phiếu chờ tổng)', () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await createFixture();
  });
  afterAll(async () => {
    await closeDatabase();
  });

  it('A: merges B (2 nam + 2 nữ) with new demand into C and keeps B as history', async () => {
    const store = await createStore();
    const nam = await createTicket(store.id, fx.nam, 2);
    await createTicket(store.id, fx.nu, 2);
    await reconcile(store.id, 'allocation_run', `run:${randomUUID()}`);
    const b = await currentDocument(store.id);
    expect(b.code).toMatch(/^PCT-\d{6}$/u);
    expect(lineSummary(b)).toEqual({ [fx.nam]: [0, 2], [fx.nu]: [0, 2] });

    // Day 2: the run queues 1 more nam on the active ticket and 3 trẻ em on a new one.
    await db
      .update(waitTickets)
      .set({ originalQuantity: 3, remainingQuantity: 3 })
      .where(eq(waitTickets.id, nam.id));
    await createTicket(store.id, fx.tre, 3);
    const sourceKey = `run:${randomUUID()}`;
    await reconcile(store.id, 'allocation_run', sourceKey);
    const c = await currentDocument(store.id);
    expect(c.id).not.toBe(b.id);
    expect(lineSummary(c)).toEqual({ [fx.nam]: [2, 1], [fx.nu]: [2, 0], [fx.tre]: [0, 3] });
    expect(c.predecessor).toEqual({ id: b.id, code: b.code });
    expect(c.chainSequence).toBe(2);

    const history = await getStoreWaitDocument(db, { actorUserId: fx.adminId, documentId: b.id });
    expect(history.status).toBe('merged');
    expect(history.successor).toEqual({ id: c.id, code: c.code });
    expect(history.currentDocument).toEqual({ id: c.id, code: c.code });
    // B's snapshot is frozen: 2 nam + 2 nữ handed over, nothing confirmed or cancelled.
    expect(
      history.lines.map((line) => [
        line.productId,
        line.carriedOutQuantity,
        line.cancelledQuantity,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [fx.nam, 2, 0],
        [fx.nu, 2, 0],
      ]),
    );
    expect(history.lines.every((line) => line.remainingQuantity === null)).toBe(true);
    expect(history.chain.map((row) => row.code)).toEqual([b.code, c.code]);

    // A retry of the same event, or a refresh, changes nothing.
    await reconcile(store.id, 'allocation_run', sourceKey);
    await syncAllStoreWaitDocuments(db);
    expect((await currentDocument(store.id)).id).toBe(c.id);
    expect(await documentCount(store.id)).toBe(2);
  });

  it('B/C: a PENDING grant stays on C; confirming it rolls the rest over to D, then completes', async () => {
    const store = await createStore();
    const nam = await createTicket(store.id, fx.nam, 3);
    const nu = await createTicket(store.id, fx.nu, 2);
    await createTicket(store.id, fx.tre, 3);
    await reconcile(store.id, 'allocation_run', `run:${randomUUID()}`);
    const c = await currentDocument(store.id);

    // The run grants 1 nam + 2 nữ from the tickets, awaiting the store's answer.
    const result = await publishTicketResult(store.id, [
      { ticketId: nam.id, productId: fx.nam, quantity: 1 },
      { ticketId: nu.id, productId: fx.nu, quantity: 2 },
    ]);
    await reconcile(store.id, 'allocation_run', `allocation-run:${result.runId}`);
    const unchanged = await currentDocument(store.id);
    expect(unchanged.id).toBe(c.id);
    const live = Object.fromEntries(
      unchanged.lines.map((line) => [
        line.productId,
        [line.remainingQuantity, line.pendingQuantity],
      ]),
    );
    expect(live).toEqual({ [fx.nam]: [2, 1], [fx.nu]: [0, 2], [fx.tre]: [3, 0] });
    const detail = await getStoreWaitDocument(db, { actorUserId: store.userId, documentId: c.id });
    expect(detail.pendingResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          allocationDecisionId: result.decisionId,
          productId: fx.nam,
          quantity: 1,
        }),
        expect.objectContaining({
          allocationDecisionId: result.decisionId,
          productId: fx.nu,
          quantity: 2,
        }),
      ]),
    );

    await respondAllocationDecision(db, {
      decisionId: result.decisionId,
      action: 'ACCEPT',
      expectedVersion: 1,
      actorUserId: store.userId,
      idempotencyKey: randomUUID(),
      requestHash: 'accept',
    });
    const d = await currentDocument(store.id);
    expect(d.predecessor?.id).toBe(c.id);
    expect(lineSummary(d)).toEqual({ [fx.nam]: [2, 0], [fx.tre]: [3, 0] });
    const closedC = await getStoreWaitDocument(db, { actorUserId: store.userId, documentId: c.id });
    expect(closedC.status).toBe('rolled_over');
    expect(
      Object.fromEntries(
        closedC.lines.map((line) => [
          line.productId,
          [line.confirmedQuantity, line.carriedOutQuantity],
        ]),
      ),
    ).toEqual({ [fx.nam]: [1, 2], [fx.nu]: [2, 0], [fx.tre]: [0, 3] });
    const [re] = await db
      .select({ code: reshareOrders.code })
      .from(reshareOrders)
      .where(eq(reshareOrders.allocationDecisionId, result.decisionId));
    expect(closedC.closedEvent).toMatchObject({
      kind: 'result_accepted',
      allocationDecisionId: result.decisionId,
      actorUserId: store.userId,
      actorRole: 'store',
      reshareOrderCode: re!.code,
    });

    // Confirming everything that is left completes D without an empty successor.
    const tre = (await activeTickets(store.id)).find((t) => t.productId === fx.tre)!;
    const last = await publishTicketResult(store.id, [
      { ticketId: nam.id, productId: fx.nam, quantity: 2 },
      { ticketId: tre.id, productId: fx.tre, quantity: 3 },
    ]);
    await reconcile(store.id, 'allocation_run', `allocation-run:${last.runId}`);
    expect((await currentDocument(store.id)).id).toBe(d.id);
    await db.insert(htkdAssignments).values({ userId: fx.htkdId, storeId: store.id });
    await respondAllocationDecision(db, {
      decisionId: last.decisionId,
      action: 'ACCEPT',
      expectedVersion: 1,
      actorUserId: fx.htkdId,
      idempotencyKey: randomUUID(),
      requestHash: 'accept',
    });
    expect(await currentDocumentOrNull(store.id)).toBeNull();
    const closedD = await getStoreWaitDocument(db, { actorUserId: fx.adminId, documentId: d.id });
    expect(closedD.status).toBe('completed');
    expect(closedD.successor).toBeNull();
    expect(closedD.closedEvent?.actorRole).toBe('htkd');
  });

  it('C: new demand while a grant awaits the answer keeps the PENDING goods on the newest document', async () => {
    const store = await createStore();
    const nam = await createTicket(store.id, fx.nam, 2);
    await createTicket(store.id, fx.nu, 2);
    await reconcile(store.id, 'allocation_run', `run:${randomUUID()}`);
    const b = await currentDocument(store.id);
    const result = await publishTicketResult(store.id, [
      { ticketId: nam.id, productId: fx.nam, quantity: 1 },
    ]);
    await reconcile(store.id, 'allocation_run', `allocation-run:${result.runId}`);
    expect((await currentDocument(store.id)).id).toBe(b.id);

    await createTicket(store.id, fx.tre, 1);
    await reconcile(store.id, 'allocation_run', `run:${randomUUID()}`);
    const c = await currentDocument(store.id);
    expect(
      Object.fromEntries(
        c.lines.map((line) => [
          line.productId,
          [line.openingRemainingQuantity, line.openingPendingQuantity],
        ]),
      ),
    ).toEqual({ [fx.nam]: [1, 1], [fx.nu]: [2, 0], [fx.tre]: [1, 0] });

    await respondAllocationDecision(db, {
      decisionId: result.decisionId,
      action: 'ACCEPT',
      expectedVersion: 1,
      actorUserId: store.userId,
      idempotencyKey: randomUUID(),
      requestHash: 'accept',
    });
    const closedB = await getStoreWaitDocument(db, { actorUserId: fx.adminId, documentId: b.id });
    expect(closedB).toMatchObject({ status: 'merged', version: 2 });
    expect(closedB.lines.every((line) => line.confirmedQuantity === 0)).toBe(true);
    const closedC = await getStoreWaitDocument(db, { actorUserId: fx.adminId, documentId: c.id });
    expect(closedC.status).toBe('rolled_over');
    expect(closedC.lines.find((line) => line.productId === fx.nam)?.confirmedQuantity).toBe(1);
    // The answer was recorded once: replaying the command changes nothing more.
    expect(await documentCount(store.id)).toBe(3);
  });

  it('session documents show the wait document before and after each run', async () => {
    const store = await createStore();
    await createTicket(store.id, fx.nu, 3);
    await reconcile(store.id, 'allocation_run', `run:${randomUUID()}`);
    const old = await currentDocument(store.id);

    // The run grants 2 nam of a 6-bag order and queues the other 4 on a new ticket.
    const run = await publishOrderResult(store.id, fx.nam, 2);
    await createTicket(store.id, fx.nam, 4);
    await withSerializableTransaction(db, (tx) =>
      reconcileStoreWaitDocumentsInTransaction(tx, [
        {
          storeId: store.id,
          event: {
            kind: 'allocation_run',
            sourceKey: `allocation-run:${run.runId}`,
            actorUserId: null,
            occurredAt: new Date(),
            orderSessionId: run.sessionId,
            allocationRunId: run.runId,
          },
        },
      ]),
    );
    const next = await currentDocument(store.id);
    expect(next.id).not.toBe(old.id);

    // A later run that leaves the open demand unchanged writes no event.
    const quiet = await publishOrderResult(store.id, fx.tre, 1);
    await db
      .update(allocationRuns)
      .set({ finishedAt: new Date() })
      .where(eq(allocationRuns.id, quiet.runId));

    const read = async (includeWaitDocuments: boolean) =>
      (
        await listSessionDocuments(db, {
          page: 1,
          pageSize: 20,
          storeIds: [store.id],
          includeWaitDocuments,
        })
      ).data;
    const documents = await read(true);
    const byRun = new Map(documents.map((document) => [document.allocationRunId, document]));
    const changed = byRun.get(run.runId)!;
    expect('waitDocuments' in changed && changed.waitDocuments).toEqual({
      before: {
        id: old.id,
        code: old.code,
        lines: [{ productId: fx.nu, quantity: 3, remainingQuantity: 3, pendingQuantity: 0 }],
      },
      after: {
        id: next.id,
        code: next.code,
        lines: expect.arrayContaining([
          { productId: fx.nu, quantity: 3, remainingQuantity: 3, pendingQuantity: 0 },
          { productId: fx.nam, quantity: 4, remainingQuantity: 4, pendingQuantity: 0 },
        ]),
      },
      changed: true,
      removed: [],
    });
    const unchanged = byRun.get(quiet.runId)!;
    expect('waitDocuments' in unchanged && unchanged.waitDocuments).toMatchObject({
      before: { id: next.id },
      after: { id: next.id },
      changed: false,
    });
    // Without the opt-in the document keeps its previous shape.
    expect((await read(false)).every((document) => !('waitDocuments' in document))).toBe(true);
  });

  it('session documents split each wait document at the run: still waiting vs granted awaiting the answer', async () => {
    // DS TH: day 15 waits 3 nam + 1 short + 2 nữ; the run grants 1 nữ from the ticket. Day 16
    // orders 2 đầm + 2 đồ bộ; the run grants 1 nam + 1 short + 1 nữ from the tickets and queues
    // 1 đồ bộ. "Phiếu chờ mới" of day 16 is what still waits: 2 nam + 1 đồ bộ.
    const store = await createStore();
    const nam = await createTicket(store.id, fx.nam, 3);
    const short = await createTicket(store.id, fx.short, 1);
    const nu = await createTicket(store.id, fx.nu, 2);
    await reconcile(store.id, 'allocation_run', `run:${randomUUID()}`);
    const day15Document = await currentDocument(store.id);

    const day15 = await publishTicketResult(store.id, [
      { ticketId: nu.id, productId: fx.nu, quantity: 1 },
    ]);
    await markRunFinished(day15.runId);
    await reconcileRun(store.id, day15);
    expect((await currentDocument(store.id)).id).toBe(day15Document.id);
    await respondAllocationDecision(db, {
      decisionId: day15.decisionId,
      action: 'ACCEPT',
      expectedVersion: 1,
      actorUserId: store.userId,
      idempotencyKey: randomUUID(),
      requestHash: 'accept',
    });
    const day16Document = await currentDocument(store.id);
    expect(lineSummaryTotals(day16Document)).toEqual({ [fx.nam]: 3, [fx.short]: 1, [fx.nu]: 1 });

    const day16 = await publishTicketResult(store.id, [
      { ticketId: nam.id, productId: fx.nam, quantity: 1 },
      { ticketId: short.id, productId: fx.short, quantity: 1 },
      { ticketId: nu.id, productId: fx.nu, quantity: 1 },
    ]);
    await createTicket(store.id, fx.bo, 1);
    await markRunFinished(day16.runId);
    await reconcileRun(store.id, day16);
    const afterDay16 = await currentDocument(store.id);
    expect(afterDay16.id).not.toBe(day16Document.id);

    const byRun = await waitDocumentsByRun(store.id);
    expect(byRun.get(day15.runId)).toEqual({
      before: {
        id: day15Document.id,
        code: day15Document.code,
        lines: split({ [fx.nam]: [3, 0], [fx.short]: [1, 0], [fx.nu]: [2, 0] }),
      },
      after: {
        id: day15Document.id,
        code: day15Document.code,
        lines: split({ [fx.nam]: [3, 0], [fx.short]: [1, 0], [fx.nu]: [1, 1] }),
      },
      changed: false,
      removed: [],
    });
    expect(byRun.get(day16.runId)).toEqual({
      before: {
        id: day16Document.id,
        code: day16Document.code,
        lines: split({ [fx.nam]: [3, 0], [fx.short]: [1, 0], [fx.nu]: [1, 0] }),
      },
      after: {
        id: afterDay16.id,
        code: afterDay16.code,
        lines: split({ [fx.nam]: [2, 1], [fx.short]: [0, 1], [fx.nu]: [0, 1], [fx.bo]: [1, 0] }),
      },
      changed: true,
      removed: [],
    });
  });

  it('session documents keep earlier unanswered grants apart across runs that leave the document unchanged', async () => {
    const store = await createStore();
    const nam = await createTicket(store.id, fx.nam, 3);
    const nu = await createTicket(store.id, fx.nu, 2);
    await reconcile(store.id, 'allocation_run', `run:${randomUUID()}`);
    const document = await currentDocument(store.id);

    // Day 1 grants 1 nữ, never answered; day 2 grants 1 nam. Neither changes the open demand.
    const first = await publishTicketResult(store.id, [
      { ticketId: nu.id, productId: fx.nu, quantity: 1 },
    ]);
    await markRunFinished(first.runId);
    await reconcileRun(store.id, first);
    const second = await publishTicketResult(store.id, [
      { ticketId: nam.id, productId: fx.nam, quantity: 1 },
    ]);
    await markRunFinished(second.runId);
    await reconcileRun(store.id, second);
    expect((await currentDocument(store.id)).id).toBe(document.id);

    const byRun = await waitDocumentsByRun(store.id);
    expect(byRun.get(second.runId)).toMatchObject({
      before: { id: document.id, lines: split({ [fx.nam]: [3, 0], [fx.nu]: [1, 1] }) },
      after: { id: document.id, lines: split({ [fx.nam]: [2, 1], [fx.nu]: [1, 1] }) },
      changed: false,
    });
    // History never drifts: the first run still reads as it was when it ran.
    expect(byRun.get(first.runId)).toMatchObject({
      before: { lines: split({ [fx.nam]: [3, 0], [fx.nu]: [2, 0] }) },
      after: { lines: split({ [fx.nam]: [3, 0], [fx.nu]: [1, 1] }) },
    });
  });

  it('session documents count a grant moved back to waiting as waiting again', async () => {
    const store = await createStore();
    const nam = await createTicket(store.id, fx.nam, 3);
    const nu = await createTicket(store.id, fx.nu, 2);
    await reconcile(store.id, 'allocation_run', `run:${randomUUID()}`);

    const first = await publishTicketResult(store.id, [
      { ticketId: nu.id, productId: fx.nu, quantity: 1 },
    ]);
    await markRunFinished(first.runId);
    await reconcileRun(store.id, first);
    await respondAllocationDecision(db, {
      decisionId: first.decisionId,
      action: 'WAITLIST',
      expectedVersion: 1,
      actorUserId: store.userId,
      idempotencyKey: randomUUID(),
      requestHash: 'waitlist',
    });
    const document = await currentDocument(store.id);
    const second = await publishTicketResult(store.id, [
      { ticketId: nam.id, productId: fx.nam, quantity: 1 },
    ]);
    await markRunFinished(second.runId);
    await reconcileRun(store.id, second);
    expect((await currentDocument(store.id)).id).toBe(document.id);

    expect((await waitDocumentsByRun(store.id)).get(second.runId)).toMatchObject({
      before: { id: document.id, lines: split({ [fx.nam]: [3, 0], [fx.nu]: [2, 0] }) },
      after: { id: document.id, lines: split({ [fx.nam]: [2, 1], [fx.nu]: [2, 0] }) },
      changed: false,
    });
  });

  it('session documents list what a run removed without granting: an unanswered full offer', async () => {
    // DS CT waits 1 nam + 1 short. Its 1 short had a full priority offer nobody answered, so the
    // 09:00 run cancels that ticket while it queues 1 đồ bộ from today's order. Old − removed +
    // new waiting = new: 1 nam + 1 short − 1 short + 1 đồ bộ = 1 nam + 1 đồ bộ.
    const store = await createStore();
    await createTicket(store.id, fx.nam, 1);
    const short = await createTicket(store.id, fx.short, 1);
    await reconcile(store.id, 'allocation_run', `run:${randomUUID()}`);
    const old = await currentDocument(store.id);

    const run = await publishOrderResult(store.id, fx.nu, 1);
    await db
      .update(waitTickets)
      .set({ status: 'cancelled', resolvedAt: new Date() })
      .where(eq(waitTickets.id, short.id));
    await createTicket(store.id, fx.bo, 1);
    await markRunFinished(run.runId);
    await withSerializableTransaction(db, (tx) =>
      reconcileStoreWaitDocumentsInTransaction(tx, [
        {
          storeId: store.id,
          declared: [{ productId: fx.short, category: 'cancelled', quantity: 1 }],
          event: {
            kind: 'allocation_run',
            sourceKey: `allocation-run:${run.runId}`,
            actorUserId: null,
            occurredAt: new Date(),
            orderSessionId: run.sessionId,
            allocationRunId: run.runId,
          },
        },
      ]),
    );
    const next = await currentDocument(store.id);

    expect((await waitDocumentsByRun(store.id)).get(run.runId)).toEqual({
      before: {
        id: old.id,
        code: old.code,
        lines: split({ [fx.nam]: [1, 0], [fx.short]: [1, 0] }),
      },
      after: { id: next.id, code: next.code, lines: split({ [fx.nam]: [1, 0], [fx.bo]: [1, 0] }) },
      changed: true,
      removed: [{ productId: fx.short, quantity: 1, reason: 'PRIORITY_RESPONSE_TIMEOUT' }],
    });
  });

  it('session documents report an undeclared drop of a run as a system adjustment', async () => {
    const store = await createStore();
    const nam = await createTicket(store.id, fx.nam, 2);
    await reconcile(store.id, 'allocation_run', `run:${randomUUID()}`);

    const run = await publishOrderResult(store.id, fx.nu, 1);
    // A drop no writer declared (as left by a writer without documents).
    await db
      .update(waitTickets)
      .set({ remainingQuantity: 1, fulfilledQuantity: 1 })
      .where(eq(waitTickets.id, nam.id));
    await markRunFinished(run.runId);
    await reconcileRun(store.id, run);

    expect((await waitDocumentsByRun(store.id)).get(run.runId)).toMatchObject({
      changed: true,
      removed: [{ productId: fx.nam, quantity: 1, reason: 'SYSTEM_ADJUSTMENT' }],
    });
  });

  it('a document whose open demand only awaits an answer stays open; no empty successor', async () => {
    const store = await createStore();
    const nam = await createTicket(store.id, fx.nam, 1);
    await reconcile(store.id, 'allocation_run', `run:${randomUUID()}`);
    const doc = await currentDocument(store.id);
    const result = await publishTicketResult(store.id, [
      { ticketId: nam.id, productId: fx.nam, quantity: 1 },
    ]);
    await reconcile(store.id, 'allocation_run', `allocation-run:${result.runId}`);
    const still = await currentDocument(store.id);
    expect(still.id).toBe(doc.id);
    expect(still.lines[0]).toMatchObject({ remainingQuantity: 0, pendingQuantity: 1 });
    await respondAllocationDecision(db, {
      decisionId: result.decisionId,
      action: 'ACCEPT',
      expectedVersion: 1,
      actorUserId: store.userId,
      idempotencyKey: randomUUID(),
      requestHash: 'accept',
    });
    expect(await currentDocumentOrNull(store.id)).toBeNull();
    expect(await documentCount(store.id)).toBe(1);
  });

  it('D: 10/6/4 — accepting ordinary goods leaves the document; moving them back merges 4 + 6 = 10', async () => {
    for (const action of ['ACCEPT', 'WAITLIST'] as const) {
      const store = await createStore();
      // The order of 10 was granted 6; the run queued the other 4 on a wait ticket.
      const result = await publishOrderResult(store.id, fx.nam, 6);
      await createTicket(store.id, fx.nam, 4);
      await reconcile(store.id, 'allocation_run', `run:${randomUUID()}`);
      const before = await currentDocument(store.id);
      await respondAllocationDecision(db, {
        decisionId: result.decisionId,
        action,
        expectedVersion: 1,
        actorUserId: store.userId,
        idempotencyKey: randomUUID(),
        requestHash: action,
      });
      const after = await currentDocument(store.id);
      if (action === 'ACCEPT') {
        expect(after.id).toBe(before.id);
        expect(after.lines[0]).toMatchObject({ remainingQuantity: 4, pendingQuantity: 0 });
      } else {
        expect(after.predecessor?.id).toBe(before.id);
        expect(lineSummary(after)).toEqual({ [fx.nam]: [4, 6] });
        expect(after.openedEvent).toMatchObject({
          kind: 'result_waitlisted',
          allocationDecisionId: result.decisionId,
        });
        const merged = await getStoreWaitDocument(db, {
          actorUserId: fx.adminId,
          documentId: before.id,
        });
        expect(merged.status).toBe('merged');
      }
    }
  });

  it('cancelling one ticket line rolls the other products over; cancelling the whole document closes it', async () => {
    const store = await createStore();
    const nam = await createTicket(store.id, fx.nam, 2);
    await createTicket(store.id, fx.nu, 1);
    await reconcile(store.id, 'allocation_run', `run:${randomUUID()}`);
    const first = await currentDocument(store.id);
    const preview = await previewWaitTicketCancellation(db, {
      actorUserId: store.userId,
      waitTicketId: nam.id,
    });
    await cancelWaitTicket(db, {
      waitTicketId: nam.id,
      actorUserId: store.userId,
      reason: 'Không cần nam nữa',
      expectedFingerprint: preview.scope.fingerprint,
      idempotencyKey: randomUUID(),
      requestHash: 'cancel-nam',
    });
    const second = await currentDocument(store.id);
    expect(lineSummary(second)).toEqual({ [fx.nu]: [1, 0] });
    const closed = await getStoreWaitDocument(db, {
      actorUserId: store.userId,
      documentId: first.id,
    });
    expect(closed.status).toBe('rolled_over');
    expect(closed.lines.find((line) => line.productId === fx.nam)).toMatchObject({
      cancelledQuantity: 2,
      carriedOutQuantity: 0,
    });
    expect(closed.closedEvent).toMatchObject({
      kind: 'wait_ticket_cancelled',
      reason: 'Không cần nam nữa',
      waitTicketCode: nam.code,
    });

    // The old document refuses a cancellation instead of silently cancelling its successor.
    await expect(
      previewStoreWaitDocumentCancellation(db, { actorUserId: store.userId, documentId: first.id }),
    ).rejects.toBeInstanceOf(StoreWaitDocumentSupersededError);

    const docPreview = await previewStoreWaitDocumentCancellation(db, {
      actorUserId: store.userId,
      documentId: second.id,
    });
    await expect(
      cancelStoreWaitDocument(db, {
        documentId: second.id,
        actorUserId: store.userId,
        reason: 'Đóng phiếu',
        expectedFingerprint: '0'.repeat(64),
        idempotencyKey: randomUUID(),
        requestHash: 'stale',
      }),
    ).rejects.toBeInstanceOf(WaitTicketPreviewStaleError);
    const key = randomUUID();
    const cancelled = await cancelStoreWaitDocument(db, {
      documentId: second.id,
      actorUserId: store.userId,
      reason: 'Đóng phiếu',
      expectedFingerprint: docPreview.fingerprint,
      idempotencyKey: key,
      requestHash: 'doc-cancel',
    });
    if (cancelled.replayed) throw new Error('The first cancellation must not be a replay.');
    expect(cancelled.value).toMatchObject({ cancelledQuantity: 1, currentDocumentId: null });
    expect(await currentDocumentOrNull(store.id)).toBeNull();
    const done = await getStoreWaitDocument(db, {
      actorUserId: store.userId,
      documentId: second.id,
    });
    expect(done.status).toBe('cancelled');
    expect(done.closedEvent).toMatchObject({
      kind: 'wait_document_cancelled',
      reason: 'Đóng phiếu',
    });
    // Same key, same body: the stored answer, nothing new.
    const replay = await cancelStoreWaitDocument(db, {
      documentId: second.id,
      actorUserId: store.userId,
      reason: 'Đóng phiếu',
      expectedFingerprint: docPreview.fingerprint,
      idempotencyKey: key,
      requestHash: 'doc-cancel',
    });
    expect(replay.replayed).toBe(true);
    expect(await documentCount(store.id)).toBe(2);
  });

  it('cancelling a document revokes PENDING goods of its tickets and keeps goods of a cancelled source', async () => {
    const store = await createStore();
    const nam = await createTicket(store.id, fx.nam, 3);
    await reconcile(store.id, 'allocation_run', `run:${randomUUID()}`);
    const result = await publishTicketResult(store.id, [
      { ticketId: nam.id, productId: fx.nam, quantity: 1 },
    ]);
    await reconcile(store.id, 'allocation_run', `allocation-run:${result.runId}`);
    const doc = await currentDocument(store.id);
    const reservedBefore = await reserved(fx.nam);
    const preview = await previewStoreWaitDocumentCancellation(db, {
      actorUserId: store.userId,
      documentId: doc.id,
    });
    expect(preview.tickets.map((scope) => scope.ticket.id)).toEqual([nam.id]);
    expect(preview.tickets[0]!.lines.filter((line) => line.kind === 'REVOCABLE')).toHaveLength(1);
    await cancelStoreWaitDocument(db, {
      documentId: doc.id,
      actorUserId: store.userId,
      reason: 'Không cần',
      expectedFingerprint: preview.fingerprint,
      idempotencyKey: randomUUID(),
      requestHash: 'doc-cancel',
    });
    expect(await reserved(fx.nam)).toBe(reservedBefore - 1);
    const closed = await getStoreWaitDocument(db, { actorUserId: fx.adminId, documentId: doc.id });
    expect(closed.status).toBe('cancelled');
    expect(closed.lines[0]).toMatchObject({ cancelledQuantity: 3, carriedOutQuantity: 0 });
    const [decision] = await db
      .select()
      .from(allocationResultDecisions)
      .where(eq(allocationResultDecisions.id, result.decisionId));
    expect(decision!.status).toBe('cancelled');
  });

  it('scopes lists and details server-side for store, HTKD and admin accounts', async () => {
    const storeA = await createStore();
    const storeB = await createStore();
    await createTicket(storeA.id, fx.nam, 1);
    await createTicket(storeB.id, fx.nu, 1);
    await reconcile(storeA.id, 'allocation_run', `run:${randomUUID()}`);
    await reconcile(storeB.id, 'allocation_run', `run:${randomUUID()}`);
    const docB = await currentDocument(storeB.id);

    const own = await listStoreWaitDocuments(db, { actorUserId: storeA.userId, view: 'ALL' });
    expect(new Set(own.data.map((row) => row.storeId))).toEqual(new Set([storeA.id]));
    await expect(
      getStoreWaitDocument(db, { actorUserId: storeA.userId, documentId: docB.id }),
    ).rejects.toBeInstanceOf(StoreWaitDocumentNotFoundError);

    const htkd = await createUser('htkd', null);
    expect(
      (await listStoreWaitDocuments(db, { actorUserId: htkd, view: 'ALL' })).pagination.totalItems,
    ).toBe(0);
    await db.insert(htkdAssignments).values({ userId: htkd, storeId: storeB.id });
    const assigned = await listStoreWaitDocuments(db, { actorUserId: htkd, view: 'ACTIVE' });
    expect(assigned.data.map((row) => row.id)).toEqual([docB.id]);
    await db
      .update(htkdAssignments)
      .set({ revokedAt: new Date() })
      .where(eq(htkdAssignments.userId, htkd));
    expect(
      (await listStoreWaitDocuments(db, { actorUserId: htkd, view: 'ALL' })).pagination.totalItems,
    ).toBe(0);

    const admin = await listStoreWaitDocuments(db, {
      actorUserId: fx.adminId,
      storeId: storeB.id,
      q: docB.code,
    });
    expect(admin.data.map((row) => row.id)).toEqual([docB.id]);
    const byTicket = await listStoreWaitDocuments(db, {
      actorUserId: fx.adminId,
      view: 'ALL',
      q: (await activeTickets(storeB.id))[0]!.code,
    });
    expect(byTicket.data.map((row) => row.id)).toEqual([docB.id]);
    // A product filter selects documents but returns every line of them.
    const byProduct = await listStoreWaitDocuments(db, {
      actorUserId: fx.adminId,
      storeId: storeB.id,
      productId: fx.nu,
    });
    expect(byProduct.pagination.totalItems).toBe(1);
  });

  it('the database keeps one current document per store and never edits a closed one', async () => {
    const store = await createStore();
    await createTicket(store.id, fx.nam, 1);
    await reconcile(store.id, 'allocation_run', `run:${randomUUID()}`);
    const doc = await currentDocument(store.id);
    await expect(
      db.transaction(async (tx) => {
        const [event] = await tx
          .insert(storeWaitDocumentEvents)
          .values({ storeId: store.id, kind: 'system_sync', occurredAt: new Date() })
          .returning();
        const id = randomUUID();
        await tx.insert(storeWaitDocuments).values({
          id,
          storeId: store.id,
          status: 'current',
          chainId: id,
          chainSequence: 1,
          openedEventId: event!.id,
          openedAt: new Date(),
          waitingSince: new Date(),
        });
      }),
    ).rejects.toThrow();
    await expect(
      db
        .update(storeWaitDocumentLines)
        .set({ addedQuantity: 9 })
        .where(eq(storeWaitDocumentLines.documentId, doc.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(storeWaitDocuments).where(eq(storeWaitDocuments.id, doc.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(storeWaitDocumentEvents).where(eq(storeWaitDocumentEvents.storeId, store.id)),
    ).rejects.toThrow();
    // Closing without handing the bags to a successor fails at commit.
    await expect(
      db.transaction(async (tx) => {
        const [event] = await tx
          .insert(storeWaitDocumentEvents)
          .values({ storeId: store.id, kind: 'system_sync', occurredAt: new Date() })
          .returning();
        await tx
          .update(storeWaitDocuments)
          .set({
            status: 'rolled_over',
            version: 2,
            closedAt: new Date(),
            closedEventId: event!.id,
          })
          .where(eq(storeWaitDocuments.id, doc.id));
        await tx
          .update(storeWaitDocumentLines)
          .set({
            confirmedQuantity: 0,
            cancelledQuantity: 0,
            adjustedQuantity: 0,
            carriedOutQuantity: 1,
          })
          .where(eq(storeWaitDocumentLines.documentId, doc.id));
      }),
    ).rejects.toThrow();
    expect((await currentDocument(store.id)).id).toBe(doc.id);
  });

  it('concurrent events of one store end with exactly one current document holding both', async () => {
    const store = await createStore();
    await createTicket(store.id, fx.nam, 1);
    await reconcile(store.id, 'allocation_run', `run:${randomUUID()}`);
    // Two commands each add demand of another product and reconcile at their end, in parallel.
    const sessions = [(await createRun()).sessionId, (await createRun()).sessionId];
    const add = (productId: string, sessionId: string) =>
      withSerializableTransaction(
        db,
        async (tx) => {
          const ticket = await createTicketIn(tx, sessionId, store.id, productId, 2);
          await reconcileStoreWaitDocumentsInTransaction(tx, [
            {
              storeId: store.id,
              event: {
                kind: 'receipt_shortage',
                sourceKey: `concurrent:${ticket.id}`,
                actorUserId: null,
                occurredAt: new Date(),
              },
            },
          ]);
        },
        { maxAttempts: 8 },
      );
    await Promise.all([add(fx.nu, sessions[0]!), add(fx.tre, sessions[1]!)]);
    const current = await currentDocument(store.id);
    expect(lineSummaryTotals(current)).toEqual({ [fx.nam]: 1, [fx.nu]: 2, [fx.tre]: 2 });
    const [currents] = await db
      .select({ value: sql<number>`count(*)`.mapWith(Number) })
      .from(storeWaitDocuments)
      .where(
        and(eq(storeWaitDocuments.storeId, store.id), eq(storeWaitDocuments.status, 'current')),
      );
    expect(currents!.value).toBe(1);
    // Every hand-over in the chain conserves the bags (checked by the commit triggers too).
    const chain = await getStoreWaitDocument(db, {
      actorUserId: fx.adminId,
      documentId: current.id,
    });
    expect(chain.chain.map((row) => row.chainSequence)).toEqual([1, 2, 3]);
  });

  it('system catch-up records a difference left by a writer without documents, once', async () => {
    const store = await createStore();
    await createTicket(store.id, fx.nam, 2);
    await reconcile(store.id, 'allocation_run', `run:${randomUUID()}`);
    const before = await currentDocument(store.id);
    // A previous release changes the ticket without touching documents.
    await db
      .update(waitTickets)
      .set({ originalQuantity: 5, remainingQuantity: 5 })
      .where(and(eq(waitTickets.storeId, store.id), eq(waitTickets.productId, fx.nam)));
    const results = await syncAllStoreWaitDocuments(db);
    expect(results.find((row) => row.storeId === store.id)?.plan).toBe('ROLLOVER');
    const after = await currentDocument(store.id);
    expect(after.predecessor?.id).toBe(before.id);
    expect(after.openedEvent.kind).toBe('system_sync');
    expect(lineSummary(after)).toEqual({ [fx.nam]: [2, 3] });
    const again = await syncAllStoreWaitDocuments(db);
    expect(again.find((row) => row.storeId === store.id)?.plan).toBe('NOOP');
  });

  // ---------------------------------------------------------------------------------------------

  async function markRunFinished(runId: string) {
    await db
      .update(allocationRuns)
      .set({ finishedAt: new Date() })
      .where(eq(allocationRuns.id, runId));
  }

  /** The run's own reconciliation, as the worker writes it last in the run transaction. */
  async function reconcileRun(storeId: string, run: { sessionId: string; runId: string }) {
    await withSerializableTransaction(db, (tx) =>
      reconcileStoreWaitDocumentsInTransaction(tx, [
        {
          storeId,
          event: {
            kind: 'allocation_run',
            sourceKey: `allocation-run:${run.runId}`,
            actorUserId: null,
            occurredAt: new Date(),
            orderSessionId: run.sessionId,
            allocationRunId: run.runId,
          },
        },
      ]),
    );
  }

  async function waitDocumentsByRun(storeId: string) {
    const page = await listSessionDocuments(db, {
      page: 1,
      pageSize: 20,
      storeIds: [storeId],
      includeWaitDocuments: true,
    });
    return new Map(
      page.data.map((document) => [
        document.allocationRunId,
        'waitDocuments' in document ? document.waitDocuments : undefined,
      ]),
    );
  }

  /** Expected snapshot lines from { product: [still waiting, granted awaiting the answer] }. */
  function split(byProduct: Record<string, readonly [number, number]>) {
    return expect.arrayContaining(
      Object.entries(byProduct).map(([productId, [remainingQuantity, pendingQuantity]]) => ({
        productId,
        quantity: remainingQuantity + pendingQuantity,
        remainingQuantity,
        pendingQuantity,
      })),
    );
  }

  async function reconcile(storeId: string, kind: 'allocation_run', sourceKey: string) {
    await withSerializableTransaction(db, (tx) =>
      reconcileStoreWaitDocumentsInTransaction(tx, [
        { storeId, event: { kind, sourceKey, actorUserId: null, occurredAt: new Date() } },
      ]),
    );
  }

  async function currentDocumentOrNull(storeId: string) {
    const page = await listStoreWaitDocuments(db, {
      actorUserId: fx.adminId,
      storeId,
      view: 'ACTIVE',
    });
    expect(page.data.length).toBeLessThanOrEqual(1);
    return page.data[0] ?? null;
  }

  async function currentDocument(storeId: string) {
    const document = await currentDocumentOrNull(storeId);
    expect(document).not.toBeNull();
    return document!;
  }

  async function documentCount(storeId: string) {
    const [row] = await db
      .select({ value: sql<number>`count(*)`.mapWith(Number) })
      .from(storeWaitDocuments)
      .where(eq(storeWaitDocuments.storeId, storeId));
    return row!.value;
  }

  function lineSummary(document: {
    lines: readonly { productId: string; carriedInQuantity: number; addedQuantity: number }[];
  }) {
    return Object.fromEntries(
      document.lines.map((line) => [line.productId, [line.carriedInQuantity, line.addedQuantity]]),
    );
  }

  function lineSummaryTotals(document: {
    lines: readonly { productId: string; carriedInQuantity: number; addedQuantity: number }[];
  }) {
    return Object.fromEntries(
      document.lines.map((line) => [line.productId, line.carriedInQuantity + line.addedQuantity]),
    );
  }

  async function reserved(productId: string) {
    const [row] = await db
      .select({ reserved: warehouseBalances.reservedQuantity })
      .from(warehouseBalances)
      .where(eq(warehouseBalances.productId, productId));
    return row?.reserved ?? 0;
  }

  async function activeTickets(storeId: string) {
    return db
      .select()
      .from(waitTickets)
      .where(and(eq(waitTickets.storeId, storeId), eq(waitTickets.status, 'active')));
  }

  async function createUser(role: 'store' | 'htkd', storeId: string | null) {
    const token = randomUUID().replaceAll('-', '');
    const [user] = await db
      .insert(users)
      .values({
        email: `swd-${role}-${token}@example.test`,
        passwordHash: 'store-wait-document-test-hash',
        displayName: `SWD ${role} ${token.slice(0, 6)}`,
        role,
        storeId,
      })
      .returning({ id: users.id });
    return user!.id;
  }

  async function createStore() {
    const token = randomUUID().replaceAll('-', '');
    const [store] = await db
      .insert(stores)
      .values({
        code: `SWD-${token}`,
        name: `SWD ${token.slice(0, 6)}`,
        groupId: fx.groupId,
        kind: 'retail',
      })
      .returning({ id: stores.id });
    return { id: store!.id, userId: await createUser('store', store!.id) };
  }

  async function createRun() {
    const token = randomUUID().replaceAll('-', '');
    const date = '2026-10-05';
    const [session] = await db
      .insert(orderSessions)
      .values({
        code: `SWD-${token}`,
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
        status: 'running',
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
        idempotencyKey: randomUUID(),
      })
      .returning();
    return { sessionId: session!.id, runId: run!.id };
  }

  async function createTicketIn(
    tx: Parameters<Parameters<typeof withTransaction>[1]>[0],
    sessionId: string,
    storeId: string,
    productId: string,
    quantity: number,
  ) {
    const [order] = await tx
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
    const [item] = await tx
      .insert(orderRequestItems)
      .values({ orderRequestId: order!.id, productId, requestedQuantity: quantity })
      .returning();
    const [ticket] = await tx
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

  async function createTicket(storeId: string, productId: string, quantity: number) {
    const { sessionId } = await createRun();
    return withTransaction(db, (tx) => createTicketIn(tx, sessionId, storeId, productId, quantity));
  }

  /** P0A lines granted from tickets, held for a PENDING result, as the worker writes them. */
  async function publishTicketResult(
    storeId: string,
    grants: readonly { ticketId: string; productId: string; quantity: number }[],
  ) {
    const { sessionId, runId } = await createRun();
    let sequence = 0;
    for (const grant of grants) {
      sequence += 1;
      const [ticket] = await db
        .select()
        .from(waitTickets)
        .where(eq(waitTickets.id, grant.ticketId));
      const [offer] = await db
        .insert(dailyPriorityOffers)
        .values({
          businessDate: '2026-10-05',
          orderSessionId: sessionId,
          storeId,
          productId: grant.productId,
          waitTicketId: grant.ticketId,
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
          waitTicketId: grant.ticketId,
          priorityOfferId: offer!.id,
          priorityLevel: 'P0A',
          roundNumber: 1,
          sequenceInRound: sequence,
          requestedQuantity: grant.quantity,
          allocatedQuantity: grant.quantity,
          waitlistedQuantity: 0,
          status: 'allocated',
          reasonCode: 'TEST_DOCUMENT',
        })
        .returning({ id: allocationLines.id });
      await hold(storeId, grant.productId, line!.id, grant.quantity, runId, sequence);
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
    }
    return finishRun(storeId, sessionId, runId);
  }

  /** An ordinary (order) line granted to the store, held for a PENDING result. */
  async function publishOrderResult(storeId: string, productId: string, quantity: number) {
    const { sessionId, runId } = await createRun();
    const [order] = await db
      .insert(orderRequests)
      .values({
        orderSessionId: sessionId,
        storeId,
        requestNumber: 1,
        status: 'partially_allocated',
        submittedAt: new Date(),
        requestedByUserId: fx.adminId,
      })
      .returning();
    const [item] = await db
      .insert(orderRequestItems)
      .values({ orderRequestId: order!.id, productId, requestedQuantity: quantity + 4 })
      .returning();
    const [merged] = await db
      .insert(mergedOrders)
      .values({ orderSessionId: sessionId, storeId, status: 'allocated', requestCount: 1 })
      .returning();
    const [mergedItem] = await db
      .insert(mergedOrderItems)
      .values({
        mergedOrderId: merged!.id,
        productId,
        requestedQuantity: quantity + 4,
        priorityLevel: 'P1',
      })
      .returning();
    await db.insert(mergedOrderSources).values({
      mergedOrderItemId: mergedItem!.id,
      orderRequestItemId: item!.id,
      requestedQuantity: quantity + 4,
    });
    const [line] = await db
      .insert(allocationLines)
      .values({
        allocationRunId: runId,
        mergedOrderId: merged!.id,
        storeId,
        productId,
        orderRequestItemId: item!.id,
        priorityLevel: 'P1',
        roundNumber: 1,
        sequenceInRound: 1,
        requestedQuantity: quantity + 4,
        allocatedQuantity: quantity,
        waitlistedQuantity: 4,
        status: 'partial',
        reasonCode: 'TEST_DOCUMENT',
      })
      .returning({ id: allocationLines.id });
    await hold(storeId, productId, line!.id, quantity, runId, 1);
    return finishRun(storeId, sessionId, runId);
  }

  async function hold(
    storeId: string,
    productId: string,
    allocationLineId: string,
    quantity: number,
    runId: string,
    sequence: number,
  ) {
    await db.insert(reservations).values({ productId, storeId, allocationLineId, quantity });
    await withSerializableTransaction(db, (tx) =>
      applyWarehouseMovement(tx, {
        productId,
        eventType: 'reservation',
        onHandDelta: 0,
        reservedDelta: quantity,
        sourceType: 'allocation_run',
        sourceId: runId,
        eventSequence: sequence,
      }),
    );
  }

  async function finishRun(storeId: string, sessionId: string, runId: string) {
    await withSerializableTransaction(db, (tx) =>
      publishAllocationDecisionsInTransaction(tx, {
        allocationRunId: runId,
        orderSessionId: sessionId,
        publishedAt: new Date(),
      }),
    );
    await db
      .update(allocationRuns)
      .set({ status: 'completed' })
      .where(eq(allocationRuns.id, runId));
    const [decision] = await db
      .select({ id: allocationResultDecisions.id })
      .from(allocationResultDecisions)
      .where(
        and(
          eq(allocationResultDecisions.allocationRunId, runId),
          inArray(allocationResultDecisions.storeId, [storeId]),
        ),
      );
    return { sessionId, runId, decisionId: decision!.id };
  }
});

async function createFixture() {
  const token = randomUUID().replaceAll('-', '');
  const [group] = await db
    .insert(storeGroups)
    .values({ code: `SWD-${token}`, name: `SWD ${token.slice(0, 6)}` })
    .returning();
  const createProduct = async (suffix: string) => {
    const [product] = await db
      .insert(products)
      .values({
        sku: `SWD-${suffix}-${token}`,
        slug: `swd-${suffix}-${token}`,
        name: `SWD ${suffix}`,
      })
      .returning({ id: products.id });
    await withSerializableTransaction(db, (tx) =>
      applyWarehouseMovement(tx, {
        productId: product!.id,
        eventType: 'opening_balance',
        onHandDelta: 1000,
        reservedDelta: 0,
        sourceType: 'store_wait_document_test_opening',
        sourceId: randomUUID(),
      }),
    );
    return product!.id;
  };
  const createUser = async (role: 'admin' | 'htkd') => {
    const [user] = await db
      .insert(users)
      .values({
        email: `swd-${role}-${token}@example.test`,
        passwordHash: 'store-wait-document-test-hash',
        displayName: `SWD ${role}`,
        role,
      })
      .returning({ id: users.id });
    return user!.id;
  };
  const adminId = await createUser('admin');
  const htkdId = await createUser('htkd');
  return {
    groupId: group!.id,
    adminId,
    htkdId,
    nam: await createProduct('nam'),
    nu: await createProduct('nu'),
    tre: await createProduct('tre'),
    short: await createProduct('short'),
    bo: await createProduct('bo'),
  };
}
