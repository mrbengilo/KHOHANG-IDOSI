import { randomUUID } from 'node:crypto';

import {
  allocationLines,
  applyWarehouseMovement,
  createDatabase,
  createOrderSession,
  dispatchWarehouseOutboundRequest,
  listStoreReceiptSources,
  listWarehouseOutboundRequests,
  mergedOrderItems,
  orderSessions,
  products,
  reservations,
  stores,
  submitOrderRequest,
  transitionOrderSession,
  users,
} from '@idosi/database';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { PostgresAllocationJobRepository } from '../src/postgres-repository.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('fresh PostgreSQL order-to-receipt-source pipeline', () => {
  it('creates a session, allocates an order, materializes and dispatches an outbound exactly once', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required when RUN_POSTGRES_TESTS=1.');
    const client = createDatabase({
      connectionString: databaseUrl,
      max: 2,
      application_name: 'idosi-fresh-pipeline-integration-test',
    });
    let cleanupSessionId: string | null = null;
    let cleanupActorId: string | null = null;

    try {
      const [administrator] = await client.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.status, 'active'), isNull(users.deletedAt)))
        .limit(1);
      const [store] = await client.db
        .select({ id: stores.id })
        .from(stores)
        .where(and(eq(stores.isActive, true), isNull(stores.deletedAt)))
        .limit(1);
      const [product] = await client.db
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.isActive, true), isNull(products.deletedAt)))
        .limit(1);
      if (!administrator || !store || !product) {
        throw new Error('Reference seed and administrator bootstrap must run before this test.');
      }

      // Request acceptance is deliberately checked against the real clock, so
      // this end-to-end database fixture must use today's Ho Chi Minh date.
      // The session is soft-deleted in finally so the later live browser suite
      // can create its own same-day session in this shared CI database.
      const runKey = randomUUID();
      const now = new Date();
      const businessDate = hoChiMinhDate(now);
      const requestOpensAt = new Date(`${businessDate}T00:00:00+07:00`);
      const requestClosesAt = new Date(`${businessDate}T23:59:58+07:00`);
      const allocationStartsAt = new Date(`${businessDate}T23:59:59+07:00`);
      if (now >= requestClosesAt) {
        throw new Error(
          'Integration test started during the final two seconds of the business day.',
        );
      }
      const sessionResult = await createOrderSession(client.db, {
        businessDate,
        requestOpensAt,
        requestClosesAt,
        allocationStartsAt,
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
        createdByUserId: administrator.id,
        idempotencyKey: `integration-session-${runKey}`,
        requestHash: `integration-session-hash-${runKey}`,
        requestId: `integration-session-${runKey}`,
      });
      if (sessionResult.replayed) throw new Error('Fresh session unexpectedly replayed.');
      const sessionId = sessionResult.value.id;
      cleanupSessionId = sessionId;
      cleanupActorId = administrator.id;

      const opened = await transitionOrderSession(client.db, {
        orderSessionId: sessionId,
        targetStatus: 'open',
        expectedVersion: 0,
        actorUserId: administrator.id,
        transitionedAt: now,
        idempotencyKey: `integration-open-${runKey}`,
        requestHash: `integration-open-hash-${runKey}`,
        requestId: `integration-open-${runKey}`,
      });
      expect(opened.replayed).toBe(false);

      await client.db.transaction((tx) =>
        applyWarehouseMovement(tx, {
          productId: product.id,
          eventType: 'opening_balance',
          onHandDelta: 10,
          reservedDelta: 0,
          sourceType: 'integration_test_opening',
          sourceId: randomUUID(),
          reason: 'Fresh pipeline integration stock',
          actorUserId: administrator.id,
          occurredAt: now,
        }),
      );
      const order = await submitOrderRequest(client.db, {
        orderSessionId: sessionId,
        storeId: store.id,
        requestedByUserId: administrator.id,
        items: [{ productId: product.id, quantity: 3 }],
        idempotencyKey: `integration-order-${runKey}`,
        requestHash: `integration-order-hash-${runKey}`,
      });
      expect(order.replayed).toBe(false);

      const workerRepository = new PostgresAllocationJobRepository(client);
      const scheduled = {
        id: sessionId,
        businessDate,
        snapshotDueAt: requestClosesAt,
        finalDueAt: allocationStartsAt,
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
      };
      const processedAt = new Date(allocationStartsAt.getTime() + 1_000);
      const snapshot = await workerRepository.captureSnapshotAndCreateOffers(
        scheduled,
        processedAt,
      );
      const allocation = await workerRepository.expireOffersAndFinalizeAllocation(
        scheduled,
        processedAt,
      );
      expect(snapshot.replayed).toBe(false);
      expect(allocation.replayed).toBe(false);

      const [allocationLine] = await client.db
        .select({
          mergedOrderId: allocationLines.mergedOrderId,
          requestedQuantity: allocationLines.requestedQuantity,
          allocatedQuantity: allocationLines.allocatedQuantity,
          waitlistedQuantity: allocationLines.waitlistedQuantity,
          roundNumber: allocationLines.roundNumber,
          sequenceInRound: allocationLines.sequenceInRound,
          decisionMetadata: allocationLines.decisionMetadata,
        })
        .from(allocationLines)
        .where(eq(allocationLines.allocationRunId, allocation.resourceId))
        .limit(1);
      expect(allocationLine).toMatchObject({
        requestedQuantity: 3,
        allocatedQuantity: 3,
        waitlistedQuantity: 0,
        roundNumber: 1,
        sequenceInRound: 1,
        decisionMetadata: expect.objectContaining({ policyRounds: [1, 2, 3] }),
      });
      if (!allocationLine?.mergedOrderId) {
        throw new Error('Fresh allocation did not preserve merged-order provenance.');
      }
      const [mergedItem] = await client.db
        .select({
          requestedQuantity: mergedOrderItems.requestedQuantity,
          allocatedQuantity: mergedOrderItems.allocatedQuantity,
          waitlistedQuantity: mergedOrderItems.waitlistedQuantity,
        })
        .from(mergedOrderItems)
        .where(
          and(
            eq(mergedOrderItems.mergedOrderId, allocationLine.mergedOrderId),
            eq(mergedOrderItems.productId, product.id),
          ),
        )
        .limit(1);
      expect(mergedItem).toEqual({
        requestedQuantity: 3,
        allocatedQuantity: 3,
        waitlistedQuantity: 0,
      });

      const outbounds = await listWarehouseOutboundRequests(client.db, {
        page: 1,
        pageSize: 20,
        storeIds: [store.id],
        allocationRunId: allocation.resourceId,
        status: 'reserved',
      });
      expect(outbounds.data).toHaveLength(1);
      const outbound = outbounds.data[0]!;
      expect(outbound.lines).toHaveLength(1);
      expect(outbound.lines[0]).toMatchObject({
        productId: product.id,
        approvedQuantity: 3,
        reservedQuantity: 3,
        dispatchedQuantity: 0,
      });
      const [linkedReservation] = await client.db
        .select({ outboundRequestLineId: reservations.outboundRequestLineId })
        .from(reservations)
        .where(eq(reservations.allocationLineId, outbound.lines[0]!.allocationLineId))
        .limit(1);
      expect(linkedReservation?.outboundRequestLineId).toBe(outbound.lines[0]!.id);

      const dispatchInput = {
        outboundRequestId: outbound.id,
        expectedVersion: outbound.version,
        dispatchedByUserId: administrator.id,
        dispatchNote: 'Integration dispatch handoff',
        dispatchedAt: new Date(processedAt.getTime() + 1_000),
        idempotencyKey: `integration-dispatch-${runKey}`,
        requestHash: `integration-dispatch-hash-${runKey}`,
        requestId: `integration-dispatch-${runKey}`,
      } as const;
      const dispatched = await dispatchWarehouseOutboundRequest(client.db, dispatchInput);
      const replay = await dispatchWarehouseOutboundRequest(client.db, dispatchInput);
      expect(dispatched.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      if (dispatched.replayed) throw new Error('Fresh dispatch unexpectedly replayed.');
      expect(dispatched.value.status).toBe('dispatched');
      expect(dispatched.value.version).toBe(1);
      expect(dispatched.value.lines[0]!.dispatchedQuantity).toBe(3);

      const sources = await listStoreReceiptSources(client.db, {
        page: 1,
        pageSize: 20,
        storeId: store.id,
      });
      const receiptSource = sources.data.find((source) => source.id === outbound.id);
      expect(receiptSource).toMatchObject({
        id: outbound.id,
        storeId: store.id,
        lines: [{ productId: product.id, approvedUnits: 3, dispatchedUnits: 3 }],
      });
    } finally {
      if (cleanupSessionId && cleanupActorId) {
        await client.db
          .update(orderSessions)
          .set({ deletedAt: new Date(), deletedByUserId: cleanupActorId })
          .where(eq(orderSessions.id, cleanupSessionId));
      }
      await client.close();
    }
  }, 30_000);
});

function hoChiMinhDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
  }).formatToParts(instant);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) throw new Error('Unable to resolve the Ho Chi Minh business date.');
  return `${year}-${month}-${day}`;
}
