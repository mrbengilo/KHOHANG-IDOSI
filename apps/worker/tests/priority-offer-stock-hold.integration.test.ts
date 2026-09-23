import { randomUUID } from 'node:crypto';
import {
  allocationLines,
  applyWarehouseMovement,
  createDatabase,
  dailyPriorityOffers,
  htkdAssignments,
  listPriorityOffers,
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
  WaitTicketAuthorizationError,
} from '@idosi/database';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PostgresAllocationJobRepository } from '../src/postgres-repository.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('priority offer stock holds', () => {
  it('holds at 08:00, releases a wholesale decline, and transfers an HTKD acceptance into 09:00 allocation', async () => {
    const client = createDatabase({ connectionString: process.env.DATABASE_URL!, max: 4 });
    const db = client.db;
    const token = randomUUID().replaceAll('-', '');
    const now = new Date();
    const snapshotDueAt = new Date(now.getTime() - 30_000);
    const finalDueAt = new Date(now.getTime() + 120_000);
    const businessDate = new Date(
      Date.UTC(2030, 0, 1) + (Number.parseInt(token.slice(0, 8), 16) % 20000) * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    try {
      const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
      const [referenceStore] = await db.select().from(stores).limit(1);
      if (!admin || !referenceStore) throw new Error('Reference seed required.');
      const [product] = await db
        .insert(products)
        .values({
          sku: `HOLD-${token}`,
          slug: `hold-${token}`,
          name: 'Priority hold test product',
        })
        .returning();
      const storeRows = await db
        .insert(stores)
        .values(
          [1, 2, 3].map((index) => ({
            code: `HOLD-${index}-${token}`,
            name: `Priority hold store ${index}`,
            groupId: referenceStore.groupId,
            kind: index === 2 ? ('wholesale' as const) : ('retail' as const),
          })),
        )
        .returning();
      const [htkd] = await db
        .insert(users)
        .values({
          email: `hold.htkd.${token}`,
          displayName: 'Priority hold HTKD',
          passwordHash: admin.passwordHash,
          role: 'htkd',
        })
        .returning();
      const [wholesaleUser] = await db
        .insert(users)
        .values({
          email: `hold.wholesale.${token}`,
          displayName: 'Priority hold wholesale desk',
          passwordHash: admin.passwordHash,
          role: 'wholesale',
        })
        .returning();
      await db.insert(htkdAssignments).values({ userId: htkd!.id, storeId: storeRows[0]!.id });
      const [sourceSession] = await db
        .insert(orderSessions)
        .values({
          code: `HOLD-SOURCE-${token}`,
          businessDate,
          status: 'completed',
          inventorySnapshotDueAt: snapshotDueAt,
          requestDeadlineAt: finalDueAt,
          policyVersion: 'idosi-round-robin-p0a-p3-v1',
        })
        .returning();
      const [session] = await db
        .insert(orderSessions)
        .values({
          code: `HOLD-ACTIVE-${token}`,
          businessDate,
          status: 'open',
          inventorySnapshotDueAt: snapshotDueAt,
          requestDeadlineAt: finalDueAt,
          policyVersion: 'idosi-round-robin-p0a-p3-v1',
        })
        .returning();
      const tickets: { id: string }[] = [];
      for (const store of storeRows.slice(0, 2)) {
        const [sourceOrder] = await db
          .insert(orderRequests)
          .values({
            orderSessionId: sourceSession!.id,
            storeId: store.id,
            requestNumber: 1,
            status: 'allocated',
            submittedAt: new Date(now.getTime() - 60_000),
            requestedByUserId: admin.id,
          })
          .returning();
        const [sourceLine] = await db
          .insert(orderRequestItems)
          .values({
            orderRequestId: sourceOrder!.id,
            productId: product!.id,
            requestedQuantity: 2,
          })
          .returning();
        const [ticket] = await db
          .insert(waitTickets)
          .values({
            storeId: store.id,
            productId: product!.id,
            sourceOrderRequestItemId: sourceLine!.id,
            originalQuantity: 2,
            remainingQuantity: 2,
            priorityLevel: 'P0B',
            queuedAt: new Date(now.getTime() - 60_000),
          })
          .returning();
        tickets.push(ticket!);
      }
      await db.transaction((tx) =>
        applyWarehouseMovement(tx, {
          productId: product!.id,
          eventType: 'opening_balance',
          onHandDelta: 4,
          reservedDelta: 0,
          sourceType: 'priority_hold_test',
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
      expect((await worker.captureSnapshotAndCreateOffers(scheduled, now)).replayed).toBe(false);
      expect((await worker.captureSnapshotAndCreateOffers(scheduled, now)).replayed).toBe(true);
      const offers = await db
        .select()
        .from(dailyPriorityOffers)
        .where(eq(dailyPriorityOffers.businessDate, businessDate));
      const ownOffers = offers.filter((offer) =>
        tickets.some((ticket) => ticket.id === offer.waitTicketId),
      );
      expect(ownOffers).toHaveLength(2);
      expect(ownOffers.map((offer) => offer.stockHeldQuantity)).toEqual([2, 2]);
      expect(
        (
          await db
            .select()
            .from(warehouseBalances)
            .where(eq(warehouseBalances.productId, product!.id))
        )[0]?.reservedQuantity,
      ).toBe(4);

      const accepted = ownOffers.find((offer) => offer.storeId === storeRows[0]!.id)!;
      const declined = ownOffers.find((offer) => offer.storeId === storeRows[1]!.id)!;
      expect(
        (await listPriorityOffers(db, { actorUserId: wholesaleUser!.id })).data.map(
          (offer) => offer.id,
        ),
      ).toContain(declined.id);
      expect(
        (await listPriorityOffers(db, { actorUserId: wholesaleUser!.id })).data.map(
          (offer) => offer.id,
        ),
      ).not.toContain(accepted.id);
      await expect(
        respondPriorityOffer(db, {
          offerId: accepted.id,
          action: 'accept',
          actorUserId: wholesaleUser!.id,
          acceptedQuantity: 2,
          idempotencyKey: randomUUID(),
          requestHash: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(WaitTicketAuthorizationError);
      await expect(
        respondPriorityOffer(db, {
          offerId: declined.id,
          action: 'accept',
          actorUserId: htkd!.id,
          acceptedQuantity: 2,
          idempotencyKey: randomUUID(),
          requestHash: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(WaitTicketAuthorizationError);
      await respondPriorityOffer(db, {
        offerId: accepted.id,
        action: 'accept',
        actorUserId: htkd!.id,
        acceptedQuantity: 2,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
      });
      await respondPriorityOffer(db, {
        offerId: declined.id,
        action: 'decline',
        actorUserId: wholesaleUser!.id,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
      });
      const [ordinaryOrder] = await db
        .insert(orderRequests)
        .values({
          orderSessionId: session!.id,
          storeId: storeRows[2]!.id,
          requestNumber: 1,
          status: 'submitted',
          submittedAt: new Date(now.getTime() - 20_000),
          requestedByUserId: admin.id,
        })
        .returning();
      await db.insert(orderRequestItems).values({
        orderRequestId: ordinaryOrder!.id,
        productId: product!.id,
        requestedQuantity: 2,
      });
      expect(
        (
          await db
            .select()
            .from(warehouseBalances)
            .where(eq(warehouseBalances.productId, product!.id))
        )[0]?.reservedQuantity,
      ).toBe(2);
      expect(
        (
          await worker.expireOffersAndFinalizeAllocation(
            scheduled,
            new Date(finalDueAt.getTime() + 1_000),
          )
        ).replayed,
      ).toBe(false);
      expect(
        (
          await worker.expireOffersAndFinalizeAllocation(
            scheduled,
            new Date(finalDueAt.getTime() + 1_000),
          )
        ).replayed,
      ).toBe(true);
      const lines = await db
        .select()
        .from(allocationLines)
        .where(eq(allocationLines.productId, product!.id));
      expect(
        lines.filter((line) => line.priorityOfferId === accepted.id)[0]?.allocatedQuantity,
      ).toBe(2);
      expect(lines.filter((line) => line.orderRequestItemId !== null)[0]?.allocatedQuantity).toBe(
        2,
      );
      expect(
        (
          await db
            .select()
            .from(warehouseBalances)
            .where(eq(warehouseBalances.productId, product!.id))
        )[0]?.reservedQuantity,
      ).toBe(4);
      const ledger = await db
        .select({ reservedDelta: warehouseLedgerEntries.reservedDelta })
        .from(warehouseLedgerEntries)
        .where(eq(warehouseLedgerEntries.productId, product!.id));
      expect(ledger.reduce((total, entry) => total + entry.reservedDelta, 0)).toBe(4);
      expect(
        (
          await db.select().from(dailyPriorityOffers).where(eq(dailyPriorityOffers.id, accepted.id))
        )[0]?.stockHeldQuantity,
      ).toBe(0);
    } finally {
      await client.close();
    }
  });
});
