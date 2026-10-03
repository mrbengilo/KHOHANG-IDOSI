import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import {
  applyWarehouseMovement,
  auditLogs,
  cancelWaitTicket,
  closeDatabase,
  dailyPriorityOffers,
  db,
  htkdAssignments,
  orderRequestItems,
  orderRequests,
  orderSessions,
  products,
  respondPriorityOffer,
  stores,
  users,
  waitTickets,
  warehouseBalances,
} from '../src/index.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('wait ticket cancellation rights and holds', () => {
  const sessionIds: string[] = [];
  afterAll(async () => {
    for (const id of sessionIds) {
      await db.update(orderSessions).set({ deletedAt: new Date() }).where(eq(orderSessions.id, id));
    }
    await closeDatabase();
  });

  async function fixture(options: { readonly inactiveStore?: boolean } = {}) {
    const token = randomUUID().replaceAll('-', '');
    const [reference] = await db.select().from(stores).limit(1);
    const [product] = await db
      .insert(products)
      .values({ sku: `CAN-${token}`, slug: `can-${token}`, name: 'Cancellation product' })
      .returning();
    const [store, otherStore] = await db
      .insert(stores)
      .values(
        [1, 2].map((index) => ({
          code: `CAN-${index}-${token}`,
          name: `Cancellation store ${index}`,
          groupId: reference!.groupId,
          kind: 'retail' as const,
        })),
      )
      .returning();
    const account = async (role: 'admin' | 'htkd' | 'store', label: string, storeId?: string) =>
      (
        await db
          .insert(users)
          .values({
            email: `can.${label}.${token}`,
            displayName: label,
            passwordHash: 'integration-test-placeholder-hash',
            role,
            storeId: storeId ?? null,
          })
          .returning()
      )[0]!;
    const admin = await account('admin', 'admin');
    const lockedAdmin = await account('admin', 'locked-admin');
    await db.update(users).set({ status: 'locked' }).where(eq(users.id, lockedAdmin.id));
    const owner = await account('store', 'owner', store!.id);
    const stranger = await account('store', 'stranger', otherStore!.id);
    const htkd = await account('htkd', 'htkd');
    await db.insert(htkdAssignments).values({ userId: htkd.id, storeId: store!.id });
    const now = Date.now();
    const [session] = await db
      .insert(orderSessions)
      .values({
        code: `CAN-${token}`,
        kind: 'manual',
        businessDate: new Date(
          Date.UTC(2033, 0, 1) + (Number.parseInt(token.slice(0, 8), 16) % 20000) * 86400000,
        )
          .toISOString()
          .slice(0, 10),
        status: 'open',
        inventorySnapshotDueAt: new Date(now - 60_000),
        requestDeadlineAt: new Date(now + 10 * 60_000),
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
      })
      .returning();
    sessionIds.push(session!.id);
    const [order] = await db
      .insert(orderRequests)
      .values({
        orderSessionId: session!.id,
        storeId: store!.id,
        requestNumber: 1,
        status: 'allocated',
        submittedAt: new Date(now - 120_000),
        requestedByUserId: owner.id,
      })
      .returning();
    const [line] = await db
      .insert(orderRequestItems)
      .values({ orderRequestId: order!.id, productId: product!.id, requestedQuantity: 3 })
      .returning();
    const [ticket] = await db
      .insert(waitTickets)
      .values({
        storeId: store!.id,
        productId: product!.id,
        sourceOrderRequestItemId: line!.id,
        originalQuantity: 3,
        remainingQuantity: 3,
      })
      .returning();
    if (options.inactiveStore) {
      await db.update(stores).set({ isActive: false }).where(eq(stores.id, store!.id));
    }
    return {
      admin,
      lockedAdmin,
      owner,
      stranger,
      htkd,
      store: store!,
      product: product!,
      session: session!,
      ticket: ticket!,
    };
  }

  async function holdOffer(
    f: Awaited<ReturnType<typeof fixture>>,
    quantity: number,
    eligible: number | null,
  ) {
    const offerId = randomUUID();
    await db.transaction(async (tx) => {
      await applyWarehouseMovement(tx, {
        productId: f.product.id,
        eventType: 'opening_balance',
        onHandDelta: quantity,
        reservedDelta: 0,
        sourceType: 'cancellation_test',
        sourceId: randomUUID(),
      });
      await tx.insert(dailyPriorityOffers).values({
        id: offerId,
        businessDate: f.session.businessDate,
        orderSessionId: f.session.id,
        storeId: f.store.id,
        productId: f.product.id,
        waitTicketId: f.ticket.id,
        priorityLevel: 'P0A',
        offeredQuantity: quantity,
        eligibleQuantityAtOffer: eligible,
        stockHeldQuantity: quantity,
        responseDeadlineAt: f.session.requestDeadlineAt,
      });
      await applyWarehouseMovement(tx, {
        productId: f.product.id,
        eventType: 'reservation',
        onHandDelta: 0,
        reservedDelta: quantity,
        sourceType: 'priority_offer',
        sourceId: offerId,
        eventSequence: 1,
      });
    });
    return offerId;
  }

  const reserved = async (productId: string) =>
    (await db.select().from(warehouseBalances).where(eq(warehouseBalances.productId, productId)))[0]
      ?.reservedQuantity;

  const cancel = (
    waitTicketId: string,
    actorUserId: string,
    key = randomUUID(),
    reason = 'Không cần nữa',
  ) =>
    cancelWaitTicket(db, {
      waitTicketId,
      actorUserId,
      reason,
      idempotencyKey: key,
      requestHash: `${reason}`,
    });

  it('lets only the owning store or an active admin cancel, never HTKD or another store', async () => {
    const f = await fixture();
    for (const actor of [f.stranger, f.htkd, f.lockedAdmin]) {
      await expect(cancel(f.ticket.id, actor.id)).rejects.toMatchObject({
        code: 'WAIT_TICKET_FORBIDDEN',
      });
    }
    const key = randomUUID();
    const first = await cancel(f.ticket.id, f.owner.id, key);
    expect(first.replayed).toBe(false);
    // An exact retry replays; the same key with another payload conflicts; a new key has no effect.
    expect((await cancel(f.ticket.id, f.owner.id, key)).replayed).toBe(true);
    await expect(cancel(f.ticket.id, f.owner.id, key, 'Lý do khác')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    await expect(cancel(f.ticket.id, f.admin.id)).rejects.toMatchObject({
      code: 'WAIT_TICKET_CONFLICT',
    });
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, f.ticket.id), eq(auditLogs.entityType, 'wait_ticket')));
    expect(audits.map((row) => row.action)).toEqual(['WAIT_TICKET_STORE_CANCELLED']);
    expect(audits[0]!.metadata).toMatchObject({
      cancellationKind: 'store_cancelled',
      cancelledQuantity: 3,
    });
  });

  it('lets an admin cancel the wait of an inactive store and release an accepted, unallocated hold', async () => {
    const f = await fixture({ inactiveStore: true });
    const offerId = await holdOffer(f, 2, 3);
    // The accepted offer was answered while the store was still active.
    await db
      .update(dailyPriorityOffers)
      .set({ status: 'accepted', acceptedQuantity: 2, respondedAt: new Date() })
      .where(eq(dailyPriorityOffers.id, offerId));
    expect(await reserved(f.product.id)).toBe(2);
    await expect(cancel(f.ticket.id, f.owner.id)).rejects.toMatchObject({
      code: 'WAIT_TICKET_FORBIDDEN',
    });
    const result = await cancel(f.ticket.id, f.admin.id);
    if (result.replayed) throw new Error('unexpected replay');
    expect(result.value).toMatchObject({
      cancellationKind: 'admin_cancelled',
      cancelledOfferIds: [offerId],
    });
    expect(
      (await db.select().from(waitTickets).where(eq(waitTickets.id, f.ticket.id)))[0],
    ).toMatchObject({
      status: 'cancelled',
      cancellationKind: 'admin_cancelled',
      remainingQuantity: 3,
      fulfilledQuantity: 0,
    });
    expect(
      (await db.select().from(dailyPriorityOffers).where(eq(dailyPriorityOffers.id, offerId)))[0],
    ).toMatchObject({ status: 'cancelled', acceptedQuantity: 0, stockHeldQuantity: 0 });
    expect(await reserved(f.product.id)).toBe(0);
    expect(
      await db
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(eq(auditLogs.entityId, f.ticket.id)),
    ).toEqual([{ action: 'WAIT_TICKET_ADMIN_CANCELLED' }]);
  });

  it('declining a partial offer keeps the ticket; declining a full offer cancels it at once', async () => {
    const partial = await fixture();
    const partialOffer = await holdOffer(partial, 1, 3);
    const declinedPartial = await respondPriorityOffer(db, {
      offerId: partialOffer,
      action: 'decline',
      actorUserId: partial.owner.id,
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    });
    if (declinedPartial.replayed) throw new Error('unexpected replay');
    expect(declinedPartial.value.waitTicketCancelled).toBe(false);
    expect(
      (await db.select().from(waitTickets).where(eq(waitTickets.id, partial.ticket.id)))[0],
    ).toMatchObject({ status: 'active', remainingQuantity: 3, cancellationKind: null });
    expect(await reserved(partial.product.id)).toBe(0);

    const full = await fixture();
    const fullOffer = await holdOffer(full, 3, 3);
    // HTKD may answer for an assigned store; its decline of a full offer ends the wait.
    const declinedFull = await respondPriorityOffer(db, {
      offerId: fullOffer,
      action: 'decline',
      actorUserId: full.htkd.id,
      reason: 'Cửa hàng không còn chỗ chứa',
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    });
    if (declinedFull.replayed) throw new Error('unexpected replay');
    expect(declinedFull.value).toMatchObject({ status: 'declined', waitTicketCancelled: true });
    expect(
      (await db.select().from(waitTickets).where(eq(waitTickets.id, full.ticket.id)))[0],
    ).toMatchObject({
      status: 'cancelled',
      cancellationKind: 'full_offer_declined',
      cancelledByOfferId: fullOffer,
    });
    expect(await reserved(full.product.id)).toBe(0);

    // A legacy full-quantity offer without a recorded basis is treated as partial.
    const legacy = await fixture();
    const legacyOffer = await holdOffer(legacy, 3, null);
    const declinedLegacy = await respondPriorityOffer(db, {
      offerId: legacyOffer,
      action: 'decline',
      actorUserId: legacy.owner.id,
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    });
    if (declinedLegacy.replayed) throw new Error('unexpected replay');
    expect(declinedLegacy.value.waitTicketCancelled).toBe(false);
    expect(
      (await db.select().from(waitTickets).where(eq(waitTickets.id, legacy.ticket.id)))[0],
    ).toMatchObject({ status: 'active' });
  });

  it('never rewrites a fulfilled ticket', async () => {
    const f = await fixture();
    await db
      .update(waitTickets)
      .set({
        status: 'fulfilled',
        remainingQuantity: 0,
        fulfilledQuantity: 3,
        resolvedAt: new Date(),
      })
      .where(eq(waitTickets.id, f.ticket.id));
    await expect(cancel(f.ticket.id, f.admin.id)).rejects.toMatchObject({
      code: 'WAIT_TICKET_CONFLICT',
    });
    expect(
      (await db.select().from(waitTickets).where(eq(waitTickets.id, f.ticket.id)))[0],
    ).toMatchObject({
      status: 'fulfilled',
      cancellationKind: null,
    });
  });
});
