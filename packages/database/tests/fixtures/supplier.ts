import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import {
  addSupplierSourceProducts,
  allocationLines,
  allocationResultDecisions,
  allocationRuns,
  applyWarehouseMovement,
  confirmSupplierStockObservation,
  createSupplierSource,
  dailyPriorityOffers,
  db,
  htkdAssignments,
  inventorySnapshots,
  mergedOrderItems,
  mergedOrders,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  orderSessions,
  previewSupplierStockObservation,
  products,
  recordSupplierOrder,
  reservations,
  storeGroups,
  stores,
  users,
  waitTickets,
  warehouseBalances,
  warehouseLedgerEntries,
  withSerializableTransaction,
} from '../../src/index.js';

/**
 * Builds the persisted shape the 09:00 worker leaves behind (session, run, line, reservation,
 * accepted decision) so supplier commands run against real rows. Every fixture is unique.
 */
export async function createSupplierFixture() {
  const token = randomUUID().replaceAll('-', '').slice(0, 20);
  const [group] = await db
    .insert(storeGroups)
    .values({ code: `SUP-${token}`, name: `Supplier group ${token.slice(0, 6)}` })
    .returning();
  const createStore = async (suffix: string) => {
    const [store] = await db
      .insert(stores)
      .values({ code: `SUP-${suffix}-${token}`, name: `Supplier ${suffix}`, groupId: group!.id })
      .returning();
    return store!.id;
  };
  const createUser = async (
    suffix: string,
    role: 'admin' | 'htkd' | 'store' | 'wholesale',
    storeId: string | null = null,
  ) => {
    const [user] = await db
      .insert(users)
      .values({
        email: `sup-${suffix}-${token}@example.test`,
        passwordHash: 'supplier-test-password-hash-placeholder',
        displayName: `Supplier ${suffix}`,
        role,
        storeId,
      })
      .returning({ id: users.id });
    return user!.id;
  };
  const storeA = await createStore('A');
  const storeB = await createStore('B');
  const adminId = await createUser('admin', 'admin');
  const htkdId = await createUser('htkd', 'htkd');
  const otherHtkdId = await createUser('htkd-other', 'htkd');
  const storeUserA = await createUser('store-a', 'store', storeA);
  await db
    .insert(htkdAssignments)
    .values({ userId: htkdId, storeId: storeA, assignedByUserId: adminId });
  await db
    .insert(htkdAssignments)
    .values({ userId: otherHtkdId, storeId: storeB, assignedByUserId: adminId });
  const source = await createSupplierSource(db, {
    actorUserId: adminId,
    code: `RS-${token.slice(0, 12).toUpperCase()}`,
    name: 'Kho Reshare test',
    idempotencyKey: randomUUID(),
    requestHash: 'create-source',
  });
  if (source.replayed) throw new Error('Fresh source unexpectedly replayed.');
  return {
    token,
    storeA,
    storeB,
    adminId,
    htkdId,
    otherHtkdId,
    storeUserA,
    sourceId: source.value.id,
  };
}

export type SupplierFixture = Awaited<ReturnType<typeof createSupplierFixture>>;

export async function createMappedProduct(
  fx: SupplierFixture,
  options: { legacyOnHand?: number; map?: boolean } = {},
) {
  const token = randomUUID().replaceAll('-', '');
  const [product] = await db
    .insert(products)
    .values({ sku: `SUP-${token}`, slug: `sup-${token}`, name: `Reshare ${token.slice(0, 6)}` })
    .returning({ id: products.id });
  if (options.legacyOnHand) await movement(product!.id, options.legacyOnHand, 0, 'opening_balance');
  if (options.map !== false) await mapProduct(fx, product!.id);
  return product!.id;
}

export async function mapProduct(fx: SupplierFixture, productId: string) {
  await addSupplierSourceProducts(db, {
    actorUserId: fx.adminId,
    sourceId: fx.sourceId,
    productIds: [productId],
    idempotencyKey: randomUUID(),
    requestHash: `map:${productId}`,
  });
}

