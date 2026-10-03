import { randomUUID } from 'node:crypto';
import {
  allocationLines,
  applyWarehouseMovement,
  auditLogs,
  cancelWaitTicket,
  createDatabase,
  dailyPriorityOffers,
  listPriorityOffers,
  orderRequestItems,
  orderRequests,
  orderSessions,
  products,
  reservations,
  respondPriorityOffer,
  stores,
  users,
  waitTickets,
  warehouseBalances,
  warehouseLedgerEntries,
  type DatabaseClient,
} from '@idosi/database';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresAllocationJobRepository } from '../src/postgres-repository.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;
const POLICY = 'idosi-round-robin-p0a-p3-v1';
const MINUTE = 60_000;

/**
 * Fixed clocks: sessions are scheduled relative to one instant and jobs receive explicit
 * processing times. Only store answers use the server clock, so their deadlines lie ahead of it.
 */
describePostgres('priority wait policy across sessions (worker + PostgreSQL)', () => {
  let client: DatabaseClient;
  let worker: PostgresAllocationJobRepository;
  let adminId: string;
  let groupId: string;
  const sessionIds: string[] = [];

  beforeAll(async () => {
    client = createDatabase({ connectionString: process.env.DATABASE_URL!, max: 4 });
    worker = new PostgresAllocationJobRepository(client);
    const [admin] = await client.db.select().from(users).where(eq(users.role, 'admin')).limit(1);
    const [reference] = await client.db.select().from(stores).limit(1);
    if (!admin || !reference) throw new Error('Reference seed required.');
    adminId = admin.id;
    groupId = reference.groupId;
  });

  afterAll(async () => {
    if (sessionIds.length > 0) {
      await client.db
        .update(orderSessions)
        .set({ deletedAt: new Date() })
        .where(inArray(orderSessions.id, sessionIds));
    }
    await client.close();
  });

  const db = () => client.db;
  const token = () => randomUUID().replaceAll('-', '');
  const businessDate = () =>
    new Date(Date.UTC(2031, 0, 1) + (Number.parseInt(token().slice(0, 8), 16) % 20000) * 86400000)
      .toISOString()
      .slice(0, 10);

  async function product(label: string) {
    const suffix = token();
    const [row] = await db()
      .insert(products)
      .values({ sku: `POL-${label}-${suffix}`, slug: `pol-${label}-${suffix}`, name: label })
      .returning();
    return row!;
  }

  async function store(label: string) {
    const suffix = token();
    const [row] = await db()
      .insert(stores)
      .values({
        // Store codes are limited to 40 characters by the store contract.
        code: `POL-${label.slice(0, 8)}-${suffix.slice(0, 16)}`,
        name: `Store ${label}`,
        groupId,
        kind: 'retail',
      })
      .returning();
    const [account] = await db()
      .insert(users)
      .values({
        email: `pol.${label}.${suffix}`,
        displayName: `Store ${label}`,
        passwordHash: 'integration-test-placeholder-hash',
        role: 'store',
        storeId: row!.id,
      })
      .returning();
    return { ...row!, userId: account!.id };
  }

  async function session(date: string, snapshotDueAt: Date, finalDueAt: Date, code: string) {
    const [row] = await db()
      .insert(orderSessions)
      .values({
        code: `POL-${code}-${token()}`,
        kind: 'manual',
        businessDate: date,
        status: 'open',
        inventorySnapshotDueAt: snapshotDueAt,
        requestDeadlineAt: finalDueAt,
        policyVersion: POLICY,
      })
      .returning();
    sessionIds.push(row!.id);
    return {
      row: row!,
      scheduled: {
        id: row!.id,
        businessDate: date,
        snapshotDueAt,
        finalDueAt,
        policyVersion: POLICY,
      },
    };
  }

  async function waitFor(
    storeId: string,
    productId: string,
    quantity: number,
    sourceSessionId: string,
    queuedAt: Date,
  ) {
    const [order] = await db()
      .insert(orderRequests)
      .values({
        orderSessionId: sourceSessionId,
        storeId,
        requestNumber: 1,
        status: 'allocated',
        submittedAt: queuedAt,
        requestedByUserId: adminId,
      })
      .onConflictDoNothing()
      .returning();
    const orderId =
      order?.id ??
      (
        await db()
          .select({ id: orderRequests.id })
          .from(orderRequests)
          .where(
            and(
              eq(orderRequests.orderSessionId, sourceSessionId),
              eq(orderRequests.storeId, storeId),
            ),
          )
          .limit(1)
      )[0]!.id;
    const [line] = await db()
      .insert(orderRequestItems)
      .values({ orderRequestId: orderId, productId, requestedQuantity: quantity })
      .returning();
    const [ticket] = await db()
      .insert(waitTickets)
      .values({
        storeId,
        productId,
        sourceOrderRequestItemId: line!.id,
        originalQuantity: quantity,
        remainingQuantity: quantity,
        priorityLevel: 'P0B',
        queuedAt,
      })
      .returning();
    return ticket!;
  }

  async function stock(productId: string, quantity: number, occurredAt: Date) {
    await db().transaction((tx) =>
      applyWarehouseMovement(tx, {
        productId,
        eventType: 'opening_balance',
        onHandDelta: quantity,
        reservedDelta: 0,
        sourceType: 'priority_policy_test',
        sourceId: randomUUID(),
        occurredAt,
      }),
    );
  }

  async function balance(productId: string) {
    const [row] = await db()
      .select()
      .from(warehouseBalances)
      .where(eq(warehouseBalances.productId, productId));
    const ledger = await db()
      .select({
        onHandDelta: warehouseLedgerEntries.onHandDelta,
        reservedDelta: warehouseLedgerEntries.reservedDelta,
      })
      .from(warehouseLedgerEntries)
      .where(eq(warehouseLedgerEntries.productId, productId));
    // The balance must always reconcile with its ledger.
    expect(row?.onHandQuantity).toBe(ledger.reduce((sum, entry) => sum + entry.onHandDelta, 0));
    expect(row?.reservedQuantity).toBe(ledger.reduce((sum, entry) => sum + entry.reservedDelta, 0));
    return { onHand: row!.onHandQuantity, reserved: row!.reservedQuantity };
  }

  async function offersFor(ticketId: string) {
    return db()
      .select()
      .from(dailyPriorityOffers)
      .where(eq(dailyPriorityOffers.waitTicketId, ticketId))
      .orderBy(dailyPriorityOffers.createdAt);
  }

  async function ticket(id: string) {
    return (await db().select().from(waitTickets).where(eq(waitTickets.id, id)))[0]!;
  }

  async function respond(
    offerId: string,
    actorUserId: string,
    action: 'accept' | 'decline',
    acceptedQuantity = 0,
  ) {
    return action === 'accept'
      ? respondPriorityOffer(db(), {
          offerId,
          actorUserId,
          action,
          acceptedQuantity,
          idempotencyKey: randomUUID(),
          requestHash: randomUUID(),
        })
      : respondPriorityOffer(db(), {
          offerId,
          actorUserId,
          action,
          idempotencyKey: randomUUID(),
          requestHash: randomUUID(),
        });
  }

  it('partial offers (3 nam + 2 nữ waiting, 1 + 1 offered) keep the wait when declined or missed', async () => {
    const date = businessDate();
    const now = Date.now();
    const men = await product('nam');
    const women = await product('nu');
    const storeA = await store('A');
    const source = await session(
      date,
      new Date(now - 3 * MINUTE),
      new Date(now - 2 * MINUTE),
      'SRC',
    );
    const queuedAt = new Date(now - 10 * MINUTE);
    const menTicket = await waitFor(storeA.id, men.id, 3, source.row.id, queuedAt);
    const womenTicket = await waitFor(storeA.id, women.id, 2, source.row.id, queuedAt);
    await stock(men.id, 1, new Date(now - 5 * MINUTE));
    await stock(women.id, 1, new Date(now - 5 * MINUTE));

    // Session 1 (main): close in the past, allocation 10 minutes ahead of the server clock.
    const s1 = await session(date, new Date(now - MINUTE), new Date(now + 10 * MINUTE), 'S1');
    await worker.captureSnapshotAndCreateOffers(s1.scheduled, new Date(now - MINUTE + 1_000));
    const [menOffer] = await offersFor(menTicket.id);
    const [womenOffer] = await offersFor(womenTicket.id);
    expect(menOffer).toMatchObject({
      orderSessionId: s1.row.id,
      offeredQuantity: 1,
      eligibleQuantityAtOffer: 3,
      stockHeldQuantity: 1,
      responseDeadlineAt: s1.scheduled.finalDueAt,
    });
    expect(womenOffer).toMatchObject({ offeredQuantity: 1, eligibleQuantityAtOffer: 2 });
    // The store is notified of the partial share: it appears in its pending list.
    const pending = await listPriorityOffers(db(), {
      actorUserId: storeA.userId,
      status: 'offered',
    });
    expect(pending.data.map((offer) => [offer.id, offer.coverage, offer.orderSessionId])).toEqual(
      expect.arrayContaining([
        [menOffer!.id, 'partial', s1.row.id],
        [womenOffer!.id, 'partial', s1.row.id],
      ]),
    );
    expect(await balance(men.id)).toEqual({ onHand: 1, reserved: 1 });

    // "Không nhận" on a partial offer: offer declined, hold returned, ticket untouched.
    const declined = await respond(menOffer!.id, storeA.userId, 'decline');
    expect(declined.replayed).toBe(false);
    if (!declined.replayed) expect(declined.value.waitTicketCancelled).toBe(false);
    expect(await ticket(menTicket.id)).toMatchObject({
      status: 'active',
      remainingQuantity: 3,
      cancellationKind: null,
    });
    expect(await balance(men.id)).toEqual({ onHand: 1, reserved: 0 });

    // No answer on the other partial offer: it expires at the session's allocation start.
    await worker.expireOffersAndFinalizeAllocation(
      s1.scheduled,
      new Date(s1.scheduled.finalDueAt.getTime() + 1_000),
    );
    expect((await offersFor(womenTicket.id))[0]).toMatchObject({
      status: 'expired',
      stockHeldQuantity: 0,
    });
    expect(await ticket(womenTicket.id)).toMatchObject({ status: 'active', remainingQuantity: 2 });
    expect(await balance(women.id)).toEqual({ onHand: 1, reserved: 0 });
    // The declined/expired lot is not offered again inside the finished session.
    await worker.captureSnapshotAndCreateOffers(s1.scheduled, new Date(now));
    expect(await offersFor(menTicket.id)).toHaveLength(1);

    // Session 2 (supplementary, later the same day) offers both tickets again.
    const s2Close = new Date(s1.scheduled.finalDueAt.getTime() + 4 * 60 * MINUTE);
    const s2 = await session(date, s2Close, new Date(s2Close.getTime() + 30 * MINUTE), 'S2');
    await worker.captureSnapshotAndCreateOffers(s2.scheduled, s2Close);
    const menOffers = await offersFor(menTicket.id);
    expect(menOffers).toHaveLength(2);
    expect(menOffers[1]).toMatchObject({
      orderSessionId: s2.row.id,
      offeredQuantity: 1,
      eligibleQuantityAtOffer: 3,
      responseDeadlineAt: s2.scheduled.finalDueAt,
    });

    // Accept in session 2: the unit is protected, allocated once, and held for combined shipping.
    const accepted = await respond(menOffers[1]!.id, storeA.userId, 'accept', 1);
    expect(accepted.replayed).toBe(false);
    expect(await ticket(menTicket.id)).toMatchObject({ remainingQuantity: 3 });
    await worker.expireOffersAndFinalizeAllocation(
      s2.scheduled,
      new Date(s2.scheduled.finalDueAt.getTime() + 1_000),
    );
    expect(await ticket(menTicket.id)).toMatchObject({
      status: 'active',
      remainingQuantity: 2,
      fulfilledQuantity: 1,
    });
    const line = (
      await db()
        .select()
        .from(allocationLines)
        .where(eq(allocationLines.priorityOfferId, menOffers[1]!.id))
    )[0]!;
    expect(line.allocatedQuantity).toBe(1);
    const held = await db()
      .select()
      .from(reservations)
      .where(eq(reservations.allocationLineId, line.id));
    // No ordinary order from store A yet: the unit stays reserved, not shipped on its own.
    expect(held).toEqual([
      expect.objectContaining({ quantity: 1, status: 'active', outboundRequestLineId: null }),
    ]);
    expect(await balance(men.id)).toEqual({ onHand: 1, reserved: 1 });
    // The women's partial offer of session 2 lapsed again; that ticket keeps waiting too.
    expect(await ticket(womenTicket.id)).toMatchObject({ status: 'active', remainingQuantity: 2 });

    // Manual cancellation now only cancels the 2 units still waiting; the held unit remains.
    const cancelled = await cancelWaitTicket(db(), {
      waitTicketId: menTicket.id,
      actorUserId: storeA.userId,
      reason: 'Cửa hàng không cần thêm',
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    });
    expect(cancelled.replayed).toBe(false);
    expect(await ticket(menTicket.id)).toMatchObject({
      status: 'cancelled',
      cancellationKind: 'store_cancelled',
      remainingQuantity: 2,
      fulfilledQuantity: 1,
    });
    expect(
      (await db().select().from(reservations).where(eq(reservations.allocationLineId, line.id)))[0],
    ).toMatchObject({ status: 'active', quantity: 1 });
    // A cancelled ticket is never offered again.
    const s3Close = new Date(s2.scheduled.finalDueAt.getTime() + 60 * MINUTE);
    const s3 = await session(date, s3Close, new Date(s3Close.getTime() + 30 * MINUTE), 'S3');
    await stock(men.id, 2, new Date(s3Close.getTime() - MINUTE));
    await worker.captureSnapshotAndCreateOffers(s3.scheduled, s3Close);
    expect(await offersFor(menTicket.id)).toHaveLength(2);
  });

  it('full offers: accept keeps the wait, decline cancels at once, silence cancels at the deadline', async () => {
    const date = businessDate();
    const now = Date.now();
    const item = await product('full');
    const [declining, silent, accepting, ordinary] = await Promise.all([
      store('decline'),
      store('silent'),
      store('accept'),
      store('ordinary'),
    ]);
    const source = await session(
      date,
      new Date(now - 3 * MINUTE),
      new Date(now - 2 * MINUTE),
      'SRC',
    );
    const declineTicket = await waitFor(
      declining.id,
      item.id,
      2,
      source.row.id,
      new Date(now - 9 * MINUTE),
    );
    const silentTicket = await waitFor(
      silent.id,
      item.id,
      2,
      source.row.id,
      new Date(now - 8 * MINUTE),
    );
    const acceptTicket = await waitFor(
      accepting.id,
      item.id,
      1,
      source.row.id,
      new Date(now - 7 * MINUTE),
    );
    await stock(item.id, 5, new Date(now - 5 * MINUTE));

    const s1 = await session(date, new Date(now - MINUTE), new Date(now + 10 * MINUTE), 'MAIN');
    await worker.captureSnapshotAndCreateOffers(s1.scheduled, new Date(now - MINUTE + 1_000));
    const [declineOffer] = await offersFor(declineTicket.id);
    const [silentOffer] = await offersFor(silentTicket.id);
    const [acceptOffer] = await offersFor(acceptTicket.id);
    for (const offer of [declineOffer, silentOffer, acceptOffer])
      expect(offer!.offeredQuantity).toBe(offer!.eligibleQuantityAtOffer);
    expect(await balance(item.id)).toEqual({ onHand: 5, reserved: 5 });

    const declined = await respond(declineOffer!.id, declining.userId, 'decline');
    if (declined.replayed) throw new Error('unexpected replay');
    expect(declined.value).toMatchObject({ status: 'declined', waitTicketCancelled: true });
    expect(await ticket(declineTicket.id)).toMatchObject({
      status: 'cancelled',
      cancellationKind: 'full_offer_declined',
      cancelledByOfferId: declineOffer!.id,
      remainingQuantity: 2,
      fulfilledQuantity: 0,
    });
    const declineAudit = await db()
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, declineTicket.id),
          eq(auditLogs.action, 'WAIT_TICKET_STORE_DECLINED_FULL_PRIORITY'),
        ),
      );
    expect(declineAudit).toHaveLength(1);
    expect(declineAudit[0]!.actorUserId).toBe(declining.userId);
    expect(declineAudit[0]!.metadata).toMatchObject({
      offerId: declineOffer!.id,
      orderSessionId: s1.row.id,
      basis: { offeredQuantity: 2, eligibleQuantityAtOffer: 2, ticketRemainingQuantity: 2 },
    });
    expect(await balance(item.id)).toEqual({ onHand: 5, reserved: 3 });

    await respond(acceptOffer!.id, accepting.userId, 'accept', 1);
    // An ordinary order in the same session competes for the stock the cancelled waits release.
    const [order] = await db()
      .insert(orderRequests)
      .values({
        orderSessionId: s1.row.id,
        storeId: ordinary.id,
        requestNumber: 1,
        status: 'submitted',
        submittedAt: new Date(now - 30_000),
        requestedByUserId: adminId,
      })
      .returning();
    await db()
      .insert(orderRequestItems)
      .values({ orderRequestId: order!.id, productId: item.id, requestedQuantity: 4 });

    await worker.expireOffersAndFinalizeAllocation(
      s1.scheduled,
      new Date(s1.scheduled.finalDueAt.getTime() + 1_000),
    );
    // The silent full offer expired and cancelled its ticket before allocation ran.
    expect((await offersFor(silentTicket.id))[0]).toMatchObject({ status: 'expired' });
    expect(await ticket(silentTicket.id)).toMatchObject({
      status: 'cancelled',
      cancellationKind: 'full_offer_timeout',
      cancelledByOfferId: silentOffer!.id,
    });
    const timeoutAudit = await db()
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, silentTicket.id),
          eq(auditLogs.action, 'WAIT_TICKET_PRIORITY_RESPONSE_TIMEOUT'),
        ),
      );
    expect(timeoutAudit).toHaveLength(1);
    expect(timeoutAudit[0]!.actorUserId).toBeNull();
    // The accepted full offer is allocated and its ticket fulfilled, never cancelled.
    expect(await ticket(acceptTicket.id)).toMatchObject({
      status: 'fulfilled',
      cancellationKind: null,
    });
    // No cancelled wait received stock; the ordinary order got the 4 units released to it.
    const lines = await db()
      .select()
      .from(allocationLines)
      .where(eq(allocationLines.productId, item.id));
    expect(
      lines
        .filter((row) => [declineTicket.id, silentTicket.id].includes(row.waitTicketId ?? ''))
        .reduce((sum, row) => sum + row.allocatedQuantity, 0),
    ).toBe(0);
    expect(
      lines
        .filter((row) => row.orderRequestItemId !== null)
        .reduce((sum, row) => sum + row.allocatedQuantity, 0),
    ).toBe(4);
    expect(await balance(item.id)).toEqual({ onHand: 5, reserved: 5 });
    // Replaying the finished run changes nothing and writes no second cancellation.
    expect(
      (
        await worker.expireOffersAndFinalizeAllocation(
          s1.scheduled,
          new Date(s1.scheduled.finalDueAt.getTime() + 2_000),
        )
      ).replayed,
    ).toBe(true);
    expect(
      await db()
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, silentTicket.id),
            eq(auditLogs.action, 'WAIT_TICKET_PRIORITY_RESPONSE_TIMEOUT'),
          ),
        ),
    ).toHaveLength(1);
  });

  it('main and supplementary sessions of one day keep their own deadlines and never cancel across', async () => {
    const date = businessDate();
    const item = await product('sessions');
    const [early, late] = await Promise.all([store('early'), store('late')]);
    const base = new Date(Date.UTC(2032, 5, 1, 1, 0, 0)); // 08:00 Asia/Ho_Chi_Minh
    const source = await session(
      date,
      new Date(base.getTime() - 3 * 60 * MINUTE),
      new Date(base.getTime() - 2 * 60 * MINUTE),
      'SRC',
    );
    const earlyTicket = await waitFor(
      early.id,
      item.id,
      1,
      source.row.id,
      new Date(base.getTime() - 4 * 60 * MINUTE),
    );
    await stock(item.id, 1, new Date(base.getTime() - 60 * MINUTE));
    // Main: close 08:00, allocate 09:00. Supplementary: close 14:00, allocate 14:30.
    const main = await session(date, base, new Date(base.getTime() + 60 * MINUTE), 'MAIN');
    const extraClose = new Date(base.getTime() + 6 * 60 * MINUTE);
    const extra = await session(
      date,
      extraClose,
      new Date(extraClose.getTime() + 30 * MINUTE),
      'EXTRA',
    );

    await worker.captureSnapshotAndCreateOffers(main.scheduled, base);
    expect((await offersFor(earlyTicket.id))[0]).toMatchObject({
      orderSessionId: main.row.id,
      responseDeadlineAt: main.scheduled.finalDueAt,
    });
    // The late store's wait only appears after the main close; the main session had no stock left.
    const lateTicket = await waitFor(
      late.id,
      item.id,
      1,
      source.row.id,
      new Date(base.getTime() + 60_000),
    );
    await stock(item.id, 1, new Date(base.getTime() + 2 * 60 * MINUTE));
    await worker.captureSnapshotAndCreateOffers(extra.scheduled, extraClose);
    expect((await offersFor(lateTicket.id))[0]).toMatchObject({
      orderSessionId: extra.row.id,
      responseDeadlineAt: extra.scheduled.finalDueAt,
      eligibleQuantityAtOffer: 1,
    });
    // The early ticket's offer is still live in the main session: never offered twice.
    expect(await offersFor(earlyTicket.id)).toHaveLength(1);

    // Main finalizes at 09:00 (late, catch-up at 13:00): only its own offer lapses.
    await worker.expireOffersAndFinalizeAllocation(
      main.scheduled,
      new Date(base.getTime() + 5 * 60 * MINUTE),
    );
    expect(await ticket(earlyTicket.id)).toMatchObject({
      status: 'cancelled',
      cancellationKind: 'full_offer_timeout',
    });
    expect((await offersFor(lateTicket.id))[0]).toMatchObject({ status: 'offered' });
    expect(await ticket(lateTicket.id)).toMatchObject({ status: 'active' });

    await worker.expireOffersAndFinalizeAllocation(
      extra.scheduled,
      new Date(extra.scheduled.finalDueAt.getTime() + 1_000),
    );
    expect(await ticket(lateTicket.id)).toMatchObject({
      status: 'cancelled',
      cancellationKind: 'full_offer_timeout',
    });
    expect(await balance(item.id)).toEqual({ onHand: 2, reserved: 0 });
  });

  it('never cancels on a basis it cannot prove: late catch-up, grown demand and legacy offers', async () => {
    const date = businessDate();
    const now = Date.now();
    const item = await product('proof');
    const [lateStore, growing] = await Promise.all([store('catchup'), store('growing')]);
    const source = await session(
      date,
      new Date(now - 3 * MINUTE),
      new Date(now - 2 * MINUTE),
      'SRC',
    );
    const catchUpTicket = await waitFor(
      lateStore.id,
      item.id,
      1,
      source.row.id,
      new Date(now - 9 * MINUTE),
    );
    await stock(item.id, 1, new Date(now - 5 * MINUTE));

    // A snapshot processed only after the session's allocation start creates no offer at all.
    const missed = await session(
      date,
      new Date(now - 60 * MINUTE),
      new Date(now - 30 * MINUTE),
      'MISSED',
    );
    await worker.captureSnapshotAndCreateOffers(missed.scheduled, new Date(now - 10 * MINUTE));
    expect(await offersFor(catchUpTicket.id)).toHaveLength(0);
    await worker.expireOffersAndFinalizeAllocation(missed.scheduled, new Date(now - 10 * MINUTE));
    expect(await ticket(catchUpTicket.id)).toMatchObject({ status: 'active' });

    // A full offer whose ticket grew afterwards (e.g. a new receipt shortage) is partial now.
    const growingTicket = await waitFor(
      growing.id,
      item.id,
      1,
      source.row.id,
      new Date(now - 8 * MINUTE),
    );
    await stock(item.id, 1, new Date(now - 4 * MINUTE));
    const s1 = await session(date, new Date(now - MINUTE), new Date(now + 10 * MINUTE), 'GROW');
    await worker.captureSnapshotAndCreateOffers(s1.scheduled, new Date(now - MINUTE + 1_000));
    const [growingOffer] = await offersFor(growingTicket.id);
    expect(growingOffer).toMatchObject({ offeredQuantity: 1, eligibleQuantityAtOffer: 1 });
    await db()
      .update(waitTickets)
      .set({ originalQuantity: 3, remainingQuantity: 3 })
      .where(eq(waitTickets.id, growingTicket.id));
    // A legacy offer without a recorded basis is never treated as full.
    const [catchUpOffer] = await offersFor(catchUpTicket.id);
    await db()
      .update(dailyPriorityOffers)
      .set({ eligibleQuantityAtOffer: null })
      .where(eq(dailyPriorityOffers.id, catchUpOffer!.id));
    await worker.expireOffersAndFinalizeAllocation(
      s1.scheduled,
      new Date(s1.scheduled.finalDueAt.getTime() + 1_000),
    );
    expect(await ticket(growingTicket.id)).toMatchObject({
      status: 'active',
      remainingQuantity: 3,
    });
    expect(await ticket(catchUpTicket.id)).toMatchObject({ status: 'active' });
    expect(await balance(item.id)).toEqual({ onHand: 2, reserved: 0 });
  });

  it('concurrent cancel and accept settle to one valid order without double holds', async () => {
    const date = businessDate();
    const now = Date.now();
    const item = await product('race');
    const racer = await store('race');
    const source = await session(
      date,
      new Date(now - 3 * MINUTE),
      new Date(now - 2 * MINUTE),
      'SRC',
    );
    const raceTicket = await waitFor(
      racer.id,
      item.id,
      2,
      source.row.id,
      new Date(now - 9 * MINUTE),
    );
    await stock(item.id, 1, new Date(now - 5 * MINUTE));
    const s1 = await session(date, new Date(now - MINUTE), new Date(now + 10 * MINUTE), 'RACE');
    await worker.captureSnapshotAndCreateOffers(s1.scheduled, new Date(now - MINUTE + 1_000));
    const [offer] = await offersFor(raceTicket.id);
    const results = await Promise.allSettled([
      respond(offer!.id, racer.userId, 'accept', 1),
      cancelWaitTicket(db(), {
        waitTicketId: raceTicket.id,
        actorUserId: racer.userId,
        reason: 'Đổi kế hoạch nhận hàng',
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
      }),
    ]);
    // Cancellation always wins eventually: it releases an accepted, unallocated offer too.
    expect(results[1]!.status).toBe('fulfilled');
    expect(await ticket(raceTicket.id)).toMatchObject({
      status: 'cancelled',
      cancellationKind: 'store_cancelled',
    });
    expect((await offersFor(raceTicket.id))[0]).toMatchObject({
      status: 'cancelled',
      acceptedQuantity: 0,
      stockHeldQuantity: 0,
    });
    expect(await balance(item.id)).toEqual({ onHand: 1, reserved: 0 });
    await worker.expireOffersAndFinalizeAllocation(
      s1.scheduled,
      new Date(s1.scheduled.finalDueAt.getTime() + 1_000),
    );
    expect(
      await db()
        .select()
        .from(allocationLines)
        .where(eq(allocationLines.waitTicketId, raceTicket.id)),
    ).toHaveLength(0);
    expect(await balance(item.id)).toEqual({ onHand: 1, reserved: 0 });
  });
});
