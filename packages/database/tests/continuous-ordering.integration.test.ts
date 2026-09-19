import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  db,
  orderRequests,
  orderSessions,
  products,
  storeGroups,
  stores,
  users,
  submitOrderRequest,
  prepareOrderingContext,
} from '../src/index.js';
import {
  countOrderingQuota,
  OrderRequestAuthorizationError,
  RequestLimitExceededError,
} from '../src/order-requests.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;
describePostgres('24/7 ordering and allocation-completion quota', () => {
  const sessionIds = new Set<string>();
  afterEach(async () => {
    for (const id of sessionIds) {
      await db.update(orderSessions).set({ deletedAt: new Date() }).where(eq(orderSessions.id, id));
    }
    sessionIds.clear();
  });
  afterAll(() => closeDatabase());

  it('prepares one open cycle concurrently and refuses an unassigned HTKD', async () => {
    const fixture = await createFixture();
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        prepareOrderingContext(db, fixture.admin.id, fixture.store.id, randomUUID()),
      ),
    );
    results.forEach((result) => sessionIds.add(result.session.id));
    expect(new Set(results.map((result) => result.session.id)).size).toBe(1);
    expect(results[0]!.session.status).toBe('open');
    expect(results[0]!.session.inventorySnapshotDueAt.getTime()).toBeGreaterThan(Date.now());
    const [htkd] = await db
      .insert(users)
      .values({
        email: `unassigned.${randomUUID()}`,
        displayName: 'Unassigned test',
        role: 'htkd',
        status: 'active',
        passwordHash: fixture.admin.passwordHash,
      })
      .returning();
    await expect(
      prepareOrderingContext(db, htkd!.id, fixture.store.id, randomUUID()),
    ).rejects.toBeInstanceOf(OrderRequestAuthorizationError);
  });

  it('does not reset at close, resets after completed allocation, and serializes the next two slots', async () => {
    const { admin, store, product } = await createFixture();
    const now = Date.now();
    const [previous] = await db
      .insert(orderSessions)
      .values({
        code: `PREV-${randomUUID()}`,
        businessDate: new Date(now - 86400000).toISOString().slice(0, 10),
        status: 'closed',
        openedAt: new Date(now - 7200000),
        inventorySnapshotDueAt: new Date(now - 3600000),
        requestDeadlineAt: new Date(now - 1800000),
        closedAt: new Date(now - 3600000),
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
        createdByUserId: admin.id,
      })
      .returning();
    await db.insert(orderRequests).values(
      [1, 2].map((requestNumber) => ({
        orderSessionId: previous!.id,
        storeId: store.id,
        requestNumber,
        status: 'submitted' as const,
        requestedByUserId: admin.id,
        submittedAt: new Date(now),
      })),
    );
    const [next] = await db
      .insert(orderSessions)
      .values({
        code: `NEXT-${randomUUID()}`,
        businessDate: new Date(now + 7 * 3600000).toISOString().slice(0, 10),
        status: 'open',
        openedAt: new Date(now - 1000),
        inventorySnapshotDueAt: new Date(now + 3600000),
        requestDeadlineAt: new Date(now + 7200000),
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
        createdByUserId: admin.id,
      })
      .returning();
    const submit = () =>
      submitOrderRequest(db, {
        orderSessionId: next!.id,
        storeId: store.id,
        requestedByUserId: admin.id,
        items: [{ productId: product.id, quantity: 1 }],
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
      });
    sessionIds.add(previous!.id);
    sessionIds.add(next!.id);
    await expect(submit()).rejects.toBeInstanceOf(RequestLimitExceededError);
    await db
      .update(orderSessions)
      .set({ status: 'completed', completedAt: new Date(), version: previous!.version + 1 })
      .where(eq(orderSessions.id, previous!.id));
    const attempts = await Promise.allSettled([submit(), submit(), submit()]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await db.transaction((tx) => countOrderingQuota(tx, store.id, next!.id))).toBe(2);
  });

  it('resets cancelled-cycle requests when a replacement completes without that store', async () => {
    const { admin, store, product } = await createFixture();
    const makeSession = async (status: 'cancelled' | 'open' | 'completed') => {
      const [session] = await db
        .insert(orderSessions)
        .values({
          code: `RESET-${randomUUID()}`,
          businessDate: new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10),
          status,
          openedAt: new Date(Date.now() - 3600000),
          inventorySnapshotDueAt: new Date(Date.now() + 3600000),
          requestDeadlineAt: new Date(Date.now() + 7200000),
          policyVersion: 'idosi-round-robin-p0a-p3-v1',
        })
        .returning();
      sessionIds.add(session!.id);
      return session!;
    };
    const cancelled = await makeSession('cancelled');
    const next = await makeSession('open');
    await db.insert(orderRequests).values(
      [1, 2].map((requestNumber) => ({
        orderSessionId: cancelled.id,
        storeId: store.id,
        requestNumber,
        requestedByUserId: admin.id,
        submittedAt: new Date(),
      })),
    );
    expect(await db.transaction((tx) => countOrderingQuota(tx, store.id, next.id))).toBe(2);
    const replacement = await makeSession('completed');
    await db
      .update(orderSessions)
      .set({ completedAt: new Date() })
      .where(eq(orderSessions.id, replacement.id));
    expect(await db.transaction((tx) => countOrderingQuota(tx, store.id, next.id))).toBe(0);
    await submitOrderRequest(db, {
      orderSessionId: next.id,
      storeId: store.id,
      requestedByUserId: admin.id,
      items: [{ productId: product.id, quantity: 1 }],
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    });
    // A further completed cycle cannot erase a request already queued for next.
    await db
      .update(orderSessions)
      .set({ completedAt: new Date() })
      .where(eq(orderSessions.id, replacement.id));
    expect(await db.transaction((tx) => countOrderingQuota(tx, store.id, next.id))).toBe(1);
  });
});

async function createFixture() {
  const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
  const [group] = await db.select().from(storeGroups).limit(1);
  const [product] = await db.select().from(products).where(eq(products.isActive, true)).limit(1);
  if (!admin || !group || !product)
    throw new Error('Reference data and bootstrap admin are required.');
  const [store] = await db
    .insert(stores)
    .values({
      code: `CYCLE-${randomUUID()}`,
      name: 'Cycle test',
      groupId: group.id,
      kind: 'retail',
    })
    .returning();
  return { admin, store: store!, product };
}
