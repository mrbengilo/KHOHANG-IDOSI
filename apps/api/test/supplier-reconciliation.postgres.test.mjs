import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

import {
  allocationLines,
  allocationResultDecisions,
  allocationRuns,
  applyWarehouseMovement,
  auditLogs,
  db,
  htkdAssignments,
  inventorySnapshots,
  mergedOrderItems,
  mergedOrders,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  orderSessions,
  products,
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

describePostgres('Reshare supplier reconciliation through the API on PostgreSQL', () => {
  test('lets Admin and every HTKD manage Reshare, refuses stores, replays exactly', async () => {
    const repository = new PostgresWarehouseRepository();
    const app = await createApi({ repository });
    try {
      const fx = await createFixture();
      const call = (token, method, url, payload, key) =>
        app.inject({
          method,
          url,
          headers: {
            cookie: `idosi_session=${token}`,
            ...(key ? { 'idempotency-key': key } : {}),
          },
          ...(payload === undefined ? {} : { payload }),
        });

      // Admin and any active HTKD (assigned or not) manage the module; stores never do.
      for (const token of [fx.tokens.storeA, fx.tokens.wholesale]) {
        assert.equal((await call(token, 'GET', '/api/v1/supplier-reconciliation')).statusCode, 403);
        assert.equal((await call(token, 'GET', '/api/v1/supplier-sources')).statusCode, 403);
        assert.equal(
          (
            await call(
              token,
              'POST',
              '/api/v1/supplier-sources',
              { code: `X${fx.token}`, name: 'x' },
              randomUUID(),
            )
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await call(
              token,
              'POST',
              '/api/v1/supplier-source-returns',
              {
                sourceId: randomUUID(),
                productId: fx.productId,
                quantity: 1,
                externalRef: `RET-${fx.token}`,
                occurredAt: new Date().toISOString(),
                note: 'không được phép',
              },
              randomUUID(),
            )
          ).statusCode,
          403,
        );
      }
      for (const token of [fx.tokens.htkd, fx.tokens.unassignedHtkd]) {
        assert.equal((await call(token, 'GET', '/api/v1/supplier-reconciliation')).statusCode, 200);
        assert.equal((await call(token, 'GET', '/api/v1/supplier-sources')).statusCode, 200);
        assert.equal(
          (await call(token, 'GET', '/api/v1/supplier-reconciliation/history')).statusCode,
          200,
        );
      }
      // An HTKD without any store assignment configures the source; the audit keeps its role.
      const created = await call(
        fx.tokens.unassignedHtkd,
        'POST',
        '/api/v1/supplier-sources',
        { code: `rs-${fx.token}`, name: 'Reshare API test' },
        randomUUID(),
      );
      assert.equal(created.statusCode, 201);
      const sourceId = created.json().data.id;
      const [sourceAudit] = await db
        .select({
          role: auditLogs.actorRole,
          actor: auditLogs.actorUserId,
          metadata: auditLogs.metadata,
        })
        .from(auditLogs)
        .where(
          and(eq(auditLogs.entityId, sourceId), eq(auditLogs.action, 'SUPPLIER_SOURCE_CREATED')),
        );
      assert.deepEqual(
        [sourceAudit.role, sourceAudit.actor, sourceAudit.metadata.actorName],
        ['htkd', fx.unassignedHtkdId, 'Supplier API htkd-none'],
      );
      const mapped = await call(
        fx.tokens.otherHtkd,
        'POST',
        `/api/v1/supplier-sources/${sourceId}/products`,
        { productIds: [fx.productId] },
        randomUUID(),
      );
      assert.equal(mapped.statusCode, 200);
      assert.deepEqual(mapped.json().data.added, [fx.productId]);

      // T28 legacy cumulative inbound and adjustments are refused with a clear code.
      const inbound = await call(
        fx.tokens.admin,
        'POST',
        '/api/v1/inbound-receipts',
        {
          supplierName: 'Reshare',
          receivedAt: new Date().toISOString(),
          bags: [{ productId: fx.productId, bagCode: `B-${randomUUID()}`, weightKg: null }],
        },
        randomUUID(),
      );
      assert.equal(inbound.statusCode, 409);
      assert.equal(inbound.json().error.code, 'SOURCE_RECONCILED');
      const adjustment = await call(
        fx.tokens.admin,
        'POST',
        '/api/v1/warehouse-adjustments',
        {
          productId: fx.productId,
          direction: 'INCREASE',
          quantity: 1,
          reasonCode: 'COUNT_CORRECTION',
          reason: 'thử tăng',
          expectedVersion: (await balance(fx.productId)).version,
        },
        randomUUID(),
      );
      assert.equal(adjustment.statusCode, 409);
      assert.equal(adjustment.json().error.code, 'SOURCE_RECONCILED');

      // Baseline: preview (read-only) then confirm; exact replay; changed payload conflicts.
      const observation = {
        sourceId,
        observedAt: new Date(Date.now() - 60_000).toISOString(),
        lines: [{ productId: fx.productId, observedQuantity: 3 }],
        attestUnlinkedAsNotOrdered: true,
      };
      const preview = await call(
        fx.tokens.unassignedHtkd,
        'POST',
        '/api/v1/supplier-stock-observations/preview',
        observation,
      );
      assert.equal(preview.statusCode, 200);
      assert.equal(preview.json().data.lines[0].after.freeQuantity, 3);
      assert.equal((await balance(fx.productId)).onHand, 5, 'preview writes nothing');
      const key = randomUUID();
      const body = { ...observation, expectedRevision: preview.json().data.revision };
      const confirmed = await call(
        fx.tokens.unassignedHtkd,
        'POST',
        '/api/v1/supplier-stock-observations',
        body,
        key,
      );
      assert.equal(confirmed.statusCode, 201);
      assert.equal(confirmed.json().data.lines[0].onHandAfter, 3);
      assert.equal(confirmed.json().data.createdBy.accountId, fx.unassignedHtkdId);
      const replay = await call(
        fx.tokens.unassignedHtkd,
        'POST',
        '/api/v1/supplier-stock-observations',
        body,
        key,
      );
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.headers['idempotency-replayed'], 'true');
      assert.equal(replay.json().data.id, confirmed.json().data.id);
      const changed = await call(
        fx.tokens.unassignedHtkd,
        'POST',
        '/api/v1/supplier-stock-observations',
        { ...body, lines: [{ productId: fx.productId, observedQuantity: 4 }] },
        key,
      );
      assert.equal(changed.statusCode, 409);
      assert.equal(changed.json().error.code, 'IDEMPOTENCY_CONFLICT');
      const stale = await call(
        fx.tokens.admin,
        'POST',
        '/api/v1/supplier-stock-observations',
        { ...body, observedAt: new Date().toISOString() },
        randomUUID(),
      );
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().error.code, 'VERSION_CONFLICT');
      assert.deepEqual(await stock(fx.productId), { onHand: 3, reserved: 0 });

      // A store accepted a grant of 2; every HTKD sees it (all stores), stores only their own.
      const granted = await grant(fx, 2);
      for (const token of [fx.tokens.htkd, fx.tokens.otherHtkd, fx.tokens.unassignedHtkd]) {
        const orderable = await call(
          token,
          'GET',
          `/api/v1/supplier-commitments?filter=ORDERABLE&productId=${fx.productId}`,
        );
        assert.equal(orderable.statusCode, 200);
        assert.equal(orderable.json().scoped, false);
        assert.deepEqual(
          orderable.json().data.map((row) => [row.id, row.unorderedQuantity]),
          [[granted.reservationId, 2]],
        );
        assert.ok(orderable.json().data[0].htkdNames.length >= 1);
        assert.equal(
          (await call(token, 'GET', `/api/v1/supplier-commitments?storeId=${fx.storeA}`))
            .statusCode,
          200,
        );
      }
      assert.equal(
        (await call(fx.tokens.storeA, 'GET', `/api/v1/supplier-commitments?storeId=${fx.storeB}`))
          .statusCode,
        403,
      );
      const wholesaleView = await call(
        fx.tokens.wholesale,
        'GET',
        `/api/v1/supplier-commitments?productId=${fx.productId}`,
      );
      assert.equal(wholesaleView.json().data.length, 0);
      assert.equal(wholesaleView.json().scoped, true);
      const storeView = await call(
        fx.tokens.storeA,
        'GET',
        `/api/v1/supplier-commitments?productId=${fx.productId}`,
      );
      assert.equal(storeView.json().data.length, 1);
      const adminView = await call(
        fx.tokens.admin,
        'GET',
        `/api/v1/supplier-commitments?productId=${fx.productId}`,
      );
      assert.equal(adminView.json().scoped, false);
      assert.ok(adminView.json().data[0].htkdNames.length >= 1);

      const orderBody = {
        sourceId,
        externalRef: `RS-${fx.token}`,
        occurredAt: new Date().toISOString(),
        lines: [{ reservationId: granted.reservationId, quantity: 2, externalLineRef: 'L1' }],
      };
      for (const token of [fx.tokens.storeA, fx.tokens.wholesale]) {
        assert.equal(
          (await call(token, 'POST', '/api/v1/supplier-orders', orderBody, randomUUID()))
            .statusCode,
          403,
        );
      }
      // The HTKD of another store records it: Reshare is not narrowed by assignments.
      const orderKey = randomUUID();
      const recorded = await call(
        fx.tokens.otherHtkd,
        'POST',
        '/api/v1/supplier-orders',
        orderBody,
        orderKey,
      );
      assert.equal(recorded.statusCode, 201);
      assert.equal(recorded.json().data.createdBy.accountId, fx.otherHtkdId);
      assert.equal(recorded.json().data.events[0].quantity, 2);
      const duplicate = await call(
        fx.tokens.admin,
        'POST',
        '/api/v1/supplier-orders',
        orderBody,
        randomUUID(),
      );
      assert.equal(duplicate.statusCode, 409);
      assert.ok(
        ['DUPLICATE_EXTERNAL_EVENT', 'QUANTITY_EXCEEDED'].includes(duplicate.json().error.code),
      );
      // F did not move when B recorded the order; reserved stays held for receipt.
      assert.deepEqual(await stock(fx.productId), { onHand: 3, reserved: 2 });

      const summary = await call(
        fx.tokens.admin,
        'GET',
        `/api/v1/supplier-reconciliation?sourceId=${sourceId}`,
      );
      assert.equal(summary.statusCode, 200);
      assert.equal(summary.headers['cache-control'], 'no-store');
      assert.deepEqual(
        summary
          .json()
          .data.map((row) => [
            row.productId,
            row.position.freeQuantity,
            row.position.unorderedCommitmentQuantity,
            row.position.orderedReservedQuantity,
            row.position.state,
          ]),
        [[fx.productId, 1, 0, 2, 'RECONCILED']],
      );
      const orders = await call(fx.tokens.storeA, 'GET', '/api/v1/supplier-orders');
      assert.equal(orders.json().data.length, 1);
      const htkdOrders = await call(
        fx.tokens.htkd,
        'GET',
        `/api/v1/supplier-orders?productId=${fx.productId}`,
      );
      assert.equal(htkdOrders.json().data.length, 1);
      assert.equal(
        (await call(fx.tokens.wholesale, 'GET', '/api/v1/supplier-orders')).json().data.length,
        0,
      );

      // Removing a store assignment revokes the HTKD's sessions (existing policy), but after
      // signing in again the module-wide Reshare right of an active HTKD remains.
      await db
        .update(htkdAssignments)
        .set({ revokedAt: new Date() })
        .where(and(eq(htkdAssignments.userId, fx.otherHtkdId), isNull(htkdAssignments.revokedAt)));
      const freshToken = await signIn(fx.otherHtkdId);
      const unassignedReplay = await call(
        freshToken,
        'POST',
        '/api/v1/supplier-orders',
        orderBody,
        orderKey,
      );
      assert.equal(unassignedReplay.statusCode, 200);
      assert.equal(unassignedReplay.headers['idempotency-replayed'], 'true');

      // A role change or a lock ends it at once, replays included.
      await db
        .update(users)
        .set({ role: 'store', storeId: fx.storeB })
        .where(eq(users.id, fx.otherHtkdId));
      const demotedReplay = await call(
        freshToken,
        'POST',
        '/api/v1/supplier-orders',
        orderBody,
        orderKey,
      );
      assert.ok([401, 403].includes(demotedReplay.statusCode));
      await db.update(users).set({ status: 'locked' }).where(eq(users.id, fx.unassignedHtkdId));
      const lockedReplay = await call(
        fx.tokens.unassignedHtkd,
        'POST',
        '/api/v1/supplier-stock-observations',
        body,
        key,
      );
      assert.ok([401, 403].includes(lockedReplay.statusCode));

      const specification = await app.inject({ method: 'GET', url: '/openapi.json' });
      for (const path of [
        '/api/v1/supplier-reconciliation',
        '/api/v1/supplier-commitments',
        '/api/v1/supplier-stock-observations/preview',
        '/api/v1/supplier-stock-observations',
        '/api/v1/supplier-orders',
        '/api/v1/supplier-orders/{eventId}/cancellations',
        '/api/v1/supplier-reconciliation/history',
        '/api/v1/supplier-source-returns',
      ]) {
        assert.ok(specification.json().paths[path], `${path} is documented`);
      }
    } finally {
      await app.close();
    }
  });
});

