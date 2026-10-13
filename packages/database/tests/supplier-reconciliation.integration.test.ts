import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyWarehouseMovement,
  auditLogs,
  cancelSupplierOrder,
  closeDatabase,
  confirmSupplierStockObservation,
  createWarehouseStockAdjustment,
  db,
  listSupplierCommitments,
  listSupplierObservationHistory,
  listSupplierReconciliationSummary,
  loadSupplierAllocationCaps,
  previewSupplierStockObservation,
  receiveSupplierInbound,
  recordSupplierSourceReturn,
  supplierExternalEvents,
  supplierSourceProducts,
  supplierStockObservations,
  SupplierReconciliationError,
  users,
  warehouseLedgerEntries,
  withSerializableTransaction,
} from '../src/index.js';
import {
  balanceOf,
  createMappedProduct,
  createSupplierFixture,
  grant,
  ledgerTotals,
  mapProduct,
  observe,
  offerHold,
  order,
  type SupplierFixture,
} from './fixtures/supplier.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

async function caps(productId: string) {
  return withSerializableTransaction(db, async (tx) =>
    (await loadSupplierAllocationCaps(tx)).get(productId),
  );
}

async function statusOf(productId: string) {
  const [row] = await db
    .select()
    .from(supplierSourceProducts)
    .where(eq(supplierSourceProducts.productId, productId));
  return row!.status;
}

async function rejected(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: 'SupplierReconciliationError', code });
}

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000);
}

