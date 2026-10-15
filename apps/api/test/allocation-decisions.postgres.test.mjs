import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { ListOrderSessionsResponseSchema } from '@idosi/contracts';

import {
  allocationLines,
  allocationRuns,
  applyWarehouseMovement,
  db,
  closeDatabase,
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
after(async () => {
  if (process.env.RUN_POSTGRES_TESTS === '1') await closeDatabase();
});

function sharedRepository() {
  const repository = new PostgresWarehouseRepository();
  // Both API scenarios share this process's pool; release it once after the suite.
  repository.close = async () => {};
  return repository;
}

describePostgres('allocation result decisions through the API on PostgreSQL', () => {
  test('scopes reads, answers once per result and gates shipping server-side', async () => {
    const repository = sharedRepository();
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
          url: `/api/v1/allocation-decisions/${decisionId}/respond?includeWaitlist=true`,
          headers: { cookie: `idosi_session=${token}`, 'idempotency-key': key },
          payload,
        });

      // CI runs browser workflows against accumulated API fixtures. Keep every
      // published session valid for the same list contract used by the dashboard.
      let sessionPage = 1;
      let sessionPages = 1;
      do {
        const response = await get(
          fx.tokens.admin,
          `/api/v1/order-sessions?pageSize=100&page=${sessionPage}`,
        );
        assert.equal(response.statusCode, 200);
        const parsed = ListOrderSessionsResponseSchema.parse(response.json());
        sessionPages = parsed.pagination.totalPages;
        sessionPage++;
      } while (sessionPage <= sessionPages);

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
      // The assigned HTKD may accept for the store (never reject): canRespond is true and,
      // when asked, the allowed actions say exactly that.
      assert.deepEqual(
        htkdList.json().data.map((row) => [row.id, row.canRespond]),
        [[resultA.decisionId, true]],
      );
      assert.equal('allowedActions' in htkdList.json().data[0], false);
      const htkdListV2 = await get(
        fx.tokens.htkd,
        '/api/v1/allocation-decisions?includeReshare=true',
      );
      assert.deepEqual(htkdListV2.json().data[0].allowedActions, ['ACCEPT']);
      assert.equal(htkdListV2.json().data[0].reshareOrder, null);
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

      // The receiving side and an assigned HTKD answer (both actions); nobody outside scope.
      assert.equal((await respond(fx.tokens.admin, resultA.decisionId, accept())).statusCode, 403);
      assert.deepEqual(
        (
          await get(
            fx.tokens.htkd,
            `/api/v1/allocation-decisions/${resultA.decisionId}?includeReshare=true&includeWaitlist=true`,
          )
        ).json().data.allowedActions,
        ['ACCEPT', 'WAITLIST'],
      );
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
      // Acceptance creates the RE order and issues the 3 bags at once (on-hand and reserved
      // drop together); it is not a receipt, so the store's stock is untouched.
      assert.deepEqual(await balance(fx.productId), { onHand: 97, reserved: 3 });
      const acceptedV2 = await get(
        fx.tokens.storeA,
        `/api/v1/allocation-decisions/${resultA.decisionId}?includeReshare=true`,
      );
      assert.match(acceptedV2.json().data.reshareOrder.code, /^RE-\d{6}$/u);
      assert.equal(acceptedV2.json().data.reshareOrder.totalQuantity, 3);
      assert.deepEqual(acceptedV2.json().data.allowedActions, []);
      const history = await get(
        fx.tokens.storeA,
        `/api/v1/reshare-orders?decisionId=${resultA.decisionId}`,
      );
      assert.equal(history.statusCode, 200);
      assert.equal(history.json().scoped, true);
      assert.deepEqual(
        history.json().data.map((row) => [row.status, row.order.code, row.totalQuantity]),
        [['ORDERED', acceptedV2.json().data.reshareOrder.code, 3]],
      );
      // Server scope: another store and an unassigned query never see it.
      assert.deepEqual(
        (
          await get(fx.tokens.storeB, `/api/v1/reshare-orders?decisionId=${resultA.decisionId}`)
        ).json().data,
        [],
      );
      assert.equal(
        (await get(fx.tokens.storeB, `/api/v1/reshare-orders?storeId=${fx.storeA}`)).statusCode,
        403,
      );
      assert.equal(
        (
          await get(fx.tokens.htkd, `/api/v1/reshare-orders?decisionId=${resultA.decisionId}`)
        ).json().data.length,
        1,
      );
      const adminHistory = await get(
        fx.tokens.admin,
        `/api/v1/reshare-orders?decisionId=${resultA.decisionId}`,
      );
      assert.equal(adminHistory.json().scoped, false);
      assert.equal(adminHistory.json().data.length, 1);
      assert.equal(await receiptSourceCount(app, fx.tokens.storeA), 1);
      const linked = await get(
        fx.tokens.storeA,
        `/api/v1/allocation-decisions?outboundRequestId=${resultA.outboundId}`,
      );
      assert.deepEqual(
        linked.json().data.map((row) => row.id),
        [resultA.decisionId],
      );
      const foreignLink = await get(
        fx.tokens.storeB,
        `/api/v1/allocation-decisions?outboundRequestId=${resultA.outboundId}`,
      );
      assert.deepEqual(foreignLink.json().data, []);

      const replay = await respond(fx.tokens.storeA, resultA.decisionId, accept(), key);
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.headers['idempotency-replayed'], 'true');
      assert.equal(replay.json().data.status, 'ACCEPTED');
      const reused = await respond(fx.tokens.storeA, resultA.decisionId, waitlist(), key);
      assert.equal(reused.statusCode, 409);
      assert.equal(reused.json().error.code, 'IDEMPOTENCY_CONFLICT');
      const flip = await respond(fx.tokens.storeA, resultA.decisionId, waitlist(2));
      assert.equal(flip.statusCode, 409);
      assert.equal(flip.json().error.code, 'INVALID_STATE_TRANSITION');
      assert.equal(flip.json().error.details.currentStatus, 'ACCEPTED');
      // The retired rejection is a structured refusal, never an alias of the move to waiting.
      const retired = await respond(fx.tokens.wholesale, resultW.decisionId, {
        action: 'REJECT',
        expectedVersion: 1,
      });
      assert.equal(retired.statusCode, 409);
      assert.equal(retired.json().error.code, 'ALLOCATION_DECISION_ACTION_RETIRED');
      // A bundle without the 0044 opt-in cannot move a result to waiting.
      const oldBundle = await app.inject({
        method: 'POST',
        url: `/api/v1/allocation-decisions/${resultW.decisionId}/respond`,
        headers: {
          cookie: `idosi_session=${fx.tokens.wholesale}`,
          'idempotency-key': randomUUID(),
        },
        payload: waitlist(),
      });
      assert.equal(oldBundle.statusCode, 409);
      assert.equal(oldBundle.json().error.code, 'CLIENT_UPGRADE_REQUIRED');

      // The wholesale desk answers for wholesale stores; the move to waiting releases the goods
      // and the 2 bags wait again on a ticket.
      const moved = await respond(fx.tokens.wholesale, resultW.decisionId, waitlist());
      assert.equal(moved.statusCode, 200);
      assert.equal(moved.json().data.status, 'WAITLISTED');
      assert.equal(moved.json().data.reason, null);
      assert.equal(moved.json().data.releasedQuantity, 2);
      assert.deepEqual(
        moved.json().data.requeued.map((row) => [row.quantity, row.mode]),
        [[2, 'ADD_DEMAND']],
      );
      assert.deepEqual(await balance(fx.productId), { onHand: 97, reserved: 1 });
      // Older bundles read the new terminal status as the closest one they know.
      const oldView = await get(
        fx.tokens.wholesale,
        `/api/v1/allocation-decisions/${resultW.decisionId}?includeReshare=true`,
      );
      assert.equal(oldView.json().data.status, 'REJECTED');
      assert.equal('requeued' in oldView.json().data, false);
      // ...and its REJECTED filter finds that same row; an opted-in client filters exactly.
      const listIds = async (query) =>
        (
          await get(
            fx.tokens.wholesale,
            `/api/v1/allocation-decisions?sessionId=${resultW.sessionId}&${query}`,
          )
        )
          .json()
          .data.map((row) => row.id);
      assert.deepEqual(await listIds('status=REJECTED'), [resultW.decisionId]);
      assert.deepEqual(await listIds('status=REJECTED&includeWaitlist=true'), []);
      assert.deepEqual(await listIds('status=WAITLISTED&includeWaitlist=true'), [
        resultW.decisionId,
      ]);
      const rejectedDocuments = await get(
        fx.tokens.wholesale,
        `/api/v1/session-documents?sessionId=${resultW.sessionId}&includeDecision=true&decisionStatus=REJECTED`,
      );
      assert.equal(rejectedDocuments.json().data[0].decision.status, 'REJECTED');
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
      assert.equal('waitDocuments' in legacyShape.json().data[0], false);
      // Wait documents around the run are opt-in too, and pass the strict response schema.
      const withWait = await get(
        fx.tokens.storeA,
        `/api/v1/session-documents?sessionId=${resultA.sessionId}&includeDecision=true&includeWaitDocuments=true`,
      );
      assert.equal(withWait.statusCode, 200, withWait.body);
      const waitDocuments = withWait.json().data[0].waitDocuments;
      assert.equal(typeof waitDocuments.changed, 'boolean');
      assert.ok('before' in waitDocuments && 'after' in waitDocuments);

      // Locking the account takes effect at once, even for a retry of its own key.
      const keyB = randomUUID();
      await db.update(users).set({ status: 'locked' }).where(eq(users.id, fx.storeUserB));
      const locked = await respond(fx.tokens.storeB, resultB.decisionId, accept(), keyB);
      assert.ok([401, 403].includes(locked.statusCode));
      assert.deepEqual(await balance(fx.productId), { onHand: 97, reserved: 1 });
    } finally {
      await app.close();
    }
  });
});

