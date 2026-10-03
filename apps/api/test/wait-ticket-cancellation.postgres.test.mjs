import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

import {
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
  waitTickets,
} from '@idosi/database';
import { and, eq, isNull } from 'drizzle-orm';

import { createApi } from '../dist/app.js';
import { PostgresWarehouseRepository } from '../dist/postgres-repository.js';
import { hashSessionToken } from '../dist/security.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('wait ticket cancellation through the API on PostgreSQL', () => {
  test('ADMIN cancels any store wait (inactive too), HTKD is refused, STORE only its own', async () => {
    const repository = new PostgresWarehouseRepository();
    const app = await createApi({ repository });
    try {
      const fixture = await createFixture();
      const cancel = (token, ticketId, key, reason = 'Không còn nhu cầu nhận hàng') =>
        app.inject({
          method: 'POST',
          url: `/api/v1/wait-tickets/${ticketId}/cancel`,
          headers: { cookie: `idosi_session=${token}`, 'idempotency-key': key },
          payload: { reason },
        });

      const htkd = await cancel(fixture.tokens.htkd, fixture.ticketA, 'htkd-cancel-0001');
      assert.equal(htkd.statusCode, 403);
      const foreign = await cancel(fixture.tokens.store, fixture.ticketB, 'store-foreign-0001');
      assert.equal(foreign.statusCode, 403);

      const own = await cancel(fixture.tokens.store, fixture.ticketA, 'store-own-cancel-0001');
      assert.equal(own.statusCode, 200);
      assert.equal(own.json().data.status, 'CANCELLED');
      assert.equal(own.json().data.cancellationKind, 'STORE_CANCELLED');
      assert.equal(own.json().data.resolutionReason, 'Không còn nhu cầu nhận hàng');
      const replay = await cancel(fixture.tokens.store, fixture.ticketA, 'store-own-cancel-0001');
      assert.equal(replay.headers['idempotency-replayed'], 'true');
      assert.deepEqual(replay.json().data, own.json().data);

      // Store B is deactivated; its stale demand can still be closed by an Admin.
      await db.update(stores).set({ isActive: false }).where(eq(stores.id, fixture.storeB));
      const admin = await cancel(fixture.tokens.admin, fixture.ticketB, 'admin-cancel-0001');
      assert.equal(admin.statusCode, 200);
      assert.equal(admin.json().data.cancellationKind, 'ADMIN_CANCELLED');
      const history = await app.inject({
        method: 'GET',
        url: `/api/v1/wait-tickets/${fixture.ticketB}/history`,
        headers: { cookie: `idosi_session=${fixture.tokens.admin}` },
      });
      assert.equal(history.statusCode, 200);
      assert.ok(
        history
          .json()
          .data.audit.some(
            (event) =>
              event.action === 'WAIT_TICKET_ADMIN_CANCELLED' && event.actorRole === 'ADMIN',
          ),
      );
    } finally {
      await app.close();
    }
  });
});

async function createFixture() {
  const suffix = randomUUID();
  const [administrator] = await db
    .select({ id: users.id, tokenVersion: users.tokenVersion })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active'), isNull(users.deletedAt)))
    .limit(1);
  const [group] = await db
    .select({ id: storeGroups.id })
    .from(storeGroups)
    .where(eq(storeGroups.isActive, true))
    .limit(1);
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.isActive, true), isNull(products.deletedAt)))
    .limit(1);
  if (!administrator || !group || !product) {
    throw new Error('Reference seed and administrator bootstrap must run before this test.');
  }
  return db.transaction(async (tx) => {
    const [storeA, storeB] = await tx
      .insert(stores)
      .values(
        ['A', 'B'].map((label, index) => ({
          groupId: group.id,
          code: `WCAN_${suffix.slice(0, 8)}_${label}`,
          name: `Wait cancellation ${label}`,
          kind: 'retail',
          displayOrder: 20_000 + index,
        })),
      )
      .returning({ id: stores.id });
    const [htkdUser] = await tx
      .insert(users)
      .values({
        email: `wcan.htkd.${suffix}@example.test`,
        passwordHash: `integration-hash-${suffix}`,
        displayName: 'Wait cancellation HTKD',
        role: 'htkd',
      })
      .returning({ id: users.id, tokenVersion: users.tokenVersion });
    const [storeUser] = await tx
      .insert(users)
      .values({
        email: `wcan.store.${suffix}@example.test`,
        passwordHash: `integration-hash-${suffix}`,
        displayName: 'Wait cancellation store',
        role: 'store',
        storeId: storeA.id,
      })
      .returning({ id: users.id, tokenVersion: users.tokenVersion });
    await tx.insert(htkdAssignments).values([
      { userId: htkdUser.id, storeId: storeA.id, assignedByUserId: administrator.id },
      { userId: htkdUser.id, storeId: storeB.id, assignedByUserId: administrator.id },
    ]);
    const [session] = await tx
      .insert(orderSessions)
      .values({
        code: `WCAN-${suffix}`,
        kind: 'manual',
        businessDate: '2000-01-02',
        status: 'completed',
        openedAt: new Date('2000-01-02T00:00:00.000Z'),
        inventorySnapshotDueAt: new Date('2000-01-02T01:00:00.000Z'),
        requestDeadlineAt: new Date('2000-01-02T02:00:00.000Z'),
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
      })
      .returning({ id: orderSessions.id });
    const tickets = [];
    for (const store of [storeA, storeB]) {
      const [order] = await tx
        .insert(orderRequests)
        .values({
          orderSessionId: session.id,
          storeId: store.id,
          requestNumber: 1,
          status: 'waitlisted',
          submittedAt: new Date('2000-01-02T00:30:00.000Z'),
          requestedByUserId: administrator.id,
        })
        .returning({ id: orderRequests.id });
      const [line] = await tx
        .insert(orderRequestItems)
        .values({ orderRequestId: order.id, productId: product.id, requestedQuantity: 2 })
        .returning({ id: orderRequestItems.id });
      const [ticket] = await tx
        .insert(waitTickets)
        .values({
          storeId: store.id,
          productId: product.id,
          sourceOrderRequestItemId: line.id,
          originalQuantity: 2,
          remainingQuantity: 2,
        })
        .returning({ id: waitTickets.id });
      tickets.push(ticket.id);
    }
    const tokens = {
      admin: `wcan-admin-${suffix}`,
      htkd: `wcan-htkd-${suffix}`,
      store: `wcan-store-${suffix}`,
    };
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    await tx.insert(sessions).values([
      {
        userId: administrator.id,
        tokenHash: hashSessionToken(tokens.admin),
        userTokenVersion: administrator.tokenVersion,
        expiresAt,
      },
      {
        userId: htkdUser.id,
        tokenHash: hashSessionToken(tokens.htkd),
        userTokenVersion: htkdUser.tokenVersion,
        expiresAt,
      },
      {
        userId: storeUser.id,
        tokenHash: hashSessionToken(tokens.store),
        userTokenVersion: storeUser.tokenVersion,
        expiresAt,
      },
    ]);
    return {
      storeA: storeA.id,
      storeB: storeB.id,
      ticketA: tickets[0],
      ticketB: tickets[1],
      tokens,
    };
  });
}
