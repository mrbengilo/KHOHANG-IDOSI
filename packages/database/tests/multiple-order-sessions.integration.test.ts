import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  auditLogs,
  closeDatabase,
  createOrderSession,
  db,
  ensureDailyOrderingSession,
  orderRequestItems,
  orderRequests,
  orderSessions,
  OrderSessionAuthorizationError,
  OrderSessionScheduleConflictError,
  OrderSessionValidationError,
  prepareOrderingContext,
  products,
  resolveOrderingSession,
  storeGroups,
  stores,
  transitionOrderSession,
  users,
} from '../src/index.js';
import { countOrderingQuota } from '../src/order-requests.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

/** A business date far from every other test, so routing only sees this test's sessions. */
function isolatedBusinessDate(): string {
  const offset = Number.parseInt(randomUUID().replaceAll('-', '').slice(0, 8), 16) % 20_000;
  return new Date(Date.UTC(2045, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);
}

const at = (date: string, time: string) => new Date(`${date}T${time}:00+07:00`);

describePostgres('several independent allocation sessions on one business date', () => {
  afterAll(() => closeDatabase());

  async function fixture() {
    const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
    const [group] = await db.select().from(storeGroups).limit(1);
    const [product] = await db.select().from(products).where(eq(products.isActive, true)).limit(1);
    if (!admin || !group || !product) throw new Error('Reference seed and admin are required.');
    const [store] = await db
      .insert(stores)
      .values({
        code: `MULTI-${randomUUID().replaceAll('-', '')}`,
        name: 'Multi session store',
        groupId: group.id,
        kind: 'retail',
      })
      .returning();
    const [htkd] = await db
      .insert(users)
      .values({
        email: `multi.htkd.${randomUUID()}`,
        displayName: 'Multi session HTKD',
        passwordHash: admin.passwordHash,
        role: 'htkd',
      })
      .returning();
    return { admin, htkd: htkd!, product, store: store! };
  }

  const create = (
    actorId: string,
    date: string,
    opens: string,
    closes: string,
    allocates: string,
    key = randomUUID(),
    now = at(date, '00:00'),
  ) =>
    createOrderSession(db, {
      businessDate: date,
      requestOpensAt: at(date, opens),
      requestClosesAt: at(date, closes),
      allocationStartsAt: at(date, allocates),
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
      createdByUserId: actorId,
      idempotencyKey: key,
      requestHash: `hash:${date}:${opens}:${closes}:${allocates}`,
      now,
    });

  it('creates any number of Admin sessions beside the default one, each with its own code', async () => {
    const { admin, htkd } = await fixture();
    const date = isolatedBusinessDate();
    const s1 = await ensureDailyOrderingSession(db, at(date, '00:05'));
    expect(s1.kind).toBe('default');
    const [s2, s3] = await Promise.all([
      create(admin.id, date, '00:00', '10:00', '11:00'),
      create(admin.id, date, '00:00', '14:00', '15:00'),
    ]);
    if (s2.replayed || s3.replayed) throw new Error('Fresh keys must not replay.');
    expect(s2.value.kind).toBe('manual');
    expect(s3.value.kind).toBe('manual');
    const codes = [s1.code, s2.value.code, s3.value.code];
    expect(new Set(codes).size).toBe(3);
    codes.forEach((code) => expect(code).toMatch(/^PDH-\d{6}$/u));

    // Same key and payload replays; a new key is a new session.
    const key = randomUUID();
    const first = await create(admin.id, date, '00:00', '16:00', '17:00', key);
    const replay = await create(admin.id, date, '00:00', '16:00', '17:00', key);
    expect(replay.replayed).toBe(true);
    expect(replay.resourceId).toBe(first.replayed ? first.resourceId : first.value.id);

    // Restarting the worker never adds a second default session or touches Admin sessions.
    const again = await ensureDailyOrderingSession(db, at(date, '09:30'));
    expect(again.id).toBe(s1.id);
    const rows = await db.select().from(orderSessions).where(eq(orderSessions.businessDate, date));
    expect(rows.filter((row) => row.kind === 'default')).toHaveLength(1);
    expect(rows).toHaveLength(4);
    const created = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'ORDER_SESSION_CREATED'),
          inArray(
            auditLogs.entityId,
            rows.map((row) => row.id),
          ),
        ),
      );
    expect(created).toHaveLength(3);

    await expect(create(htkd.id, date, '00:00', '18:00', '19:00')).rejects.toBeInstanceOf(
      OrderSessionAuthorizationError,
    );
  });

  it('refuses a session closing in the past or at the same instant as another session', async () => {
    const { admin } = await fixture();
    const date = isolatedBusinessDate();
    await create(admin.id, date, '00:00', '10:00', '11:00');
    await expect(create(admin.id, date, '01:00', '10:00', '12:00')).rejects.toBeInstanceOf(
      OrderSessionScheduleConflictError,
    );
    await expect(
      create(admin.id, date, '00:00', '09:00', '10:00', randomUUID(), at(date, '09:30')),
    ).rejects.toBeInstanceOf(OrderSessionValidationError);
    const rows = await db.select().from(orderSessions).where(eq(orderSessions.businessDate, date));
    expect(rows).toHaveLength(1);
  });

  it('routes new requests to the open session closing first and opens scheduled ones on time', async () => {
    const { admin, store } = await fixture();
    const date = isolatedBusinessDate();
    const late = await create(admin.id, date, '06:00', '14:00', '15:00');
    const early = await create(admin.id, date, '07:00', '10:00', '11:00');
    if (late.replayed || early.replayed) throw new Error('Fresh keys must not replay.');

    // 06:30: only the late session has started; it opens on its own schedule.
    const at0630 = await db.transaction((tx) => resolveOrderingSession(tx, at(date, '06:30')));
    expect(at0630?.id).toBe(late.value.id);
    // 07:30: both accept requests; the one closing first wins.
    const at0730 = await db.transaction((tx) => resolveOrderingSession(tx, at(date, '07:30')));
    expect(at0730?.id).toBe(early.value.id);
    // 10:30: the early session has closed; requests go to the late one.
    const at1030 = await db.transaction((tx) => resolveOrderingSession(tx, at(date, '10:30')));
    expect(at1030?.id).toBe(late.value.id);
    const opened = await db
      .select({
        id: orderSessions.id,
        status: orderSessions.status,
        openedAt: orderSessions.openedAt,
      })
      .from(orderSessions)
      .where(inArray(orderSessions.id, [late.value.id, early.value.id]));
    expect(opened.map((row) => row.status)).toEqual(['open', 'open']);
    // Opening never rewrites the Admin's stored schedule.
    expect(opened.find((row) => row.id === early.value.id)?.openedAt?.toISOString()).toBe(
      at(date, '07:00').toISOString(),
    );

    const context = await prepareOrderingContext(db, admin.id, store.id, randomUUID(), () =>
      at(date, '07:45'),
    );
    expect(context.session.id).toBe(early.value.id);
  });

  it('keeps a submitted request in its session when an earlier session is added later', async () => {
    const { admin, store, product } = await fixture();
    const date = isolatedBusinessDate();
    const later = await create(admin.id, date, '00:00', '14:00', '15:00');
    if (later.replayed) throw new Error('Fresh key must not replay.');
    const [request] = await db
      .insert(orderRequests)
      .values({
        orderSessionId: later.value.id,
        storeId: store.id,
        requestNumber: 1,
        status: 'submitted',
        requestedByUserId: admin.id,
        submittedAt: at(date, '08:00'),
      })
      .returning();
    await db
      .insert(orderRequestItems)
      .values({ orderRequestId: request!.id, productId: product.id, requestedQuantity: 1 });
    await create(admin.id, date, '00:00', '09:00', '10:00');
    const [unchanged] = await db
      .select()
      .from(orderRequests)
      .where(eq(orderRequests.id, request!.id));
    expect(unchanged?.orderSessionId).toBe(later.value.id);
  });

  it('counts requests waiting for another session even after an earlier session completes', async () => {
    const { admin, store, product } = await fixture();
    const date = isolatedBusinessDate();
    const s1 = await create(admin.id, date, '00:00', '08:00', '09:00');
    const s2 = await create(admin.id, date, '00:00', '10:00', '11:00');
    const s3 = await create(admin.id, date, '00:00', '14:00', '15:00');
    if (s1.replayed || s2.replayed || s3.replayed) throw new Error('Fresh keys must not replay.');
    const queue = async (sessionId: string, requestNumber: number, submittedAt: Date) => {
      const [request] = await db
        .insert(orderRequests)
        .values({
          orderSessionId: sessionId,
          storeId: store.id,
          requestNumber,
          status: 'submitted',
          requestedByUserId: admin.id,
          submittedAt,
        })
        .returning();
      await db
        .insert(orderRequestItems)
        .values({ orderRequestId: request!.id, productId: product.id, requestedQuantity: 1 });
    };
    await queue(s1.value.id, 1, at(date, '07:00'));
    await queue(s2.value.id, 1, at(date, '08:30'));
    const quota = () => db.transaction((tx) => countOrderingQuota(tx, store.id, s3.value.id));
    expect(await quota()).toBe(2);
    // S1 finishes after S2's request was sent. Before multi-session days this released S2's
    // request too; now only S1's own request is released.
    await db
      .update(orderSessions)
      .set({ status: 'completed', completedAt: at(date, '09:01'), closedAt: at(date, '08:00') })
      .where(eq(orderSessions.id, s1.value.id));
    expect(await quota()).toBe(1);
    await db
      .update(orderSessions)
      .set({ status: 'completed', completedAt: at(date, '11:01'), closedAt: at(date, '10:00') })
      .where(eq(orderSessions.id, s2.value.id));
    expect(await quota()).toBe(0);
    // Completed far-future fixtures must not release requests of later test runs.
    await db
      .update(orderSessions)
      .set({ deletedAt: new Date() })
      .where(inArray(orderSessions.id, [s1.value.id, s2.value.id, s3.value.id]));
  });

  it('cancels only the targeted session and its own pending requests', async () => {
    const { admin, store, product } = await fixture();
    const date = isolatedBusinessDate();
    const now = new Date();
    // Two open sessions in the real near future so the cancellation window is still open.
    const insertOpen = async (closeOffsetMinutes: number) => {
      const [row] = await db
        .insert(orderSessions)
        .values({
          code: '',
          kind: 'manual',
          businessDate: date,
          status: 'open',
          openedAt: new Date(now.getTime() - 60_000),
          inventorySnapshotDueAt: new Date(now.getTime() + closeOffsetMinutes * 60_000),
          requestDeadlineAt: new Date(now.getTime() + (closeOffsetMinutes + 30) * 60_000),
          policyVersion: 'idosi-round-robin-p0a-p3-v1',
        })
        .returning();
      const [request] = await db
        .insert(orderRequests)
        .values({
          orderSessionId: row!.id,
          storeId: store.id,
          requestNumber: 1,
          status: 'submitted',
          requestedByUserId: admin.id,
          submittedAt: now,
        })
        .returning();
      await db
        .insert(orderRequestItems)
        .values({ orderRequestId: request!.id, productId: product.id, requestedQuantity: 1 });
      return { session: row!, request: request! };
    };
    const kept = await insertOpen(60);
    const cancelled = await insertOpen(90);
    await transitionOrderSession(db, {
      orderSessionId: cancelled.session.id,
      targetStatus: 'cancelled',
      expectedVersion: cancelled.session.version,
      reason: 'Phiên bổ sung không cần nữa',
      actorUserId: admin.id,
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    });
    const rows = await db
      .select({ id: orderRequests.id, status: orderRequests.status })
      .from(orderRequests)
      .where(inArray(orderRequests.id, [kept.request.id, cancelled.request.id]));
    expect(rows.find((row) => row.id === kept.request.id)?.status).toBe('submitted');
    expect(rows.find((row) => row.id === cancelled.request.id)?.status).toBe('cancelled');
    const [keptSession] = await db
      .select()
      .from(orderSessions)
      .where(eq(orderSessions.id, kept.session.id));
    expect(keptSession?.status).toBe('open');
    // These sessions accept requests right now; they must not route other tests' orders.
    await db
      .update(orderSessions)
      .set({ deletedAt: new Date() })
      .where(inArray(orderSessions.id, [kept.session.id, cancelled.session.id]));
  });

  it('lets a scheduled session that never opened be cancelled after its close time', async () => {
    const { admin } = await fixture();
    const date = isolatedBusinessDate();
    const [stale] = await db
      .insert(orderSessions)
      .values({
        code: '',
        kind: 'manual',
        businessDate: date,
        status: 'draft',
        openedAt: at(date, '06:00'),
        inventorySnapshotDueAt: at(date, '07:00'),
        requestDeadlineAt: at(date, '08:00'),
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
      })
      .returning();
    const result = await transitionOrderSession(db, {
      orderSessionId: stale!.id,
      targetStatus: 'cancelled',
      expectedVersion: stale!.version,
      reason: 'Phiên chưa từng mở',
      actorUserId: admin.id,
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
      transitionedAt: at(date, '09:00'),
    });
    expect(result.replayed ? null : result.value.status).toBe('cancelled');
  });
});