function accept(expectedVersion = 1) {
  return { action: 'ACCEPT', expectedVersion };
}

describePostgres('Reshare acknowledgement API and status history', () => {
  test('lets Admin and any HTKD change status, records real actors and serves the history', async () => {
    const app = await createApi({ repository: sharedRepository() });
    try {
      const fx = await createFixture();
      // Store B is outside the HTKD's assignments: the Reshare module ignores them.
      const result = await publishResult(fx, fx.storeB, 3, { shipment: true });
      const url = `/api/v1/reshare-orders/${result.decisionId}/status`;
      const input = { status: 'ORDERED', expectedStatus: 'NOT_ORDERED', expectedVersion: 0 };
      const key = randomUUID();
      const put = (token, payload = input, idempotencyKey = key) =>
        app.inject({
          method: 'PUT',
          url,
          headers: { cookie: `idosi_session=${token}`, 'idempotency-key': idempotencyKey },
          payload,
        });
      const get = (token, path) =>
        app.inject({ method: 'GET', url: path, headers: { cookie: `idosi_session=${token}` } });
      const historyUrl = `/api/v1/reshare-orders/${result.decisionId}/status-history`;
      for (const token of [fx.tokens.storeA, fx.tokens.storeB, fx.tokens.wholesale])
        assert.equal((await put(token)).statusCode, 403);
      assert.equal((await get(fx.tokens.admin, historyUrl)).json().pagination.totalItems, 0);
      const before = await balance(fx.productId);
      const saved = await put(fx.tokens.htkd);
      assert.equal(saved.statusCode, 200, saved.body);
      assert.deepEqual(saved.json().data, {
        decisionId: result.decisionId,
        status: 'ORDERED',
        version: 1,
      });
      assert.equal((await put(fx.tokens.htkd)).headers['idempotency-replayed'], 'true');
      assert.equal(
        (await put(fx.tokens.htkd, { ...input, status: 'NOT_ORDERED' })).statusCode,
        409,
      );
      assert.equal((await put(fx.tokens.admin, input, randomUUID())).statusCode, 409);
      assert.equal(
        (await put(fx.tokens.admin, { ...input, status: 'CANCELLED' }, randomUUID())).statusCode,
        400,
      );
      // Asking for the current status changes nothing: same version, no X → X history event.
      const unchanged = await put(
        fx.tokens.admin,
        { status: 'ORDERED', expectedStatus: 'ORDERED', expectedVersion: 1 },
        randomUUID(),
      );
      assert.equal(unchanged.statusCode, 200, unchanged.body);
      assert.equal(unchanged.json().data.version, 1);
      assert.equal((await get(fx.tokens.admin, historyUrl)).json().pagination.totalItems, 1);

      const list = (token, suffix = '') =>
        get(token, `/api/v1/reshare-orders?decisionId=${result.decisionId}${suffix}`);
      const read = await list(
        fx.tokens.storeB,
        '&includeStatusControl=true&includeStatusActor=true&status=ORDERED',
      );
      assert.equal(read.statusCode, 200, read.body);
      assert.deepEqual(read.json().data[0].statusControl, {
        version: 1,
        updatedAt: read.json().data[0].statusControl.updatedAt,
        updatedByName: 'Allocation decision htkd',
        updatedByRole: 'HTKD',
      });
      assert.equal(read.json().data[0].decisionStatus, 'PENDING');
      assert.equal(read.json().data[0].order, null);
      // Older bundles that do not ask for the actor keep the strict shape they validate.
      assert.equal(
        'updatedByRole' in
          (await list(fx.tokens.admin, '&includeStatusControl=true')).json().data[0].statusControl,
        false,
      );
      assert.equal(
        (await list(fx.tokens.admin, '&status=NOT_ORDERED')).json().pagination.totalItems,
        0,
      );
      assert.equal('statusControl' in (await list(fx.tokens.admin)).json().data[0], false);
      assert.equal((await list(fx.tokens.storeA)).json().pagination.totalItems, 0);
      const htkdList = await list(fx.tokens.htkd, `&storeId=${fx.storeB}`);
      assert.equal(htkdList.statusCode, 200);
      assert.equal(htkdList.json().pagination.totalItems, 1);
      assert.equal(htkdList.json().scoped, false);
      assert.equal(
        (await list(fx.tokens.storeA, `&storeId=${fx.storeB}`)).statusCode,
        403,
        'stores stay in their own scope',
      );

      // Two managers on the same version: exactly one transition, the other a conflict.
      const racers = await Promise.all([
        put(
          fx.tokens.admin,
          { status: 'NOT_ORDERED', expectedStatus: 'ORDERED', expectedVersion: 1 },
          randomUUID(),
        ),
        put(
          fx.tokens.unassignedHtkd,
          { status: 'NOT_ORDERED', expectedStatus: 'ORDERED', expectedVersion: 1 },
          randomUUID(),
        ),
      ]);
      assert.deepEqual(racers.map((response) => response.statusCode).sort(), [200, 409]);
      const winner = racers.find((response) => response.statusCode === 200);
      assert.equal(winner.json().data.version, 2);
      const winnerIsAdmin = racers[0].statusCode === 200;
      assert.equal(
        (await list(fx.tokens.admin, '&status=NOT_ORDERED')).json().pagination.totalItems,
        1,
      );

      // A later rename does not rewrite the name recorded with the HTKD's event.
      await db
        .update(users)
        .set({ displayName: 'Tên mới của HTKD' })
        .where(eq(users.id, fx.htkdId));
      const history = await get(fx.tokens.admin, historyUrl);
      assert.equal(history.statusCode, 200, history.body);
      assert.equal(history.headers['cache-control'], 'no-store');
      assert.equal(history.json().pagination.totalItems, 2);
      assert.deepEqual(
        history
          .json()
          .data.map((event) => [
            event.kind,
            event.source,
            event.statusBefore,
            event.statusAfter,
            event.version,
            event.actor.role,
            event.actor.nameAtEvent,
            event.actor.currentName,
          ]),
        [
          [
            'STATUS_CHANGED',
            'MANUAL',
            'ORDERED',
            'NOT_ORDERED',
            2,
            winnerIsAdmin ? 'ADMIN' : 'HTKD',
            winnerIsAdmin ? fx.adminName : 'Allocation decision htkd-none',
            null,
          ],
          [
            'STATUS_CHANGED',
            'MANUAL',
            'NOT_ORDERED',
            'ORDERED',
            1,
            'HTKD',
            'Allocation decision htkd',
            null,
          ],
        ],
      );
      assert.equal(history.json().data[1].actor.accountId, fx.htkdId);
      // Stable server paging: page 2 of size 1 is the older event, no duplicates.
      const second = await get(fx.tokens.htkd, `${historyUrl}?page=2&pageSize=1`);
      assert.equal(second.json().data.length, 1);
      assert.equal(second.json().data[0].id, history.json().data[1].id);
      assert.equal(second.json().pagination.totalPages, 2);
      // The receiving store reads its own result's history; other stores get 404 (no leak).
      assert.equal((await get(fx.tokens.storeB, historyUrl)).statusCode, 200);
      for (const token of [fx.tokens.storeA, fx.tokens.wholesale])
        assert.equal((await get(token, historyUrl)).statusCode, 404);
      assert.equal(
        (await get(fx.tokens.admin, `/api/v1/reshare-orders/${randomUUID()}/status-history`))
          .statusCode,
        404,
      );
      assert.equal((await get(fx.tokens.admin, `${historyUrl}?pageSize=101`)).statusCode, 400);

      // Other modules keep the assignment scope: the HTKD may not answer for store B (the
      // result is outside its allocation scope, so it is not even found there).
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/allocation-decisions/${result.decisionId}/respond`,
            headers: { cookie: `idosi_session=${fx.tokens.htkd}`, 'idempotency-key': randomUUID() },
            payload: accept(),
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (await get(fx.tokens.htkd, `/api/v1/allocation-decisions?storeId=${fx.storeB}`)).statusCode,
        403,
      );

      // Acceptance creates the RE order: a "created" event by the real store account.
      const accepted = await app.inject({
        method: 'POST',
        url: `/api/v1/allocation-decisions/${result.decisionId}/respond`,
        headers: { cookie: `idosi_session=${fx.tokens.storeB}`, 'idempotency-key': randomUUID() },
        payload: accept(),
      });
      assert.equal(accepted.statusCode, 200, accepted.body);
      const afterAcceptance = (await get(fx.tokens.admin, historyUrl)).json();
      assert.equal(afterAcceptance.pagination.totalItems, 3);
      const created = afterAcceptance.data[0];
      assert.equal(created.kind, 'CREATED');
      assert.equal(created.source, 'ACCEPTANCE');
      assert.match(created.orderCode, /^RE-\d{6}$/u);
      assert.equal(created.actor.accountId, fx.storeUserB);
      assert.equal(created.actor.role, 'STORE');
      assert.equal(created.actor.nameAtEvent, 'Allocation decision store-b');
      // The stored acknowledgement (not ordered) still wins over the new RE document.
      assert.equal(created.statusBefore, 'NOT_ORDERED');
      assert.equal(created.statusAfter, 'NOT_ORDERED');
      assert.deepEqual(
        (await balance(fx.productId)).reserved,
        before.reserved - 3,
        'only the acceptance moved stock; status changes never did',
      );

      // The Reshare store filter: every store for HTKD, own store for a store account.
      const htkdStores = await get(fx.tokens.htkd, '/api/v1/reshare-orders/stores');
      assert.equal(htkdStores.statusCode, 200);
      assert.equal(htkdStores.json().scoped, false);
      const ids = htkdStores.json().data.map((store) => store.id);
      for (const id of [fx.storeA, fx.storeB, fx.wholesaleStore]) assert.ok(ids.includes(id));
      assert.deepEqual((await get(fx.tokens.storeA, '/api/v1/reshare-orders/stores')).json(), {
        data: [
          { id: fx.storeA, code: fx.storeACode, name: 'Allocation decision A', isActive: true },
        ],
        scoped: true,
      });

      // A locked HTKD is refused at once (session check), and so is a demoted one.
      await db.update(users).set({ status: 'locked' }).where(eq(users.id, fx.unassignedHtkdId));
      assert.ok(
        [401, 403].includes(
          (
            await put(
              fx.tokens.unassignedHtkd,
              { status: 'ORDERED', expectedStatus: 'NOT_ORDERED', expectedVersion: 2 },
              randomUUID(),
            )
          ).statusCode,
        ),
      );
      await db.update(users).set({ role: 'wholesale' }).where(eq(users.id, fx.htkdId));
      assert.ok(
        [401, 403].includes(
          (
            await put(
              fx.tokens.htkd,
              { status: 'ORDERED', expectedStatus: 'NOT_ORDERED', expectedVersion: 2 },
              randomUUID(),
            )
          ).statusCode,
        ),
      );
      assert.equal((await get(fx.tokens.admin, historyUrl)).json().pagination.totalItems, 3);
    } finally {
      await app.close();
    }
  });
});
function waitlist(expectedVersion = 1) {
  return { action: 'WAITLIST', expectedVersion };
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
      openedAt: new Date('2000-01-03T00:00:00+07:00'),
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
    .select({ id: users.id, tokenVersion: users.tokenVersion, displayName: users.displayName })
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
  const unassignedHtkd = await user('htkd-none', 'htkd', null);
  const wholesaleUser = await user('wholesale', 'wholesale', null);
  await db.insert(htkdAssignments).values([
    { userId: htkdUser.id, storeId: storeA.id, assignedByUserId: administrator.id },
    { userId: wholesaleUser.id, storeId: wholesaleStore.id, assignedByUserId: administrator.id },
  ]);
  const tokens = {
    admin: `adec-admin-${suffix}`,
    htkd: `adec-htkd-${suffix}`,
    unassignedHtkd: `adec-htkd-none-${suffix}`,
    storeA: `adec-store-a-${suffix}`,
    storeB: `adec-store-b-${suffix}`,
    wholesale: `adec-wholesale-${suffix}`,
  };
  const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
  await db.insert(sessions).values(
    [
      [administrator, tokens.admin],
      [htkdUser, tokens.htkd],
      [unassignedHtkd, tokens.unassignedHtkd],
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
    adminName: administrator.displayName,
    productId: product.id,
    storeA: storeA.id,
    storeB: storeB.id,
    wholesaleStore: wholesaleStore.id,
    storeACode: `ADEC_${suffix.slice(0, 8)}_A`,
    htkdId: htkdUser.id,
    unassignedHtkdId: unassignedHtkd.id,
    storeUserA: storeUserA.id,
    storeUserB: storeUserB.id,
    tokens,
  };
}
