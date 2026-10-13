import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  allocationLines,
  allocationResultDecisions,
  allocationRuns,
  applyWarehouseMovement,
  db,
  declareStoreReceipt,
  finalizeStoreReceipt,
  inventorySnapshots,
  mergedOrderItems,
  mergedOrders,
  mergedOrderSources,
  operationalSettingsVersions,
  orderRequestItems,
  orderRequests,
  orderSessions,
  outboundRequestLines,
  outboundRequests,
  products,
  publishAllocationDecisionsInTransaction,
  reservations,
  respondAllocationDecision,
  submitStoreReceipt,
  warehouseBalances,
  warehouseLedgerEntries,
  withSerializableTransaction,
  type Database,
} from '../../src/index.js';
import type { SupplierFixture } from './supplier.js';

/**
 * Builds what the 09:00 worker persists for one store in one run (lines, holds, ledger holds,
 * a pending decision and optionally its reserved shipment carrying earlier holds), then lets
 * tests answer it, receive it and inspect the central ledger.
 */

export async function createProduct(name = 'RE product') {
  const token = randomUUID().replaceAll('-', '');
  const [product] = await db
    .insert(products)
    .values({ sku: `RE-${token}`, slug: `re-${token}`, name: `${name} ${token.slice(0, 6)}` })
    .returning({ id: products.id });
  return product!.id;
}

export async function openingStock(productId: string, quantity: number) {
  await withSerializableTransaction(db, (tx) =>
    applyWarehouseMovement(tx, {
      productId,
      eventType: 'opening_balance',
      onHandDelta: quantity,
      reservedDelta: 0,
      sourceType: 'reshare_test_opening',
      sourceId: randomUUID(),
    }),
  );
}

export async function balanceOf(productId: string) {
  const [row] = await db
    .select()
    .from(warehouseBalances)
    .where(eq(warehouseBalances.productId, productId));
  return { onHand: row?.onHandQuantity ?? 0, reserved: row?.reservedQuantity ?? 0 };
}

export async function ledgerTotals(productId: string) {
  const [ledger] = await db
    .select({
      onHand: sql<number>`coalesce(sum(${warehouseLedgerEntries.onHandDelta}), 0)`.mapWith(Number),
      reserved: sql<number>`coalesce(sum(${warehouseLedgerEntries.reservedDelta}), 0)`.mapWith(
        Number,
      ),
    })
    .from(warehouseLedgerEntries)
    .where(eq(warehouseLedgerEntries.productId, productId));
  return ledger!;
}

/** Reserved must equal live on-hand holds (active reservations); issued holds are out of R. */
export async function activeHeld(productId: string) {
  const [row] = await db
    .select({ value: sql<number>`coalesce(sum(${reservations.quantity}), 0)`.mapWith(Number) })
    .from(reservations)
    .where(and(eq(reservations.productId, productId), eq(reservations.status, 'active')));
  return row!.value;
}

export interface PendingResult {
  readonly sessionId: string;
  readonly runId: string;
  readonly decisionId: string;
  readonly outboundId: string | null;
  readonly lineIds: readonly string[];
  readonly reservationIds: readonly string[];
}

