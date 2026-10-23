import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { db, stores, users, sessions, products, storeGroups } from '@idosi/database';
import { eq } from 'drizzle-orm';
import { createApi } from '../dist/app.js';
import { PostgresWarehouseRepository } from '../dist/postgres-repository.js';
import { hashSessionToken } from '../dist/security.js';

test(
  'emergency API authenticates every read and command; any HTKD, scoped store and wholesale',
  { skip: process.env.RUN_POSTGRES_TESTS !== '1' },
  async () => {
    const tag = randomUUID();
    const [group] = await db
      .insert(storeGroups)
      .values({ code: `UK-${tag}`, name: 'Emergency API group' })
      .returning();
    const [store] = await db
      .insert(stores)
      .values({ groupId: group.id, code: `UK-${tag}`, name: 'Emergency API store' })
      .returning();
    const [other] = await db
      .insert(stores)
      .values({ groupId: group.id, code: `UK2-${tag}`, name: 'Other API store', kind: 'wholesale' })
      .returning();
    const [product] = await db
      .insert(products)
      .values({ sku: `UK-${tag}`, slug: `uk-${tag}`, name: 'Emergency API product' })
      .returning();
    const tokens = {};
    const accounts = {};
    for (const role of ['admin', 'htkd', 'store', 'wholesale']) {
      const [actor] = await db
        .insert(users)
        .values({
          email: `${role}-${tag}@example.test`,
          passwordHash: 'supplier-test-password-hash-placeholder',
          displayName: role,
          role,
          ...(role === 'store' ? { storeId: store.id } : {}),
        })
        .returning();
      const token = randomUUID();
      await db.insert(sessions).values({
        userId: actor.id,
        tokenHash: hashSessionToken(token),
        userTokenVersion: actor.tokenVersion,
        expiresAt: new Date(Date.now() + 3600000),
      });
      tokens[role] = token;
      accounts[role] = actor;
    }
    const app = await createApi({ repository: new PostgresWarehouseRepository() });
    const base = '/api/v1/priority-orders';
    const call = (role, method, url, payload, key) =>
      app.inject({
        method,
        url,
        headers: {
          ...(role ? { cookie: `idosi_session=${tokens[role]}` } : {}),
          ...(key ? { 'idempotency-key': key } : {}),
        },
        ...(payload === undefined ? {} : { payload }),
      });
    const input = {
      storeId: store.id,
      sources: [{ id: randomUUID(), revision: 'stale' }],
      additionalLines: [{ productId: product.id, quantity: 1 }],
      notes: '',
    };
    try {
      assert.equal((await call(null, 'GET', base)).statusCode, 401);
      for (const role of ['admin', 'htkd']) {
        const context = await call(role, 'GET', `${base}/context?storeId=${store.id}`);
        assert.equal(context.statusCode, 200);
        assert.equal(context.headers['cache-control'], 'no-store');
        const stock = await call(
          role,
          'GET',
          `${base}/availability?storeId=${store.id}&productId=${product.id}`,
        );
        assert.equal(stock.statusCode, 200);
        assert.equal(stock.json().data.availableBags, 0);
        assert.equal((await call(role, 'POST', base, input)).statusCode, 400);
        assert.equal(
          (
            await call(
              role,
              'POST',
              base,
              { ...input, additionalLines: [{ productId: product.id, quantity: 0 }] },
              randomUUID(),
            )
          ).statusCode,
          400,
        );
        assert.equal((await call(role, 'POST', base, input, randomUUID())).statusCode, 409);
        assert.equal((await call(role, 'POST', `${base}/preview`, input)).statusCode, 409);
        assert.equal((await call(role, 'GET', `${base}/${randomUUID()}`)).statusCode, 404);
      }
      for (const role of ['store', 'wholesale']) {
        assert.equal((await call(role, 'GET', base)).statusCode, 200);
        assert.equal((await call(role, 'GET', `${base}/context`)).statusCode, 403);
        assert.equal(
          (
            await call(
              role,
              'GET',
              `${base}/availability?storeId=${store.id}&productId=${product.id}`,
            )
          ).statusCode,
          403,
        );
        assert.equal((await call(role, 'POST', base, input, randomUUID())).statusCode, 403);
        assert.equal((await call(role, 'POST', `${base}/preview`, input)).statusCode, 403);
        assert.equal(
          (
            await call(
              role,
              'PUT',
              `${base}/${randomUUID()}/reshare-status`,
              { status: 'ORDERED', expectedVersion: 1 },
              randomUUID(),
            )
          ).statusCode,
          403,
        );
      }
      assert.equal((await call('store', 'GET', `${base}?storeId=${other.id}`)).statusCode, 403);
      assert.equal((await call('wholesale', 'GET', `${base}?storeId=${store.id}`)).statusCode, 403);
      assert.equal((await call('wholesale', 'GET', `${base}?storeId=${other.id}`)).statusCode, 200);
      await db.update(users).set({ status: 'disabled' }).where(eq(users.id, accounts.htkd.id));
      assert.equal((await call('htkd', 'GET', base)).statusCode, 401);
      const spec = (await app.inject({ url: '/openapi.json' })).json();
      assert.ok(spec.paths[base].post);
      for (const [path, operations] of Object.entries(spec.paths)) {
        if (path.startsWith(base)) {
          for (const operation of Object.values(operations)) {
            assert.deepEqual(operation.security, [{ cookieSession: [] }]);
          }
        }
      }
    } finally {
      await app.close();
    }
  },
);
