import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import {
  ListStoreWaitDocumentsResponseSchema,
  StoreWaitDocumentCancelPreviewResponseSchema,
  StoreWaitDocumentDetailResponseSchema,
} from '@idosi/contracts';
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
  syncAllStoreWaitDocuments,
  users,
  waitTickets,
} from '@idosi/database';
import { and, eq, isNull } from 'drizzle-orm';

import { createApi } from '../dist/app.js';
import { PostgresWarehouseRepository } from '../dist/postgres-repository.js';
import { hashSessionToken } from '../dist/security.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('store wait documents through the API on PostgreSQL', () => {
  let app;
  before(async () => {
    app = await createApi({ repository: new PostgresWarehouseRepository() });
  });
  after(async () => {
    await app?.close();
  });

  test('scopes lists and details by role and store; HTKD sees assigned stores only', async () => {
    const f = await createFixture();
    const storeList = await app.inject({
      method: 'GET',
      url: '/api/v1/wait-documents',
      headers: f.headers.store,
    });
    assert.equal(storeList.statusCode, 200, storeList.body);
    assert.equal(storeList.headers['cache-control'], 'no-store');
    const page = ListStoreWaitDocumentsResponseSchema.parse(storeList.json());
    assert.deepEqual(
      page.data.map((document) => document.storeId),
      [f.storeA],
    );
    const [document] = page.data;
    assert.equal(document.status, 'CURRENT');
    assert.match(document.code, /^PCT-\d{6}$/u);
    assert.deepEqual(
      document.lines.map((line) => [line.productId, line.remainingQuantity, line.pendingQuantity]),
      [[f.product, 2, 0]],
    );

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v1/wait-documents?storeId=${f.storeB}`,
      headers: f.headers.store,
    });
    assert.equal(foreign.statusCode, 403, foreign.body);
    const foreignDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/wait-documents/${f.documentB}`,
      headers: f.headers.store,
    });
    assert.equal(foreignDetail.statusCode, 404, foreignDetail.body);

    const htkd = ListStoreWaitDocumentsResponseSchema.parse(
      (
        await app.inject({ method: 'GET', url: '/api/v1/wait-documents', headers: f.headers.htkd })
      ).json(),
    );
    assert.deepEqual(
      htkd.data.map((row) => row.storeId),
      [f.storeA],
    );
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/wait-documents/${document.id}`,
      headers: f.headers.htkd,
    });
    assert.equal(detail.statusCode, 200, detail.body);
    const parsed = StoreWaitDocumentDetailResponseSchema.parse(detail.json()).data;
    assert.deepEqual(
      parsed.members.map((member) => member.waitTicketId),
      [f.ticketA],
    );
    assert.deepEqual(parsed.currentDocument, { id: document.id, code: document.code });

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/wait-documents?openedFrom=2041-03-05&openedTo=2041-03-04',
      headers: f.headers.store,
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
  });

  test('cancels a whole document after its preview; stale, replayed and superseded calls', async () => {
    const f = await createFixture();
    const previewResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/wait-documents/${f.documentA}/cancel-preview`,
      headers: f.headers.store,
    });
    assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    const preview = StoreWaitDocumentCancelPreviewResponseSchema.parse(previewResponse.json()).data;
    assert.deepEqual(
      preview.tickets.map((ticket) => [ticket.waitTicketId, ticket.cancelledQuantity]),
      [[f.ticketA, 2]],
    );

    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/wait-documents/${f.documentA}/cancel`,
      headers: { ...f.headers.store, 'idempotency-key': `stale-${randomUUID()}` },
      payload: { reason: 'Không cần nữa', expectedFingerprint: '0'.repeat(64) },
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error.code, 'WAIT_TICKET_PREVIEW_STALE');

    const key = `cancel-${randomUUID()}`;
    const body = { reason: 'Không cần nữa', expectedFingerprint: preview.fingerprint };
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/wait-documents/${f.documentA}/cancel`,
      headers: { ...f.headers.store, 'idempotency-key': key },
      payload: body,
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.headers['idempotency-replayed'], 'false');
    assert.deepEqual(cancelled.json().data, {
      documentId: f.documentA,
      cancelledQuantity: 2,
      revokedQuantity: 0,
      currentDocumentId: null,
    });
    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/wait-documents/${f.documentA}/cancel`,
      headers: { ...f.headers.store, 'idempotency-key': key },
      payload: body,
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    assert.deepEqual(replay.json().data, cancelled.json().data);

    const superseded = await app.inject({
      method: 'GET',
      url: `/api/v1/wait-documents/${f.documentA}/cancel-preview`,
      headers: f.headers.store,
    });
    assert.equal(superseded.statusCode, 409, superseded.body);
    assert.equal(superseded.json().error.code, 'WAIT_DOCUMENT_SUPERSEDED');

    const history = ListStoreWaitDocumentsResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/wait-documents?view=HISTORY&status=CANCELLED',
          headers: f.headers.store,
        })
      ).json(),
    );
    assert.deepEqual(
      history.data.map((row) => [
        row.id,
        row.status,
        row.closedEvent?.kind,
        row.closedEvent?.actor?.role,
      ]),
      [[f.documentA, 'CANCELLED', 'WAIT_DOCUMENT_CANCELLED', 'STORE']],
    );

    // Revoking the HTKD assignment ends its access to the store's documents at once.
    await db
      .update(htkdAssignments)
      .set({ revokedAt: new Date() })
      .where(eq(htkdAssignments.userId, f.htkdId));
    const revoked = await app.inject({
      method: 'GET',
      url: `/api/v1/wait-documents/${f.documentB}`,
      headers: f.headers.htkd,
    });
    assert.ok([401, 404].includes(revoked.statusCode), revoked.body);
  });

  test('documents the new routes in OpenAPI', async () => {
    const openapi = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    for (const path of [
      '/api/v1/wait-documents',
      '/api/v1/wait-documents/{documentId}',
      '/api/v1/wait-documents/{documentId}/cancel-preview',
      '/api/v1/wait-documents/{documentId}/cancel',
    ]) {
      assert.ok(openapi.paths[path], path);
    }
  });
});

async function createFixture() {
  const suffix = randomUUID();
  const [administrator] = await db
    .select({ id: users.id })
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
  const fixture = await db.transaction(async (tx) => {
    const [storeA, storeB] = await tx
      .insert(stores)
      .values(
        ['A', 'B'].map((label, index) => ({
          groupId: group.id,
          code: `SWD_${suffix.slice(0, 8)}_${label}`,
          name: `Store wait document ${label}`,
          kind: 'retail',
          displayOrder: 21_000 + index,
        })),
      )
      .returning({ id: stores.id });
    const [htkdUser] = await tx
      .insert(users)
      .values({
        email: `swd.htkd.${suffix}@example.test`,
        passwordHash: `integration-hash-${suffix}`,
        displayName: 'Store wait document HTKD',
        role: 'htkd',
      })
      .returning({ id: users.id, tokenVersion: users.tokenVersion });
    const [storeUser] = await tx
      .insert(users)
      .values({
        email: `swd.store.${suffix}@example.test`,
        passwordHash: `integration-hash-${suffix}`,
        displayName: 'Store wait document store',
        role: 'store',
        storeId: storeA.id,
      })
      .returning({ id: users.id, tokenVersion: users.tokenVersion });
    await tx
      .insert(htkdAssignments)
      .values({ userId: htkdUser.id, storeId: storeA.id, assignedByUserId: administrator.id });
    const [session] = await tx
      .insert(orderSessions)
      .values({
        code: `SWD-${suffix}`,
        kind: 'manual',
        businessDate: '2000-01-03',
        status: 'completed',
        openedAt: new Date('2000-01-03T00:00:00.000Z'),
        inventorySnapshotDueAt: new Date('2000-01-03T01:00:00.000Z'),
        requestDeadlineAt: new Date('2000-01-03T02:00:00.000Z'),
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
          submittedAt: new Date('2000-01-03T00:30:00.000Z'),
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
          status: 'active',
          priorityLevel: 'P0B',
          originalQuantity: 2,
          remainingQuantity: 2,
          fulfilledQuantity: 0,
        })
        .returning({ id: waitTickets.id });
      tickets.push(ticket.id);
    }
    const tokens = {};
    for (const [name, user] of Object.entries({ store: storeUser, htkd: htkdUser })) {
      const token = randomBytes(32).toString('base64url');
      await tx.insert(sessions).values({
        userId: user.id,
        tokenHash: hashSessionToken(token),
        userTokenVersion: user.tokenVersion,
        expiresAt: new Date(Date.now() + 60_000),
      });
      tokens[name] = { cookie: `idosi_session=${token}` };
    }
    return {
      storeA: storeA.id,
      storeB: storeB.id,
      product: product.id,
      ticketA: tickets[0],
      htkdId: htkdUser.id,
      headers: tokens,
    };
  });
  // The tickets were inserted directly (as a previous release would); catch-up opens documents.
  const synced = await syncAllStoreWaitDocuments(db);
  const documentOf = (storeId) => synced.find((row) => row.storeId === storeId)?.currentDocumentId;
  return {
    ...fixture,
    documentA: documentOf(fixture.storeA),
    documentB: documentOf(fixture.storeB),
  };
}
