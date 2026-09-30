import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { ListWarehouseOutboundRequestsResponseSchema } from '@idosi/contracts';
import {
  db,
  storeGroups,
  stores,
  products,
  users,
  sessions,
  outboundRequests,
  outboundRequestLines,
  auditLogs,
} from '@idosi/database';
import { createApi } from '../dist/app.js';
import { PostgresWarehouseRepository } from '../dist/postgres-repository.js';
import { hashSessionToken } from '../dist/security.js';

test(
  'warehouse history preserves missing legacy provenance without authorizing a new dispatch',
  { skip: process.env.RUN_POSTGRES_TESTS !== '1' },
  async () => {
    const suffix = randomUUID().slice(0, 8);
    const repository = new PostgresWarehouseRepository();
    const app = await createApi({ repository });
    try {
      const [group] = await db
        .insert(storeGroups)
        .values({ code: `HISTORY-${suffix}`, name: 'History test' })
        .returning();
      const [store] = await db
        .insert(stores)
        .values({ groupId: group.id, code: `HISTORY-${suffix}`, name: 'History test store' })
        .returning();
      const [product] = await db
        .insert(products)
        .values({
          sku: `HISTORY-${suffix}`,
          slug: `history-${suffix}`,
          name: 'History test product',
        })
        .returning();
      const [admin] = await db
        .insert(users)
        .values({
          email: `history.${suffix}`,
          passwordHash: 'not-used-by-session-fixture',
          displayName: 'History test admin',
          role: 'admin',
        })
        .returning();
      const token = randomUUID();
      await db.insert(sessions).values({
        userId: admin.id,
        tokenHash: hashSessionToken(token),
        userTokenVersion: admin.tokenVersion,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const headers = { cookie: `idosi_session=${token}` };
      const outbounds = await db
        .insert(outboundRequests)
        .values(
          ['dispatched', 'reserved'].map((status) => ({
            requestNumber: '',
            storeId: store.id,
            requestedByUserId: admin.id,
            status,
          })),
        )
        .returning();
      for (const outbound of outbounds)
        await db.insert(outboundRequestLines).values({
          outboundRequestId: outbound.id,
          productId: product.id,
          requestedQuantity: 3,
          approvedQuantity: 3,
          reservedQuantity: 3,
          dispatchedQuantity: outbound.status === 'dispatched' ? 3 : 0,
        });
      const before = await db
        .select()
        .from(outboundRequests)
        .where(eq(outboundRequests.storeId, store.id));
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/outbound-requests?storeId=${store.id}`,
        headers,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = ListWarehouseOutboundRequestsResponseSchema.parse(response.json());
      assert.equal(payload.data.length, 2);
      for (const outbound of payload.data) {
        assert.equal(outbound.lines[0].allocationLineId, null);
        assert.equal(outbound.dispatchedAt, null);
        assert.equal(outbound.lines[0].approvedUnits, 3);
      }
      const reserved = outbounds.find((outbound) => outbound.status === 'reserved');
      const rejected = await app.inject({
        method: 'POST',
        url: `/api/v1/outbound-requests/${reserved.id}/dispatch`,
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: { expectedVersion: 0 },
      });
      assert.equal(rejected.statusCode, 409, rejected.body);
      assert.equal(rejected.json().error.code, 'INVALID_STATE_TRANSITION');
      assert.deepEqual(
        await db.select().from(outboundRequests).where(eq(outboundRequests.storeId, store.id)),
        before,
      );
      assert.deepEqual(
        await db.select().from(auditLogs).where(eq(auditLogs.entityId, reserved.id)),
        [],
      );
    } finally {
      await app.close();
    }
  },
);