/** A movement from an allowed source (opening stock before mapping, or a hold). */
export async function movement(
  productId: string,
  onHandDelta: number,
  reservedDelta: number,
  eventType: 'opening_balance' | 'reservation' | 'reservation_release',
  sourceType = eventType === 'opening_balance' ? 'supplier_test_opening' : 'allocation_run',
) {
  await withSerializableTransaction(db, (tx) =>
    applyWarehouseMovement(tx, {
      productId,
      eventType,
      onHandDelta,
      reservedDelta,
      sourceType,
      sourceId: randomUUID(),
    }),
  );
}

export async function observe(
  fx: SupplierFixture,
  lines: readonly { productId: string; observedQuantity: number }[],
  options: {
    observedAt?: Date;
    coverage?: readonly { eventId: string; included: boolean }[];
    attest?: boolean;
    key?: string;
    hash?: string;
    actorUserId?: string;
    expectedRevision?: string;
  } = {},
) {
  const input = {
    actorUserId: options.actorUserId ?? fx.adminId,
    sourceId: fx.sourceId,
    observedAt: options.observedAt ?? new Date(),
    lines,
    eventCoverage: options.coverage ?? [],
    attestUnlinkedAsNotOrdered: options.attest ?? false,
  };
  const preview = await previewSupplierStockObservation(db, input);
  const result = await confirmSupplierStockObservation(db, {
    ...input,
    expectedRevision: options.expectedRevision ?? preview.revision,
    idempotencyKey: options.key ?? randomUUID(),
    requestHash: options.hash ?? JSON.stringify(lines),
  });
  return { preview, ...result };
}

export async function createRun(fx: SupplierFixture) {
  const token = randomUUID().replaceAll('-', '');
  const date = '2026-10-12';
  const [session] = await db
    .insert(orderSessions)
    .values({
      code: `SUP-${token}`,
      kind: 'manual',
      businessDate: date,
      status: 'completed',
      openedAt: new Date(`${date}T00:00:00+07:00`),
      inventorySnapshotDueAt: new Date(`${date}T08:00:00+07:00`),
      requestDeadlineAt: new Date(`${date}T09:00:00+07:00`),
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
      createdByUserId: fx.adminId,
      deletedAt: new Date(),
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
      status: 'completed',
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
      idempotencyKey: randomUUID(),
    })
    .returning();
  return { sessionId: session!.id, runId: run!.id };
}

async function orderItem(
  fx: SupplierFixture,
  sessionId: string,
  storeId: string,
  productId: string,
  quantity: number,
) {
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
  const [existing] = order
    ? [order]
    : await db
        .select()
        .from(orderRequests)
        .where(and(eq(orderRequests.orderSessionId, sessionId), eq(orderRequests.storeId, storeId)))
        .limit(1);
  const [item] = await db
    .insert(orderRequestItems)
    .values({ orderRequestId: existing!.id, productId, requestedQuantity: quantity })
    .returning();
  return item!.id;
}

/**
 * Grants `quantity` to a store: allocation line + active reservation + ledger hold, with the
 * store's decision `accepted` (orderable at B) or `pending`.
 */
