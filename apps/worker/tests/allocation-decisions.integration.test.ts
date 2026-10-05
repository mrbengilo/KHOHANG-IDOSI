import { randomUUID } from 'node:crypto';
import {
  allocationLines,
  allocationResultDecisions,
  allocationRuns,
  applyWarehouseMovement,
  createDatabase,
  inventorySnapshots,
  listWarehouseOutboundRequests,
  mergedOrderItems,
  mergedOrders,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  orderSessions,
  products,
  publishAllocationDecisionsInTransaction,
  reservations,
  respondAllocationDecision,
  STOCK_JOBS_LOCK,
  storeGroups,
  stores,
  users,
  warehouseBalances,
  withAdvisoryLock,
  withSerializableTransaction,
  type Database,
} from '@idosi/database';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { materializeOutboundRequests } from '../src/postgres-repository.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;
const POLICY = 'idosi-round-robin-p0a-p3-v1';

describePostgres('09:00 shipments and store decisions (worker + PostgreSQL)', () => {
  const client = createDatabase({ connectionString: process.env.DATABASE_URL!, max: 6 });
  const db = client.db;
  const sessionIds: string[] = [];
  let adminId: string;
  let groupId: string;

  beforeAll(async () => {
    const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
    const [group] = await db.select().from(storeGroups).limit(1);
    if (!admin || !group) throw new Error('Bootstrap admin and reference seed required.');
    adminId = admin.id;
    groupId = group.id;
  });
  afterAll(async () => {
    for (const id of sessionIds) {
      await db.update(orderSessions).set({ deletedAt: new Date() }).where(eq(orderSessions.id, id));
    }
    await client.close();
  });

  it('ships only accepted earlier goods, and releases a carried-only shipment at once', async () => {
    const { storeId, storeUserId, productId } = await createStoreAndProduct(20);
    // Earlier session: priority goods only, still unanswered.
    const earlier = await createCycle({ storeId, productId, grants: [2], ordinary: false });
    const earlierDecision = await publish(earlier);
    expect(earlierDecision.status).toBe('pending');

    // Next session: an ordinary order of 3. Its shipment must not carry the unanswered goods.
    const next = await createCycle({ storeId, productId, grants: [3], ordinary: true });
    await publish(next);
    await materialize(next);
    const [nextShipment] = await shipments(storeId, next.runId);
    expect(nextShipment).toMatchObject({ status: 'reserved' });
    expect(nextShipment!.lines.map((line) => line.approvedQuantity)).toEqual([3]);
    expect(await linkedSourceRuns(nextShipment!.lines[0]!.id)).toEqual([next.runId]);

    // The store accepts the earlier result now: the goods are held for the next order.
    await respond(earlierDecision.id, storeUserId, 'ACCEPT');
    // Third session: the order gets nothing new, so its shipment carries only accepted goods
    // and needs no answer; it is released immediately as before.
    const third = await createCycle({ storeId, productId, grants: [0], ordinary: true });
    const thirdDecisions = await publish(third);
    expect(thirdDecisions.status).toBe('not_required');
    await materialize(third);
    const [thirdShipment] = await shipments(storeId, third.runId);
    expect(thirdShipment).toMatchObject({ status: 'dispatched' });
    expect(thirdShipment!.lines.map((line) => line.approvedQuantity)).toEqual([2]);
    expect(await linkedSourceRuns(thirdShipment!.lines[0]!.id)).toEqual([earlier.runId]);
    // Re-running the job attaches nothing twice.
    await materialize(third);
    expect(await shipments(storeId, third.runId)).toHaveLength(1);
    await expectReservedMatchesActive(productId);
  });

  it('serializes a rejection with a concurrent 09:00 run: nothing is shipped or released twice', async () => {
    for (const action of ['REJECT', 'ACCEPT'] as const) {
      const { storeId, storeUserId, productId } = await createStoreAndProduct(30);
      const earlier = await createCycle({ storeId, productId, grants: [4], ordinary: false });
      const earlierDecision = await publish(earlier);
      const next = await createCycle({ storeId, productId, grants: [5], ordinary: true });
      await publish(next);
      const outcomes = await Promise.allSettled([
        respond(earlierDecision.id, storeUserId, action),
        withSerializableTransaction(db, (tx) =>
          withAdvisoryLock(tx, STOCK_JOBS_LOCK.namespace, STOCK_JOBS_LOCK.key, () =>
            materializeOutboundRequests(tx, next.runId, scheduled(next), new Date()),
          ),
        ),
      ]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
      const [shipment] = await shipments(storeId, next.runId);
      const sourceRuns = await linkedSourceRuns(shipment!.lines[0]!.id);
      const earlierReservations = await db
        .select()
        .from(reservations)
        .where(inArray(reservations.allocationLineId, earlier.lineIds));
      if (action === 'REJECT') {
        expect(sourceRuns).toEqual([next.runId]);
        expect(earlierReservations.map((row) => row.status)).toEqual(['released']);
        expect(await balance(productId)).toEqual({ onHand: 30, reserved: 5 });
      } else {
        // Whichever committed first: the accepted goods ride this shipment or wait held,
        // never both and never lost.
        const active = earlierReservations.filter((row) => row.status === 'active');
        expect(active).toHaveLength(1);
        if (sourceRuns.includes(earlier.runId)) {
          expect(active[0]!.outboundRequestLineId).toBe(shipment!.lines[0]!.id);
        } else {
          expect(active[0]!.outboundRequestLineId).toBeNull();
        }
        expect(await balance(productId)).toEqual({ onHand: 30, reserved: 9 });
      }
      await expectReservedMatchesActive(productId);
    }
  });

  // ------------------------------------------------------------------------------------------

  async function respond(decisionId: string, actorUserId: string, action: 'ACCEPT' | 'REJECT') {
    return respondAllocationDecision(db, {
      decisionId,
      action,
      expectedVersion: 1,
      actorUserId,
      idempotencyKey: randomUUID(),
      requestHash: action,
    });
  }

  async function createStoreAndProduct(stock: number) {
    const token = randomUUID().replaceAll('-', '');
    const [store] = await db
      .insert(stores)
      .values({ code: `WDEC-${token}`, name: 'Decision worker test', groupId })
      .returning();
    const [user] = await db
      .insert(users)
      .values({
        email: `wdec.${token}@example.test`,
        displayName: 'Decision worker store',
        passwordHash: 'worker-decision-test-password-hash',
        role: 'store',
        storeId: store!.id,
      })
      .returning();
    const [product] = await db
      .insert(products)
      .values({ sku: `WDEC-${token}`, slug: `wdec-${token}`, name: 'Decision worker product' })
      .returning();
    await withSerializableTransaction(db, (tx) =>
      applyWarehouseMovement(tx, {
        productId: product!.id,
        eventType: 'opening_balance',
        onHandDelta: stock,
        reservedDelta: 0,
        sourceType: 'worker_decision_test',
        sourceId: randomUUID(),
      }),
    );
    return { storeId: store!.id, storeUserId: user!.id, productId: product!.id };
  }

  type Cycle = Awaited<ReturnType<typeof createCycle>>;

  /** One completed session/run for one store, exactly as the 09:00 job persists it. */
  async function createCycle(input: {
    storeId: string;
    productId: string;
    grants: readonly number[];
    ordinary: boolean;
  }) {
    const productId = input.productId;
    const token = randomUUID().replaceAll('-', '');
    const date = '2026-10-05';
    const now = new Date();
    const [session] = await db
      .insert(orderSessions)
      .values({
        code: `WDEC-${token}`,
        kind: 'manual',
        businessDate: date,
        status: 'completed',
        inventorySnapshotDueAt: new Date(`${date}T08:00:00+07:00`),
        requestDeadlineAt: new Date(`${date}T09:00:00+07:00`),
        policyVersion: POLICY,
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
        status: 'running',
        policyVersion: POLICY,
        idempotencyKey: randomUUID(),
      })
      .returning();
    const [order] = await db
      .insert(orderRequests)
      .values({
        orderSessionId: session!.id,
        storeId: input.storeId,
        requestNumber: 1,
        // A priority-only cycle has no ordinary order in this session.
        status: input.ordinary ? 'allocated' : 'cancelled',
        submittedAt: now,
        ...(input.ordinary
          ? {}
          : { cancelledAt: now, cancellationReason: 'priority-only fixture' }),
        requestedByUserId: adminId,
      })
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
    const lineIds: string[] = [];
    for (const [index, granted] of input.grants.entries()) {
      const requested = Math.max(granted, 1);
      const [item] = await db
        .insert(orderRequestItems)
        .values({ orderRequestId: order!.id, productId, requestedQuantity: requested })
        .returning();
      const [mergedItem] = await db
        .insert(mergedOrderItems)
        .values({
          mergedOrderId: merged!.id,
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
          allocationRunId: run!.id,
          mergedOrderId: merged!.id,
          storeId: input.storeId,
          productId,
          orderRequestItemId: item!.id,
          priorityLevel: 'P1',
          roundNumber: 1,
          sequenceInRound: index + 1,
          requestedQuantity: requested,
          allocatedQuantity: granted,
          waitlistedQuantity: requested - granted,
          status: granted === 0 ? 'waitlisted' : 'allocated',
          reasonCode: 'TEST_DECISION',
        })
        .returning();
      lineIds.push(line!.id);
      if (granted > 0) {
        await db.insert(reservations).values({
          allocationLineId: line!.id,
          storeId: input.storeId,
          productId,
          quantity: granted,
          createdAt: now,
        });
        await withSerializableTransaction(db, (tx) =>
          applyWarehouseMovement(tx, {
            productId,
            eventType: 'reservation',
            onHandDelta: 0,
            reservedDelta: granted,
            sourceType: 'allocation_run',
            sourceId: run!.id,
            eventSequence: index + 1,
          }),
        );
      }
    }
    return { session: session!, runId: run!.id, storeId: input.storeId, lineIds };
  }

  async function publish(cycle: Cycle) {
    const decisions = await withSerializableTransaction(db, (tx) =>
      publishAllocationDecisionsInTransaction(tx, {
        allocationRunId: cycle.runId,
        orderSessionId: cycle.session.id,
        publishedAt: new Date(),
      }),
    );
    await db
      .update(allocationRuns)
      .set({ status: 'completed' })
      .where(eq(allocationRuns.id, cycle.runId));
    return decisions.find((decision) => decision.storeId === cycle.storeId)!;
  }

  function scheduled(cycle: Cycle) {
    return {
      id: cycle.session.id,
      businessDate: cycle.session.businessDate,
      snapshotDueAt: cycle.session.inventorySnapshotDueAt,
      finalDueAt: cycle.session.requestDeadlineAt,
      policyVersion: POLICY,
    };
  }

  async function materialize(cycle: Cycle) {
    return withSerializableTransaction(db, (tx) =>
      materializeOutboundRequests(tx, cycle.runId, scheduled(cycle), new Date()),
    );
  }

  async function shipments(storeId: string, runId: string) {
    return (
      await listWarehouseOutboundRequests(db as Database, {
        page: 1,
        pageSize: 20,
        storeIds: [storeId],
        allocationRunId: runId,
      })
    ).data;
  }

  async function linkedSourceRuns(outboundLineId: string) {
    const rows = await db
      .select({ runId: allocationLines.allocationRunId })
      .from(reservations)
      .innerJoin(allocationLines, eq(allocationLines.id, reservations.allocationLineId))
      .where(
        and(
          eq(reservations.outboundRequestLineId, outboundLineId),
          eq(reservations.status, 'active'),
        ),
      );
    return [...new Set(rows.map((row) => row.runId))].sort();
  }

  async function balance(productId: string) {
    const [row] = await db
      .select()
      .from(warehouseBalances)
      .where(eq(warehouseBalances.productId, productId));
    return { onHand: row!.onHandQuantity, reserved: row!.reservedQuantity };
  }

  async function expectReservedMatchesActive(productId: string) {
    const [active] = await db
      .select({ value: sql<number>`coalesce(sum(${reservations.quantity}), 0)`.mapWith(Number) })
      .from(reservations)
      .where(and(eq(reservations.productId, productId), eq(reservations.status, 'active')));
    expect((await balance(productId)).reserved).toBe(active!.value);
    // Every shipment carries goods only of shippable results.
    const unshippable = await db
      .select({ id: reservations.id })
      .from(reservations)
      .innerJoin(allocationLines, eq(allocationLines.id, reservations.allocationLineId))
      .innerJoin(
        allocationResultDecisions,
        and(
          eq(allocationResultDecisions.allocationRunId, allocationLines.allocationRunId),
          eq(allocationResultDecisions.storeId, allocationLines.storeId),
        ),
      )
      .where(
        and(
          eq(reservations.productId, productId),
          eq(reservations.status, 'active'),
          sql`${reservations.outboundRequestLineId} is not null`,
          eq(allocationResultDecisions.status, 'rejected'),
        ),
      );
    expect(unshippable).toEqual([]);
  }
});
