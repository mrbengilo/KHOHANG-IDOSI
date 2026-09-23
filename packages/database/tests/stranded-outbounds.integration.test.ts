import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import {
  allocationLines,
  allocationRuns,
  auditLogs,
  closeDatabase,
  db,
  dispatchStrandedAllocationOutbounds,
  inventorySnapshots,
  listStoreReceiptSources,
  listStrandedAllocationOutbounds,
  mergedOrderItems,
  mergedOrders,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  orderSessions,
  outboundRequestLines,
  outboundRequests,
  products,
  reservations,
  storeGroups,
  stores,
  users,
  warehouseBalances,
} from '../src/index.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('stranded allocation outbound backfill', () => {
  const sessionIds: string[] = [];
  afterAll(async () => {
    for (const id of sessionIds) {
      await db.update(orderSessions).set({ deletedAt: new Date() }).where(eq(orderSessions.id, id));
    }
    await closeDatabase();
  });

  it('lists without writing, releases each shipment once and leaves stock untouched', async () => {
    const fixture = await createStrandedOutbound(3);
    const other = await createStrandedOutbound(2, { shortReservation: true });

    const dryRun = await dispatchStrandedAllocationOutbounds(db, { apply: false });
    const planned = dryRun.candidates.filter((row) =>
      [fixture.outboundId, other.outboundId].includes(row.id),
    );
    expect(planned).toEqual([
      expect.objectContaining({ id: fixture.outboundId, approvedQuantity: 3, blockedReason: null }),
      expect.objectContaining({
        id: other.outboundId,
        blockedReason: 'active reservations do not cover the approved quantity',
      }),
    ]);
    expect(dryRun.dispatchedIds).toEqual([]);
    expect(await statusOf(fixture.outboundId)).toBe('reserved');

    // Two operators running the backfill at once still release the shipment exactly once.
    const runs = await Promise.all([
      dispatchStrandedAllocationOutbounds(db, { apply: true }),
      dispatchStrandedAllocationOutbounds(db, { apply: true }),
    ]);
    expect(
      runs.flatMap((run) => run.dispatchedIds).filter((id) => id === fixture.outboundId),
    ).toEqual([fixture.outboundId]);
    const [released] = await db
      .select()
      .from(outboundRequests)
      .where(eq(outboundRequests.id, fixture.outboundId));
    expect(released).toMatchObject({ status: 'dispatched', version: 1, dispatchedByUserId: null });
    const [line] = await db
      .select()
      .from(outboundRequestLines)
      .where(eq(outboundRequestLines.outboundRequestId, fixture.outboundId));
    expect(line).toMatchObject({ approvedQuantity: 3, dispatchedQuantity: 3, receivedQuantity: 0 });

    const audits = await db
      .select({ metadata: auditLogs.metadata, actorUserId: auditLogs.actorUserId })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, fixture.outboundId),
          eq(auditLogs.action, 'OUTBOUND_REQUEST_DISPATCHED'),
        ),
      );
    expect(audits).toEqual([
      {
        actorUserId: null,
        metadata: { dispatchedBy: 'system', trigger: 'stranded-outbound-backfill' },
      },
    ]);

    // The store can now declare the receipt; the blocked outbound is never touched.
    const sources = await listStoreReceiptSources(db, { storeId: fixture.storeId });
    expect(sources.data.map((source) => source.id)).toEqual([fixture.outboundId]);
    expect(await statusOf(other.outboundId)).toBe('reserved');

    const [balance] = await db
      .select()
      .from(warehouseBalances)
      .where(eq(warehouseBalances.productId, fixture.productId));
    expect(balance ?? null).toBeNull();
    const [reservation] = await db
      .select({ status: reservations.status })
      .from(reservations)
      .where(eq(reservations.storeId, fixture.storeId));
    expect(reservation).toEqual({ status: 'active' });

    const rerun = await dispatchStrandedAllocationOutbounds(db, { apply: true });
    expect(rerun.dispatchedIds).not.toContain(fixture.outboundId);
    expect((await listStrandedAllocationOutbounds(db)).map((row) => row.id)).not.toContain(
      fixture.outboundId,
    );
  });

  async function statusOf(outboundId: string) {
    const [row] = await db
      .select({ status: outboundRequests.status })
      .from(outboundRequests)
      .where(eq(outboundRequests.id, outboundId));
    return row?.status;
  }

  /** Recreates the production state: a 09:00 shipment left at `reserved` by the old worker. */
  async function createStrandedOutbound(
    quantity: number,
    options: { readonly shortReservation?: boolean } = {},
  ) {
    const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
    const [group] = await db.select().from(storeGroups).limit(1);
    if (!admin || !group) throw new Error('Bootstrap admin and reference seed required.');
    const token = randomUUID().replaceAll('-', '');
    const [store] = await db
      .insert(stores)
      .values({ code: `STRAND-${token}`, name: 'Stranded shipment', groupId: group.id })
      .returning();
    const [product] = await db
      .insert(products)
      .values({ sku: `STRAND-${token}`, slug: `strand-${token}`, name: 'Stranded product' })
      .returning();
    const now = new Date();
    // A unique far-future day per fixture keeps the one-active-session-per-day rule satisfied.
    const day = new Date(Date.UTC(2040 + Math.floor(Math.random() * 50), 0, 1));
    day.setUTCDate(day.getUTCDate() + Math.floor(Math.random() * 360));
    const date = day.toISOString().slice(0, 10);
    const [session] = await db
      .insert(orderSessions)
      .values({
        code: `STRAND-${token}`,
        businessDate: date,
        status: 'completed',
        inventorySnapshotDueAt: new Date(`${date}T08:00:00+07:00`),
        requestDeadlineAt: new Date(`${date}T09:00:00+07:00`),
        completedAt: now,
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
        createdByUserId: admin.id,
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
    const [order] = await db
      .insert(orderRequests)
      .values({
        orderSessionId: session!.id,
        storeId: store!.id,
        requestNumber: 1,
        status: 'allocated',
        submittedAt: now,
        requestedByUserId: admin.id,
      })
      .returning();
    const [orderItem] = await db
      .insert(orderRequestItems)
      .values({ orderRequestId: order!.id, productId: product!.id, requestedQuantity: quantity })
      .returning();
    const [merged] = await db
      .insert(mergedOrders)
      .values({
        orderSessionId: session!.id,
        storeId: store!.id,
        status: 'allocated',
        requestCount: 1,
      })
      .returning();
    const [mergedItem] = await db
      .insert(mergedOrderItems)
      .values({
        mergedOrderId: merged!.id,
        productId: product!.id,
        requestedQuantity: quantity,
        priorityLevel: 'P1',
      })
      .returning();
    await db.insert(mergedOrderSources).values({
      mergedOrderItemId: mergedItem!.id,
      orderRequestItemId: orderItem!.id,
      requestedQuantity: quantity,
    });
    const [allocationLine] = await db
      .insert(allocationLines)
      .values({
        allocationRunId: run!.id,
        mergedOrderId: merged!.id,
        storeId: store!.id,
        productId: product!.id,
        orderRequestItemId: orderItem!.id,
        priorityLevel: 'P1',
        roundNumber: 1,
        sequenceInRound: 1,
        requestedQuantity: quantity,
        allocatedQuantity: quantity,
        status: 'allocated',
        reasonCode: 'TEST_STRANDED',
      })
      .returning();
    const [outbound] = await db
      .insert(outboundRequests)
      .values({
        requestNumber: `OUT-STRAND-${token}`,
        storeId: store!.id,
        orderSessionId: session!.id,
        allocationRunId: run!.id,
        status: 'reserved',
        requestedByUserId: admin.id,
        submittedAt: now,
        approvedAt: now,
      })
      .returning();
    const [line] = await db
      .insert(outboundRequestLines)
      .values({
        outboundRequestId: outbound!.id,
        productId: product!.id,
        allocationLineId: allocationLine!.id,
        requestedQuantity: quantity,
        approvedQuantity: quantity,
        reservedQuantity: quantity,
      })
      .returning();
    await db.insert(reservations).values({
      allocationLineId: allocationLine!.id,
      outboundRequestLineId: line!.id,
      storeId: store!.id,
      productId: product!.id,
      quantity: options.shortReservation ? quantity - 1 : quantity,
    });
    return { outboundId: outbound!.id, storeId: store!.id, productId: product!.id };
  }
});
