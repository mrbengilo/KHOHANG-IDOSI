import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { createApi } from '../dist/app.js';
import { MEMORY_SEED_IDS, MemoryWarehouseRepository } from '../dist/memory-repository.js';
import { hashPassword, verifyPassword } from '../dist/security.js';
import { asiaHoChiMinhDateRange } from '../dist/time.js';

const PASSWORD = 'IDOSI-test-password-2026!';

describe('KHOHANG-IDOSI API', () => {
  let repository;
  let app;

  beforeEach(async () => {
    repository = await MemoryWarehouseRepository.create({ bootstrapPassword: PASSWORD });
    app = await createApi({ repository, corsOrigin: 'http://localhost:5173' });
  });

  afterEach(async () => {
    await app.close();
  });

  test('serves liveness, readiness and OpenAPI without authentication', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/ready' })).statusCode, 200);
    const specification = await app.inject({ method: 'GET', url: '/openapi.json' });
    assert.equal(specification.statusCode, 200);
    assert.equal(specification.json().openapi, '3.1.0');
  });

  test('uses scrypt and issues an opaque HttpOnly session without exposing secrets', async () => {
    const encoded = await hashPassword(PASSWORD);
    assert.match(encoded, /^scrypt\$v1\$/u);
    assert.equal(encoded.includes(PASSWORD), false);
    assert.equal(await verifyPassword(PASSWORD, encoded), true);

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'not-the-password' },
    });
    assert.equal(rejected.statusCode, 401);
    assert.equal(rejected.json().error.code, 'UNAUTHENTICATED');

    const accepted = await login('admin');
    assert.equal(accepted.statusCode, 200);
    assert.match(String(accepted.headers['set-cookie']), /HttpOnly/u);
    assert.match(String(accepted.headers['set-cookie']), /SameSite=Lax/u);
    assert.equal(JSON.stringify(accepted.json()).includes(PASSWORD), false);
    assert.equal(accepted.json().data.principal.role, 'ADMIN');

    const differentCase = await login('ADMIN');
    assert.equal(differentCase.statusCode, 401);
  });

  test('rate limits failed logins by trusted client IP and recovers after the window', async () => {
    await app.close();
    let now = Date.parse('2026-09-17T00:00:00.000Z');
    app = await createApi({
      repository,
      corsOrigin: 'http://localhost:5173',
      trustProxy: ['loopback', 'uniquelocal'],
      loginRateLimit: { maxFailures: 2, windowMs: 60_000, now: () => now },
    });

    const invalidLogin = {
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.10' },
      payload: { username: 'admin', password: 'not-the-password' },
    };
    assert.equal((await app.inject(invalidLogin)).statusCode, 401);
    assert.equal((await app.inject(invalidLogin)).statusCode, 401);
    const blocked = await app.inject(invalidLogin);
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().error.code, 'RATE_LIMITED');
    assert.equal(blocked.headers['retry-after'], '60');
    assert.equal(blocked.json().error.details.retryAfterSeconds, 60);

    // A public direct peer is not trusted to replace its address with X-Forwarded-For.
    const untrustedPeer = await app.inject({
      ...invalidLogin,
      remoteAddress: '198.51.100.20',
    });
    assert.equal(untrustedPeer.statusCode, 401);

    now += 60_001;
    const recovered = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.10' },
      payload: { username: 'admin', password: PASSWORD },
    });
    assert.equal(recovered.statusCode, 200);
  });

  test('maps inclusive Vietnam calendar days to exact UTC boundaries', () => {
    const range = asiaHoChiMinhDateRange('2026-09-17', '2026-09-17');
    assert.equal(range.start.toISOString(), '2026-09-16T17:00:00.000Z');
    assert.equal(range.endExclusive.toISOString(), '2026-09-17T17:00:00.000Z');
  });

  test('revokes an already-issued session when the account version changes', async () => {
    const cookie = cookieOf(await login('ds_nvt'));
    const initial = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    assert.equal(initial.statusCode, 200);

    repository.setAccountStatus(MEMORY_SEED_IDS.storeAccount, 'DISABLED');
    const revoked = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    assert.equal(revoked.statusCode, 401);
    assert.equal(revoked.json().error.code, 'SESSION_REVOKED');
  });

  test('revokes logout server-side and clears the cookie', async () => {
    const cookie = cookieOf(await login('admin'));
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie },
    });
    assert.equal(logout.statusCode, 200);
    assert.deepEqual(logout.json(), { data: { revoked: true } });
    assert.match(String(logout.headers['set-cookie']), /Max-Age=0/u);

    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    assert.equal(session.statusCode, 401);
  });

  test('enforces STORE and HTKD scopes on the server', async () => {
    const storeCookie = cookieOf(await login('ds_nvt'));
    const stores = await app.inject({
      method: 'GET',
      url: '/api/v1/stores?pageSize=100',
      headers: { cookie: storeCookie },
    });
    assert.equal(stores.statusCode, 200);
    assert.equal(stores.json().data.length, 1);
    assert.equal(stores.json().data[0].code, 'DS_NVT');

    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/order-requests?storeId=${MEMORY_SEED_IDS.bdStore}`,
      headers: { cookie: storeCookie },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, 'FORBIDDEN');

    const htkdCookie = cookieOf(await login('htkd'));
    const assigned = await app.inject({
      method: 'GET',
      url: '/api/v1/stores?pageSize=100',
      headers: { cookie: htkdCookie },
    });
    assert.deepEqual(
      assigned
        .json()
        .data.map((store) => store.code)
        .sort(),
      ['DS_BD', 'DS_NVT'],
    );
  });

  test('lists the open order session and rejects an unknown session', async () => {
    const cookie = cookieOf(await login('ds_nvt'));
    const sessions = await app.inject({
      method: 'GET',
      url: '/api/v1/order-sessions?status=OPEN&page=1&pageSize=10',
      headers: { cookie },
    });
    assert.equal(sessions.statusCode, 200);
    assert.equal(sessions.json().data.length, 1);
    assert.equal(sessions.json().data[0].id, MEMORY_SEED_IDS.orderSession);

    const productId = await firstProductId(cookie);
    const rejected = await submitOrder(cookie, 'unknown-session-key', {
      ...orderPayload(productId, 1),
      businessSessionId: '10000000-0000-4000-8000-999999999999',
    });
    assert.equal(rejected.statusCode, 409);
    assert.equal(rejected.json().error.code, 'SESSION_NOT_OPEN');
  });

  test('replays the same idempotency key and rejects reuse with another payload', async () => {
    const cookie = cookieOf(await login('ds_nvt'));
    const productId = await firstProductId(cookie);
    const payload = orderPayload(productId, 2);
    const first = await submitOrder(cookie, 'same-request-key', payload);
    const replay = await submitOrder(cookie, 'same-request-key', payload);
    assert.equal(first.statusCode, 201);
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    assert.equal(replay.json().data.id, first.json().data.id);

    const keyConflict = await submitOrder(cookie, 'same-request-key', orderPayload(productId, 3));
    assert.equal(keyConflict.statusCode, 409);
    assert.equal(keyConflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
  });

  test('keeps the maximum-two invariant under concurrent submissions', async () => {
    const cookie = cookieOf(await login('ds_nvt'));
    const productId = await firstProductId(cookie);
    const responses = await Promise.all(
      ['parallel-key-1', 'parallel-key-2', 'parallel-key-3'].map((key, index) =>
        submitOrder(cookie, key, orderPayload(productId, index + 1)),
      ),
    );
    assert.equal(responses.filter((response) => response.statusCode === 201).length, 2);
    assert.equal(responses.filter((response) => response.statusCode === 409).length, 1);
    assert.equal(
      responses.find((response) => response.statusCode === 409)?.json().error.code,
      'REQUEST_LIMIT_REACHED',
    );
  });

  test('exposes exact conversions and replaces one with an immutable version', async () => {
    const adminCookie = cookieOf(await login('admin'));
    const products = await app.inject({
      method: 'GET',
      url: '/api/v1/products?pageSize=100',
      headers: { cookie: adminCookie },
    });
    assert.equal(products.json().data.length, 25);
    const bedding = products
      .json()
      .data.find((product) => product.sku === 'CHAN_GA_BAO_GOI_NEM_GON');
    assert.ok(bedding);

    const projection = await app.inject({
      method: 'GET',
      url: '/api/v1/product-conversions?page=1&pageSize=100&includeRetired=false',
      headers: { cookie: adminCookie },
    });
    assert.equal(projection.statusCode, 200);
    assert.equal(projection.json().data.length, 25);
    assert.equal(projection.json().pagination.totalItems, 25);

    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${bedding.id}/conversions`,
      headers: { cookie: adminCookie },
    });
    assert.equal(history.statusCode, 200);
    assert.deepEqual(
      {
        version: history.json().data[0].version,
        itemQuantity: history.json().data[0].itemQuantity,
        weightKilograms: history.json().data[0].weightKilograms,
      },
      { version: 1, itemQuantity: 1, weightKilograms: '3.000' },
    );
    const current = history.json().data[0];

    const replaced = await app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${bedding.id}/conversions/${current.id}`,
      headers: { cookie: adminCookie },
      payload: {
        itemQuantity: 1,
        weightKilograms: '3.500',
        effectiveFrom: '2026-10-01',
        effectiveTo: null,
        reason: 'Cập nhật định mức theo kiểm kê tháng 10',
        expectedVersion: 1,
      },
    });
    assert.equal(replaced.statusCode, 200);
    assert.equal(replaced.json().data.version, 2);
    assert.equal(replaced.json().data.weightKilograms, '3.500');

    const allVersions = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${bedding.id}/conversions?includeRetired=true`,
      headers: { cookie: adminCookie },
    });
    assert.equal(allVersions.json().data.length, 2);
    assert.notEqual(allVersions.json().data.find((item) => item.version === 1).retiredAt, null);

    const beforeEffectiveDate = await app.inject({
      method: 'GET',
      url: `/api/v1/product-conversions?pageSize=100&effectiveAt=2026-09-17`,
      headers: { cookie: adminCookie },
    });
    const currentBedding = beforeEffectiveDate
      .json()
      .data.find((item) => item.productId === bedding.id);
    assert.equal(currentBedding.version, 1);
    assert.equal(currentBedding.weightKilograms, '3.000');

    const afterEffectiveDate = await app.inject({
      method: 'GET',
      url: `/api/v1/product-conversions?pageSize=100&effectiveAt=2026-10-01`,
      headers: { cookie: adminCookie },
    });
    const futureBedding = afterEffectiveDate
      .json()
      .data.find((item) => item.productId === bedding.id);
    assert.equal(futureBedding.version, 2);
    assert.equal(futureBedding.weightKilograms, '3.500');

    const retiredBeforeEffective = await app.inject({
      method: 'DELETE',
      url: `/api/v1/products/${bedding.id}/conversions/${replaced.json().data.id}`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: 2, reason: 'Hủy định mức trước ngày áp dụng' },
    });
    assert.equal(retiredBeforeEffective.statusCode, 200);
    assert.equal(
      retiredBeforeEffective.json().data.effectiveTo,
      retiredBeforeEffective.json().data.effectiveFrom,
    );

    const cancelledFuture = await app.inject({
      method: 'GET',
      url: `/api/v1/product-conversions?pageSize=100&effectiveAt=2026-10-01`,
      headers: { cookie: adminCookie },
    });
    assert.equal(
      cancelledFuture.json().data.some((item) => item.productId === bedding.id),
      false,
    );
  });

  test('runs the auditable store receipt lifecycle with scopes, versions and idempotency', async () => {
    const storeCookie = cookieOf(await login('ds_nvt'));
    const htkdCookie = cookieOf(await login('htkd'));
    const products = await app.inject({
      method: 'GET',
      url: '/api/v1/products?pageSize=100',
      headers: { cookie: storeCookie },
    });
    const product = products.json().data[1];
    assert.ok(product);

    const declaration = {
      storeId: MEMORY_SEED_IDS.nvtStore,
      outboundRequestId: MEMORY_SEED_IDS.secondOutboundRequest,
      lines: [{ productId: product.id, approvedUnits: 2, receivedUnits: 1 }],
      discrepancyNote: 'Thiếu một bao khi giao nhận',
    };
    const declared = await mutateReceipt(
      storeCookie,
      'POST',
      '/api/v1/store-receipts',
      'receipt-declare-0001',
      declaration,
    );
    assert.equal(declared.statusCode, 201);
    assert.equal(declared.json().data.status, 'DRAFT');
    assert.equal(declared.json().data.version, 0);
    assert.equal(declared.json().data.outboundRequestId, MEMORY_SEED_IDS.secondOutboundRequest);
    const receiptId = declared.json().data.id;

    const declarationReplay = await mutateReceipt(
      storeCookie,
      'POST',
      '/api/v1/store-receipts',
      'receipt-declare-0001',
      declaration,
    );
    assert.equal(declarationReplay.statusCode, 201);
    assert.equal(declarationReplay.headers['idempotency-replayed'], 'true');
    assert.equal(declarationReplay.json().data.id, receiptId);

    const declarationConflict = await mutateReceipt(
      storeCookie,
      'POST',
      '/api/v1/store-receipts',
      'receipt-declare-0001',
      {
        ...declaration,
        lines: [{ productId: product.id, approvedUnits: 2, receivedUnits: 2 }],
        discrepancyNote: null,
      },
    );
    assert.equal(declarationConflict.statusCode, 409);
    assert.equal(declarationConflict.json().error.code, 'IDEMPOTENCY_CONFLICT');

    const submitPayload = {
      lines: declaration.lines,
      discrepancyNote: declaration.discrepancyNote,
      expectedVersion: 0,
    };
    const submitted = await mutateReceipt(
      storeCookie,
      'POST',
      `/api/v1/store-receipts/${receiptId}/submit`,
      'receipt-submit-0001',
      submitPayload,
    );
    assert.equal(submitted.statusCode, 200);
    assert.equal(submitted.json().data.status, 'PENDING_HTKD');
    assert.equal(submitted.json().data.version, 1);

    const finalization = {
      lines: [
        {
          ...declaration.lines[0],
          bagWeightsKg: ['1.255'],
          pricePerKgVnd: 20_001,
        },
      ],
      freightVnd: 10_000,
      handlingVnd: 5_000,
      expectedVersion: 1,
    };
    const storeDenied = await mutateReceipt(
      storeCookie,
      'POST',
      `/api/v1/store-receipts/${receiptId}/finalize`,
      'receipt-finalize-denied',
      finalization,
    );
    assert.equal(storeDenied.statusCode, 403);

    const returned = await mutateReceipt(
      htkdCookie,
      'POST',
      `/api/v1/store-receipts/${receiptId}/return`,
      'receipt-return-0001',
      { reason: 'Vui lòng kiểm tra lại số lượng thực nhận', expectedVersion: 1 },
    );
    assert.equal(returned.statusCode, 200);
    assert.equal(returned.json().data.status, 'RETURNED');
    assert.equal(returned.json().data.version, 2);

    const staleSubmit = await mutateReceipt(
      storeCookie,
      'POST',
      `/api/v1/store-receipts/${receiptId}/submit`,
      'receipt-submit-stale',
      submitPayload,
    );
    assert.equal(staleSubmit.statusCode, 409);
    assert.equal(staleSubmit.json().error.code, 'VERSION_CONFLICT');

    const resubmitted = await mutateReceipt(
      storeCookie,
      'POST',
      `/api/v1/store-receipts/${receiptId}/submit`,
      'receipt-submit-0002',
      { ...submitPayload, expectedVersion: 2 },
    );
    assert.equal(resubmitted.statusCode, 200);
    assert.equal(resubmitted.json().data.status, 'PENDING_HTKD');
    assert.equal(resubmitted.json().data.version, 3);

    const finalized = await mutateReceipt(
      htkdCookie,
      'POST',
      `/api/v1/store-receipts/${receiptId}/finalize`,
      'receipt-finalize-0001',
      { ...finalization, expectedVersion: 3 },
    );
    assert.equal(finalized.statusCode, 200);
    assert.equal(finalized.json().data.status, 'FINALIZED');
    assert.equal(finalized.json().data.version, 4);
    assert.equal(finalized.json().data.totalCostVnd, 40_101);

    const finalizeReplay = await mutateReceipt(
      htkdCookie,
      'POST',
      `/api/v1/store-receipts/${receiptId}/finalize`,
      'receipt-finalize-0001',
      { ...finalization, expectedVersion: 3 },
    );
    assert.equal(finalizeReplay.statusCode, 200);
    assert.equal(finalizeReplay.headers['idempotency-replayed'], 'true');
    assert.deepEqual(finalizeReplay.json().data, finalized.json().data);

    const filtered = await app.inject({
      method: 'GET',
      url: `/api/v1/store-receipts?outboundRequestId=${MEMORY_SEED_IDS.secondOutboundRequest}`,
      headers: { cookie: storeCookie },
    });
    assert.equal(filtered.statusCode, 200);
    assert.equal(filtered.json().data.length, 1);
    assert.equal(filtered.json().data[0].status, 'FINALIZED');
  });

  test('lists and filters store-scoped wait tickets, offers and history', async () => {
    const storeCookie = cookieOf(await login('ds_nvt'));

    const tickets = await app.inject({
      method: 'GET',
      url: '/api/v1/wait-tickets?page=1&pageSize=10',
      headers: { cookie: storeCookie },
    });
    assert.equal(tickets.statusCode, 200);
    assert.equal(tickets.json().pagination.totalItems, 2);
    assert.deepEqual(
      new Set(tickets.json().data.map((ticket) => ticket.id)),
      new Set([MEMORY_SEED_IDS.waitTicket, MEMORY_SEED_IDS.cancellableWaitTicket]),
    );

    const filteredTickets = await app.inject({
      method: 'GET',
      url: `/api/v1/wait-tickets?status=OFFERED&priority=P0A&sessionId=${MEMORY_SEED_IDS.orderSession}`,
      headers: { cookie: storeCookie },
    });
    assert.equal(filteredTickets.statusCode, 200);
    assert.equal(filteredTickets.json().data.length, 1);
    assert.equal(filteredTickets.json().data[0].id, MEMORY_SEED_IDS.waitTicket);

    const offers = await app.inject({
      method: 'GET',
      url: `/api/v1/priority-offers?waitTicketId=${MEMORY_SEED_IDS.waitTicket}&status=PENDING`,
      headers: { cookie: storeCookie },
    });
    assert.equal(offers.statusCode, 200);
    assert.equal(offers.json().data.length, 1);
    assert.equal(offers.json().data[0].id, MEMORY_SEED_IDS.priorityOffer);
    assert.deepEqual(offers.json().data[0].offered, { kind: 'UNIT', quantity: 3 });

    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/wait-tickets/${MEMORY_SEED_IDS.waitTicket}/history?limit=25`,
      headers: { cookie: storeCookie },
    });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().data.ticket.id, MEMORY_SEED_IDS.waitTicket);
    assert.equal(history.json().data.ticket.status, 'OFFERED');
    assert.equal(history.json().data.offers.length, 1);
    assert.equal(history.json().data.offers[0].id, MEMORY_SEED_IDS.priorityOffer);

    const deniedScope = await app.inject({
      method: 'GET',
      url: `/api/v1/wait-tickets?storeId=${MEMORY_SEED_IDS.bdStore}`,
      headers: { cookie: storeCookie },
    });
    assert.equal(deniedScope.statusCode, 403);
    assert.equal(deniedScope.json().error.code, 'FORBIDDEN');
  });

  test('lets only the target store accept a full priority offer with idempotency', async () => {
    const storeCookie = cookieOf(await login('ds_nvt'));
    const htkdCookie = cookieOf(await login('htkd'));
    const url = `/api/v1/priority-offers/${MEMORY_SEED_IDS.priorityOffer}/respond`;
    const acceptance = { action: 'ACCEPT', accepted: { kind: 'UNIT', quantity: 3 } };

    const htkdDenied = await mutateWait(
      htkdCookie,
      url,
      'wait-offer-htkd-denied',
      acceptance,
    );
    assert.equal(htkdDenied.statusCode, 403);
    assert.equal(htkdDenied.json().error.code, 'FORBIDDEN');

    const partialAcceptance = await mutateWait(
      storeCookie,
      url,
      'wait-offer-partial',
      { action: 'ACCEPT', accepted: { kind: 'UNIT', quantity: 2 } },
    );
    assert.equal(partialAcceptance.statusCode, 400);
    assert.equal(partialAcceptance.json().error.code, 'VALIDATION_ERROR');

    const accepted = await mutateWait(storeCookie, url, 'wait-offer-accept-0001', acceptance);
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.headers['idempotency-replayed'], 'false');
    assert.equal(accepted.json().data.status, 'ACCEPTED');
    assert.deepEqual(accepted.json().data.accepted, acceptance.accepted);

    const replay = await mutateWait(storeCookie, url, 'wait-offer-accept-0001', acceptance);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    assert.deepEqual(replay.json().data, accepted.json().data);

    const keyConflict = await mutateWait(storeCookie, url, 'wait-offer-accept-0001', {
      action: 'DECLINE',
      reason: 'Không thể nhận hàng trong hôm nay',
    });
    assert.equal(keyConflict.statusCode, 409);
    assert.equal(keyConflict.json().error.code, 'IDEMPOTENCY_CONFLICT');

    const acceptedFilter = await app.inject({
      method: 'GET',
      url: '/api/v1/priority-offers?status=ACCEPTED',
      headers: { cookie: storeCookie },
    });
    assert.equal(acceptedFilter.statusCode, 200);
    assert.equal(acceptedFilter.json().data.length, 1);
    assert.equal(acceptedFilter.json().data[0].id, MEMORY_SEED_IDS.priorityOffer);

    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/wait-tickets/${MEMORY_SEED_IDS.waitTicket}/history`,
      headers: { cookie: storeCookie },
    });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().data.offers[0].status, 'ACCEPTED');
    assert.equal(
      history
        .json()
        .data.audit.some(
          (event) =>
            event.action === 'PRIORITY_OFFER_ACCEPTED' && event.actorRole === 'STORE',
        ),
      true,
    );
  });

  test('cancels an active wait ticket once and replays the same mutation', async () => {
    const storeCookie = cookieOf(await login('ds_nvt'));
    const url = `/api/v1/wait-tickets/${MEMORY_SEED_IDS.cancellableWaitTicket}/cancel`;
    const payload = { reason: 'Cửa hàng không còn nhu cầu nhận mặt hàng này' };

    const cancelled = await mutateWait(
      storeCookie,
      url,
      'wait-ticket-cancel-0001',
      payload,
    );
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.headers['idempotency-replayed'], 'false');
    assert.equal(cancelled.json().data.id, MEMORY_SEED_IDS.cancellableWaitTicket);
    assert.equal(cancelled.json().data.status, 'CANCELLED');

    const replay = await mutateWait(
      storeCookie,
      url,
      'wait-ticket-cancel-0001',
      payload,
    );
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    assert.deepEqual(replay.json().data, cancelled.json().data);

    const keyConflict = await mutateWait(
      storeCookie,
      url,
      'wait-ticket-cancel-0001',
      { reason: 'Thay đổi lý do hủy phiếu chờ' },
    );
    assert.equal(keyConflict.statusCode, 409);
    assert.equal(keyConflict.json().error.code, 'IDEMPOTENCY_CONFLICT');

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/v1/wait-tickets?status=CANCELLED',
      headers: { cookie: storeCookie },
    });
    assert.equal(filtered.statusCode, 200);
    assert.equal(filtered.json().data.length, 1);
    assert.equal(filtered.json().data[0].id, MEMORY_SEED_IDS.cancellableWaitTicket);

    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/wait-tickets/${MEMORY_SEED_IDS.cancellableWaitTicket}/history`,
      headers: { cookie: storeCookie },
    });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().data.ticket.status, 'CANCELLED');
    assert.equal(
      history.json().data.audit.some((event) => event.action === 'WAIT_TICKET_CANCELLED'),
      true,
    );
  });

  test('returns structured validation errors with the propagated request id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-request-id': 'web-request-123' },
      payload: { username: 'x', password: 'short' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers['x-request-id'], 'web-request-123');
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
    assert.equal(response.json().error.requestId, 'web-request-123');
  });

  async function login(username) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password: PASSWORD },
    });
  }

  async function firstProductId(cookie) {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/products',
      headers: { cookie },
    });
    return response.json().data[0].id;
  }

  async function submitOrder(cookie, idempotencyKey, payload) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/order-requests',
      headers: { cookie, 'idempotency-key': idempotencyKey },
      payload,
    });
  }

  async function mutateReceipt(cookie, method, url, idempotencyKey, payload) {
    return app.inject({
      method,
      url,
      headers: { cookie, 'idempotency-key': idempotencyKey },
      payload,
    });
  }

  async function mutateWait(cookie, url, idempotencyKey, payload) {
    return app.inject({
      method: 'POST',
      url,
      headers: { cookie, 'idempotency-key': idempotencyKey },
      payload,
    });
  }
});

function cookieOf(response) {
  const header = response.headers['set-cookie'];
  if (!header || typeof header === 'number') throw new Error('Login did not set a cookie');
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(';')[0] ?? '';
}

function orderPayload(productId, quantity) {
  return {
    businessSessionId: MEMORY_SEED_IDS.orderSession,
    storeId: MEMORY_SEED_IDS.nvtStore,
    items: [{ productId, quantity }],
  };
}
