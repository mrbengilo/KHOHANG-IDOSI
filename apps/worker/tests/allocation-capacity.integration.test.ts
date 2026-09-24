import { randomUUID } from 'node:crypto';
import {
  allocationLines,
  allocationRuns,
  applyWarehouseMovement,
  createDatabase,
  orderRequestItems,
  orderRequests,
  orderSessions,
  products,
  stores,
  users,
  waitTickets,
  warehouseBalances,
} from '@idosi/database';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  PostgresAllocationJobRepository,
  allocatableSnapshotQuantity,
} from '../src/postgres-repository.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describe('allocatableSnapshotQuantity', () => {
  it('never exceeds the snapshot or the stock that is still unreserved', () => {
    expect(allocatableSnapshotQuantity(5, 9)).toBe(5);
    expect(allocatableSnapshotQuantity(5, 2)).toBe(2);
    expect(allocatableSnapshotQuantity(5, -3)).toBe(0);
  });
});

describePostgres('09:00 allocation capacity', () => {
  it('allocates only the stock left after a post-snapshot supplier cancellation', async () => {
    const client = createDatabase({ connectionString: process.env.DATABASE_URL!, max: 4 });
    const db = client.db;
    const token = randomUUID().replaceAll('-', '');
    const now = new Date();
    const sessionIds: string[] = [];
    const snapshotDueAt = new Date(now.getTime() - 30_000);
    const finalDueAt = new Date(now.getTime() + 120_000);
    const businessDate = new Date(
      Date.UTC(2031, 0, 1) + (Number.parseInt(token.slice(0, 8), 16) % 20000) * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    try {
      const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
      const [referenceStore] = await db.select().from(stores).limit(1);
      if (!admin || !referenceStore) throw new Error('Reference seed required.');
      const [product] = await db
        .insert(products)
        .values({ sku: `CAP-${token}`, slug: `cap-${token}`, name: 'Capacity test product' })
        .returning();
      const storeRows = await db
        .insert(stores)
        .values(
          [1, 2].map((index) => ({
            code: `CAP-${index}-${token}`,
            name: `Capacity store ${index}`,
            groupId: referenceStore.groupId,
          })),
        )
        .returning();
      const [session] = await db
        .insert(orderSessions)
        .values({
          code: `CAP-${token}`,
          businessDate,
          status: 'open',
          inventorySnapshotDueAt: snapshotDueAt,
          requestDeadlineAt: finalDueAt,
          policyVersion: 'idosi-round-robin-p0a-p3-v1',
        })
        .returning();
      sessionIds.push(session!.id);
      for (const store of storeRows) {
        const [order] = await db
          .insert(orderRequests)
          .values({
            orderSessionId: session!.id,
            storeId: store.id,
            requestNumber: 1,
            status: 'submitted',
            submittedAt: new Date(now.getTime() - 60_000),
            requestedByUserId: admin.id,
          })
          .returning();
        await db.insert(orderRequestItems).values({
          orderRequestId: order!.id,
          productId: product!.id,
          requestedQuantity: 3,
        });
      }
      await db.transaction((tx) =>
        applyWarehouseMovement(tx, {
          productId: product!.id,
          eventType: 'opening_balance',
          onHandDelta: 5,
          reservedDelta: 0,
          sourceType: 'capacity_test',
          sourceId: randomUUID(),
          occurredAt: new Date(now.getTime() - 60_000),
        }),
      );
      const worker = new PostgresAllocationJobRepository(client);
      const scheduled = {
        id: session!.id,
        businessDate,
        snapshotDueAt,
        finalDueAt,
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
      };
      await worker.captureSnapshotAndCreateOffers(scheduled, now);
      // A supplier receipt holding 3 of the 5 units is cancelled after the snapshot.
      await db.transaction((tx) =>
        applyWarehouseMovement(tx, {
          productId: product!.id,
          eventType: 'adjustment',
          onHandDelta: -3,
          reservedDelta: 0,
          sourceType: 'supplier_receipt_cancellation',
          sourceId: randomUUID(),
          occurredAt: new Date(now.getTime() + 1_000),
        }),
      );

      const result = await worker.expireOffersAndFinalizeAllocation(
        scheduled,
        new Date(finalDueAt.getTime() + 1_000),
      );
      expect(result.replayed).toBe(false);

      const lines = await db
        .select()
        .from(allocationLines)
        .where(eq(allocationLines.productId, product!.id));
      expect(lines.reduce((total, line) => total + line.allocatedQuantity, 0)).toBe(2);
      expect(lines.map((line) => line.allocatedQuantity).sort()).toEqual([1, 1]);
      const [balance] = await db
        .select()
        .from(warehouseBalances)
        .where(eq(warehouseBalances.productId, product!.id));
      expect(balance?.onHandQuantity).toBe(2);
      expect(balance?.reservedQuantity).toBe(2);
      const tickets = await db
        .select()
        .from(waitTickets)
        .where(
          and(
            eq(waitTickets.productId, product!.id),
            inArray(
              waitTickets.storeId,
              storeRows.map((store) => store.id),
            ),
          ),
        );
      expect(tickets.map((ticket) => ticket.remainingQuantity).sort()).toEqual([2, 2]);
      const [run] = await db
        .select()
        .from(allocationRuns)
        .where(eq(allocationRuns.id, result.resourceId!));
      expect(run?.policyInput.capacityAdjustments).toContainEqual({
        productId: product!.id,
        snapshotAvailable: 5,
        allocatable: 2,
      });
    } finally {
      if (sessionIds.length > 0) {
        await db
          .update(orderSessions)
          .set({ deletedAt: new Date() })
          .where(inArray(orderSessions.id, sessionIds));
      }
      await client.close();
    }
  });
});
