import { randomUUID } from 'node:crypto';
import {
  allocationLines,
  allocationRuns,
  applyWarehouseMovement,
  createDatabase,
  createWarehouseStockAdjustment,
  dailyPriorityOffers,
  htkdAssignments,
  listSessionDocuments,
  mergedOrderItems,
  mergedOrders,
  orderRequestItems,
  orderRequests,
  orderSessions,
  products,
  respondPriorityOffer,
  stores,
  users,
  waitTickets,
  warehouseBalances,
  warehouseLedgerEntries,
  type Database,
} from '@idosi/database';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { PostgresAllocationJobRepository } from '../src/postgres-repository.js';
import type { ScheduledAllocationSession } from '../src/types.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;
const POLICY = 'idosi-round-robin-p0a-p3-v1';
const MINUTE = 60_000;

function isolatedDate(token: string): string {
  return new Date(
    Date.UTC(2060, 0, 1) + (Number.parseInt(token.slice(0, 8), 16) % 15_000) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
}

async function insertSession(
  db: Database,
  values: {
    businessDate: string;
    kind: 'default' | 'manual';
    snapshotDueAt: Date;
    finalDueAt: Date;
    status?: 'open' | 'completed';
  },
) {
  const [row] = await db
    .insert(orderSessions)
    .values({
      code: '',
      kind: values.kind,
      businessDate: values.businessDate,
      status: values.status ?? 'open',
      openedAt: new Date(values.snapshotDueAt.getTime() - 60 * MINUTE),
      inventorySnapshotDueAt: values.snapshotDueAt,
      requestDeadlineAt: values.finalDueAt,
      policyVersion: POLICY,
    })
    .returning();
  return row!;
}

function scheduled(row: Awaited<ReturnType<typeof insertSession>>): ScheduledAllocationSession {
  return {
    id: row.id,
    businessDate: row.businessDate,
    snapshotDueAt: row.inventorySnapshotDueAt,
    finalDueAt: row.requestDeadlineAt,
    policyVersion: row.policyVersion,
  };
}

async function insertRequest(
  db: Database,
  input: {
    sessionId: string;
    storeId: string;
    requestNumber: number;
    submittedAt: Date;
    requestedByUserId: string;
    lines: readonly (readonly [string, number])[];
    status?: 'submitted' | 'allocated';
  },
) {
  const [request] = await db
    .insert(orderRequests)
    .values({
      orderSessionId: input.sessionId,
      storeId: input.storeId,
      requestNumber: input.requestNumber,
      status: input.status ?? 'submitted',
      submittedAt: input.submittedAt,
      requestedByUserId: input.requestedByUserId,
    })
    .returning();
  const items = await db
    .insert(orderRequestItems)
    .values(
      input.lines.map(([productId, quantity]) => ({
        orderRequestId: request!.id,
        productId,
        requestedQuantity: quantity,
      })),
    )
    .returning();
  return { request: request!, items };
}

async function mergedQuantities(db: Database, sessionId: string, storeId: string) {
  const rows = await db
    .select({ productId: mergedOrderItems.productId, quantity: mergedOrderItems.requestedQuantity })
    .from(mergedOrderItems)
    .innerJoin(mergedOrders, eq(mergedOrders.id, mergedOrderItems.mergedOrderId))
    .where(and(eq(mergedOrders.orderSessionId, sessionId), eq(mergedOrders.storeId, storeId)));
  return Object.fromEntries(rows.map((row) => [row.productId, row.quantity]));
}

describePostgres('independent allocation sessions on one business date', () => {
  it('keeps S1, S2 and S3 of one day separate: documents, shortages, offers and replays', async () => {
    const client = createDatabase({ connectionString: process.env.DATABASE_URL!, max: 4 });
    const db = client.db;
    const token = randomUUID().replaceAll('-', '');
    const date = isolatedDate(token);
    const now = new Date();
    const t = now.getTime() - 30 * MINUTE;
    const sessionIds: string[] = [];
    try {
      const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
      const [referenceStore] = await db.select().from(stores).limit(1);
      if (!admin || !referenceStore) throw new Error('Reference seed required.');
      const productRows = await db
        .insert(products)
        .values(
          ['X', 'Y', 'Z'].map((name) => ({
            sku: `MS-${name}-${token}`,
            slug: `ms-${name.toLowerCase()}-${token}`,
            name: `Multi session ${name}`,
          })),
        )
        .returning();
      const [x, y, z] = productRows as [
        (typeof productRows)[number],
        (typeof productRows)[number],
        (typeof productRows)[number],
      ];
      const storeRows = await db
        .insert(stores)
        .values(
          ['A', 'B'].map((name) => ({
            code: `MS-${name}-${token}`,
            name: `Multi session store ${name}`,
            groupId: referenceStore.groupId,
          })),
        )
        .returning();
      const [storeA, storeB] = storeRows as [
        (typeof storeRows)[number],
        (typeof storeRows)[number],
      ];
      const [htkd] = await db
        .insert(users)
        .values({
          email: `ms.htkd.${token}`,
          displayName: 'Multi session HTKD',
          passwordHash: admin.passwordHash,
          role: 'htkd',
        })
        .returning();
      await db.insert(htkdAssignments).values({ userId: htkd!.id, storeId: storeB.id });
      for (const [product, quantity] of [
        [x, 10],
        [y, 10],
        [z, 3],
      ] as const) {
        await db.transaction((tx) =>
          applyWarehouseMovement(tx, {
            productId: product.id,
            eventType: 'opening_balance',
            onHandDelta: quantity,
            reservedDelta: 0,
            sourceType: 'multi_session_test',
            sourceId: randomUUID(),
            occurredAt: new Date(t - 10 * MINUTE),
          }),
        );
      }

      const s1 = await insertSession(db, {
        businessDate: date,
        kind: 'default',
        snapshotDueAt: new Date(t),
        finalDueAt: new Date(t + MINUTE),
      });
      const s2 = await insertSession(db, {
        businessDate: date,
        kind: 'manual',
        snapshotDueAt: new Date(t + 10 * MINUTE),
        finalDueAt: new Date(now.getTime() + 10 * MINUTE),
      });
      const s3 = await insertSession(db, {
        businessDate: date,
        kind: 'manual',
        snapshotDueAt: new Date(t + 20 * MINUTE),
        finalDueAt: new Date(now.getTime() + 15 * MINUTE),
      });
      sessionIds.push(s1.id, s2.id, s3.id);
      expect(new Set([s1.code, s2.code, s3.code]).size).toBe(3);

      // S1: A sends two requests that merge into one document; B is short of Z.
      await insertRequest(db, {
        sessionId: s1.id,
        storeId: storeA.id,
        requestNumber: 1,
        submittedAt: new Date(t - 5 * MINUTE),
        requestedByUserId: admin.id,
        lines: [
          [x.id, 2],
          [y.id, 1],
        ],
      });
      await insertRequest(db, {
        sessionId: s1.id,
        storeId: storeA.id,
        requestNumber: 2,
        submittedAt: new Date(t - 4 * MINUTE),
        requestedByUserId: admin.id,
        lines: [[x.id, 3]],
      });
      await insertRequest(db, {
        sessionId: s1.id,
        storeId: storeB.id,
        requestNumber: 1,
        submittedAt: new Date(t - 3 * MINUTE),
        requestedByUserId: admin.id,
        lines: [[z.id, 5]],
      });

      const worker = new PostgresAllocationJobRepository(client);
      await worker.captureSnapshotAndCreateOffers(scheduled(s1), new Date(t));
      await worker.expireOffersAndFinalizeAllocation(scheduled(s1), new Date(t + MINUTE));
      expect(await mergedQuantities(db, s1.id, storeA.id)).toEqual({ [x.id]: 5, [y.id]: 1 });
      const [ticket] = await db
        .select()
        .from(waitTickets)
        .where(and(eq(waitTickets.storeId, storeB.id), eq(waitTickets.productId, z.id)));
      expect(ticket).toMatchObject({ status: 'active', remainingQuantity: 2, originalQuantity: 2 });

      // Two more bags of Z arrive through an audited Admin adjustment before S2's snapshot.
      const [zBalance] = await db
        .select()
        .from(warehouseBalances)
        .where(eq(warehouseBalances.productId, z.id));
      await createWarehouseStockAdjustment(db, {
        productId: z.id,
        direction: 'increase',
        quantity: 2,
        reasonCode: 'count_correction',
        reason: 'Kiểm kê thấy thêm 2 bao',
        expectedVersion: zBalance!.version,
        actorUserId: admin.id,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
        now: new Date(t + 5 * MINUTE),
      });

      // S2: after S1 is allocated, A orders X=4 again.
      await insertRequest(db, {
        sessionId: s2.id,
        storeId: storeA.id,
        requestNumber: 1,
        submittedAt: new Date(t + 5 * MINUTE),
        requestedByUserId: admin.id,
        lines: [[x.id, 4]],
      });
      await worker.captureSnapshotAndCreateOffers(scheduled(s2), new Date(t + 10 * MINUTE));
      const ticketOffers = () =>
        db
          .select()
          .from(dailyPriorityOffers)
          .where(eq(dailyPriorityOffers.waitTicketId, ticket!.id));
      const s2Offers = await ticketOffers();
      expect(s2Offers).toHaveLength(1);
      expect(s2Offers[0]).toMatchObject({
        orderSessionId: s2.id,
        offeredQuantity: 2,
        stockHeldQuantity: 2,
        status: 'offered',
      });

      // S3 snapshots while S2's offer is still open: the same wait is never held twice.
      await worker.captureSnapshotAndCreateOffers(scheduled(s3), new Date(t + 20 * MINUTE));
      expect(await ticketOffers()).toHaveLength(1);

      await respondPriorityOffer(db, {
        offerId: s2Offers[0]!.id,
        action: 'accept',
        actorUserId: htkd!.id,
        acceptedQuantity: 2,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
      });
      await worker.expireOffersAndFinalizeAllocation(
        scheduled(s2),
        new Date(s2.requestDeadlineAt.getTime() + 1_000),
      );
      await worker.expireOffersAndFinalizeAllocation(
        scheduled(s3),
        new Date(s3.requestDeadlineAt.getTime() + 1_000),
      );

      // Documents are per session: S2 is X=4 (not 9) and S1 still reads X=5/Y=1.
      expect(await mergedQuantities(db, s2.id, storeA.id)).toEqual({ [x.id]: 4 });
      expect(await mergedQuantities(db, s1.id, storeA.id)).toEqual({ [x.id]: 5, [y.id]: 1 });
      const zLines = await db
        .select({
          runSession: allocationRuns.orderSessionId,
          allocated: allocationLines.allocatedQuantity,
          waitTicketId: allocationLines.waitTicketId,
        })
        .from(allocationLines)
        .innerJoin(allocationRuns, eq(allocationRuns.id, allocationLines.allocationRunId))
        .where(and(eq(allocationLines.productId, z.id), eq(allocationLines.storeId, storeB.id)));
      // 3 bags granted in S1 are not granted again; S2 grants only the 2 still waiting.
      expect(zLines.find((line) => line.runSession === s1.id)?.allocated).toBe(3);
      expect(zLines.find((line) => line.runSession === s2.id)).toMatchObject({
        allocated: 2,
        waitTicketId: ticket!.id,
      });
      expect(zLines.reduce((total, line) => total + line.allocated, 0)).toBe(5);
      const [fulfilled] = await db.select().from(waitTickets).where(eq(waitTickets.id, ticket!.id));
      expect(fulfilled).toMatchObject({ status: 'fulfilled', remainingQuantity: 0 });

      const documents = async (sessionId: string) =>
        (
          await listSessionDocuments(db, {
            page: 1,
            pageSize: 20,
            sessionId,
            storeIds: [storeA.id, storeB.id],
          })
        ).data;
      const s1Documents = await documents(s1.id);
      const s2Documents = await documents(s2.id);
      expect(s1Documents.map((document) => document.storeId).sort()).toEqual(
        [storeA.id, storeB.id].sort(),
      );
      expect(s2Documents.every((document) => document.sessionId === s2.id)).toBe(true);
      expect(await documents(s3.id)).toEqual([]);

      const [s3Row] = await db.select().from(orderSessions).where(eq(orderSessions.id, s3.id));
      expect(s3Row?.status).toBe('completed');

      // A worker restart replays every job without a second run, line or ledger entry.
      const ledgerBefore = await db
        .select({ id: warehouseLedgerEntries.id })
        .from(warehouseLedgerEntries)
        .where(inArray(warehouseLedgerEntries.productId, [x.id, y.id, z.id]));
      for (const session of [s1, s2, s3]) {
        expect(
          (await worker.captureSnapshotAndCreateOffers(scheduled(session), new Date())).replayed,
        ).toBe(true);
        expect(
          (
            await worker.expireOffersAndFinalizeAllocation(
              scheduled(session),
              new Date(session.requestDeadlineAt.getTime() + 2_000),
            )
          ).replayed,
        ).toBe(true);
      }
      const runs = await db
        .select({ sessionId: allocationRuns.orderSessionId })
        .from(allocationRuns)
        .where(inArray(allocationRuns.orderSessionId, sessionIds));
      expect(runs.map((run) => run.sessionId).sort()).toEqual([...sessionIds].sort());
      const ledgerAfter = await db
        .select({ id: warehouseLedgerEntries.id })
        .from(warehouseLedgerEntries)
        .where(inArray(warehouseLedgerEntries.productId, [x.id, y.id, z.id]));
      expect(ledgerAfter).toHaveLength(ledgerBefore.length);
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

  it('expires only offers due by the finishing session and never reuses another session offer', async () => {
    const client = createDatabase({ connectionString: process.env.DATABASE_URL!, max: 4 });
    const db = client.db;
    const token = randomUUID().replaceAll('-', '');
    const date = isolatedDate(token);
    const now = new Date();
    const sessionIds: string[] = [];
    try {
      const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
      const [referenceStore] = await db.select().from(stores).limit(1);
      if (!admin || !referenceStore) throw new Error('Reference seed required.');
      const productRows = await db
        .insert(products)
        .values(
          ['W1', 'W2'].map((name) => ({
            sku: `EXP-${name}-${token}`,
            slug: `exp-${name.toLowerCase()}-${token}`,
            name: `Expiry ${name}`,
          })),
        )
        .returning();
      const storeRows = await db
        .insert(stores)
        .values(
          ['D', 'E'].map((name) => ({
            code: `EXP-${name}-${token}`,
            name: `Expiry store ${name}`,
            groupId: referenceStore.groupId,
          })),
        )
        .returning();
      for (const product of productRows) {
        await db.transaction((tx) =>
          applyWarehouseMovement(tx, {
            productId: product.id,
            eventType: 'opening_balance',
            onHandDelta: 1,
            reservedDelta: 0,
            sourceType: 'expiry_test',
            sourceId: randomUUID(),
            occurredAt: new Date(now.getTime() - 40 * MINUTE),
          }),
        );
      }
      const source = await insertSession(db, {
        businessDate: date,
        kind: 'default',
        snapshotDueAt: new Date(now.getTime() - 50 * MINUTE),
        finalDueAt: new Date(now.getTime() - 45 * MINUTE),
        status: 'completed',
      });
      const p = await insertSession(db, {
        businessDate: date,
        kind: 'manual',
        snapshotDueAt: new Date(now.getTime() - 20 * MINUTE),
        finalDueAt: new Date(now.getTime() + 5 * MINUTE),
      });
      const q = await insertSession(db, {
        businessDate: date,
        kind: 'manual',
        snapshotDueAt: new Date(now.getTime() - 10 * MINUTE),
        finalDueAt: new Date(now.getTime() + 10 * MINUTE),
      });
      sessionIds.push(source.id, p.id, q.id);
      const ticketFor = async (index: number) => {
        const { items } = await insertRequest(db, {
          sessionId: source.id,
          storeId: storeRows[index]!.id,
          requestNumber: 1,
          submittedAt: new Date(now.getTime() - 55 * MINUTE),
          requestedByUserId: admin.id,
          lines: [[productRows[index]!.id, 1]],
          status: 'allocated',
        });
        const [ticket] = await db
          .insert(waitTickets)
          .values({
            storeId: storeRows[index]!.id,
            productId: productRows[index]!.id,
            sourceOrderRequestItemId: items[0]!.id,
            originalQuantity: 1,
            remainingQuantity: 1,
            priorityLevel: 'P0B',
            queuedAt: new Date(now.getTime() - 45 * MINUTE),
          })
          .returning();
        return ticket!;
      };
      const worker = new PostgresAllocationJobRepository(client);
      const ticketD = await ticketFor(0);
      await worker.captureSnapshotAndCreateOffers(scheduled(p), p.inventorySnapshotDueAt);
      const ticketE = await ticketFor(1);
      await worker.captureSnapshotAndCreateOffers(scheduled(q), q.inventorySnapshotDueAt);
      const offerOf = async (ticketId: string) =>
        (
          await db
            .select()
            .from(dailyPriorityOffers)
            .where(eq(dailyPriorityOffers.waitTicketId, ticketId))
        )[0]!;
      expect((await offerOf(ticketD.id)).orderSessionId).toBe(p.id);
      expect((await offerOf(ticketE.id)).orderSessionId).toBe(q.id);
      const [htkd] = await db
        .insert(users)
        .values({
          email: `exp.htkd.${token}`,
          displayName: 'Expiry HTKD',
          passwordHash: admin.passwordHash,
          role: 'htkd',
        })
        .returning();
      await db.insert(htkdAssignments).values({ userId: htkd!.id, storeId: storeRows[0]!.id });
      await respondPriorityOffer(db, {
        offerId: (await offerOf(ticketD.id)).id,
        action: 'accept',
        actorUserId: htkd!.id,
        acceptedQuantity: 1,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
      });

      await worker.expireOffersAndFinalizeAllocation(
        scheduled(p),
        new Date(p.requestDeadlineAt.getTime() + 1_000),
      );
      // P allocates the offer it owns; the accepted offer stays accepted and is consumed once.
      expect(await offerOf(ticketD.id)).toMatchObject({ status: 'accepted', stockHeldQuantity: 0 });
      const pLines = await db
        .select()
        .from(allocationLines)
        .where(eq(allocationLines.priorityOfferId, (await offerOf(ticketD.id)).id));
      expect(pLines.map((line) => line.allocatedQuantity)).toEqual([1]);
      // Q's offer is due later; finishing P neither expires it nor releases its held bag.
      expect(await offerOf(ticketE.id)).toMatchObject({ status: 'offered', stockHeldQuantity: 1 });
      const [w2] = await db
        .select()
        .from(warehouseBalances)
        .where(eq(warehouseBalances.productId, productRows[1]!.id));
      expect(w2?.reservedQuantity).toBe(1);

      // Q runs on the same business date and must not pick up P's accepted offer again.
      expect(
        (
          await worker.expireOffersAndFinalizeAllocation(
            scheduled(q),
            new Date(q.requestDeadlineAt.getTime() + 1_000),
          )
        ).replayed,
      ).toBe(false);
      expect(await offerOf(ticketE.id)).toMatchObject({ status: 'expired', stockHeldQuantity: 0 });
      const offerLines = await db
        .select()
        .from(allocationLines)
        .where(eq(allocationLines.priorityOfferId, (await offerOf(ticketD.id)).id));
      expect(offerLines).toHaveLength(1);
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
