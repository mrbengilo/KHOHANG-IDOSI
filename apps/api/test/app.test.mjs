import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { createApi } from '../dist/app.js';
import { sanitizeAuditObject } from '../dist/audit-sanitization.js';
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
    assert.ok(specification.json().paths['/api/v1/store-receipt-sources']);
    assert.ok(specification.json().paths['/api/v1/store-inventory-bags']);
    assert.ok(specification.json().paths['/api/v1/store-outbounds/{outboundId}/review']);
    assert.ok(specification.json().paths['/api/v1/order-sessions/{sessionId}/transition']);
    assert.ok(specification.json().paths['/api/v1/outbound-requests/{outboundRequestId}/dispatch']);
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

  test('redacts nested credentials at the audit response boundary', () => {
    assert.deepEqual(
      sanitizeAuditObject({
        account: { id: 'safe', passwordHash: 'scrypt$never-return', token: 'opaque-secret' },
        metadata: { sessionsRevoked: 1, authorization: 'Bearer secret' },
      }),
      { account: { id: 'safe' }, metadata: { sessionsRevoked: 1 } },
    );
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
    const allAssigned = await app.inject({
      method: 'GET',
      url: '/api/v1/store-receipt-sources?pageSize=10',
      headers: { cookie: htkdCookie },
    });
    assert.equal(allAssigned.statusCode, 200);
    assert.equal(allAssigned.json().pagination.totalItems, 1);
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

  test('creates and transitions an order session with idempotency and optimistic locking', async () => {
    await app.close();
    const fixedNow = new Date();
    const dateParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(fixedNow);
    const businessDate = `${dateParts.find((part) => part.type === 'year')?.value}-${dateParts.find((part) => part.type === 'month')?.value}-${dateParts.find((part) => part.type === 'day')?.value}`;
    repository = await MemoryWarehouseRepository.create({
      bootstrapPassword: PASSWORD,
      now: () => fixedNow,
    });
    app = await createApi({ repository, corsOrigin: 'http://localhost:5173' });
    const adminCookie = cookieOf(await login('admin'));
    const storeCookie = cookieOf(await login('ds_nvt'));

    const cancelledSeed = await mutateSession(
      adminCookie,
      `/api/v1/order-sessions/${MEMORY_SEED_IDS.orderSession}/transition`,
      'cancel-seeded-session',
      { status: 'CANCELLED', expectedVersion: 0, reason: 'Thay bằng lịch vận hành mới' },
    );
    assert.equal(cancelledSeed.statusCode, 200);
    assert.equal(cancelledSeed.json().data.status, 'CANCELLED');
    assert.equal(cancelledSeed.json().data.version, 1);

    const createPayload = {
      businessDate,
      requestOpensAt: `${businessDate}T00:00:00+07:00`,
      requestClosesAt: `${businessDate}T23:59:58+07:00`,
      allocationStartsAt: `${businessDate}T23:59:59+07:00`,
    };
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/order-sessions',
      headers: { cookie: storeCookie, 'idempotency-key': 'store-session-create' },
      payload: createPayload,
    });
    assert.equal(denied.statusCode, 403);

    const created = await mutateSession(
      adminCookie,
      '/api/v1/order-sessions',
      'create-session-20260918',
      createPayload,
    );
    const replay = await mutateSession(
      adminCookie,
      '/api/v1/order-sessions',
      'create-session-20260918',
      createPayload,
    );
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().data.status, 'SCHEDULED');
    assert.equal(created.json().data.policyVersion, 'idosi-round-robin-p0a-p3-v1');
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    assert.equal(replay.json().data.id, created.json().data.id);

    const sessionId = created.json().data.id;
    const opened = await mutateSession(
      adminCookie,
      `/api/v1/order-sessions/${sessionId}/transition`,
      'open-session-20260918',
      { status: 'OPEN', expectedVersion: 0 },
    );
    assert.equal(opened.statusCode, 200);
    assert.equal(opened.json().data.version, 1);

    const stale = await mutateSession(
      adminCookie,
      `/api/v1/order-sessions/${sessionId}/transition`,
      'close-stale-session-20260918',
      { status: 'CLOSED', expectedVersion: 0 },
    );
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'VERSION_CONFLICT');

    const closed = await mutateSession(
      adminCookie,
      `/api/v1/order-sessions/${sessionId}/transition`,
      'close-session-20260918',
      { status: 'CLOSED', expectedVersion: 1 },
    );
    assert.equal(closed.statusCode, 200);
    assert.equal(closed.json().data.status, 'CLOSED');
    assert.equal(closed.json().data.version, 2);
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

  test('resumes a retired conversion history with one optimistic immutable append', async () => {
    const adminCookie = cookieOf(await login('admin'));
    const products = await app.inject({
      method: 'GET',
      url: '/api/v1/products?pageSize=100',
      headers: { cookie: adminCookie },
    });
    const product = products.json().data[0];
    assert.ok(product);

    const initialHistory = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${product.id}/conversions?includeRetired=true`,
      headers: { cookie: adminCookie },
    });
    const initial = initialHistory.json().data[0];
    assert.equal(initial.version, 1);

    const retired = await app.inject({
      method: 'DELETE',
      url: `/api/v1/products/${product.id}/conversions/${initial.id}`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: 1, reason: 'Tạm ngừng định mức để kiểm kê lại' },
    });
    assert.equal(retired.statusCode, 200);
    assert.notEqual(retired.json().data.retiredAt, null);

    const resumedPayload = {
      itemQuantity: initial.itemQuantity,
      weightKilograms: initial.weightKilograms,
      effectiveFrom: '2099-01-01',
      effectiveTo: null,
      reason: 'Khôi phục định mức sau khi kiểm kê',
      expectedVersion: 1,
    };
    const missingExpectation = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${product.id}/conversions`,
      headers: { cookie: adminCookie },
      payload: { ...resumedPayload, expectedVersion: undefined },
    });
    assert.equal(missingExpectation.statusCode, 409);
    assert.equal(missingExpectation.json().error.code, 'VERSION_CONFLICT');

    const invalidDate = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${product.id}/conversions`,
      headers: { cookie: adminCookie },
      payload: { ...resumedPayload, effectiveFrom: initial.effectiveFrom },
    });
    assert.equal(invalidDate.statusCode, 400);
    assert.equal(invalidDate.json().error.code, 'VALIDATION_ERROR');

    const attempts = await Promise.all(
      ['resume-conversion-a', 'resume-conversion-b'].map((requestId) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/products/${product.id}/conversions`,
          headers: { cookie: adminCookie, 'x-request-id': requestId },
          payload: resumedPayload,
        }),
      ),
    );
    assert.equal(attempts.filter((response) => response.statusCode === 201).length, 1);
    assert.equal(attempts.filter((response) => response.statusCode === 409).length, 1);
    const createdResponse = attempts.find((response) => response.statusCode === 201);
    const conflictedResponse = attempts.find((response) => response.statusCode === 409);
    assert.ok(createdResponse);
    assert.ok(conflictedResponse);
    assert.equal(conflictedResponse.json().error.code, 'VERSION_CONFLICT');
    const created = createdResponse.json().data;
    assert.equal(created.version, 2);
    assert.equal(created.retiredAt, null);

    const activeAppend = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${product.id}/conversions`,
      headers: { cookie: adminCookie },
      payload: { ...resumedPayload, effectiveFrom: '2099-01-02', expectedVersion: 2 },
    });
    assert.equal(activeAppend.statusCode, 409);
    assert.equal(activeAppend.json().error.code, 'CONFLICT');

    const finalHistory = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${product.id}/conversions?includeRetired=true`,
      headers: { cookie: adminCookie },
    });
    assert.equal(finalHistory.json().data.length, 2);
    assert.deepEqual(
      finalHistory.json().data.find((conversion) => conversion.version === 1),
      retired.json().data,
    );

    const audit = await app.inject({
      method: 'GET',
      url:
        '/api/v1/admin/audit-logs?action=PRODUCT_CONVERSION_APPENDED' +
        `&entityType=product_conversion&entityId=${created.id}`,
      headers: { cookie: adminCookie },
    });
    assert.equal(audit.statusCode, 200);
    assert.equal(audit.json().pagination.totalItems, 1);
    assert.equal(audit.json().data[0].before.version, 1);
    assert.notEqual(audit.json().data[0].before.retiredAt, null);
    assert.equal(audit.json().data[0].after.version, 2);
  });

  test('creates an initial conversion against the zero-version baseline', async () => {
    const adminCookie = cookieOf(await login('admin'));
    const productResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { cookie: adminCookie },
      payload: {
        sku: 'CATALOG_LIFECYCLE_TEST',
        name: 'Mặt hàng kiểm thử vòng đời',
        measurement: 'UNIT',
        unitLabel: 'cái',
      },
    });
    assert.equal(productResponse.statusCode, 201);
    const product = productResponse.json().data;
    const payload = {
      itemQuantity: 2,
      weightKilograms: '1.000',
      effectiveFrom: '2026-09-18',
      effectiveTo: null,
      reason: 'Khởi tạo định mức có chốt phiên bản',
      expectedVersion: 0,
    };

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${product.id}/conversions`,
      headers: { cookie: adminCookie },
      payload,
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().data.version, 1);

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${product.id}/conversions`,
      headers: { cookie: adminCookie },
      payload,
    });
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().error.code, 'VERSION_CONFLICT');
  });

  test('lists only authorized dispatched sources that do not have a receipt', async () => {
    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/api/v1/store-receipt-sources',
    });
    assert.equal(unauthenticated.statusCode, 401);

    const storeCookie = cookieOf(await login('ds_nvt'));
    const storeSources = await app.inject({
      method: 'GET',
      url: '/api/v1/store-receipt-sources?page=1&pageSize=10',
      headers: { cookie: storeCookie },
    });
    assert.equal(storeSources.statusCode, 200);
    assert.equal(storeSources.json().pagination.totalItems, 1);
    assert.equal(storeSources.json().data.length, 1);
    const [source] = storeSources.json().data;
    assert.equal(source.id, MEMORY_SEED_IDS.secondOutboundRequest);
    assert.notEqual(source.id, MEMORY_SEED_IDS.outboundRequest);
    assert.equal(source.requestNumber, 'OUT-MEMORY-002');
    assert.equal(source.storeId, MEMORY_SEED_IDS.nvtStore);
    assert.equal(Number.isNaN(Date.parse(source.dispatchedAt)), false);
    assert.deepEqual(Object.keys(source).sort(), [
      'dispatchedAt',
      'id',
      'lines',
      'requestNumber',
      'storeId',
    ]);
    assert.equal(source.lines.length, 1);
    assert.deepEqual(Object.keys(source.lines[0]).sort(), [
      'approvedUnits',
      'dispatchedUnits',
      'productId',
    ]);
    assert.equal(source.lines[0].approvedUnits, 2);
    assert.equal(source.lines[0].dispatchedUnits, 2);

    const storeOverride = await app.inject({
      method: 'GET',
      url: `/api/v1/store-receipt-sources?storeId=${MEMORY_SEED_IDS.bdStore}`,
      headers: { cookie: storeCookie },
    });
    assert.equal(storeOverride.statusCode, 403);

    const htkdCookie = cookieOf(await login('htkd'));
    const assigned = await app.inject({
      method: 'GET',
      url: `/api/v1/store-receipt-sources?storeId=${MEMORY_SEED_IDS.nvtStore}`,
      headers: { cookie: htkdCookie },
    });
    assert.equal(assigned.statusCode, 200);
    assert.equal(assigned.json().pagination.totalItems, 1);
    const unassignedStore = '20000000-0000-4000-8000-000000000009';
    const htkdDenied = await app.inject({
      method: 'GET',
      url: `/api/v1/store-receipt-sources?storeId=${unassignedStore}`,
      headers: { cookie: htkdCookie },
    });
    assert.equal(htkdDenied.statusCode, 403);

    const adminCookie = cookieOf(await login('admin'));
    const adminSources = await app.inject({
      method: 'GET',
      url: '/api/v1/store-receipt-sources?pageSize=100',
      headers: { cookie: adminCookie },
    });
    assert.equal(adminSources.statusCode, 200);
    assert.equal(adminSources.json().pagination.totalItems, 1);
    const adminFiltered = await app.inject({
      method: 'GET',
      url: `/api/v1/store-receipt-sources?storeId=${MEMORY_SEED_IDS.bdStore}`,
      headers: { cookie: adminCookie },
    });
    assert.equal(adminFiltered.statusCode, 200);
    assert.equal(adminFiltered.json().pagination.totalItems, 0);

    const invalidPagination = await app.inject({
      method: 'GET',
      url: '/api/v1/store-receipt-sources?pageSize=101',
      headers: { cookie: adminCookie },
    });
    assert.equal(invalidPagination.statusCode, 400);
    assert.equal(invalidPagination.json().error.code, 'VALIDATION_ERROR');
  });

  test('dispatches an allocation-backed outbound once and exposes it as a receipt source', async () => {
    const storeCookie = cookieOf(await login('ds_nvt'));
    const htkdCookie = cookieOf(await login('htkd'));
    const reserved = await app.inject({
      method: 'GET',
      url: '/api/v1/outbound-requests?status=RESERVED&pageSize=10',
      headers: { cookie: htkdCookie },
    });
    assert.equal(reserved.statusCode, 200);
    assert.equal(reserved.json().pagination.totalItems, 1);
    assert.equal(reserved.json().data[0].id, MEMORY_SEED_IDS.reservedOutboundRequest);
    assert.equal(reserved.json().data[0].lines[0].dispatchedUnits, 0);

    const sourcesBeforeDispatch = await app.inject({
      method: 'GET',
      url: '/api/v1/store-receipt-sources?pageSize=100',
      headers: { cookie: storeCookie },
    });
    assert.equal(sourcesBeforeDispatch.statusCode, 200);
    assert.equal(
      sourcesBeforeDispatch
        .json()
        .data.some((source) => source.id === MEMORY_SEED_IDS.reservedOutboundRequest),
      false,
    );

    const storeDenied = await app.inject({
      method: 'POST',
      url: `/api/v1/outbound-requests/${MEMORY_SEED_IDS.reservedOutboundRequest}/dispatch`,
      headers: { cookie: storeCookie, 'idempotency-key': 'store-cannot-dispatch' },
      payload: { expectedVersion: 0 },
    });
    assert.equal(storeDenied.statusCode, 403);

    const dispatched = await app.inject({
      method: 'POST',
      url: `/api/v1/outbound-requests/${MEMORY_SEED_IDS.reservedOutboundRequest}/dispatch`,
      headers: { cookie: htkdCookie, 'idempotency-key': 'dispatch-outbound-0001' },
      payload: { expectedVersion: 0, dispatchNote: 'Đã bàn giao đủ hàng cho đơn vị vận chuyển' },
    });
    assert.equal(dispatched.statusCode, 200);
    assert.equal(dispatched.json().data.status, 'DISPATCHED');
    assert.equal(dispatched.json().data.version, 1);
    assert.equal(dispatched.json().data.lines[0].dispatchedUnits, 3);
    assert.equal(dispatched.json().data.lines[0].reservedUnits, 3);

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/outbound-requests/${MEMORY_SEED_IDS.reservedOutboundRequest}/dispatch`,
      headers: { cookie: htkdCookie, 'idempotency-key': 'dispatch-outbound-0001' },
      payload: { expectedVersion: 0, dispatchNote: 'Đã bàn giao đủ hàng cho đơn vị vận chuyển' },
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    assert.equal(replay.json().data.version, 1);

    const receiptSources = await app.inject({
      method: 'GET',
      url: '/api/v1/store-receipt-sources?pageSize=100',
      headers: { cookie: storeCookie },
    });
    assert.equal(receiptSources.statusCode, 200);
    assert.equal(
      receiptSources
        .json()
        .data.some((source) => source.id === MEMORY_SEED_IDS.reservedOutboundRequest),
      true,
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

    const sourcesAfterDeclaration = await app.inject({
      method: 'GET',
      url: '/api/v1/store-receipt-sources?pageSize=100',
      headers: { cookie: storeCookie },
    });
    assert.equal(sourcesAfterDeclaration.statusCode, 200);
    assert.equal(sourcesAfterDeclaration.json().pagination.totalItems, 0);

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

  test('scopes inventory reads and opens only the owning store bag with replay protection', async () => {
    const storeCookie = cookieOf(await login('ds_nvt'));
    const htkdCookie = cookieOf(await login('htkd'));

    const inventory = await app.inject({
      method: 'GET',
      url: '/api/v1/store-inventory-bags?pageSize=10',
      headers: { cookie: storeCookie },
    });
    assert.equal(inventory.statusCode, 200);
    assert.equal(inventory.json().pagination.totalItems, 1);
    const bag = inventory.json().data[0];
    assert.equal(bag.id, MEMORY_SEED_IDS.inventoryBag);
    assert.equal(bag.status, 'AVAILABLE');
    assert.equal(bag.remainingWeightKg, '24.500');
    assert.match(bag.receivedAt, /^\d{4}-\d{2}-\d{2}T/u);

    const receiveLedger = await app.inject({
      method: 'GET',
      url: `/api/v1/store-inventory-bags/${bag.id}/ledger`,
      headers: { cookie: htkdCookie },
    });
    assert.equal(receiveLedger.statusCode, 200);
    assert.equal(receiveLedger.json().pagination.totalItems, 1);
    assert.equal(receiveLedger.json().data[0].operation, 'RECEIVE');

    const crossStore = await app.inject({
      method: 'GET',
      url: `/api/v1/store-inventory-bags?storeId=${MEMORY_SEED_IDS.bdStore}`,
      headers: { cookie: storeCookie },
    });
    assert.equal(crossStore.statusCode, 403);

    const reviewerCannotOpen = await mutateInventory(
      htkdCookie,
      `/api/v1/store-inventory-bags/${bag.id}/open`,
      'inventory-open-reviewer',
      { expectedVersion: bag.version },
    );
    assert.equal(reviewerCannotOpen.statusCode, 403);

    const opened = await mutateInventory(
      storeCookie,
      `/api/v1/store-inventory-bags/${bag.id}/open`,
      'inventory-open-0001',
      { expectedVersion: bag.version },
    );
    assert.equal(opened.statusCode, 200);
    assert.equal(opened.headers['idempotency-replayed'], 'false');
    assert.equal(opened.json().data.status, 'OPEN');
    assert.equal(opened.json().data.version, 1);
    assert.equal(opened.json().data.remainingWeightKg, '24.500');

    const replay = await mutateInventory(
      storeCookie,
      `/api/v1/store-inventory-bags/${bag.id}/open`,
      'inventory-open-0001',
      { expectedVersion: bag.version },
    );
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    assert.deepEqual(replay.json().data, opened.json().data);

    const stale = await mutateInventory(
      storeCookie,
      `/api/v1/store-inventory-bags/${bag.id}/open`,
      'inventory-open-stale',
      { expectedVersion: bag.version },
    );
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'VERSION_CONFLICT');
  });

  test('creates and approves store outbounds exactly once, then records stock consumption', async () => {
    const storeCookie = cookieOf(await login('ds_nvt'));
    const htkdCookie = cookieOf(await login('htkd'));
    const bagId = MEMORY_SEED_IDS.inventoryBag;
    const payload = {
      storeId: MEMORY_SEED_IDS.nvtStore,
      inventoryLotId: bagId,
      expectedInventoryVersion: 0,
      weightKg: '5.250',
      reason: 'DISCOUNT_SALE',
      revenueVnd: 123_456,
    };

    const overdraw = await mutateInventory(
      storeCookie,
      '/api/v1/store-outbounds',
      'outbound-overdraw-0001',
      { ...payload, weightKg: '25.000' },
    );
    assert.equal(overdraw.statusCode, 409);
    assert.equal(overdraw.json().error.code, 'INSUFFICIENT_STOCK');

    const created = await mutateInventory(
      storeCookie,
      '/api/v1/store-outbounds',
      'outbound-create-0001',
      payload,
    );
    assert.equal(created.statusCode, 201);
    assert.equal(created.headers['idempotency-replayed'], 'false');
    assert.equal(created.json().data.status, 'PENDING');
    assert.equal(created.json().data.inventoryLotId, bagId);
    assert.equal(created.json().data.revenueVnd, 123_456);
    assert.equal(Number.isSafeInteger(created.json().data.revenueVnd), true);
    const outboundId = created.json().data.id;

    const createReplay = await mutateInventory(
      storeCookie,
      '/api/v1/store-outbounds',
      'outbound-create-0001',
      payload,
    );
    assert.equal(createReplay.statusCode, 201);
    assert.equal(createReplay.headers['idempotency-replayed'], 'true');
    assert.deepEqual(createReplay.json().data, created.json().data);

    const storeCannotReview = await mutateInventory(
      storeCookie,
      `/api/v1/store-outbounds/${outboundId}/review`,
      'outbound-review-store',
      { decision: 'APPROVE', note: null, expectedVersion: 0 },
    );
    assert.equal(storeCannotReview.statusCode, 403);

    const approved = await mutateInventory(
      htkdCookie,
      `/api/v1/store-outbounds/${outboundId}/review`,
      'outbound-review-0001',
      { decision: 'APPROVE', note: 'Đã đối chiếu chứng từ', expectedVersion: 0 },
    );
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().data.status, 'APPROVED');
    assert.equal(approved.json().data.version, 1);

    const reviewedReplay = await mutateInventory(
      htkdCookie,
      `/api/v1/store-outbounds/${outboundId}/review`,
      'outbound-review-0001',
      { decision: 'APPROVE', note: 'Đã đối chiếu chứng từ', expectedVersion: 0 },
    );
    assert.equal(reviewedReplay.statusCode, 200);
    assert.equal(reviewedReplay.headers['idempotency-replayed'], 'true');
    assert.deepEqual(reviewedReplay.json().data, approved.json().data);

    const staleReview = await mutateInventory(
      htkdCookie,
      `/api/v1/store-outbounds/${outboundId}/review`,
      'outbound-review-stale',
      { decision: 'APPROVE', note: null, expectedVersion: 0 },
    );
    assert.equal(staleReview.statusCode, 409);
    assert.equal(staleReview.json().error.code, 'VERSION_CONFLICT');

    const inventory = await app.inject({
      method: 'GET',
      url: `/api/v1/store-inventory-bags?storeId=${MEMORY_SEED_IDS.nvtStore}`,
      headers: { cookie: htkdCookie },
    });
    assert.equal(inventory.statusCode, 200);
    assert.equal(inventory.json().data[0].remainingWeightKg, '19.250');
    assert.equal(inventory.json().data[0].status, 'OPEN');
    assert.equal(inventory.json().data[0].version, 1);

    const ledger = await app.inject({
      method: 'GET',
      url: `/api/v1/store-inventory-bags/${bagId}/ledger`,
      headers: { cookie: htkdCookie },
    });
    assert.equal(ledger.statusCode, 200);
    assert.equal(ledger.json().pagination.totalItems, 2);
    assert.equal(ledger.json().data[0].operation, 'CONSUME');
    assert.equal(ledger.json().data[0].beforeWeightKg, '24.500');
    assert.equal(ledger.json().data[0].afterWeightKg, '19.250');
  });

  test('rejects a store outbound without consuming inventory and enforces creator scope', async () => {
    const storeCookie = cookieOf(await login('ds_nvt'));
    const htkdCookie = cookieOf(await login('htkd'));
    const adminCookie = cookieOf(await login('admin'));
    const payload = {
      storeId: MEMORY_SEED_IDS.nvtStore,
      inventoryLotId: MEMORY_SEED_IDS.inventoryBag,
      expectedInventoryVersion: 0,
      weightKg: '1.125',
      reason: 'CHARITY',
      revenueVnd: null,
    };

    const reviewerCannotCreate = await mutateInventory(
      htkdCookie,
      '/api/v1/store-outbounds',
      'outbound-create-reviewer',
      payload,
    );
    assert.equal(reviewerCannotCreate.statusCode, 403);

    const crossStore = await mutateInventory(
      storeCookie,
      '/api/v1/store-outbounds',
      'outbound-create-cross-store',
      { ...payload, storeId: MEMORY_SEED_IDS.bdStore },
    );
    assert.equal(crossStore.statusCode, 403);

    const created = await mutateInventory(
      storeCookie,
      '/api/v1/store-outbounds',
      'outbound-create-reject',
      payload,
    );
    assert.equal(created.statusCode, 201);
    const outboundId = created.json().data.id;

    const rejected = await mutateInventory(
      adminCookie,
      `/api/v1/store-outbounds/${outboundId}/review`,
      'outbound-review-reject',
      { decision: 'REJECT', note: 'Không đủ chứng từ', expectedVersion: 0 },
    );
    assert.equal(rejected.statusCode, 200);
    assert.equal(rejected.json().data.status, 'REJECTED');

    const inventory = await app.inject({
      method: 'GET',
      url: '/api/v1/store-inventory-bags',
      headers: { cookie: adminCookie },
    });
    assert.equal(inventory.json().data[0].remainingWeightKg, '24.500');
    assert.equal(inventory.json().data[0].version, 0);

    const ledger = await app.inject({
      method: 'GET',
      url: `/api/v1/store-inventory-bags/${MEMORY_SEED_IDS.inventoryBag}/ledger`,
      headers: { cookie: adminCookie },
    });
    assert.equal(ledger.json().pagination.totalItems, 1);
    assert.equal(ledger.json().data[0].operation, 'RECEIVE');
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

    const htkdDenied = await mutateWait(htkdCookie, url, 'wait-offer-htkd-denied', acceptance);
    assert.equal(htkdDenied.statusCode, 403);
    assert.equal(htkdDenied.json().error.code, 'FORBIDDEN');

    const partialAcceptance = await mutateWait(storeCookie, url, 'wait-offer-partial', {
      action: 'ACCEPT',
      accepted: { kind: 'UNIT', quantity: 2 },
    });
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
          (event) => event.action === 'PRIORITY_OFFER_ACCEPTED' && event.actorRole === 'STORE',
        ),
      true,
    );
  });

  test('cancels an active wait ticket once and replays the same mutation', async () => {
    const storeCookie = cookieOf(await login('ds_nvt'));
    const url = `/api/v1/wait-tickets/${MEMORY_SEED_IDS.cancellableWaitTicket}/cancel`;
    const payload = { reason: 'Cửa hàng không còn nhu cầu nhận mặt hàng này' };

    for (const username of ['admin', 'htkd']) {
      const denied = await mutateWait(
        cookieOf(await login(username)),
        url,
        `wait-ticket-cancel-${username}`,
        payload,
      );
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().error.code, 'FORBIDDEN');
    }

    const cancelled = await mutateWait(storeCookie, url, 'wait-ticket-cancel-0001', payload);
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.headers['idempotency-replayed'], 'false');
    assert.equal(cancelled.json().data.id, MEMORY_SEED_IDS.cancellableWaitTicket);
    assert.equal(cancelled.json().data.status, 'CANCELLED');

    const replay = await mutateWait(storeCookie, url, 'wait-ticket-cancel-0001', payload);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    assert.deepEqual(replay.json().data, cancelled.json().data);

    const keyConflict = await mutateWait(storeCookie, url, 'wait-ticket-cancel-0001', {
      reason: 'Thay đổi lý do hủy phiếu chờ',
    });
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

  test('returns JSON-safe monthly reports and enforces report scopes', async () => {
    const adminCookie = cookieOf(await login('admin'));
    const storeCookie = cookieOf(await login('ds_nvt'));
    const htkdCookie = cookieOf(await login('htkd'));

    const allStores = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/monthly?year=2026&month=9',
      headers: { cookie: adminCookie },
    });
    assert.equal(allStores.statusCode, 200);
    assert.equal(allStores.json().data.scope.kind, 'ALL');
    assert.equal(allStores.json().data.dataOrigin, 'LOCAL_TRANSACTIONAL_DATA');
    assert.equal(allStores.json().data.period.timeZone, 'Asia/Ho_Chi_Minh');
    assert.equal(typeof allStores.json().data.totals.inboundWeightGrams.value, 'string');
    assert.equal(allStores.json().data.totals.vatCostVnd.value, null);
    assert.equal(allStores.json().data.totals.vatCostVnd.unavailableReason, 'VAT_NOT_CAPTURED');
    assert.equal(allStores.json().data.ratios.effectiveCostPerSoldKgVnd.value, null);
    assert.equal(
      allStores.json().data.ratios.effectiveCostPerSoldKgVnd.unavailableReason,
      'COGS_NOT_RECORDED_PER_SALE',
    );

    const ownStoreUrl =
      `/api/v1/reports/monthly?year=2026&month=9&scopeKind=STORE` +
      `&scopeId=${MEMORY_SEED_IDS.nvtStore}`;
    const ownStore = await app.inject({
      method: 'GET',
      url: ownStoreUrl,
      headers: { cookie: storeCookie },
    });
    assert.equal(ownStore.statusCode, 200);
    assert.deepEqual(ownStore.json().data.scope, {
      kind: 'STORE',
      storeId: MEMORY_SEED_IDS.nvtStore,
    });
    assert.equal(ownStore.json().data.totals.inboundWeightGrams.source, 'STORE_RECEIPTS');

    const htkdAssignedStore = await app.inject({
      method: 'GET',
      url: ownStoreUrl,
      headers: { cookie: htkdCookie },
    });
    assert.equal(htkdAssignedStore.statusCode, 200);

    for (const [cookie, url] of [
      [storeCookie, '/api/v1/reports/monthly?year=2026&month=9'],
      [htkdCookie, '/api/v1/reports/monthly?year=2026&month=9'],
      [
        storeCookie,
        `/api/v1/reports/monthly?year=2026&month=9&scopeKind=STORE&scopeId=${MEMORY_SEED_IDS.bdStore}`,
      ],
    ]) {
      const denied = await app.inject({ method: 'GET', url, headers: { cookie } });
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().error.code, 'FORBIDDEN');
    }

    const malformed = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/monthly?year=2026&month=13&scopeKind=STORE',
      headers: { cookie: adminCookie },
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().error.code, 'VALIDATION_ERROR');
  });

  test('restricts account administration to ADMIN and never returns credentials', async () => {
    const adminCookie = cookieOf(await login('admin'));
    const storeCookie = cookieOf(await login('ds_nvt'));
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/accounts',
      headers: { cookie: storeCookie },
    });
    assert.equal(denied.statusCode, 403);

    const initial = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/accounts?pageSize=100',
      headers: { cookie: adminCookie },
    });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().pagination.totalItems, 3);
    assert.equal(JSON.stringify(initial.json()).includes('password'), false);
    assert.equal(JSON.stringify(initial.json()).includes('Hash'), false);

    const selfLock = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/accounts/${MEMORY_SEED_IDS.adminAccount}`,
      headers: { cookie: adminCookie },
      payload: { status: 'LOCKED', expectedSessionVersion: 0 },
    });
    assert.equal(selfLock.statusCode, 403);

    const missingVersion = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/accounts/${MEMORY_SEED_IDS.storeAccount}`,
      headers: { cookie: adminCookie },
      payload: { status: 'LOCKED' },
    });
    assert.equal(missingVersion.statusCode, 400);
    assert.equal(missingVersion.json().error.code, 'VALIDATION_ERROR');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/accounts',
      headers: { cookie: adminCookie, 'x-request-id': 'create-security-account' },
      payload: {
        username: 'security.htkd',
        displayName: 'Security HTKD',
        password: 'Initial-secure-password-2026!',
        role: 'HTKD',
      },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().data.sessionVersion, 0);
    assert.equal(JSON.stringify(created.json()).includes('Initial-secure-password'), false);
    const accountId = created.json().data.id;

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/accounts',
      headers: { cookie: adminCookie },
      payload: {
        username: 'security.htkd',
        displayName: 'Duplicate HTKD',
        password: 'Initial-secure-password-2026!',
        role: 'HTKD',
      },
    });
    assert.equal(duplicate.statusCode, 409);

    const accountLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'security.htkd', password: 'Initial-secure-password-2026!' },
    });
    assert.equal(accountLogin.statusCode, 200);
    const accountCookie = cookieOf(accountLogin);

    const locked = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/accounts/${accountId}`,
      headers: { cookie: adminCookie, 'x-request-id': 'lock-security-account' },
      payload: { status: 'LOCKED', expectedSessionVersion: 0 },
    });
    assert.equal(locked.statusCode, 200);
    assert.equal(locked.json().data.status, 'LOCKED');
    assert.equal(locked.json().data.sessionVersion, 1);

    const revokedSession = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: accountCookie },
    });
    assert.equal(revokedSession.statusCode, 401);

    const stalePatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/accounts/${accountId}`,
      headers: { cookie: adminCookie },
      payload: { displayName: 'Stale update', expectedSessionVersion: 0 },
    });
    assert.equal(stalePatch.statusCode, 409);
    assert.equal(stalePatch.json().error.code, 'VERSION_CONFLICT');

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/accounts?search=security.htkd&status=LOCKED',
      headers: { cookie: adminCookie },
    });
    assert.equal(filtered.statusCode, 200);
    assert.deepEqual(
      filtered.json().data.map((account) => account.id),
      [accountId],
    );
  });

  test('resets passwords with optimistic locking, revokes sessions and exposes safe audit rows', async () => {
    const adminCookie = cookieOf(await login('admin'));
    const oldPassword = 'Old-secure-password-2026!';
    const newPassword = 'New-secure-password-2026!';
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/accounts',
      headers: { cookie: adminCookie },
      payload: {
        username: 'password.reset',
        displayName: 'Password Reset',
        password: oldPassword,
        role: 'HTKD',
      },
    });
    assert.equal(created.statusCode, 201);
    const accountId = created.json().data.id;
    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'password.reset', password: oldPassword },
    });
    assert.equal(oldLogin.statusCode, 200);
    const oldCookie = cookieOf(oldLogin);

    const reset = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/accounts/${accountId}/reset-password`,
      headers: { cookie: adminCookie, 'x-request-id': 'reset-password-request' },
      payload: { newPassword, expectedSessionVersion: 0 },
    });
    assert.equal(reset.statusCode, 200);
    assert.equal(reset.json().data.accountId, accountId);
    assert.equal(reset.json().data.sessionVersion, 1);
    assert.equal(reset.json().data.sessionsRevoked, 1);
    assert.equal(JSON.stringify(reset.json()).includes(newPassword), false);

    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/auth/session',
          headers: { cookie: oldCookie },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username: 'password.reset', password: oldPassword },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username: 'password.reset', password: newPassword },
        })
      ).statusCode,
      200,
    );

    const staleReset = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/accounts/${accountId}/reset-password`,
      headers: { cookie: adminCookie },
      payload: { newPassword: 'Another-secure-password-2026!', expectedSessionVersion: 0 },
    });
    assert.equal(staleReset.statusCode, 409);

    const audit = await app.inject({
      method: 'GET',
      url:
        `/api/v1/admin/audit-logs?action=ACCOUNT_PASSWORD_RESET&entityType=user` +
        `&entityId=${accountId}`,
      headers: { cookie: adminCookie },
    });
    assert.equal(audit.statusCode, 200);
    assert.equal(audit.json().pagination.totalItems, 1);
    assert.equal(audit.json().data[0].requestId, 'reset-password-request');
    const serializedAudit = JSON.stringify(audit.json());
    assert.equal(serializedAudit.includes(newPassword), false);
    assert.equal(/passwordHash|newPassword|token/iu.test(serializedAudit), false);

    const nonAdminAudit = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs',
      headers: { cookie: cookieOf(await login('ds_nvt')) },
    });
    assert.equal(nonAdminAudit.statusCode, 403);
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

  async function mutateInventory(cookie, url, idempotencyKey, payload) {
    return app.inject({
      method: 'POST',
      url,
      headers: { cookie, 'idempotency-key': idempotencyKey },
      payload,
    });
  }

  async function mutateSession(cookie, url, idempotencyKey, payload) {
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
