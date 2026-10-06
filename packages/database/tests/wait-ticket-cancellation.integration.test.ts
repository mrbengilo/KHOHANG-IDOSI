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
  listWaitTickets,
  getWaitTicketHistory,
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

  it('lets only the owning store or an active admin cancel, never another store or a locked account', async () => {
    const f = await fixture();
    for (const actor of [f.stranger, f.lockedAdmin]) {
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

  it('records HTKD cancellation and rejects an exact replay after assignment revocation', async () => {
    const f = await fixture();
    const offerId = await holdOffer(f, 2, 3);
    const key = randomUUID();
    await cancel(f.ticket.id, f.htkd.id, key);
    expect((await cancel(f.ticket.id, f.htkd.id, key)).replayed).toBe(true);
    const history = await getWaitTicketHistory(db, {
      actorUserId: f.htkd.id,
      waitTicketId: f.ticket.id,
    });
    expect(history.ticket.cancellationKind).toBe('htkd_cancelled');
    expect(history.audit.filter((e) => e.action === 'WAIT_TICKET_HTKD_CANCELLED')).toHaveLength(1);
    expect(history.audit.find((e) => e.action === 'WAIT_TICKET_HTKD_CANCELLED')).toMatchObject({
      actorUserId: f.htkd.id,
      actorRole: 'htkd',
      actorStoreId: f.store.id,
    });
    expect(await reserved(f.product.id)).toBe(0);
    expect(history.offers.find((o) => o.id === offerId)?.status).toBe('cancelled');
    await db
      .update(htkdAssignments)
      .set({ revokedAt: new Date() })
      .where(eq(htkdAssignments.userId, f.htkd.id));
    await expect(cancel(f.ticket.id, f.htkd.id, key)).rejects.toMatchObject({
      code: 'WAIT_TICKET_FORBIDDEN',
    });
    await expect(
      getWaitTicketHistory(db, { actorUserId: f.htkd.id, waitTicketId: f.ticket.id }),
    ).rejects.toMatchObject({ code: 'WAIT_TICKET_NOT_FOUND' });
  });

  it('rejects HTKD cancellation for an inactive store and replay after account locking', async () => {
    const inactive = await fixture({ inactiveStore: true });
    await expect(cancel(inactive.ticket.id, inactive.htkd.id)).rejects.toMatchObject({
      code: 'WAIT_TICKET_FORBIDDEN',
    });
    const f = await fixture();
    const key = randomUUID();
    await cancel(f.ticket.id, f.htkd.id, key);
    await db.update(users).set({ status: 'locked' }).where(eq(users.id, f.htkd.id));
    await expect(cancel(f.ticket.id, f.htkd.id, key)).rejects.toMatchObject({
      code: 'WAIT_TICKET_FORBIDDEN',
    });
  });

  it.each(['accept', 'decline'] as const)(
    'serializes STORE accept versus HTKD %s with one offer decision',
    async (action) => {
      const f = await fixture();
      const offerId = await holdOffer(f, 2, 3);
      let start!: () => void;
      const barrier = new Promise<void>((resolve) => {
        start = resolve;
      });
      const respond = async (actorUserId: string, choice: 'accept' | 'decline') => {
        await barrier;
        return respondPriorityOffer(db, {
          offerId,
          actorUserId,
          ...(choice === 'accept'
            ? { action: 'accept' as const, acceptedQuantity: 2 }
            : { action: 'decline' as const }),
          idempotencyKey: randomUUID(),
          requestHash: choice,
        });
      };
      const pending = [respond(f.owner.id, 'accept'), respond(f.htkd.id, action)];
      start();
      const outcomes = await Promise.allSettled(pending);
      expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const history = await getWaitTicketHistory(db, {
        actorUserId: f.admin.id,
        waitTicketId: f.ticket.id,
      });
      expect(
        history.audit.filter((e) =>
          ['PRIORITY_OFFER_ACCEPTED', 'PRIORITY_OFFER_DECLINED'].includes(e.action),
        ),
      ).toHaveLength(1);
      expect(history.ticket.status).toBe('active');
      expect(await reserved(f.product.id)).toBe(history.offers[0]!.status === 'accepted' ? 2 : 0);
    },
  );

  it('serializes HTKD cancel against STORE accept without double release', async () => {
    const f = await fixture();
    const offerId = await holdOffer(f, 2, 3);
    let start!: () => void;
    const barrier = new Promise<void>((resolve) => {
      start = resolve;
    });
    const pending = [
      barrier.then(() => cancel(f.ticket.id, f.htkd.id)),
      barrier.then(() =>
        respondPriorityOffer(db, {
          offerId,
          actorUserId: f.owner.id,
          action: 'accept',
          acceptedQuantity: 2,
          idempotencyKey: randomUUID(),
          requestHash: 'accept',
        }),
      ),
    ];
    start();
    await Promise.allSettled(pending);
    const history = await getWaitTicketHistory(db, {
      actorUserId: f.admin.id,
      waitTicketId: f.ticket.id,
    });
    expect(history.ticket.status).toBe('cancelled');
    expect(history.ticket.fulfilledQuantity).toBe(0);
    expect(history.ticket.remainingQuantity).toBe(3);
    expect(await reserved(f.product.id)).toBe(0);
    expect(history.audit.filter((e) => e.action === 'WAIT_TICKET_HTKD_CANCELLED')).toHaveLength(1);
  });

  it('pages tickets including no-offer and cancelled records, filters historical PUT and Vietnam dates', async () => {
    const f = await fixture();
    const day = '2026-10-06';
    await db
      .update(waitTickets)
      .set({ createdAt: new Date('2026-10-05T17:00:00Z') })
      .where(eq(waitTickets.id, f.ticket.id));
    let page = await listWaitTickets(db, {
      actorUserId: f.admin.id,
      storeId: f.store.id,
      pageSize: 1,
      createdFrom: day,
      createdTo: day,
    });
    expect(page.pagination.totalItems).toBe(1);
    expect(page.data[0]?.latestOffer).toBeNull();
    const offerId = await holdOffer(f, 2, 3);
    await cancel(f.ticket.id, f.htkd.id);
    const [offer] = await db
      .select()
      .from(dailyPriorityOffers)
      .where(eq(dailyPriorityOffers.id, offerId));
    page = await listWaitTickets(db, {
      actorUserId: f.admin.id,
      storeId: f.store.id,
      q: offer!.code,
      pageSize: 1,
    });
    expect(page.pagination.totalItems).toBe(1);
    expect(page.data[0]).toMatchObject({
      status: 'cancelled',
      remainingQuantity: 3,
      latestOffer: { id: offerId },
      cancellationActor: { accountId: f.htkd.id, role: 'htkd' },
    });
    expect(
      (
        await listWaitTickets(db, {
          actorUserId: f.admin.id,
          storeId: f.store.id,
          createdTo: '2026-10-05',
        })
      ).pagination.totalItems,
    ).toBe(0);
    expect(
      (
        await listWaitTickets(db, {
          actorUserId: f.admin.id,
          storeId: f.store.id,
          page: 2,
          pageSize: 1,
        })
      ).data,
    ).toHaveLength(0);
  });

  it('two HTKD cancels and assignment revocation serialize against the same ticket', async () => {
    const f = await fixture();
    const [second] = await db
      .insert(users)
      .values({
        email: `htkd.race.${randomUUID()}`,
        displayName: 'Second HTKD',
        passwordHash: 'integration-test-placeholder-hash',
        role: 'htkd',
      })
      .returning();
    await db.insert(htkdAssignments).values({ userId: second!.id, storeId: f.store.id });
    let start!: () => void;
    const barrier = new Promise<void>((resolve) => {
      start = resolve;
    });
    const commands = [
      barrier.then(() => cancel(f.ticket.id, f.htkd.id)),
      barrier.then(() => cancel(f.ticket.id, second!.id)),
    ];
    start();
    const outcomes = await Promise.allSettled(commands);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const f2 = await fixture();
    let start2!: () => void;
    const barrier2 = new Promise<void>((resolve) => {
      start2 = resolve;
    });
    const pending = [
      barrier2.then(() => cancel(f2.ticket.id, f2.htkd.id)),
      barrier2.then(() =>
        db
          .update(htkdAssignments)
          .set({ revokedAt: new Date() })
          .where(eq(htkdAssignments.userId, f2.htkd.id)),
      ),
    ];
    start2();
    const result = await Promise.allSettled(pending);
    expect(result[1]!.status).toBe('fulfilled');
    const [ticket] = await db.select().from(waitTickets).where(eq(waitTickets.id, f2.ticket.id));
    expect(ticket!.status).toBe(result[0]!.status === 'fulfilled' ? 'cancelled' : 'active');
    await expect(cancel(f2.ticket.id, f2.htkd.id)).rejects.toMatchObject({
      code: 'WAIT_TICKET_FORBIDDEN',
    });
  });

  it('HTKD cancel racing expiration releases a partial offer exactly once', async () => {
    const f = await fixture();
    const offerId = await holdOffer(f, 2, 3);
    await db
      .update(dailyPriorityOffers)
      .set({
        createdAt: new Date(Date.now() - 60_000),
        responseDeadlineAt: new Date(Date.now() - 1000),
      })
      .where(eq(dailyPriorityOffers.id, offerId));
    let start!: () => void;
    const barrier = new Promise<void>((resolve) => {
      start = resolve;
    });
    const operations = [
      barrier.then(() => cancel(f.ticket.id, f.htkd.id)),
      barrier.then(() =>
        respondPriorityOffer(db, {
          offerId,
          actorUserId: null,
          action: 'expire',
          idempotencyKey: randomUUID(),
          requestHash: 'expire',
        }),
      ),
    ];
    start();
    await Promise.allSettled(operations);
    const [ticket] = await db.select().from(waitTickets).where(eq(waitTickets.id, f.ticket.id));
    expect(ticket!.status).toBe('cancelled');
    expect(await reserved(f.product.id)).toBe(0);
    expect(ticket!.remainingQuantity + ticket!.fulfilledQuantity).toBe(ticket!.originalQuantity);
  });

  it('keeps page counts stable with equal timestamps and several historical offers per ticket', async () => {
    const f = await fixture();
    const offerId = await holdOffer(f, 2, 3);
    await cancel(f.ticket.id, f.htkd.id);
    const [old] = await db
      .insert(dailyPriorityOffers)
      .values({
        businessDate: f.session.businessDate,
        orderSessionId: f.session.id,
        storeId: f.store.id,
        productId: f.product.id,
        waitTicketId: f.ticket.id,
        priorityLevel: 'P0B',
        roundNumber: 2,
        offeredQuantity: 1,
        status: 'expired',
        responseDeadlineAt: new Date('2026-01-01T02:00:00Z'),
        createdAt: new Date('2026-01-01T01:00:00Z'),
      })
      .returning();
    await db.insert(waitTickets).values(
      Array.from({ length: 41 }, () => ({
        storeId: f.store.id,
        productId: f.product.id,
        sourceOrderRequestItemId: f.ticket.sourceOrderRequestItemId,
        status: 'cancelled' as const,
        originalQuantity: 3,
        remainingQuantity: 3,
        createdAt: f.ticket.createdAt,
      })),
    );
    const first = await listWaitTickets(db, {
      actorUserId: f.admin.id,
      storeId: f.store.id,
      pageSize: 20,
    });
    const second = await listWaitTickets(db, {
      actorUserId: f.admin.id,
      storeId: f.store.id,
      pageSize: 20,
      page: 2,
    });
    expect(first.pagination.totalItems).toBe(42);
    expect(second.pagination.totalItems).toBe(42);
    expect(new Set([...first.data, ...second.data].map((t) => t.id)).size).toBe(40);
    const found = await listWaitTickets(db, { actorUserId: f.admin.id, q: old!.code });
    expect(found.pagination.totalItems).toBe(1);
    expect(found.data[0]?.latestOffer?.id).toBe(offerId);
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