export async function publishPendingResult(
  fx: SupplierFixture,
  input: {
    readonly storeId: string;
    readonly grants: readonly { readonly productId: string; readonly quantity: number }[];
    readonly shipment?: boolean;
    /** Earlier holds (active or issued) the shipment also carries. */
    readonly carry?: readonly string[];
    /** Publish as legacy (pre-confirmation) instead of pending. */
    readonly legacy?: boolean;
    /** Historical accepted row inserted before the RE acceptance trigger existed. */
    readonly acceptedLegacy?: boolean;
    /** Upgrade fixture writes the old column list before migration 0043. */
    readonly preReshareStatusSchema?: boolean;
  },
  /** Another database (e.g. an isolated upgrade test); defaults to the shared test database. */
  database: Database = db,
): Promise<PendingResult> {
  const token = randomUUID().replaceAll('-', '');
  const date = '2026-10-13';
  const [session] = await database
    .insert(orderSessions)
    .values({
      code: `RET-${token}`,
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
  const [snapshot] = await database
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
  const [run] = await database
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
  // One order item per product per order: a second hold of the same SKU comes from the
  // store's second order of the session (two ordinary orders per cycle).
  const orders: { id: string; products: Set<string> }[] = [];
  const orderFor = async (productId: string) => {
    const free = orders.find((row) => !row.products.has(productId));
    if (free) {
      free.products.add(productId);
      return free.id;
    }
    const [created] = await database
      .insert(orderRequests)
      .values({
        orderSessionId: session!.id,
        storeId: input.storeId,
        requestNumber: orders.length + 1,
        status: 'allocated',
        submittedAt: new Date(),
        requestedByUserId: fx.adminId,
      })
      .returning();
    orders.push({ id: created!.id, products: new Set([productId]) });
    return created!.id;
  };
  const [merged] = await database
    .insert(mergedOrders)
    .values({
      orderSessionId: session!.id,
      storeId: input.storeId,
      status: 'allocated',
      requestCount: 1,
    })
    .returning({ id: mergedOrders.id });
  const lineIds: string[] = [];
  const reservationIds: string[] = [];
  // Merged items are immutable: one per product with the session total, one source per order.
  const mergedItems = new Map<string, string>();
  const totals = new Map<string, number>();
  for (const grant of input.grants) {
    totals.set(grant.productId, (totals.get(grant.productId) ?? 0) + grant.quantity);
  }
  for (const [productId, quantity] of totals) {
    const [item] = await database
      .insert(mergedOrderItems)
      .values({
        mergedOrderId: merged!.id,
        productId,
        requestedQuantity: quantity,
        priorityLevel: 'P1',
      })
      .returning({ id: mergedOrderItems.id });
    mergedItems.set(productId, item!.id);
  }
  let sequence = 0;
  for (const grant of input.grants) {
    sequence += 1;
    const [item] = await database
      .insert(orderRequestItems)
      .values({
        orderRequestId: await orderFor(grant.productId),
        productId: grant.productId,
        requestedQuantity: grant.quantity,
      })
      .returning();
    const mergedItemId = mergedItems.get(grant.productId)!;
    await database.insert(mergedOrderSources).values({
      mergedOrderItemId: mergedItemId,
      orderRequestItemId: item!.id,
      requestedQuantity: grant.quantity,
    });
    const [line] = await database
      .insert(allocationLines)
      .values({
        allocationRunId: run!.id,
        mergedOrderId: merged!.id,
        storeId: input.storeId,
        productId: grant.productId,
        orderRequestItemId: item!.id,
        priorityLevel: 'P1',
        roundNumber: 1,
        sequenceInRound: sequence,
        requestedQuantity: grant.quantity,
        allocatedQuantity: grant.quantity,
        status: 'allocated',
        reasonCode: 'RESHARE_TEST',
      })
      .returning({ id: allocationLines.id });
    lineIds.push(line!.id);
    const [reservation] = await database
      .insert(reservations)
      .values({
        productId: grant.productId,
        storeId: input.storeId,
        allocationLineId: line!.id,
        quantity: grant.quantity,
      })
      .returning({ id: reservations.id });
    reservationIds.push(reservation!.id);
    await withSerializableTransaction(database, (tx) =>
      applyWarehouseMovement(tx, {
        productId: grant.productId,
        eventType: 'reservation',
        onHandDelta: 0,
        reservedDelta: grant.quantity,
        sourceType: 'allocation_run',
        sourceId: run!.id,
        eventSequence: sequence,
      }),
    );
  }
  if (input.legacy) {
    await database.insert(allocationResultDecisions).values({
      allocationRunId: run!.id,
      orderSessionId: session!.id,
      storeId: input.storeId,
      status: 'legacy',
      origin: 'legacy_backfill',
      grantedQuantity: input.grants.reduce((total, grant) => total + grant.quantity, 0),
    });
  }
  if (input.acceptedLegacy || input.preReshareStatusSchema) {
    await database.execute(sql`insert into allocation_result_decisions
      (allocation_run_id, order_session_id, store_id, status, version, granted_quantity, origin, responded_at, responded_by_user_id)
      values (${run!.id}, ${session!.id}, ${input.storeId}, ${input.acceptedLegacy ? 'accepted' : 'pending'}::allocation_decision_status,
        ${input.acceptedLegacy ? 2 : 1}, ${input.grants.reduce((sum, grant) => sum + grant.quantity, 0)}, 'allocation_run',
        ${input.acceptedLegacy ? new Date().toISOString() : null}, ${input.acceptedLegacy ? fx.adminId : null})`);
  } else
    await withSerializableTransaction(database, (tx) =>
      publishAllocationDecisionsInTransaction(tx, {
        allocationRunId: run!.id,
        orderSessionId: session!.id,
        publishedAt: new Date(),
      }),
    );
  let outboundId: string | null = null;
  if (input.shipment !== false) {
    const carried = input.carry?.length
      ? await database
          .select()
          .from(reservations)
          .where(inArray(reservations.id, [...input.carry]))
      : [];
    const [outbound] = await database
      .insert(outboundRequests)
      .values({
        requestNumber: '',
        storeId: input.storeId,
        orderSessionId: session!.id,
        allocationRunId: run!.id,
        status: 'reserved',
        requestedByUserId: fx.adminId,
        submittedAt: new Date(),
        approvedAt: new Date(),
      })
      .returning({ id: outboundRequests.id });
    outboundId = outbound!.id;
    const productIds = [
      ...new Set([...input.grants.map((g) => g.productId), ...carried.map((c) => c.productId)]),
    ];
    for (const productId of productIds) {
      const own = input.grants
        .map((grant, index) => ({ grant, index }))
        .filter(({ grant }) => grant.productId === productId);
      const carriedRows = carried.filter((row) => row.productId === productId);
      const quantity =
        own.reduce((total, { grant }) => total + grant.quantity, 0) +
        carriedRows.reduce((total, row) => total + row.quantity, 0);
      const [line] = await database
        .insert(outboundRequestLines)
        .values({
          outboundRequestId: outboundId,
          productId,
          allocationLineId: own[0] ? lineIds[own[0].index]! : carriedRows[0]!.allocationLineId,
          requestedQuantity: quantity,
          approvedQuantity: quantity,
          reservedQuantity: quantity,
        })
        .returning({ id: outboundRequestLines.id });
      await database
        .update(reservations)
        .set({ outboundRequestLineId: line!.id })
        .where(
          inArray(reservations.id, [
            ...own.map(({ index }) => reservationIds[index]!),
            ...carriedRows.map((row) => row.id),
          ]),
        );
    }
  }
  await database
    .update(allocationRuns)
    .set({ status: 'completed' })
    .where(eq(allocationRuns.id, run!.id));
  const [decision] = await database
    .select({ id: allocationResultDecisions.id })
    .from(allocationResultDecisions)
    .where(
      and(
        eq(allocationResultDecisions.allocationRunId, run!.id),
        eq(allocationResultDecisions.storeId, input.storeId),
      ),
    );
  return {
    sessionId: session!.id,
    runId: run!.id,
    decisionId: decision!.id,
    outboundId,
    lineIds,
    reservationIds,
  };
}

export async function respond(
  decisionId: string,
  actorUserId: string,
  action: 'ACCEPT' | 'REJECT',
  options: { key?: string; expectedVersion?: number } = {},
) {
  return respondAllocationDecision(db, {
    decisionId,
    action,
    expectedVersion: options.expectedVersion ?? 1,
    reason: null,
    actorUserId,
    idempotencyKey: options.key ?? randomUUID(),
    requestHash: `${action}:${options.expectedVersion ?? 1}`,
  });
}

/** Store declares and submits, HTKD finalizes: received bags per product, 10 kg each. */
export async function receive(
  fx: SupplierFixture,
  input: {
    readonly outboundId: string;
    readonly storeId: string;
    readonly storeUserId: string;
    readonly lines: readonly {
      readonly productId: string;
      readonly approvedQuantity: number;
      readonly receivedQuantity: number;
    }[];
  },
) {
  const token = randomUUID();
  const short = input.lines.some((line) => line.receivedQuantity < line.approvedQuantity);
  const note = short ? 'Thiếu bao khi nhận' : null;
  const declared = await declareStoreReceipt(db, {
    outboundRequestId: input.outboundId,
    storeId: input.storeId,
    declaredByUserId: input.storeUserId,
    lines: input.lines,
    discrepancyNote: note,
    idempotencyKey: `declare-${token}`,
    requestHash: `declare-${token}`,
  });
  if (declared.replayed) throw new Error('Unexpected declaration replay.');
  const submitted = await submitStoreReceipt(db, {
    receiptId: declared.value.receiptId,
    expectedVersion: declared.value.version,
    submittedByUserId: input.storeUserId,
    lines: input.lines,
    discrepancyNote: note,
    idempotencyKey: `submit-${token}`,
    requestHash: `submit-${token}`,
  });
  if (submitted.replayed) throw new Error('Unexpected submission replay.');
  const vatVersion = Math.max(
    ...(await db.select().from(operationalSettingsVersions)).map((row) => row.version),
  );
  await finalizeStoreReceipt(db, {
    receiptId: declared.value.receiptId,
    expectedVersion: submitted.value.version,
    reviewedByUserId: fx.htkdId,
    freightVnd: 0n,
    handlingVnd: 0n,
    expectedVatSettingsVersion: vatVersion,
    lines: input.lines.map((line) => ({
      productId: line.productId,
      pricePerKgVnd: line.receivedQuantity > 0 ? 50_000n : null,
      bagWeightsKg: Array.from({ length: line.receivedQuantity }, () => '10.000'),
    })),
    idempotencyKey: `finalize-${token}`,
    requestHash: `finalize-${token}`,
  });
  return declared.value.receiptId;
}
