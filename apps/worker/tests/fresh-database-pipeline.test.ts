import { randomUUID } from 'node:crypto';

import {
  applyWarehouseMovement,
  createDatabase,
  createOrderSession,
  dispatchWarehouseOutboundRequest,
  listStoreReceiptSources,
  listWarehouseOutboundRequests,
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
      const runKey = randomUUID();
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
