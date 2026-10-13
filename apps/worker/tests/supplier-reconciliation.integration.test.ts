import { randomUUID } from 'node:crypto';
import {
  addSupplierSourceProducts,
  allocationLines,
  applyWarehouseMovement,
  confirmSupplierStockObservation,
  createDatabase,
  createSupplierSource,
  dailyPriorityOffers,
  orderRequestItems,
  orderRequests,
  orderSessions,
  previewSupplierStockObservation,
  products,
  stores,
  users,
  warehouseBalances,
  type Database,
} from '@idosi/database';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresAllocationJobRepository } from '../src/postgres-repository.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;
const POLICY = 'idosi-round-robin-p0a-p3-v1';

describePostgres('09:00 allocation of Reshare-reconciled SKUs', () => {
  const client = createDatabase({ connectionString: process.env.DATABASE_URL!, max: 4 });
  const db: Database = client.db;
  const token = randomUUID().replaceAll('-', '').slice(0, 16);
  let adminId: string;
  let sourceId: string;
  let groupId: string;
  const sessionIds: string[] = [];
  let dayOffset = 0;

  beforeAll(async () => {
    const [admin] = await db
      .select()
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active')))
      .limit(1);
    const [referenceStore] = await db.select().from(stores).limit(1);
    if (!admin || !referenceStore) throw new Error('Reference seed and bootstrap admin required.');
    adminId = admin.id;
    groupId = referenceStore.groupId;
    const source = await createSupplierSource(db, {
      actorUserId: adminId,
      code: `RSW-${token.toUpperCase()}`,
      name: 'Reshare worker test',
      idempotencyKey: randomUUID(),
      requestHash: 'source',
    });
    if (source.replayed) throw new Error('unexpected replay');
    sourceId = source.value.id;
  });

  afterAll(async () => {
    if (sessionIds.length > 0) {
      await db
        .update(orderSessions)
        .set({ deletedAt: new Date() })
        .where(inArray(orderSessions.id, sessionIds));
    }
    await client.close();
  });

  async function product(legacyOnHand = 0) {
    const id = randomUUID().replaceAll('-', '');
    const [row] = await db
      .insert(products)
      .values({ sku: `RSW-${id}`, slug: `rsw-${id}`, name: `Reshare worker ${id.slice(0, 6)}` })
      .returning();
    if (legacyOnHand > 0) {
      await db.transaction((tx) =>
        applyWarehouseMovement(tx, {
          productId: row!.id,
          eventType: 'opening_balance',
          onHandDelta: legacyOnHand,
          reservedDelta: 0,
          sourceType: 'reshare_worker_opening',
          sourceId: randomUUID(),
          occurredAt: new Date(Date.now() - 3_600_000),
        }),
      );
    }
    await addSupplierSourceProducts(db, {
      actorUserId: adminId,
      sourceId,
      productIds: [row!.id],
      idempotencyKey: randomUUID(),
      requestHash: 'map',
    });
    return row!.id;
  }

  async function observe(productId: string, observedQuantity: number, observedAt: Date) {
    const input = {
      actorUserId: adminId,
      sourceId,
      observedAt,
      lines: [{ productId, observedQuantity }],
      eventCoverage: [],
      attestUnlinkedAsNotOrdered: true,
    };
    const preview = await previewSupplierStockObservation(db, input);
    await confirmSupplierStockObservation(db, {
      ...input,
      expectedRevision: preview.revision,
      idempotencyKey: randomUUID(),
      requestHash: `${productId}:${observedQuantity}`,
    });
  }

  /** One session: both stores order `quantity` of the SKU, then 08:00 and 09:00 run. */
  async function runSession(productId: string, quantity: number) {
    dayOffset += 1;
    const now = new Date();
    // The 08:00 snapshot reads the ledger as of its due time, which follows C's observation.
    const snapshotDueAt = now;
    const finalDueAt = new Date(now.getTime() + 120_000);
    const businessDate = new Date(
      Date.UTC(2032, 0, 1) +
        ((Number.parseInt(token.slice(0, 8), 16) % 10000) * 3 + dayOffset) * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    const [session] = await db
      .insert(orderSessions)
      .values({
        code: `RSW-${token}-${dayOffset}`,
        kind: 'manual',
        businessDate,
        status: 'open',
        inventorySnapshotDueAt: snapshotDueAt,
        requestDeadlineAt: finalDueAt,
        policyVersion: POLICY,
      })
      .returning();
    sessionIds.push(session!.id);
    // Fresh stores per session: a store's unmet remainder becomes a wait ticket, and a store
    // with an active wait ticket for the SKU may not order it again.
    const storeRows = await db
      .insert(stores)
      .values(
        [1, 2].map((index) => ({
          code: `RSW-${index}-${token}-${dayOffset}`,
          name: `Reshare worker store ${index}`,
          groupId,
        })),
      )
      .returning();
    for (const storeId of storeRows.map((row) => row.id)) {
      const [request] = await db
        .insert(orderRequests)
        .values({
          orderSessionId: session!.id,
          storeId,
          requestNumber: 1,
          status: 'submitted',
          submittedAt: new Date(now.getTime() - 60_000),
          requestedByUserId: adminId,
        })
        .returning();
      await db.insert(orderRequestItems).values({
        orderRequestId: request!.id,
        productId,
        requestedQuantity: quantity,
      });
    }
    const worker = new PostgresAllocationJobRepository(client);
    const scheduled = {
      id: session!.id,
      businessDate,
      snapshotDueAt,
      finalDueAt,
      policyVersion: POLICY,
    };
    await worker.captureSnapshotAndCreateOffers(scheduled, new Date(now.getTime() + 1));
    await worker.expireOffersAndFinalizeAllocation(
      scheduled,
      new Date(finalDueAt.getTime() + 1_000),
    );
    const lines = await db
      .select()
      .from(allocationLines)
      .innerJoin(orderRequestItems, eq(orderRequestItems.id, allocationLines.orderRequestItemId))
      .innerJoin(orderRequests, eq(orderRequests.id, orderRequestItems.orderRequestId))
      .where(
        and(
          eq(allocationLines.productId, productId),
          eq(orderRequests.orderSessionId, session!.id),
        ),
      );
    return lines.reduce((total, row) => total + row.allocation_lines.allocatedQuantity, 0);
  }

  async function available(productId: string) {
    const [row] = await db
      .select()
      .from(warehouseBalances)
      .where(eq(warehouseBalances.productId, productId));
    return (row?.onHandQuantity ?? 0) - (row?.reservedQuantity ?? 0);
  }

  it('AC01/T37: B=3 allocated, C re-observes 3 next day → nothing more is allocated', async () => {
    const productId = await product();
    await observe(productId, 3, new Date(Date.now() - 600_000));
    expect(await runSession(productId, 3)).toBe(3);
    expect(await available(productId)).toBe(0);
    // Next day HTKD has not ordered at Reshare yet; C sees 3 and records the total once.
    await observe(productId, 3, new Date(Date.now() - 60_000));
    expect(await available(productId)).toBe(0);
    expect(await runSession(productId, 3)).toBe(0);
  });

  it('allocates only F when B shows more than what A already committed', async () => {
    const productId = await product();
    await observe(productId, 3, new Date(Date.now() - 600_000));
    expect(await runSession(productId, 2)).toBe(3);
    await observe(productId, 7, new Date(Date.now() - 60_000));
    expect(await available(productId)).toBe(4);
    expect(await runSession(productId, 3)).toBe(4);
  });

  it('T29/T37: a SKU waiting for its baseline gets no offer and no allocation, whatever the ledger', async () => {
    const productId = await product(5);
    expect(await available(productId)).toBe(5);
    expect(await runSession(productId, 3)).toBe(0);
    const offers = await db
      .select()
      .from(dailyPriorityOffers)
      .where(eq(dailyPriorityOffers.productId, productId));
    expect(offers).toEqual([]);
  });
});