describePostgres('Reshare supplier reconciliation (PostgreSQL)', () => {
  let fx: SupplierFixture;

  beforeAll(async () => {
    fx = await createSupplierFixture();
  });
  afterAll(() => closeDatabase());

  it('T01–T05: re-observing the same Reshare number never adds stock', async () => {
    // Legacy cumulative inbound left 6 bags before the SKU joined reconciliation.
    const product = await createMappedProduct(fx, { legacyOnHand: 6 });
    expect(await statusOf(product)).toBe('pending_baseline');
    expect(await caps(product)).toBe(0);

    // T01 baseline B=3 with nothing committed: on-hand is projected to 3, not 6 + 3.
    const first = await observe(fx, [{ productId: product, observedQuantity: 3 }], {
      observedAt: minutesAgo(60),
    });
    expect(first.observation.lines[0]).toMatchObject({
      observedQuantity: 3,
      freeQuantity: 3,
      shortfallQuantity: 0,
      onHandBefore: 6,
      onHandAfter: 3,
    });
    expect(await balanceOf(product)).toMatchObject({ onHand: 3, reserved: 0, available: 3 });
    expect(await caps(product)).toBe(3);

    // T02 the allocation takes all 3.
    await grant(fx, { storeId: fx.storeA, productId: product, quantity: 3 });
    expect(await balanceOf(product)).toMatchObject({ available: 0 });
    expect(await caps(product)).toBe(0);

    // T03 next day C sees B=3 again (HTKD has not ordered yet): still nothing free.
    const key = randomUUID();
    const second = await observe(fx, [{ productId: product, observedQuantity: 3 }], {
      observedAt: minutesAgo(30),
      key,
      hash: 'same-observation',
    });
    expect(second.preview.lines[0]!.after).toMatchObject({
      effectiveSupplierQuantity: 3,
      unorderedCommitmentQuantity: 3,
      freeQuantity: 0,
    });
    expect(second.observation.lines[0]).toMatchObject({ onHandAfter: 3, ledgerEntryId: null });
    expect(await balanceOf(product)).toMatchObject({ onHand: 3, reserved: 3, available: 0 });

    // T04 the exact retry replays; T31 the same key with another payload conflicts.
    const replay = await confirmSupplierStockObservation(db, {
      actorUserId: fx.adminId,
      sourceId: fx.sourceId,
      observedAt: minutesAgo(30),
      lines: [{ productId: product, observedQuantity: 3 }],
      eventCoverage: [],
      attestUnlinkedAsNotOrdered: false,
      expectedRevision: 'ignored-on-replay',
      idempotencyKey: key,
      requestHash: 'same-observation',
    });
    expect(replay).toMatchObject({ replayed: true, observation: { id: second.observation.id } });
    await rejected(
      confirmSupplierStockObservation(db, {
        actorUserId: fx.adminId,
        sourceId: fx.sourceId,
        observedAt: minutesAgo(30),
        lines: [{ productId: product, observedQuantity: 4 }],
        eventCoverage: [],
        attestUnlinkedAsNotOrdered: false,
        expectedRevision: 'x',
        idempotencyKey: key,
        requestHash: 'different-payload',
      }),
      'IDEMPOTENCY_CONFLICT',
    );
    const observations = await db
      .select()
      .from(supplierStockObservations)
      .where(eq(supplierStockObservations.idempotencyKey, key));
    expect(observations).toHaveLength(1);

    // T05 a further observation with the same S writes history but no movement.
    await observe(fx, [{ productId: product, observedQuantity: 3 }], {
      observedAt: minutesAgo(20),
    });
    expect(await balanceOf(product)).toMatchObject({ onHand: 3, available: 0 });
    expect(await ledgerTotals(product)).toEqual({ onHand: 3, reserved: 3 });
    const history = await listSupplierObservationHistory(db, {
      productId: product,
      page: 1,
      pageSize: 10,
    });
    expect(history.totalItems).toBe(3);
  });

  it('T06–T09: orders recorded after the snapshot neither free nor double-deduct stock', async () => {
    const product = await createMappedProduct(fx);
    await observe(fx, [{ productId: product, observedQuantity: 7 }], {
      observedAt: minutesAgo(90),
    });
    const granted = await grant(fx, { storeId: fx.storeA, productId: product, quantity: 3 });
    // T06 B=7 with U=3 leaves 4 free.
    expect(await balanceOf(product)).toMatchObject({ onHand: 7, reserved: 3, available: 4 });

    // T07 HTKD records 1 bag accepted by B: B_eff 6, U 2, F still 4; reserved untouched.
    const first = await order(fx, {
      reservationId: granted.reservationId,
      quantity: 1,
      externalRef: 'B-T07',
    });
    expect(first.batch.events[0]).toMatchObject({ kind: 'order', quantity: 1, coverage: 'open' });
    expect(await balanceOf(product)).toMatchObject({ onHand: 7, reserved: 3, available: 4 });
    // T08 the remaining 2.
    await order(fx, { reservationId: granted.reservationId, quantity: 2, externalRef: 'B-T08' });
    expect(await balanceOf(product)).toMatchObject({ available: 4 });
    await rejected(
      order(fx, { reservationId: granted.reservationId, quantity: 1, externalRef: 'B-T08b' }),
      'QUANTITY_EXCEEDED',
    );

    // T09 C sees B=4 that already reflects both orders: declared covered, nothing twice.
    const events = await db
      .select()
      .from(supplierExternalEvents)
      .where(eq(supplierExternalEvents.productId, product));
    const preview = await previewSupplierStockObservation(db, {
      actorUserId: fx.adminId,
      sourceId: fx.sourceId,
      observedAt: new Date(),
      lines: [{ productId: product, observedQuantity: 4 }],
      eventCoverage: [],
      attestUnlinkedAsNotOrdered: false,
    });
    expect(preview.blockingIssues).toContain('EXTERNAL_EVENT_COVERAGE_AMBIGUOUS');
    await rejected(
      confirmSupplierStockObservation(db, {
        actorUserId: fx.adminId,
        sourceId: fx.sourceId,
        observedAt: new Date(),
        lines: [{ productId: product, observedQuantity: 4 }],
        eventCoverage: [],
        attestUnlinkedAsNotOrdered: false,
        expectedRevision: preview.revision,
        idempotencyKey: randomUUID(),
        requestHash: 'undeclared',
      }),
      'EXTERNAL_EVENT_COVERAGE_AMBIGUOUS',
    );
    const confirmed = await observe(fx, [{ productId: product, observedQuantity: 4 }], {
      coverage: events.map((event) => ({ eventId: event.id, included: true })),
    });
    expect(confirmed.observation.lines[0]).toMatchObject({
      effectiveSupplierQuantity: 4,
      unorderedCommitmentQuantity: 0,
      freeQuantity: 4,
      coveredEventCount: 2,
    });
    expect(await balanceOf(product)).toMatchObject({ onHand: 7, reserved: 3, available: 4 });
  });

  it('T10/T22/T30: order rules — scope, gate, partial lines and duplicates', async () => {
    const product = await createMappedProduct(fx);
    await observe(fx, [{ productId: product, observedQuantity: 10 }], {
      observedAt: minutesAgo(5),
    });
    const accepted = await grant(fx, { storeId: fx.storeA, productId: product, quantity: 3 });
    const pending = await grant(fx, {
      storeId: fx.storeA,
      productId: product,
      quantity: 2,
      decision: 'pending',
    });
    // HTKD of another store and a store account may not record B orders.
    await rejected(
      order(fx, {
        reservationId: accepted.reservationId,
        quantity: 1,
        actorUserId: fx.otherHtkdId,
      }),
      'FORBIDDEN',
    );
    await rejected(
      order(fx, { reservationId: accepted.reservationId, quantity: 1, actorUserId: fx.storeUserA }),
      'FORBIDDEN',
    );
    // Not past the acceptance gate.
    await rejected(
      order(fx, { reservationId: pending.reservationId, quantity: 1 }),
      'ORDER_SOURCE_NOT_ELIGIBLE',
    );
    // T10 B accepted only 2 of 3: the remaining 1 stays owed.
    await order(fx, { reservationId: accepted.reservationId, quantity: 2, externalRef: 'B-T10' });
    const list = await listSupplierCommitments(db, {
      productId: product,
      filter: 'ALL',
      page: 1,
      pageSize: 10,
    });
    const row = list.data.find((item) => item.id === accepted.reservationId)!;
    expect(row).toMatchObject({
      orderedQuantity: 2,
      unorderedQuantity: 1,
      orderState: 'PARTIALLY_ORDERED',
    });
    expect(list.data.find((item) => item.id === pending.reservationId)).toMatchObject({
      orderable: false,
      notOrderableReason: 'DECISION_PENDING',
    });
    expect(list.totals).toEqual({ quantity: 5, orderedQuantity: 2, unorderedQuantity: 3 });
    // The same B line cannot be recorded twice.
    await rejected(
      order(fx, { reservationId: accepted.reservationId, quantity: 1, externalRef: 'B-T10' }),
      'DUPLICATE_EXTERNAL_EVENT',
    );
    // Scoped reads never show other stores.
    const scoped = await listSupplierCommitments(db, {
      productId: product,
      storeIds: [fx.storeB],
      filter: 'ALL',
      page: 1,
      pageSize: 10,
    });
    expect(scoped).toMatchObject({ totalItems: 0, data: [] });
  });

  it('T17–T19: cancellations owe the commitment again; only a confirmed return frees stock', async () => {
    const product = await createMappedProduct(fx);
    await observe(fx, [{ productId: product, observedQuantity: 5 }], {
      observedAt: minutesAgo(10),
    });
    const granted = await grant(fx, { storeId: fx.storeA, productId: product, quantity: 3 });
    const recorded = await order(fx, {
      reservationId: granted.reservationId,
      quantity: 3,
      externalRef: 'B-T18',
    });
    expect(await balanceOf(product)).toMatchObject({ available: 2 });

    // T18 B cancels 1 without returning it: owed again (U 1), B_eff stays 2 → F 1.
    await cancelSupplierOrder(db, {
      actorUserId: fx.htkdId,
      eventId: recorded.batch.events[0]!.id,
      quantity: 1,
      cancelRef: 'C-T18',
      occurredAt: new Date(),
      sourceReturned: false,
      idempotencyKey: randomUUID(),
      requestHash: 'cancel-1',
    });
    expect(await balanceOf(product)).toMatchObject({ onHand: 4, reserved: 3, available: 1 });
    // T19 B cancels another and returns it: U +1 and B_eff +1 → F unchanged.
    await cancelSupplierOrder(db, {
      actorUserId: fx.htkdId,
      eventId: recorded.batch.events[0]!.id,
      quantity: 1,
      cancelRef: 'C-T19',
      occurredAt: new Date(),
      sourceReturned: true,
      idempotencyKey: randomUUID(),
      requestHash: 'cancel-2',
    });
    expect(await balanceOf(product)).toMatchObject({ available: 1 });
    // A standalone confirmed source return raises F exactly once.
    const returnKey = randomUUID();
    const returnInput = {
      actorUserId: fx.adminId,
      sourceId: fx.sourceId,
      productId: product,
      quantity: 2,
      externalRef: 'R-T19',
      occurredAt: new Date(),
      note: 'Reshare xác nhận hoàn 2 bao',
      idempotencyKey: returnKey,
      requestHash: 'return-2',
    };
    await recordSupplierSourceReturn(db, returnInput);
    expect(await balanceOf(product)).toMatchObject({ available: 3 });
    expect(await recordSupplierSourceReturn(db, returnInput)).toMatchObject({ replayed: true });
    expect(await balanceOf(product)).toMatchObject({ available: 3 });
    // Only an Admin may record a source return.
    await rejected(
      recordSupplierSourceReturn(db, {
        ...returnInput,
        actorUserId: fx.htkdId,
        idempotencyKey: randomUUID(),
        externalRef: 'R-T19b',
      }),
      'FORBIDDEN',
    );
    // Cannot cancel more than still ordered.
    await rejected(
      cancelSupplierOrder(db, {
        actorUserId: fx.htkdId,
        eventId: recorded.batch.events[0]!.id,
        quantity: 2,
        cancelRef: 'C-too-much',
        occurredAt: new Date(),
        sourceReturned: false,
        idempotencyKey: randomUUID(),
        requestHash: 'cancel-3',
      }),
      'QUANTITY_EXCEEDED',
    );
    expect(await ledgerTotals(product)).toEqual({
      onHand: (await balanceOf(product)).onHand,
      reserved: 3,
    });
  });

  it('T11/T20/T39: offer holds count once, shortfall is shown and blocks new allocation', async () => {
    const product = await createMappedProduct(fx);
    await observe(fx, [{ productId: product, observedQuantity: 3 }], {
      observedAt: minutesAgo(10),
    });
    await offerHold(fx, { storeId: fx.storeA, productId: product, quantity: 1 });
    await grant(fx, { storeId: fx.storeB, productId: product, quantity: 2 });
    expect(await balanceOf(product)).toMatchObject({ onHand: 3, reserved: 3, available: 0 });
    // T20 C now sees only 1 at B: D = 2, F = 0, commitments untouched.
    const confirmed = await observe(fx, [{ productId: product, observedQuantity: 1 }]);
    expect(confirmed.observation.lines[0]).toMatchObject({
      offerHoldQuantity: 1,
      unorderedReservedQuantity: 2,
      unorderedCommitmentQuantity: 3,
      freeQuantity: 0,
      shortfallQuantity: 2,
    });
    expect(await balanceOf(product)).toMatchObject({ onHand: 3, reserved: 3, available: 0 });
    expect(await caps(product)).toBe(0);
    const summary = await listSupplierReconciliationSummary(db, {
      sourceId: fx.sourceId,
      filter: 'SHORTFALL',
      page: 1,
      pageSize: 100,
    });
    expect(summary.data.find((row) => row.productId === product)?.position).toMatchObject({
      state: 'SHORTFALL',
      shortfallQuantity: 2,
    });
  });

  it('T24/T25: late or back-dated facts block the SKU until C answers', async () => {
    const product = await createMappedProduct(fx);
    const baselineAt = minutesAgo(30);
    await observe(fx, [{ productId: product, observedQuantity: 5 }], { observedAt: baselineAt });
    const granted = await grant(fx, { storeId: fx.storeA, productId: product, quantity: 2 });
    // T24 an order B accepted before the baseline, recorded only now.
    const late = await order(fx, {
      reservationId: granted.reservationId,
      quantity: 2,
      occurredAt: minutesAgo(45),
      externalRef: 'B-LATE',
    });
    expect(late.batch.events[0]!.coverage).toBe('ambiguous');
    expect(await statusOf(product)).toBe('needs_reconciliation');
    expect(await caps(product)).toBe(0);
    // T25 an observation older than the baseline is refused.
    await rejected(
      observe(fx, [{ productId: product, observedQuantity: 9 }], { observedAt: minutesAgo(40) }),
      'OBSERVATION_OUT_OF_ORDER',
    );
    // C answers: the old baseline already included the order.
    await observe(fx, [{ productId: product, observedQuantity: 5 }], {
      coverage: [{ eventId: late.batch.events[0]!.id, included: true }],
    });
    expect(await statusOf(product)).toBe('active');
    expect(await caps(product)).toBe(5);
  });

  it('T28: legacy inbound, inbound cancellation and manual adjustment are refused', async () => {
    const product = await createMappedProduct(fx);
    await expect(
      receiveSupplierInbound(db, {
        referenceCode: undefined,
        supplierName: 'Reshare',
        receivedAt: new Date(),
        receivedByUserId: fx.adminId,
        actorRole: 'admin',
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
        bags: [{ productId: product, bagCode: `B-${randomUUID()}`, weightKg: null }],
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_RECONCILED' });
    await expect(
      createWarehouseStockAdjustment(db, {
        productId: product,
        direction: 'increase',
        quantity: 1,
        reasonCode: 'count_correction',
        reason: 'thử tăng tồn',
        expectedVersion: 0,
        actorUserId: fx.adminId,
        idempotencyKey: randomUUID(),
        requestHash: 'adjust',
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_RECONCILED' });
    // An unmapped SKU keeps the legacy flow.
    const legacy = await createMappedProduct(fx, { map: false });
    const adjusted = await createWarehouseStockAdjustment(db, {
      productId: legacy,
      direction: 'increase',
      quantity: 2,
      reasonCode: 'count_correction',
      reason: 'kiểm kê',
      expectedVersion: 0,
      actorUserId: fx.adminId,
      idempotencyKey: randomUUID(),
      requestHash: 'adjust-legacy',
    });
    expect(adjusted.adjustment.onHandAfter).toBe(2);
  });

  it('T27: an unforeseen movement or a "found" shortage never creates free stock', async () => {
    const product = await createMappedProduct(fx);
    await observe(fx, [{ productId: product, observedQuantity: 4 }], {
      observedAt: minutesAgo(10),
    });
    // Safety net: a movement from a path the reconciliation does not know blocks the SKU.
    await withSerializableTransaction(db, (tx) =>
      applyWarehouseMovement(tx, {
        productId: product,
        eventType: 'return',
        onHandDelta: 2,
        reservedDelta: 0,
        sourceType: 'unexpected_path',
        sourceId: randomUUID(),
      }),
    );
    expect(await statusOf(product)).toBe('needs_reconciliation');
    expect(await caps(product)).toBe(0);
    // The next observation re-projects on-hand to R + F.
    await observe(fx, [{ productId: product, observedQuantity: 4 }]);
    expect(await balanceOf(product)).toMatchObject({ onHand: 4, available: 4 });
    expect(await statusOf(product)).toBe('active');

    // (A "found" shortage check of a reconciled SKU is covered end-to-end through the
    // receipt workflow in apps/api/test/supplier-reconciliation.postgres.test.mjs.)
    await grant(fx, { storeId: fx.storeA, productId: product, quantity: 1 });
    expect(await ledgerTotals(product)).toEqual({
      onHand: (await balanceOf(product)).onHand,
      reserved: (await balanceOf(product)).reserved,
    });
  });

  it('T29: holds that predate the baseline need an explicit not-ordered attestation', async () => {
    const product = await createMappedProduct(fx, { map: false, legacyOnHand: 5 });
    await grant(fx, { storeId: fx.storeA, productId: product, quantity: 2 });
    await mapProduct(fx, product);
    const preview = await previewSupplierStockObservation(db, {
      actorUserId: fx.adminId,
      sourceId: fx.sourceId,
      observedAt: new Date(),
      lines: [{ productId: product, observedQuantity: 4 }],
      eventCoverage: [],
      attestUnlinkedAsNotOrdered: false,
    });
    expect(preview.lines[0]).toMatchObject({ unlinkedLegacyQuantity: 2 });
    expect(preview.blockingIssues).toContain('LEGACY_ATTESTATION_REQUIRED');
    await rejected(
      observe(fx, [{ productId: product, observedQuantity: 4 }]),
      'LEGACY_ATTESTATION_REQUIRED',
    );
    const confirmed = await observe(fx, [{ productId: product, observedQuantity: 4 }], {
      attest: true,
    });
    expect(confirmed.observation.lines[0]).toMatchObject({
      attestedUnlinkedQuantity: 2,
      freeQuantity: 2,
      onHandAfter: 4,
    });
  });

  it('T32: zero is a value, missing SKUs are untouched, invalid input is refused', async () => {
    const zero = await createMappedProduct(fx);
    const untouched = await createMappedProduct(fx);
    await observe(fx, [{ productId: untouched, observedQuantity: 6 }], {
      observedAt: minutesAgo(5),
    });
    await observe(fx, [{ productId: zero, observedQuantity: 0 }]);
    expect(await balanceOf(zero)).toMatchObject({ onHand: 0, available: 0 });
    expect(await balanceOf(untouched)).toMatchObject({ onHand: 6 });
    await expect(
      observe(fx, [
        { productId: zero, observedQuantity: 1 },
        { productId: zero, observedQuantity: 2 },
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(observe(fx, [{ productId: zero, observedQuantity: -1 }])).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    const unmapped = await createMappedProduct(fx, { map: false });
    await rejected(
      observe(fx, [{ productId: unmapped, observedQuantity: 1 }]),
      'SOURCE_NOT_RECONCILED',
    );
    // A non-Admin cannot observe; a locked Admin cannot replay.
    await rejected(
      observe(fx, [{ productId: zero, observedQuantity: 1 }], { actorUserId: fx.htkdId }),
      'FORBIDDEN',
    );
  });

  it('T21/T23: concurrent observation, orders and holds never over-allocate', async () => {
    const product = await createMappedProduct(fx);
    await observe(fx, [{ productId: product, observedQuantity: 6 }], {
      observedAt: minutesAgo(15),
    });
    const granted = await grant(fx, { storeId: fx.storeA, productId: product, quantity: 3 });
    const input = {
      actorUserId: fx.adminId,
      sourceId: fx.sourceId,
      observedAt: minutesAgo(1),
      lines: [{ productId: product, observedQuantity: 6 }],
      eventCoverage: [],
      attestUnlinkedAsNotOrdered: false,
    };
    const preview = await previewSupplierStockObservation(db, input);
    // Two HTKD writes and one confirmation race on real connections.
    const results = await Promise.allSettled([
      order(fx, { reservationId: granted.reservationId, quantity: 3, externalRef: 'B-RACE-1' }),
      order(fx, { reservationId: granted.reservationId, quantity: 3, externalRef: 'B-RACE-2' }),
      confirmSupplierStockObservation(db, {
        ...input,
        expectedRevision: preview.revision,
        idempotencyKey: randomUUID(),
        requestHash: 'race',
      }),
    ]);
    const orders = results.slice(0, 2);
    expect(orders.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failedOrder = orders.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(failedOrder.reason).toMatchObject({ code: 'QUANTITY_EXCEEDED' });
    const confirmation = results[2]!;
    if (confirmation.status === 'rejected') {
      // The order committed first, so the preview became stale.
      expect(confirmation.reason).toMatchObject({ code: 'VERSION_CONFLICT' });
    }
    // Whatever the interleaving, A's free stock equals F and stays within B.
    const summary = await listSupplierReconciliationSummary(db, {
      filter: 'ALL',
      page: 1,
      pageSize: 500,
    });
    const position = summary.data.find((row) => row.productId === product)!.position;
    expect(position.projectionMismatch).toBe(false);
    expect(position.unorderedCommitmentQuantity).toBe(0);
    expect((await balanceOf(product)).available).toBe(position.freeQuantity);
    expect(position.freeQuantity).toBeLessThanOrEqual(position.effectiveSupplierQuantity!);
    expect(await ledgerTotals(product)).toEqual({
      onHand: (await balanceOf(product)).onHand,
      reserved: 3,
    });
  });

  it('records an immutable audit trail and refuses edits of evidence', async () => {
    const product = await createMappedProduct(fx);
    const confirmed = await observe(fx, [{ productId: product, observedQuantity: 2 }]);
    const audit = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, confirmed.observation.id),
          eq(auditLogs.action, 'SUPPLIER_STOCK_OBSERVATION_CONFIRMED'),
        ),
      );
    expect(audit).toHaveLength(1);
    await expect(
      db
        .update(supplierStockObservations)
        .set({ note: 'edited' })
        .where(eq(supplierStockObservations.id, confirmed.observation.id)),
    ).rejects.toThrow();
    const ledger = await db
      .select()
      .from(warehouseLedgerEntries)
      .where(eq(warehouseLedgerEntries.sourceId, confirmed.observation.id));
    expect(ledger).toEqual([
      expect.objectContaining({ sourceType: 'supplier_stock_observation', onHandDelta: 2 }),
    ]);
    // A locked Admin gets neither a new command nor a replay.
    const [locked] = await db
      .insert(users)
      .values({
        email: `sup-locked-${randomUUID().slice(0, 8)}@example.test`,
        passwordHash: 'supplier-test-password-hash-placeholder',
        displayName: 'Locked admin',
        role: 'admin',
        status: 'locked',
      })
      .returning({ id: users.id });
    await rejected(
      observe(fx, [{ productId: product, observedQuantity: 2 }], { actorUserId: locked!.id }),
      'FORBIDDEN',
    );
    expect(SupplierReconciliationError).toBeDefined();
  });
});
