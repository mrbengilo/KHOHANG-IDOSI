import { randomUUID } from 'node:crypto';
import {
  allocationLines,
  allocationRuns,
  applyWarehouseMovement,
  type createDatabase,
  declareStoreReceipt,
  finalizeStoreReceipt,
  inventorySnapshots,
  mergedOrderItems,
  mergedOrders,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  orderSessions,
  outboundRequestLines,
  outboundRequests,
  reservations,
  submitStoreReceipt,
} from '@idosi/database';

export async function finalizedReceipt(
  client: ReturnType<typeof createDatabase>,
  input: {
    readonly adminId: string;
    readonly storeId: string;
    readonly storeUserId: string;
    readonly htkdId: string;
    readonly productId: string;
  },
): Promise<void> {
  const db = client.db;
  const now = new Date();
  const day = new Date(Date.UTC(2040 + Math.floor(Math.random() * 50), 0, 1));
  day.setUTCDate(day.getUTCDate() + Math.floor(Math.random() * 360));
  const date = day.toISOString().slice(0, 10);
  const [session] = await db
    .insert(orderSessions)
    .values({
      code: 'E2E',
      businessDate: date,
      status: 'completed',
      inventorySnapshotDueAt: new Date(`${date}T08:00:00+07:00`),
      requestDeadlineAt: new Date(`${date}T09:00:00+07:00`),
      completedAt: now,
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
      createdByUserId: input.adminId,
    })
    .returning();
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
  const [order] = await db
    .insert(orderRequests)
    .values({
      orderSessionId: session!.id,
      storeId: input.storeId,
      requestNumber: 1,
      status: 'allocated',
      submittedAt: now,
      requestedByUserId: input.storeUserId,
    })
    .returning();
  const [item] = await db
    .insert(orderRequestItems)
    .values({ orderRequestId: order!.id, productId: input.productId, requestedQuantity: 3 })
    .returning();
  const [merged] = await db
    .insert(mergedOrders)
    .values({
      orderSessionId: session!.id,
      storeId: input.storeId,
      status: 'allocated',
      requestCount: 1,
    })
    .returning();
  const [mergedItem] = await db
    .insert(mergedOrderItems)
    .values({
      mergedOrderId: merged!.id,
      productId: input.productId,
      requestedQuantity: 3,
      priorityLevel: 'P1',
    })
    .returning();
  await db.insert(mergedOrderSources).values({
    mergedOrderItemId: mergedItem!.id,
    orderRequestItemId: item!.id,
    requestedQuantity: 3,
  });
  const [allocation] = await db
    .insert(allocationLines)
    .values({
      allocationRunId: run!.id,
      mergedOrderId: merged!.id,
      storeId: input.storeId,
      productId: input.productId,
      orderRequestItemId: item!.id,
      priorityLevel: 'P1',
      roundNumber: 1,
      sequenceInRound: 1,
      requestedQuantity: 3,
      allocatedQuantity: 3,
      status: 'allocated',
      reasonCode: 'LIVE_E2E_ADJUSTMENT',
    })
    .returning();
  const [outbound] = await db
    .insert(outboundRequests)
    .values({
      requestNumber: '',
      storeId: input.storeId,
      orderSessionId: session!.id,
      allocationRunId: run!.id,
      status: 'dispatched',
      requestedByUserId: input.adminId,
      submittedAt: now,
      approvedAt: now,
      dispatchedAt: now,
    })
    .returning();
  const [line] = await db
    .insert(outboundRequestLines)
    .values({
      outboundRequestId: outbound!.id,
      productId: input.productId,
      allocationLineId: allocation!.id,
      requestedQuantity: 3,
      approvedQuantity: 3,
      reservedQuantity: 3,
      dispatchedQuantity: 3,
    })
    .returning();
  await db.insert(reservations).values({
    allocationLineId: allocation!.id,
    outboundRequestLineId: line!.id,
    storeId: input.storeId,
    productId: input.productId,
    quantity: 3,
  });
  await db.transaction((tx) =>
    applyWarehouseMovement(tx, {
      productId: input.productId,
      eventType: 'opening_balance',
      onHandDelta: 3,
      reservedDelta: 3,
      sourceType: 'live_e2e_adjustment',
      sourceId: randomUUID(),
    }),
  );
  const lines = [{ productId: input.productId, approvedQuantity: 3, receivedQuantity: 3 }];
  const declared = await declareStoreReceipt(db, {
    outboundRequestId: outbound!.id,
    storeId: input.storeId,
    declaredByUserId: input.storeUserId,
    lines,
    idempotencyKey: randomUUID(),
    requestHash: randomUUID(),
  });
  if (declared.replayed) throw new Error('unexpected replay');
  const submitted = await submitStoreReceipt(db, {
    receiptId: declared.value.receiptId,
    expectedVersion: declared.value.version,
    submittedByUserId: input.storeUserId,
    lines,
    idempotencyKey: randomUUID(),
    requestHash: randomUUID(),
  });
  if (submitted.replayed) throw new Error('unexpected replay');
  await finalizeStoreReceipt(db, {
    receiptId: declared.value.receiptId,
    expectedVersion: submitted.value.version,
    reviewedByUserId: input.htkdId,
    freightVnd: 0n,
    handlingVnd: 0n,
    vat: { amountVnd: 0n, ratePercent: 8 },
    lines: [
      {
        productId: input.productId,
        pricePerKgVnd: 50_000n,
        bagWeightsKg: ['20.000', '20.000', '20.000'],
      },
    ],
    idempotencyKey: randomUUID(),
    requestHash: randomUUID(),
  });
}