async function signIn(userId) {
  const [account] = await db
    .select({ tokenVersion: users.tokenVersion })
    .from(users)
    .where(eq(users.id, userId));
  const token = randomUUID();
  await db.insert(sessions).values({
    userId,
    tokenHash: hashSessionToken(token),
    userTokenVersion: account.tokenVersion,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return token;
}

async function balance(productId) {
  const [row] = await db
    .select()
    .from(warehouseBalances)
    .where(eq(warehouseBalances.productId, productId));
  return {
    onHand: row?.onHandQuantity ?? 0,
    reserved: row?.reservedQuantity ?? 0,
    version: row?.version ?? 0,
  };
}

async function stock(productId) {
  const { onHand, reserved } = await balance(productId);
  return { onHand, reserved };
}

async function grant(fx, quantity) {
  const date = '2026-10-12';
  const [session] = await db
    .insert(orderSessions)
    .values({
      code: `SUPAPI-${randomUUID()}`,
      kind: 'manual',
      businessDate: date,
      status: 'completed',
      inventorySnapshotDueAt: new Date(`${date}T08:00:00+07:00`),
      requestDeadlineAt: new Date(`${date}T09:00:00+07:00`),
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
      createdByUserId: fx.adminId,
      deletedAt: new Date(),
    })
    .returning();
  const [snapshot] = await db
    .insert(inventorySnapshots)
    .values({
      orderSessionId: session.id,
      businessDate: date,
      snapshotType: 'manual',
      status: 'completed',
      capturedAt: new Date(),
      completedAt: new Date(),
      balanceVersion: 0,
    })
    .returning();
  const [run] = await db
    .insert(allocationRuns)
    .values({
      orderSessionId: session.id,
      inventorySnapshotId: snapshot.id,
      runNumber: 1,
      status: 'completed',
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
      idempotencyKey: randomUUID(),
    })
    .returning();
  const [order] = await db
    .insert(orderRequests)
    .values({
      orderSessionId: session.id,
      storeId: fx.storeA,
      requestNumber: 1,
      status: 'allocated',
      submittedAt: new Date(),
      requestedByUserId: fx.adminId,
    })
    .returning();
  const [item] = await db
    .insert(orderRequestItems)
    .values({ orderRequestId: order.id, productId: fx.productId, requestedQuantity: quantity })
    .returning();
  const [merged] = await db
    .insert(mergedOrders)
    .values({
      orderSessionId: session.id,
      storeId: fx.storeA,
      status: 'allocated',
      requestCount: 1,
    })
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
      storeId: fx.storeA,
      productId: fx.productId,
      orderRequestItemId: item.id,
      priorityLevel: 'P1',
      roundNumber: 1,
      sequenceInRound: 1,
      requestedQuantity: quantity,
      allocatedQuantity: quantity,
      status: 'allocated',
      reasonCode: 'SUPPLIER_API_TEST',
    })
    .returning();
  const [reservation] = await db
    .insert(reservations)
    .values({
      productId: fx.productId,
      storeId: fx.storeA,
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
  await db.insert(allocationResultDecisions).values({
    allocationRunId: run.id,
    orderSessionId: session.id,
    storeId: fx.storeA,
    status: 'accepted',
    grantedQuantity: quantity,
    respondedAt: new Date(),
    respondedByUserId: fx.storeUserA,
  });
  return { reservationId: reservation.id };
}

async function createFixture() {
  const token = randomUUID().replaceAll('-', '').slice(0, 16);
  const [administrator] = await db
    .select({ id: users.id, tokenVersion: users.tokenVersion, passwordHash: users.passwordHash })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active'), isNull(users.deletedAt)))
    .limit(1);
  if (!administrator) throw new Error('Bootstrap administrator required.');
  const [group] = await db
    .insert(storeGroups)
    .values({ code: `SUPAPI-${token}`, name: `Supplier API ${token.slice(0, 6)}` })
    .returning();
  const [storeA] = await db
    .insert(stores)
    .values({ code: `SUPAPI-A-${token}`, name: 'Supplier API A', groupId: group.id })
    .returning();
  const [storeB] = await db
    .insert(stores)
    .values({ code: `SUPAPI-B-${token}`, name: 'Supplier API B', groupId: group.id })
    .returning();
  const createUser = async (suffix, role, storeId = null) => {
    const [user] = await db
      .insert(users)
      .values({
        email: `supapi-${suffix}-${token}@example.test`,
        passwordHash: administrator.passwordHash,
        displayName: `Supplier API ${suffix}`,
        role,
        storeId,
      })
      .returning({ id: users.id, tokenVersion: users.tokenVersion });
    return user;
  };
  const htkd = await createUser('htkd', 'htkd');
  const otherHtkd = await createUser('htkd-other', 'htkd');
  const unassignedHtkd = await createUser('htkd-none', 'htkd');
  const storeUserA = await createUser('store-a', 'store', storeA.id);
  const wholesale = await createUser('wholesale', 'wholesale');
  await db.insert(htkdAssignments).values([
    { userId: htkd.id, storeId: storeA.id, assignedByUserId: administrator.id },
    { userId: otherHtkd.id, storeId: storeB.id, assignedByUserId: administrator.id },
  ]);
  const [product] = await db
    .insert(products)
    .values({
      sku: `SUPAPI-${token}`,
      slug: `supapi-${token}`,
      name: `Reshare API ${token.slice(0, 6)}`,
    })
    .returning();
  await withSerializableTransaction(db, (tx) =>
    applyWarehouseMovement(tx, {
      productId: product.id,
      eventType: 'opening_balance',
      onHandDelta: 5,
      reservedDelta: 0,
      sourceType: 'supplier_api_opening',
      sourceId: randomUUID(),
    }),
  );
  const tokens = {
    admin: randomUUID(),
    htkd: randomUUID(),
    otherHtkd: randomUUID(),
    unassignedHtkd: randomUUID(),
    storeA: randomUUID(),
    wholesale: randomUUID(),
  };
  const expiresAt = new Date(Date.now() + 3_600_000);
  await db.insert(sessions).values(
    [
      [administrator, tokens.admin],
      [htkd, tokens.htkd],
      [otherHtkd, tokens.otherHtkd],
      [unassignedHtkd, tokens.unassignedHtkd],
      [storeUserA, tokens.storeA],
      [wholesale, tokens.wholesale],
    ].map(([account, sessionToken]) => ({
      userId: account.id,
      tokenHash: hashSessionToken(sessionToken),
      userTokenVersion: account.tokenVersion,
      expiresAt,
    })),
  );
  return {
    token,
    adminId: administrator.id,
    htkdId: htkd.id,
    otherHtkdId: otherHtkd.id,
    unassignedHtkdId: unassignedHtkd.id,
    storeUserA: storeUserA.id,
    storeA: storeA.id,
    storeB: storeB.id,
    productId: product.id,
    tokens,
  };
}