export async function grant(
  fx: SupplierFixture,
  input: {
    storeId: string;
    productId: string;
    quantity: number;
    decision?: 'accepted' | 'pending';
  },
) {
  const { sessionId, runId } = await createRun(fx);
  const itemId = await orderItem(fx, sessionId, input.storeId, input.productId, input.quantity);
  const [merged] = await db
    .insert(mergedOrders)
    .values({
      orderSessionId: sessionId,
      storeId: input.storeId,
      status: 'allocated',
      requestCount: 1,
    })
    .returning({ id: mergedOrders.id });
  const [mergedItem] = await db
    .insert(mergedOrderItems)
    .values({
      mergedOrderId: merged!.id,
      productId: input.productId,
      requestedQuantity: input.quantity,
      priorityLevel: 'P1',
    })
    .returning();
  await db.insert(mergedOrderSources).values({
    mergedOrderItemId: mergedItem!.id,
    orderRequestItemId: itemId,
    requestedQuantity: input.quantity,
  });
  const [line] = await db
    .insert(allocationLines)
    .values({
      allocationRunId: runId,
      storeId: input.storeId,
      productId: input.productId,
      orderRequestItemId: itemId,
      mergedOrderId: merged!.id,
      priorityLevel: 'P1',
      roundNumber: 1,
      sequenceInRound: 1,
      requestedQuantity: input.quantity,
      allocatedQuantity: input.quantity,
      status: 'allocated',
      reasonCode: 'SUPPLIER_TEST',
    })
    .returning({ id: allocationLines.id });
  const [reservation] = await db
    .insert(reservations)
    .values({
      productId: input.productId,
      storeId: input.storeId,
      allocationLineId: line!.id,
      quantity: input.quantity,
    })
    .returning({ id: reservations.id });
  await withSerializableTransaction(db, (tx) =>
    applyWarehouseMovement(tx, {
      productId: input.productId,
      eventType: 'reservation',
      onHandDelta: 0,
      reservedDelta: input.quantity,
      sourceType: 'allocation_run',
      sourceId: runId,
    }),
  );
  const decision = input.decision ?? 'accepted';
  await db.insert(allocationResultDecisions).values({
    allocationRunId: runId,
    orderSessionId: sessionId,
    storeId: input.storeId,
    status: decision,
    grantedQuantity: input.quantity,
    ...(decision === 'accepted'
      ? { respondedAt: new Date(), respondedByUserId: fx.storeUserA }
      : {}),
  });
  return { reservationId: reservation!.id, allocationLineId: line!.id, runId, sessionId };
}

/** A live priority-offer hold (stock_held_quantity > 0) with its ledger reservation. */
export async function offerHold(
  fx: SupplierFixture,
  input: { storeId: string; productId: string; quantity: number },
) {
  const { sessionId } = await createRun(fx);
  const itemId = await orderItem(fx, sessionId, input.storeId, input.productId, input.quantity);
  const [ticket] = await db
    .insert(waitTickets)
    .values({
      storeId: input.storeId,
      productId: input.productId,
      sourceOrderRequestItemId: itemId,
      priorityLevel: 'P0A',
      originalQuantity: input.quantity,
      remainingQuantity: input.quantity,
    })
    .returning({ id: waitTickets.id });
  const [offer] = await db
    .insert(dailyPriorityOffers)
    .values({
      businessDate: '2026-10-12',
      orderSessionId: sessionId,
      storeId: input.storeId,
      productId: input.productId,
      waitTicketId: ticket!.id,
      priorityLevel: 'P0A',
      offeredQuantity: input.quantity,
      stockHeldQuantity: input.quantity,
      responseDeadlineAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: dailyPriorityOffers.id });
  await withSerializableTransaction(db, (tx) =>
    applyWarehouseMovement(tx, {
      productId: input.productId,
      eventType: 'reservation',
      onHandDelta: 0,
      reservedDelta: input.quantity,
      sourceType: 'priority_offer',
      sourceId: offer!.id,
      eventSequence: 1,
    }),
  );
  return { offerId: offer!.id, ticketId: ticket!.id };
}

export async function order(
  fx: SupplierFixture,
  input: {
    reservationId: string;
    quantity: number;
    externalRef?: string;
    lineRef?: string;
    actorUserId?: string;
    occurredAt?: Date;
    key?: string;
  },
) {
  return recordSupplierOrder(db, {
    actorUserId: input.actorUserId ?? fx.htkdId,
    sourceId: fx.sourceId,
    externalRef: input.externalRef ?? `B-${randomUUID().slice(0, 8)}`,
    occurredAt: input.occurredAt ?? new Date(),
    lines: [
      {
        reservationId: input.reservationId,
        quantity: input.quantity,
        externalLineRef: input.lineRef ?? 'L1',
      },
    ],
    idempotencyKey: input.key ?? randomUUID(),
    requestHash: `${input.reservationId}:${input.quantity}:${input.externalRef ?? ''}`,
  });
}

export async function balanceOf(productId: string) {
  const [row] = await db
    .select()
    .from(warehouseBalances)
    .where(eq(warehouseBalances.productId, productId));
  return {
    onHand: row?.onHandQuantity ?? 0,
    reserved: row?.reservedQuantity ?? 0,
    available: (row?.onHandQuantity ?? 0) - (row?.reservedQuantity ?? 0),
  };
}

/** Independent reconciliation: the balance equals the sum of its ledger. */
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
