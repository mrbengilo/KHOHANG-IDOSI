import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { eq } from 'drizzle-orm';
import {
  ListOrderHistoryResponseSchema,
  ListWarehouseStockAdjustmentsResponseSchema,
  WarehouseInventoryResponseSchema,
} from '@idosi/contracts';
import {
  applyWarehouseMovement,
  db,
  htkdAssignments,
  orderRequestItems,
  orderRequests,
  orderSessions,
  products,
  sessions,
  storeGroups,
  stores,
  users,
  warehouseStockAdjustments,
} from '@idosi/database';
import { createApi } from '../dist/app.js';
import { PostgresWarehouseRepository } from '../dist/postgres-repository.js';
import { hashSessionToken } from '../dist/security.js';

const skip = process.env.RUN_POSTGRES_TESTS !== '1';
// One app per file: closing it also closes the shared database pool.
let app;
before(async () => {
  if (!skip) app = await createApi({ repository: new PostgresWarehouseRepository() });
});
after(async () => {
  await app?.close();
});

async function login(user) {
  const token = randomUUID();
  await db.insert(sessions).values({
    userId: user.id,
    tokenHash: hashSessionToken(token),
    userTokenVersion: user.tokenVersion,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return { cookie: `idosi_session=${token}` };
}

async function fixture() {
  const suffix = randomUUID().slice(0, 8);
  const [group] = await db
    .insert(storeGroups)
    .values({ code: `OH-${suffix}`, name: 'Order history API' })
    .returning();
  const storeRows = await db
    .insert(stores)
    .values(
      ['A', 'B'].map((name) => ({
        groupId: group.id,
        code: `OH-${name}-${suffix}`,
        name: `Order history ${name}`,
      })),
    )
    .returning();
  const [product] = await db
    .insert(products)
    .values({ sku: `OH-${suffix}`, slug: `oh-${suffix}`, name: 'Order history product' })
    .returning();
  const userRows = await db
    .insert(users)
    .values(
      [
        ['admin', null],
        ['htkd', null],
        ['store', storeRows[1].id],
      ].map(([role, storeId]) => ({
        email: `oh.${role}.${suffix}`,
        passwordHash: 'not-used-by-session-fixture',
        displayName: `Order history ${role}`,
        role,
        storeId,
      })),
    )
    .returning();
  const [admin, htkd, storeUser] = userRows;
  await db.insert(htkdAssignments).values({ userId: htkd.id, storeId: storeRows[0].id });
  const [session] = await db
    .insert(orderSessions)
    .values({
      code: '',
      kind: 'manual',
      businessDate: '2041-03-04',
      status: 'open',
      openedAt: new Date('2041-03-04T00:00:00+07:00'),
      inventorySnapshotDueAt: new Date('2041-03-04T08:00:00+07:00'),
      requestDeadlineAt: new Date('2041-03-04T09:00:00+07:00'),
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
    })
    .returning();
  for (const [index, store] of storeRows.entries()) {
    const [request] = await db
      .insert(orderRequests)
      .values({
        orderSessionId: session.id,
        storeId: store.id,
        requestNumber: 1,
        status: 'submitted',
        requestedByUserId: admin.id,
        submittedAt: new Date(Date.now() - (index + 1) * 60_000),
      })
      .returning();
    await db
      .insert(orderRequestItems)
      .values({ orderRequestId: request.id, productId: product.id, requestedQuantity: index + 2 });
  }
  return { admin, htkd, storeUser, storeRows, product, session };
}

test('order history is ADMIN-wide, HTKD-scoped and closed to stores', { skip }, async () => {
  {
    const f = await fixture();
    const scopedQuery = `sessionId=${f.session.id}`;
    const admin = await app.inject({
      method: 'GET',
      url: `/api/v1/order-history?${scopedQuery}`,
      headers: await login(f.admin),
    });
    assert.equal(admin.statusCode, 200, admin.body);
    const adminPage = ListOrderHistoryResponseSchema.parse(admin.json());
    assert.equal(adminPage.pagination.totalItems, 2);
    assert.equal(admin.headers['cache-control'], 'no-store');

    const htkdHeaders = await login(f.htkd);
    const htkd = await app.inject({
      method: 'GET',
      url: `/api/v1/order-history?${scopedQuery}`,
      headers: htkdHeaders,
    });
    const htkdPage = ListOrderHistoryResponseSchema.parse(htkd.json());
    assert.equal(htkdPage.pagination.totalItems, 1);
    assert.deepEqual(
      htkdPage.data.map((entry) => entry.storeId),
      [f.storeRows[0].id],
    );
    assert.equal(htkdPage.data[0].lines[0].requestedQuantity, 2);
    assert.equal(htkdPage.data[0].session.kind, 'MANUAL');

    // Naming an unassigned store is refused, not answered with an empty page or a count.
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v1/order-history?storeId=${f.storeRows[1].id}`,
      headers: htkdHeaders,
    });
    assert.equal(foreign.statusCode, 403, foreign.body);

    // Revoking the assignment takes effect on the next request of the same session.
    await db
      .update(htkdAssignments)
      .set({ revokedAt: new Date() })
      .where(eq(htkdAssignments.userId, f.htkd.id));
    const revoked = await app.inject({
      method: 'GET',
      url: `/api/v1/order-history?${scopedQuery}`,
      headers: htkdHeaders,
    });
    // Revoking an assignment revokes the HTKD's sessions; nothing of the store is readable after.
    if (revoked.statusCode === 200) {
      assert.equal(ListOrderHistoryResponseSchema.parse(revoked.json()).pagination.totalItems, 0);
    } else {
      assert.equal(revoked.statusCode, 401, revoked.body);
    }

    const store = await app.inject({
      method: 'GET',
      url: '/api/v1/order-history',
      headers: await login(f.storeUser),
    });
    assert.equal(store.statusCode, 403, store.body);

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/order-history?submittedFrom=2041-03-05&submittedTo=2041-03-04',
      headers: await login(f.admin),
    });
    assert.equal(invalid.statusCode, 400, invalid.body);

    // A locked account cannot keep using its old session.
    const lockedHeaders = await login(f.admin);
    await db.update(users).set({ status: 'locked' }).where(eq(users.id, f.admin.id));
    const locked = await app.inject({
      method: 'GET',
      url: '/api/v1/order-history',
      headers: lockedHeaders,
    });
    // Locking revokes the account's sessions; either refusal ends the old session's access.
    assert.ok([401, 403].includes(locked.statusCode), locked.body);
    assert.ok(['SESSION_REVOKED', 'ACCOUNT_INACTIVE'].includes(locked.json().error.code));
  }
});

test(
  'warehouse adjustments: admin-only writes, replay by key, stale and reserved-stock conflicts',
  { skip },
  async () => {
    {
      const f = await fixture();
      await db.transaction(async (tx) => {
        await applyWarehouseMovement(tx, {
          productId: f.product.id,
          eventType: 'opening_balance',
          onHandDelta: 10,
          reservedDelta: 0,
          sourceType: 'api_adjustment_test',
          sourceId: randomUUID(),
        });
        await applyWarehouseMovement(tx, {
          productId: f.product.id,
          eventType: 'reservation',
          onHandDelta: 0,
          reservedDelta: 4,
          sourceType: 'api_adjustment_test_hold',
          sourceId: randomUUID(),
        });
      });
      const adminHeaders = await login(f.admin);
      const inventory = await app.inject({
        method: 'GET',
        url: `/api/v1/warehouse-inventory?search=${encodeURIComponent(f.product.sku)}`,
        headers: adminHeaders,
      });
      const row = WarehouseInventoryResponseSchema.parse(inventory.json()).data[0];
      assert.equal(row.onHandBags, 10);
      assert.equal(row.reservedBags, 4);
      assert.equal(row.balanceVersion, 2);

      const payload = {
        productId: f.product.id,
        direction: 'INCREASE',
        quantity: 3,
        reasonCode: 'COUNT_CORRECTION',
        reason: 'Kiểm kê dư 3 bao',
        expectedVersion: row.balanceVersion,
      };
      for (const user of [f.htkd, f.storeUser]) {
        const refused = await app.inject({
          method: 'POST',
          url: '/api/v1/warehouse-adjustments',
          headers: { ...(await login(user)), 'idempotency-key': randomUUID() },
          payload,
        });
        assert.equal(refused.statusCode, 403, refused.body);
      }
      const key = randomUUID();
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/warehouse-adjustments',
        headers: { ...adminHeaders, 'idempotency-key': key },
        payload,
      });
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(created.headers['idempotency-replayed'], 'false');
      const adjustment = created.json().data;
      assert.deepEqual(adjustment.before, { onHand: 10, reserved: 4, available: 6 });
      assert.deepEqual(adjustment.after, { onHand: 13, reserved: 4, available: 9 });
      assert.equal(adjustment.delta, 3);
      assert.match(adjustment.code, /^DCK-\d{6}$/u);

      const replay = await app.inject({
        method: 'POST',
        url: '/api/v1/warehouse-adjustments',
        headers: { ...adminHeaders, 'idempotency-key': key },
        payload,
      });
      assert.equal(replay.statusCode, 201, replay.body);
      assert.equal(replay.headers['idempotency-replayed'], 'true');
      assert.equal(replay.json().data.id, adjustment.id);

      const reused = await app.inject({
        method: 'POST',
        url: '/api/v1/warehouse-adjustments',
        headers: { ...adminHeaders, 'idempotency-key': key },
        payload: { ...payload, quantity: 4 },
      });
      assert.equal(reused.statusCode, 409, reused.body);
      assert.equal(reused.json().error.code, 'IDEMPOTENCY_CONFLICT');

      const stale = await app.inject({
        method: 'POST',
        url: '/api/v1/warehouse-adjustments',
        headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
        payload,
      });
      assert.equal(stale.statusCode, 409, stale.body);
      assert.equal(stale.json().error.code, 'VERSION_CONFLICT');

      const belowReserved = await app.inject({
        method: 'POST',
        url: '/api/v1/warehouse-adjustments',
        headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
        payload: {
          ...payload,
          direction: 'DECREASE',
          quantity: 10,
          expectedVersion: adjustment.balanceVersionAfter,
        },
      });
      assert.equal(belowReserved.statusCode, 409, belowReserved.body);
      assert.equal(belowReserved.json().error.code, 'INSUFFICIENT_STOCK');

      for (const invalid of [
        { ...payload, quantity: 0 },
        { ...payload, quantity: 1.5 },
        { ...payload, reason: 'ab' },
        { ...payload, direction: 'SET' },
        { ...payload, unexpected: true },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/warehouse-adjustments',
          headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
          payload: invalid,
        });
        assert.equal(response.statusCode, 400, response.body);
      }
      const documents = await db
        .select()
        .from(warehouseStockAdjustments)
        .where(eq(warehouseStockAdjustments.productId, f.product.id));
      assert.equal(documents.length, 1);

      const history = await app.inject({
        method: 'GET',
        url: `/api/v1/warehouse-adjustments?productId=${f.product.id}`,
        headers: adminHeaders,
      });
      const page = ListWarehouseStockAdjustmentsResponseSchema.parse(history.json());
      assert.deepEqual(
        page.data.map((entry) => entry.id),
        [adjustment.id],
      );
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/warehouse-adjustments/${adjustment.id}`,
        headers: adminHeaders,
      });
      assert.equal(detail.statusCode, 200, detail.body);
      const htkdHistory = await app.inject({
        method: 'GET',
        url: '/api/v1/warehouse-adjustments',
        headers: await login(f.htkd),
      });
      assert.equal(htkdHistory.statusCode, 403, htkdHistory.body);

      const openapi = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
      assert.ok(openapi.paths['/api/v1/order-history']);
      assert.ok(openapi.paths['/api/v1/warehouse-adjustments'].post);
      assert.ok(openapi.paths['/api/v1/warehouse-adjustments/{adjustmentId}']);
    }
  },
);
