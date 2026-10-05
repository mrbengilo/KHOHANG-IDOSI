import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

import {
  allocationLines,
  allocationRuns,
  applyWarehouseMovement,
  db,
  htkdAssignments,
  inventorySnapshots,
  mergedOrderItems,
  mergedOrders,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  orderSessions,
  outboundRequestLines,
  outboundRequests,
  products,
  publishAllocationDecisionsInTransaction,
  reservations,
  sessions,
  storeGroups,
  stores,
  users,
  warehouseBalances,
  withSerializableTransaction,
} from '@idosi/database';
import { and, eq, isNull } from 'drizzle-orm';

import { createApi } from '../dist/app.js';
import { PostgresWarehouseRepository } from '../dist/postgres-repository.js';
import { hashSessionToken } from '../dist/security.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('allocation result decisions through the API on PostgreSQL', () => {
  test('scopes reads, answers once per result and gates shipping server-side', async () => {
    const repository = new PostgresWarehouseRepository();
    const app = await createApi({ repository });
    try {
      const fx = await createFixture();
      const resultA = await publishResult(fx, fx.storeA, 3, { shipment: true });
      const resultW = await publishResult(fx, fx.wholesaleStore, 2, { shipment: false });
      const resultB = await publishResult(fx, fx.storeB, 1, { shipment: true });

      const get = (token, url) =>
        app.inject({ method: 'GET', url, headers: { cookie: `idosi_session=${token}` } });
      const respond = (token, decisionId, payload, key = randomUUID()) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/allocation-decisions/${decisionId}/respond`,
          headers: { cookie: `idosi_session=${token}`, 'idempotency-key': key },
          payload,
        });

      // The notice source: each account sees only its scope, PENDING first-class.
      const storeList = await get(fx.tokens.storeA, '/api/v1/allocation-decisions?status=PENDING');
      assert.equal(storeList.statusCode, 200);
      assert.equal(storeList.headers['cache-control'], 'no-store');
      assert.deepEqual(
        storeList.json().data.map((row) => [row.id, row.status, row.canRespond]),
        [[resultA.decisionId, 'PENDING', true]],
      );
      assert.equal(storeList.json().data[0].grantedQuantity, 3);
      assert.equal(storeList.json().data[0].shipment.status, 'RESERVED');
      const htkdList = await get(fx.tokens.htkd, '/api/v1/allocation-decisions');
      assert.deepEqual(
        htkdList.json().data.map((row) => [row.id, row.canRespond]),
        [[resultA.decisionId, false]],
      );
      const otherStore = await get(fx.tokens.storeB, '/api/v1/allocation-decisions');
      assert.deepEqual(
        otherStore.json().data.map((row) => row.id),
        [resultB.decisionId],
      );
      assert.equal(
        (await get(fx.tokens.storeB, `/api/v1/allocation-decisions/${resultA.decisionId}`))
          .statusCode,
        404,
      );
      assert.equal(
        (await get(fx.tokens.storeA, `/api/v1/allocation-decisions?storeId=${fx.storeB}`))
          .statusCode,
        403,
      );
      const detail = await get(
        fx.tokens.htkd,
        `/api/v1/allocation-decisions/${resultA.decisionId}`,
      );
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().data.sources.length, 1);
      assert.equal(detail.json().data.version, 1);
      assert.equal(detail.json().data.runVersion, 1);

      // Only the receiving side answers; nobody can answer outside their scope.
      assert.equal((await respond(fx.tokens.admin, resultA.decisionId, accept())).statusCode, 403);
      assert.equal((await respond(fx.tokens.htkd, resultA.decisionId, accept())).statusCode, 403);
      assert.equal((await respond(fx.tokens.storeB, resultA.decisionId, accept())).statusCode, 404);
      assert.equal(
        (await respond(fx.tokens.wholesale, resultA.decisionId, accept())).statusCode,
        404,
      );
      assert.equal(
        (await respond(fx.tokens.storeA, resultA.decisionId, { action: 'ACCEPT' })).statusCode,
        400,
      );
      assert.equal(
        (
          await respond(fx.tokens.storeA, resultA.decisionId, {
            ...accept(),
            reason: 'không cần',
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await respond(fx.tokens.storeA, resultA.decisionId, {
            ...accept(),
            storeId: fx.storeB,
          })
        ).statusCode,
        400,
      );
      // An administrator cannot release the shipment while the store has not accepted.
      const early = await app.inject({
        method: 'POST',
        url: `/api/v1/outbound-requests/${resultA.outboundId}/dispatch`,
        headers: { cookie: `idosi_session=${fx.tokens.admin}`, 'idempotency-key': randomUUID() },
        payload: { expectedVersion: 0 },
      });
      assert.equal(early.statusCode, 409);
      assert.equal(early.json().error.code, 'INVALID_STATE_TRANSITION');
      assert.equal(await receiptSourceCount(app, fx.tokens.storeA), 0);

      const key = randomUUID();
      const accepted = await respond(fx.tokens.storeA, resultA.decisionId, accept(), key);
      assert.equal(accepted.statusCode, 200);
      assert.equal(accepted.headers['idempotency-replayed'], 'false');
      assert.equal(accepted.json().data.status, 'ACCEPTED');
      assert.equal(accepted.json().data.version, 2);
      assert.equal(accepted.json().data.canRespond, false);
      assert.equal(accepted.json().data.respondedByAccountId, fx.storeUserA);
      assert.equal(accepted.json().data.shipment.status, 'DISPATCHED');
      // Acceptance is not receipt: stock stays on hand and reserved.
      assert.deepEqual(await balance(fx.productId), { onHand: 100, reserved: 6 });
      assert.equal(await receiptSourceCount(app, fx.tokens.storeA), 1);

      const replay = await respond(fx.tokens.storeA, resultA.decisionId, accept(), key);
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.headers['idempotency-replayed'], 'true');
      assert.equal(replay.json().data.status, 'ACCEPTED');
      const reused = await respond(fx.tokens.storeA, resultA.decisionId, reject(), key);
      assert.equal(reused.statusCode, 409);
      assert.equal(reused.json().error.code, 'IDEMPOTENCY_CONFLICT');
      const flip = await respond(fx.tokens.storeA, resultA.decisionId, reject(2));
      assert.equal(flip.statusCode, 409);
      assert.equal(flip.json().error.code, 'INVALID_STATE_TRANSITION');
      assert.equal(flip.json().error.details.currentStatus, 'ACCEPTED');

      // The wholesale desk answers for wholesale stores; a rejection releases the goods.
      const rejected = await respond(fx.tokens.wholesale, resultW.decisionId, {
        ...reject(),
        reason: 'Kho sỉ đã đủ hàng',
      });
      assert.equal(rejected.statusCode, 200);
      assert.equal(rejected.json().data.status, 'REJECTED');
      assert.equal(rejected.json().data.reason, 'Kho sỉ đã đủ hàng');
      assert.equal(rejected.json().data.releasedQuantity, 2);
      assert.deepEqual(await balance(fx.productId), { onHand: 100, reserved: 4 });
      const stale = await respond(fx.tokens.storeB, resultB.decisionId, accept(9));
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().error.code, 'VERSION_CONFLICT');

      // Session documents carry the decision only when asked.
      const documents = await get(
        fx.tokens.storeA,
        `/api/v1/session-documents?sessionId=${resultA.sessionId}&includeDecision=true`,
      );
      assert.equal(documents.statusCode, 200);
      assert.equal(documents.json().data[0].decision.status, 'ACCEPTED');
      const legacyShape = await get(
        fx.tokens.storeA,
        `/api/v1/session-documents?sessionId=${resultA.sessionId}`,
      );
      assert.equal('decision' in legacyShape.json().data[0], false);

      // Locking the account takes effect at once, even for a retry of its own key.
      const keyB = randomUUID();
      await db.update(users).set({ status: 'locked' }).where(eq(users.id, fx.storeUserB));
      const locked = await respond(fx.tokens.storeB, resultB.decisionId, accept(), keyB);
      assert.ok([401, 403].includes(locked.statusCode));
      assert.deepEqual(await balance(fx.productId), { onHand: 100, reserved: 4 });
    } finally {
      await app.close();
    }
  });
});

function accept(expectedVersion = 1) {
  return { action: 'ACCEPT', expectedVersion };
}
function reject(expectedVersion = 1) {
  return { action: 'REJECT', expectedVersion };
}

async function receiptSourceCount(app, token) {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/store-receipt-sources',
    headers: { cookie: `idosi_session=${token}` },
  });
  assert.equal(response.statusCode, 200);
  return response.json().data.length;
}

async function balance(productId) {
  const [row] = await db
    .select()
    .from(warehouseBalances)
    .where(eq(warehouseBalances.productId, productId));
  return { onHand: row.onHandQuantity, reserved: row.reservedQuantity };
}

async function publishResult(fx, storeId, quantity, { shipment }) {
  const token = randomUUID().replaceAll('-', '');
  const now = new Date();
  const [session] = await db
    .insert(orderSessions)
    .values({
      code: `ADEC-${token}`,
      kind: 'manual',
      businessDate: '2000-01-03',
      status: 'completed',
      inventorySnapshotDueAt: new Date('2000-01-03T01:00:00.000Z'),
      requestDeadlineAt: new Date('2000-01-03T02:00:00.000Z'),
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
    })
    .returning();
  const [snapshot] = await db
    .insert(inventorySnapshots)
    .values({
      orderSessionId: session.id,
      businessDate: '2000-01-03',
      snapshotType: 'manual',
      status: 'completed',
      capturedAt: now,
      completedAt: now,
      balanceVersion: 0,
    })
    .returning();
  const [run] = await db
    .insert(allocationRuns)
    .values({
      orderSessionId: session.id,
      inventorySnapshotId: snapshot.id,
      runNumber: 1,
      status: 'running',
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
      idempotencyKey: randomUUID(),
    })
    .returning();
  const [order] = await db
    .insert(orderRequests)
    .values({
      orderSessionId: session.id,
      storeId,
      requestNumber: 1,
      status: 'allocated',
      submittedAt: now,
      requestedByUserId: fx.adminId,
    })
    .returning();
  const [item] = await db
    .insert(orderRequestItems)
    .values({ orderRequestId: order.id, productId: fx.productId, requestedQuantity: quantity })
    .returning();
  const [merged] = await db
    .insert(mergedOrders)
    .values({ orderSessionId: session.id, storeId, status: 'allocated', requestCount: 1 })
    .returning();
  const [mergedItem] = await db
    .insert(mergedOrderItems)
    .values({
      mergedOrderId: merged.id,
      productId: fx.productId,
      requestedQuantity: quantity,
      priorityLevel: 'P1',
    })
    .returning();
  await db.insert(mergedOrderSources).values({
    mergedOrderItemId: mergedItem.id,
    orderRequestItemId: item.id,
    requestedQuantity: quantity,
  });
  const [line] = await db
    .insert(allocationLines)
    .values({
      allocationRunId: run.id,
      mergedOrderId: merged.id,
      storeId,
      productId: fx.productId,
      orderRequestItemId: item.id,
      priorityLevel: 'P1',
      roundNumber: 1,
      sequenceInRound: 1,
      requestedQuantity: quantity,
      allocatedQuantity: quantity,
      status: 'allocated',
      reasonCode: 'API_DECISION_TEST',
    })
    .returning();
  const [reservation] = await db
    .insert(reservations)
    .values({
      productId: fx.productId,
      storeId,
      allocationLineId: line.id,
      quantity,
    })
    .returning();
  await withSerializableTransaction(db, (tx) =>
    applyWarehouseMovement(tx, {
      productId: fx.productId,
      eventType: 'reservation',
      onHandDelta: 0,
      reservedDelta: quantity,
      sourceType: 'allocation_run',
      sourceId: run.id,
    }),
  );
  const decisions = await withSerializableTransaction(db, (tx) =>
    publishAllocationDecisionsInTransaction(tx, {
      allocationRunId: run.id,
      orderSessionId: session.id,
      publishedAt: now,
    }),
  );
  let outboundId = null;
  if (shipment) {
    const [outbound] = await db
      .insert(outboundRequests)
      .values({
        requestNumber: '',
        storeId,
        orderSessionId: session.id,
        allocationRunId: run.id,
        status: 'reserved',
        requestedByUserId: fx.adminId,
        submittedAt: now,
        approvedAt: now,
      })
      .returning();
    const [outboundLine] = await db
      .insert(outboundRequestLines)
      .values({
        outboundRequestId: outbound.id,
        productId: fx.productId,
        allocationLineId: line.id,
        requestedQuantity: quantity,
        approvedQuantity: quantity,
        reservedQuantity: quantity,
      })
      .returning();
    await db
      .update(reservations)
      .set({ outboundRequestLineId: outboundLine.id })
      .where(eq(reservations.id, reservation.id));
    outboundId = outbound.id;
  }
  await db.update(allocationRuns).set({ status: 'completed' }).where(eq(allocationRuns.id, run.id));
  return { sessionId: session.id, decisionId: decisions[0].id, outboundId };
}

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
  if (!administrator || !group) {
    throw new Error('Reference seed and administrator bootstrap must run before this test.');
  }
  const [product] = await db
    .insert(products)
    .values({
      sku: `ADEC-${suffix.slice(0, 8)}`,
      slug: `adec-${suffix}`,
      name: 'Allocation decision product',
    })
    .returning({ id: products.id });
  await withSerializableTransaction(db, (tx) =>
    applyWarehouseMovement(tx, {
      productId: product.id,
      eventType: 'opening_balance',
      onHandDelta: 100,
      reservedDelta: 0,
      sourceType: 'api_decision_test',
      sourceId: randomUUID(),
    }),
  );
  const [storeA, storeB, wholesaleStore] = await db
    .insert(stores)
    .values(
      [
        ['A', 'retail'],
        ['B', 'retail'],
        ['W', 'wholesale'],
      ].map(([label, kind], index) => ({
        groupId: group.id,
        code: `ADEC_${suffix.slice(0, 8)}_${label}`,
        name: `Allocation decision ${label}`,
        kind,
        displayOrder: 21_000 + index,
      })),
    )
    .returning({ id: stores.id });
  const user = async (label, role, storeId) => {
    const [row] = await db
      .insert(users)
      .values({
        email: `adec.${label}.${suffix}@example.test`,
        passwordHash: `integration-hash-${suffix}`,
        displayName: `Allocation decision ${label}`,
        role,
        storeId,
      })
      .returning({ id: users.id, tokenVersion: users.tokenVersion });
    return row;
  };
  const storeUserA = await user('store-a', 'store', storeA.id);
  const storeUserB = await user('store-b', 'store', storeB.id);
  const htkdUser = await user('htkd', 'htkd', null);
  const wholesaleUser = await user('wholesale', 'wholesale', null);
  await db.insert(htkdAssignments).values([
    { userId: htkdUser.id, storeId: storeA.id, assignedByUserId: administrator.id },
    { userId: wholesaleUser.id, storeId: wholesaleStore.id, assignedByUserId: administrator.id },
  ]);
  const tokens = {
    admin: `adec-admin-${suffix}`,
    htkd: `adec-htkd-${suffix}`,
    storeA: `adec-store-a-${suffix}`,
    storeB: `adec-store-b-${suffix}`,
    wholesale: `adec-wholesale-${suffix}`,
  };
  const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
  await db.insert(sessions).values(
    [
      [administrator, tokens.admin],
      [htkdUser, tokens.htkd],
      [storeUserA, tokens.storeA],
      [storeUserB, tokens.storeB],
      [wholesaleUser, tokens.wholesale],
    ].map(([account, token]) => ({
      userId: account.id,
      tokenHash: hashSessionToken(token),
      userTokenVersion: account.tokenVersion,
      expiresAt,
    })),
  );
  return {
    adminId: administrator.id,
    productId: product.id,
    storeA: storeA.id,
    storeB: storeB.id,
    wholesaleStore: wholesaleStore.id,
    storeUserA: storeUserA.id,
    storeUserB: storeUserB.id,
    tokens,
  };
}
