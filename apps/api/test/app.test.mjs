import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { OrderSessionSchema } from '@idosi/contracts';

import { createApi } from '../dist/app.js';
import { sanitizeAuditObject } from '../dist/audit-sanitization.js';
import { MEMORY_SEED_IDS, MemoryWarehouseRepository } from '../dist/memory-repository.js';
import { RETAIL_STORE_OPERATION_FORBIDDEN_MESSAGE } from '../dist/repository.js';
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
    assert.ok(specification.json().paths['/api/v1/order-requests/{requestId}/cancel']);
    const allocationList = specification.json().paths['/api/v1/allocations'];
    assert.ok(allocationList);
    assert.equal(
      allocationList.get.parameters.find((parameter) => parameter.name === 'page').schema.maximum,
      Number.MAX_SAFE_INTEGER,
    );
    assert.ok(specification.json().paths['/api/v1/outbound-requests/{outboundRequestId}/dispatch']);
    assert.ok(specification.json().paths['/api/v1/store-transfers/destinations']);
    assert.ok(specification.json().paths['/api/v1/store-transfers/{transferId}/receive']);
    assert.ok(specification.json().paths['/api/v1/warehouse-balances']);
    assert.ok(specification.json().paths['/api/v1/inbound-receipts']);
    assert.ok(specification.json().paths['/api/v1/inbound-receipts/{receiptId}/confirm-costs']);
    assert.ok(specification.json().paths['/api/v1/admin/operational-settings']);
    assert.ok(specification.json().paths['/api/v1/admin/accounts/{htkdAccountId}/assignments']);
    assert.ok(specification.json().paths['/api/v1/integrations/idosi/order-statistics']);
    assert.ok(specification.json().paths['/api/v1/integrations/idosi/order-statistics/sync']);
  });

  test('prepares the next date instead of recreating an explicitly cancelled cycle', async () => {
    await app.close();
    repository = await MemoryWarehouseRepository.create({
      bootstrapPassword: PASSWORD,
      now: () => new Date('2020-04-05T07:00:00+07:00'),
    });
    app = await createApi({ repository, corsOrigin: 'http://localhost:5173' });
    const adminCookie = cookieOf(await login('admin'));
    const storeCookie = cookieOf(await login('ds_nvt'));
    const cancelled = await mutateSession(
      adminCookie,
      `/api/v1/order-sessions/${MEMORY_SEED_IDS.orderSession}/transition`,
      'cancel-before-snapshot',
      { status: 'CANCELLED', expectedVersion: 0, reason: 'Admin hủy phiên trong ngày' },
    );
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    const prepared = await app.inject({
      method: 'POST',
      url: '/api/v1/ordering-context',
      headers: { cookie: storeCookie },
      payload: { storeId: MEMORY_SEED_IDS.nvtStore },
    });
    assert.equal(prepared.statusCode, 200, prepared.body);
    assert.equal(prepared.json().data.session.businessDate, '2020-04-06');
  });

  test('prepares continuous ordering with scoped stores, two slots and cutoff-safe replay', async () => {
    const storeCookie = cookieOf(await login('ds_nvt'));
    const headers = { cookie: storeCookie };
    const prepare = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/ordering-context',
        headers,
        payload: { storeId: MEMORY_SEED_IDS.nvtStore },
      });
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/ordering-context',
          payload: { storeId: MEMORY_SEED_IDS.nvtStore },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/ordering-context',
          headers,
          payload: { storeId: MEMORY_SEED_IDS.bdStore },
        })
      ).statusCode,
      403,
    );
    const initial = await prepare();
    assert.equal(initial.statusCode, 200, initial.body);
    const context = initial.json().data;
    assert.equal(context.maxSlots, 2);
    assert.equal(context.usedSlots, 0);
    assert.equal((await prepare()).json().data.session.id, context.session.id);
    const payload = {
      businessSessionId: context.session.id,
      storeId: MEMORY_SEED_IDS.nvtStore,
      items: [{ productId: await firstProductId(storeCookie), quantity: 1 }],
    };
    const submit = (key) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/order-requests',
        headers: { ...headers, 'idempotency-key': key },
        payload,
      });
    const first = await submit('continuous-first-order');
    assert.equal(first.statusCode, 201, first.body);
    assert.equal((await prepare()).json().data.usedSlots, 1);
    assert.equal((await submit('continuous-second-order')).statusCode, 201);
    assert.equal(
      (await submit('continuous-third-order')).json().error.code,
      'REQUEST_LIMIT_REACHED',
    );
    assert.equal((await prepare()).json().data.usedSlots, 2);
    const adminCookie = cookieOf(await login('admin'));
    const closed = await app.inject({
      method: 'POST',
      url: `/api/v1/order-sessions/${context.session.id}/transition`,
      headers: { cookie: adminCookie, 'idempotency-key': 'continuous-close-session' },
      payload: { status: 'CLOSED', expectedVersion: context.session.version },
    });
    assert.equal(closed.statusCode, 200, closed.body);
    const replay = await submit('continuous-first-order');
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    const next = (await prepare()).json().data;
    assert.notEqual(next.session.id, context.session.id);
    assert.equal(next.usedSlots, 2);
  });

  test('versions operational settings for ADMIN without accepting or returning secrets', async () => {
    await app.close();
    app = await createApi({
      repository,
      corsOrigin: 'http://localhost:5173',
      idosiIntegrationEndpoint:
        'https://idosi.io.vn/api/integrations/warehouse/v1/order-statistics',
      idosiIntegrationSecretConfigured: true,
    });
    const adminCookie = cookieOf(await login('admin'));
    const storeCookie = cookieOf(await login('ds_nvt'));

    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operational-settings',
      headers: { cookie: storeCookie },
    });
    assert.equal(denied.statusCode, 403);

    const initial = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operational-settings?historyLimit=10',
      headers: { cookie: adminCookie },
    });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.headers['cache-control'], 'no-store');
    assert.equal(initial.json().data.current.version, 1);
    assert.equal(initial.json().data.current.snapshotTime, '08:00');
    assert.equal(initial.json().data.current.cutoffTime, '09:00');
    assert.deepEqual(initial.json().data.integration, {
      endpoint: 'https://idosi.io.vn/api/integrations/warehouse/v1/order-statistics',
      status: 'CONFIGURED',
    });
    assert.equal(JSON.stringify(initial.json()).includes('integrationSecret'), false);
    assert.equal(JSON.stringify(initial.json()).includes('secretConfigured'), false);

    const invalidSchedule = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/operational-settings',
      headers: { cookie: adminCookie },
      payload: {
        expectedVersion: 1,
        timezone: 'Asia/Ho_Chi_Minh',
        snapshotTime: '09:00',
        cutoffTime: '08:00',
        maxRequestsPerStore: 2,
        policyVersion: 'ALLOC-v1.3',
        idosiSyncIntervalMinutes: 15,
      },
    });
    assert.equal(invalidSchedule.statusCode, 400);
    assert.equal(invalidSchedule.json().error.code, 'VALIDATION_ERROR');

    const secretInput = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/operational-settings',
      headers: { cookie: adminCookie },
      payload: {
        expectedVersion: 1,
        timezone: 'Asia/Ho_Chi_Minh',
        snapshotTime: '08:00',
        cutoffTime: '09:00',
        maxRequestsPerStore: 2,
        policyVersion: 'ALLOC-v1.3',
        idosiSyncIntervalMinutes: 15,
        integrationSecret: 'must-not-be-accepted',
      },
    });
    assert.equal(secretInput.statusCode, 400);

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/operational-settings',
      headers: { cookie: adminCookie, 'x-request-id': 'settings-update-request' },
      payload: {
        expectedVersion: 1,
        timezone: 'Asia/Ho_Chi_Minh',
        snapshotTime: '07:45',
        cutoffTime: '08:45',
        maxRequestsPerStore: 3,
        policyVersion: 'ALLOC-v1.3',
        idosiSyncIntervalMinutes: 30,
      },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().data.current.version, 2);
    assert.equal(updated.json().data.current.createdByAccountId, MEMORY_SEED_IDS.adminAccount);
    assert.equal(updated.json().data.current.requestId, 'settings-update-request');
    assert.deepEqual(
      updated.json().data.history.map((item) => item.version),
      [2, 1],
    );

    const stale = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/operational-settings',
      headers: { cookie: adminCookie },
      payload: {
        expectedVersion: 1,
        timezone: 'Asia/Ho_Chi_Minh',
        snapshotTime: '08:00',
        cutoffTime: '09:00',
        maxRequestsPerStore: 2,
        policyVersion: 'ALLOC-v1.4',
        idosiSyncIntervalMinutes: 15,
      },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'VERSION_CONFLICT');

    const audit = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs?action=OPERATIONAL_SETTINGS_VERSION_CREATED',
      headers: { cookie: adminCookie },
    });
    assert.equal(audit.statusCode, 200);
    assert.equal(audit.json().pagination.totalItems, 1);
    assert.equal(audit.json().data[0].requestId, 'settings-update-request');
  });

  test('upserts scoped IDOSI aggregates without changing inventory and keeps stale data on failure', async () => {
    await app.close();
    let remoteRevenue = 300_000;
    let shouldFail = false;
    const remoteFetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get('storeId'), 'S01');
      assert.equal(url.searchParams.get('period'), '2026-09');
      assert.equal(url.toString().includes('warehouse-server-secret'), false);
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        'Bearer warehouse-server-secret',
      );
      if (shouldFail) return new Response('{}', { status: 503 });
      const payload = idosiStatisticsPayload(remoteRevenue);
      return new Response(
        JSON.stringify({ ...payload, storeId: 'S01', store: { ...payload.store, id: 'S01' } }),
      );
    };
    app = await createApi({
      repository,
      corsOrigin: 'http://localhost:5173',
      idosiIntegrationSecret: 'warehouse-server-secret',
      idosiStoreIdMap: { DS_NVT: 'S01' },
      idosiFetch: remoteFetch,
    });
    const storeCookie = cookieOf(await login('ds_nvt'));
    const adminCookie = cookieOf(await login('admin'));
    const query =
      `/api/v1/integrations/idosi/order-statistics?storeId=${MEMORY_SEED_IDS.nvtStore}` +
      '&period=2026-09';
    const scope = {
      storeId: MEMORY_SEED_IDS.nvtStore,
      period: '2026-09',
      date: null,
      shiftId: null,
      paymentMethod: null,
    };

    assert.equal((await app.inject({ method: 'GET', url: query })).statusCode, 401);
    const initial = await app.inject({
      method: 'GET',
      url: query,
      headers: { cookie: storeCookie },
    });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().data.freshness, 'EMPTY');
    assert.equal(initial.json().data.integrationStatus, 'CONFIGURED');

    const inventoryBefore = await app.inject({
      method: 'GET',
      url: `/api/v1/store-inventory-bags?storeId=${MEMORY_SEED_IDS.nvtStore}`,
      headers: { cookie: storeCookie },
    });
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/idosi/order-statistics/sync',
      headers: { cookie: storeCookie, 'x-request-id': 'idosi-sync-first' },
      payload: scope,
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['cache-control'], 'no-store');
    assert.equal(first.json().data.freshness, 'CURRENT');
    assert.equal(first.json().data.snapshot.storeId, MEMORY_SEED_IDS.nvtStore);
    assert.equal(first.json().data.snapshot.payload.storeId, 'S01');
    assert.equal(first.json().data.snapshot.payload.totals.revenue, 300_000);
    assert.equal(first.json().data.snapshot.payload.totals.revenueByType.SALE_PIECE, 30_000);
    assert.equal(first.json().data.snapshot.payload.products.salePieceQuantity, 3);
    assert.equal(
      first.json().data.snapshot.payload.totals.weight.byRevenueType.SALE_KG.actualKg,
      2.5,
    );
    const snapshotId = first.json().data.snapshot.id;

    // A persisted pre-contract snapshot must ask for a refresh instead of showing fake zeroes.
    const stored = [...repository.idosiStatisticsSnapshots.values()][0];
    delete stored.payload.totals.unclassifiedRevenue;
    const needsResync = await app.inject({
      method: 'GET',
      url: query,
      headers: { cookie: storeCookie },
    });
    assert.equal(needsResync.json().data.freshness, 'RESYNC_REQUIRED');
    assert.equal(needsResync.json().data.snapshot, null);

    remoteRevenue = 450_000;
    const replacement = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/idosi/order-statistics/sync',
      headers: { cookie: storeCookie, 'x-request-id': 'idosi-sync-replacement' },
      payload: scope,
    });
    assert.equal(replacement.statusCode, 200);
    assert.equal(replacement.json().data.snapshot.id, snapshotId);
    assert.equal(replacement.json().data.snapshot.payload.totals.revenue, 450_000);

    const inventoryAfter = await app.inject({
      method: 'GET',
      url: `/api/v1/store-inventory-bags?storeId=${MEMORY_SEED_IDS.nvtStore}`,
      headers: { cookie: storeCookie },
    });
    assert.deepEqual(inventoryAfter.json(), inventoryBefore.json());

    shouldFail = true;
    const failed = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/idosi/order-statistics/sync',
      headers: { cookie: storeCookie, 'x-request-id': 'idosi-sync-failed' },
      payload: scope,
    });
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.json().error.code, 'INTEGRATION_UNAVAILABLE');
    const stale = await app.inject({ method: 'GET', url: query, headers: { cookie: storeCookie } });
    assert.equal(stale.json().data.freshness, 'STALE');
    assert.equal(stale.json().data.snapshot.payload.totals.revenue, 450_000);
    assert.equal(stale.json().data.latestAttempt.status, 'FAILED');

    const summaryUrl = '/api/v1/integrations/idosi/statistics-summary?period=2026-09&pageSize=100';
    assert.equal((await app.inject({ method: 'GET', url: summaryUrl })).statusCode, 401);
    const summary = await app.inject({
      method: 'GET',
      url: summaryUrl,
      headers: { cookie: storeCookie },
    });
    assert.equal(summary.statusCode, 200, summary.body);
    assert.equal(summary.headers['cache-control'], 'no-store');
    assert.equal(summary.json().data.length, 1);
    assert.equal(summary.json().data[0].scope.storeId, MEMORY_SEED_IDS.nvtStore);
    assert.equal(summary.json().data[0].snapshot.payload.totals.revenue, 450_000);
    assert.equal(summary.json().data[0].freshness, 'STALE');
    const deniedSummary = await app.inject({
      method: 'GET',
      url: summaryUrl + `&storeId=${MEMORY_SEED_IDS.bdStore}`,
      headers: { cookie: storeCookie },
    });
    assert.equal(deniedSummary.statusCode, 403);
    const allSummary = await app.inject({
      method: 'GET',
      url: summaryUrl,
      headers: { cookie: adminCookie },
    });
    assert.ok(allSummary.json().data.length > 1);
    assert.ok(
      allSummary
        .json()
        .data.some((state) => state.snapshot === null && state.freshness === 'EMPTY'),
    );
    const anotherMonth = await app.inject({
      method: 'GET',
      url: summaryUrl.replace('2026-09', '2026-08'),
      headers: { cookie: storeCookie },
    });
    assert.equal(anotherMonth.json().data[0].snapshot, null);
    const firstPage = await app.inject({
      method: 'GET',
      url: summaryUrl.replace('pageSize=100', 'pageSize=1'),
      headers: { cookie: adminCookie },
    });
    assert.equal(firstPage.json().data.length, 1);
    assert.equal(firstPage.json().pagination.totalItems, allSummary.json().data.length);

    const audit = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs?entityType=idosi_statistics_snapshot&pageSize=100',
      headers: { cookie: adminCookie },
    });
    assert.equal(audit.statusCode, 200);
    assert.equal(audit.json().pagination.totalItems, 2);
    assert.equal(JSON.stringify(audit.json()).includes('warehouse-server-secret'), false);

    const deniedScope = await app.inject({
      method: 'GET',
      url:
        `/api/v1/integrations/idosi/order-statistics?storeId=${MEMORY_SEED_IDS.bdStore}` +
        '&period=2026-09',
      headers: { cookie: storeCookie },
    });
    assert.equal(deniedScope.statusCode, 403);
  });

  test('fails closed before outbound sync when the server secret is absent', async () => {
    const storeCookie = cookieOf(await login('ds_nvt'));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/idosi/order-statistics/sync',
      headers: { cookie: storeCookie },
      payload: {
        storeId: MEMORY_SEED_IDS.nvtStore,
        period: '2026-09',
        date: null,
        shiftId: null,
        paymentMethod: null,
      },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'INTEGRATION_NOT_CONFIGURED');
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

  test('keeps account sessions and logout independent across browser tabs', async () => {
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/session',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-headers': 'x-idosi-tab-id',
      },
    });
    assert.equal(preflight.statusCode, 204);
    assert.match(String(preflight.headers['access-control-allow-headers']), /x-idosi-tab-id/u);
    const setupAdminCookie = cookieOf(await login('admin'));
    const wholesaleAccount = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/accounts',
      headers: { cookie: setupAdminCookie },
      payload: {
        username: 'wholesale.tab',
        displayName: 'Bàn cửa hàng sỉ',
        password: PASSWORD,
        role: 'WHOLESALE',
      },
    });
    assert.equal(wholesaleAccount.statusCode, 201, wholesaleAccount.body);
    const tabIds = {
      admin: 'a'.repeat(32),
      htkd: 'b'.repeat(32),
      store: 'c'.repeat(32),
      wholesale: 'd'.repeat(32),
      empty: 'e'.repeat(32),
    };
    const tabLogin = async (username, tabId) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-idosi-tab-id': tabId },
        payload: { username, password: PASSWORD },
      });
    const logins = await Promise.all([
      tabLogin('admin', tabIds.admin),
      tabLogin('htkd', tabIds.htkd),
      tabLogin('ds_nvt', tabIds.store),
      tabLogin('wholesale.tab', tabIds.wholesale),
    ]);
    for (const [index, loginResponse] of logins.entries()) {
      assert.equal(loginResponse.statusCode, 200, loginResponse.body);
      assert.match(
        cookieOf(loginResponse),
        new RegExp(`^idosi_session_${Object.values(tabIds)[index]}=`),
      );
      assert.match(String(loginResponse.headers['set-cookie']), /HttpOnly/u);
    }
    const sharedCookies = logins.map(cookieOf).join('; ');
    const requestAs = (tabId, url = '/api/v1/auth/session') =>
      app.inject({
        method: 'GET',
        url,
        headers: { cookie: sharedCookies, 'x-idosi-tab-id': tabId },
      });

    assert.equal((await requestAs(tabIds.admin)).json().data.principal.role, 'ADMIN');
    assert.equal((await requestAs(tabIds.htkd)).json().data.principal.role, 'HTKD');
    assert.equal((await requestAs(tabIds.store)).json().data.principal.role, 'STORE');
    assert.equal((await requestAs(tabIds.wholesale)).json().data.principal.role, 'WHOLESALE');
    assert.equal((await requestAs(tabIds.empty)).statusCode, 401);
    assert.equal((await requestAs(tabIds.store, '/api/v1/admin/accounts')).statusCode, 403);
    assert.equal((await requestAs(tabIds.admin, '/api/v1/admin/accounts')).statusCode, 200);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: sharedCookies, 'x-idosi-tab-id': tabIds.htkd },
    });
    assert.equal(logout.statusCode, 200);
    assert.match(
      String(logout.headers['set-cookie']),
      new RegExp(`^idosi_session_${tabIds.htkd}=`),
    );
    assert.equal((await requestAs(tabIds.htkd)).statusCode, 401);
    assert.equal((await requestAs(tabIds.admin)).statusCode, 200);
    assert.equal((await requestAs(tabIds.store)).statusCode, 200);
    assert.equal((await requestAs(tabIds.wholesale)).statusCode, 200);

    const invalid = await tabLogin('admin', 'invalid');
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, 'VALIDATION_ERROR');
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

  test('lists allocation results with role scope, filters and pagination', async () => {
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/allocations' });
    assert.equal(unauthenticated.statusCode, 401);

    const storeCookie = cookieOf(await login('ds_nvt'));
    const ownResults = await app.inject({
      method: 'GET',
      url: '/api/v1/allocations?page=1&pageSize=100',
      headers: { cookie: storeCookie, accept: 'application/vnd.idosi.allocations.v2+json' },
    });
    assert.equal(ownResults.statusCode, 200);
    assert.equal(ownResults.headers['cache-control'], 'no-store');
    assert.equal(ownResults.json().pagination.totalItems, 1);
    assert.deepEqual(
      ownResults.json().data.map((result) => result.storeId),
      [MEMORY_SEED_IDS.nvtStore],
    );
    assert.deepEqual(ownResults.json().data[0], {
      id: MEMORY_SEED_IDS.allocationLine,
      allocationRunId: MEMORY_SEED_IDS.allocationRun,
      sessionId: MEMORY_SEED_IDS.orderSession,
      mergedOrderId: '11000000-0000-4000-8000-400000000001',
      storeId: MEMORY_SEED_IDS.nvtStore,
      productId: ownResults.json().data[0].productId,
      priority: 'P1',
      roundNumber: 1,
      sequenceInRound: 1,
      rounds: [
        { roundNumber: 1, allocatedQuantity: 1 },
        { roundNumber: 2, allocatedQuantity: 1 },
        { roundNumber: 3, allocatedQuantity: 1 },
        { roundNumber: 4, allocatedQuantity: 1 },
        { roundNumber: 5, allocatedQuantity: 1 },
      ],
      requestedQuantity: 5,
      allocatedQuantity: 5,
      waitlistedQuantity: 0,
      status: 'ALLOCATED',
      reasonCode: 'ALLOCATED_BY_PRIORITY_ROUND_ROBIN',
      createdAt: ownResults.json().data[0].createdAt,
    });

    const legacyResults = await app.inject({
      method: 'GET',
      url: '/api/v1/allocations?page=1&pageSize=100',
      headers: { cookie: storeCookie },
    });
    const {
      rounds: _rounds,
      appliedPriority: _appliedPriority,
      ...legacyResult
    } = ownResults.json().data[0];
    assert.deepEqual(legacyResults.json().data[0], legacyResult);
    for (const [accept, hasRounds] of [
      ['application/vnd.idosi.allocations.v2+json, application/json;q=0.9', true],
      ['application/vnd.idosi.allocations.v2+json; q=0.5', true],
      ['application/vnd.idosi.allocations.v2+json;q=0, application/json', false],
      ['application/vnd.idosi.allocations.v2+json;q=invalid', false],
    ]) {
      const negotiated = await app.inject({
        method: 'GET',
        url: '/api/v1/allocations?page=1&pageSize=100',
        headers: { cookie: storeCookie, accept },
      });
      assert.equal(negotiated.statusCode, 200);
      assert.equal(Object.hasOwn(negotiated.json().data[0], 'rounds'), hasRounds);
      assert.equal(
        negotiated.headers['content-type'].split(';')[0],
        hasRounds ? 'application/vnd.idosi.allocations.v2+json' : 'application/json',
      );
    }

    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/allocations?storeId=${MEMORY_SEED_IDS.bdStore}`,
      headers: { cookie: storeCookie },
    });
    assert.equal(denied.statusCode, 403);

    const htkdCookie = cookieOf(await login('htkd'));
    const assignedResults = await app.inject({
      method: 'GET',
      url: '/api/v1/allocations?pageSize=100',
      headers: { cookie: htkdCookie },
    });
    assert.equal(assignedResults.statusCode, 200);
    assert.equal(assignedResults.json().pagination.totalItems, 2);
    assert.deepEqual(
      [...new Set(assignedResults.json().data.map((result) => result.storeId))].sort(),
      [MEMORY_SEED_IDS.bdStore, MEMORY_SEED_IDS.nvtStore].sort(),
    );

    const adminCookie = cookieOf(await login('admin'));
    const filtered = await app.inject({
      method: 'GET',
      url:
        `/api/v1/allocations?sessionId=${MEMORY_SEED_IDS.orderSession}` +
        `&storeId=${MEMORY_SEED_IDS.bdStore}&status=PARTIAL&priority=P2`,
      headers: { cookie: adminCookie },
    });
    assert.equal(filtered.statusCode, 200);
    assert.deepEqual(
      filtered.json().data.map((result) => result.id),
      [MEMORY_SEED_IDS.bdAllocationLine],
    );

    const page = await app.inject({
      method: 'GET',
      url: '/api/v1/allocations?page=2&pageSize=1',
      headers: { cookie: adminCookie },
    });
    assert.deepEqual(page.json().pagination, {
      page: 2,
      pageSize: 1,
      totalItems: 3,
      totalPages: 3,
    });
    assert.equal(page.json().data.length, 1);

    const invalidStatus = await app.inject({
      method: 'GET',
      url: '/api/v1/allocations?status=RESERVED',
      headers: { cookie: adminCookie },
    });
    assert.equal(invalidStatus.statusCode, 400);

    const unsafePage = await app.inject({
      method: 'GET',
      url: '/api/v1/allocations?page=9007199254740992&pageSize=1',
      headers: { cookie: adminCookie },
    });
    assert.equal(unsafePage.statusCode, 400);
    assert.equal(unsafePage.json().error.code, 'VALIDATION_ERROR');
  });

  test('blocks wholesale STORE actors and inactive stores from protected retail actions', async () => {
    const storeCookie = cookieOf(await login('ds_nvt'));
    const products = await app.inject({
      method: 'GET',
      url: '/api/v1/products?pageSize=100',
      headers: { cookie: storeCookie },
    });
    const [firstProduct, secondProduct] = products.json().data;
    assert.ok(firstProduct);
    assert.ok(secondProduct);

    repository.setStoreOperationEligibility(MEMORY_SEED_IDS.nvtStore, { kind: 'WHOLESALE' });
    const unknownTransferId = '10000000-0000-4000-8000-999999999998';

    const attempts = [
      () => submitOrder(storeCookie, 'wholesale-order-request', orderPayload(firstProduct.id, 1)),
      () =>
        mutateReceipt(storeCookie, 'POST', '/api/v1/store-receipts', 'wholesale-receipt-declare', {
          storeId: MEMORY_SEED_IDS.nvtStore,
          outboundRequestId: MEMORY_SEED_IDS.secondOutboundRequest,
          lines: [{ productId: secondProduct.id, approvedUnits: 2, receivedUnits: 2 }],
          discrepancyNote: null,
        }),
      () =>
        mutateReceipt(
          storeCookie,
          'POST',
          `/api/v1/store-receipts/${MEMORY_SEED_IDS.storeReceipt}/submit`,
          'wholesale-receipt-submit',
          {
            lines: [{ productId: firstProduct.id, approvedUnits: 5, receivedUnits: 4 }],
            discrepancyNote: 'Thiếu một bao khi giao nhận',
            expectedVersion: 0,
          },
        ),
      () =>
        mutateInventory(
          storeCookie,
          `/api/v1/store-inventory-bags/${MEMORY_SEED_IDS.inventoryBag}/open`,
          'wholesale-inventory-open',
          { expectedVersion: 0 },
        ),
      () =>
        mutateInventory(storeCookie, '/api/v1/store-outbounds', 'wholesale-outbound-create', {
          storeId: MEMORY_SEED_IDS.nvtStore,
          inventoryLotId: MEMORY_SEED_IDS.inventoryBag,
          expectedInventoryVersion: 0,
          weightKg: '1.000',
          reason: 'SALE_KG',
          revenueVnd: 10_000,
        }),
      () =>
        mutateWait(
          storeCookie,
          `/api/v1/wait-tickets/${MEMORY_SEED_IDS.cancellableWaitTicket}/cancel`,
          'wholesale-wait-cancel',
          { reason: 'Cửa hàng không còn nhu cầu nhận mặt hàng này' },
        ),
      () =>
        mutateWait(
          storeCookie,
          `/api/v1/priority-offers/${MEMORY_SEED_IDS.priorityOffer}/respond`,
          'wholesale-offer-response',
          { action: 'ACCEPT', accepted: { kind: 'UNIT', quantity: 3 } },
        ),
      () =>
        app.inject({
          method: 'GET',
          url: '/api/v1/store-transfers/destinations',
          headers: { cookie: storeCookie },
        }),
      () =>
        mutateTransfer(storeCookie, '/api/v1/store-transfers', 'wholesale-transfer-create', {
          sourceStoreId: MEMORY_SEED_IDS.nvtStore,
          destinationStoreId: MEMORY_SEED_IDS.bdStore,
          sourceInventoryBagId: MEMORY_SEED_IDS.inventoryBag,
          weightKg: '1.000',
          expectedSourceBagVersion: 0,
          note: 'Bổ sung tồn kho cửa hàng Bình Dương',
        }),
      () =>
        mutateTransfer(
          storeCookie,
          `/api/v1/store-transfers/${unknownTransferId}/dispatch`,
          'wholesale-transfer-dispatch',
          { expectedVersion: 0, expectedSourceBagVersion: 0 },
        ),
      () =>
        mutateTransfer(
          storeCookie,
          `/api/v1/store-transfers/${unknownTransferId}/receive`,
          'wholesale-transfer-receive',
          { expectedVersion: 0 },
        ),
      () =>
        mutateTransfer(
          storeCookie,
          `/api/v1/store-transfers/${unknownTransferId}/cancel`,
          'wholesale-transfer-cancel',
          { expectedVersion: 0, reason: 'Cửa hàng không còn nhu cầu điều chuyển' },
        ),
    ];

    for (const attempt of attempts) {
      const response = await attempt();
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error.code, 'FORBIDDEN');
      assert.equal(response.json().error.message, RETAIL_STORE_OPERATION_FORBIDDEN_MESSAGE);
    }

    repository.setStoreOperationEligibility(MEMORY_SEED_IDS.nvtStore, {
      kind: 'RETAIL',
      status: 'INACTIVE',
    });
    const inactive = await submitOrder(
      storeCookie,
      'inactive-store-order-request',
      orderPayload(firstProduct.id, 1),
    );
    assert.equal(inactive.statusCode, 403);
    assert.equal(inactive.json().error.code, 'FORBIDDEN');
    assert.equal(inactive.json().error.message, RETAIL_STORE_OPERATION_FORBIDDEN_MESSAGE);
    const inactiveTransferDestinations = await app.inject({
      method: 'GET',
      url: '/api/v1/store-transfers/destinations',
      headers: { cookie: storeCookie },
    });
    assert.equal(inactiveTransferDestinations.statusCode, 403);
    assert.equal(inactiveTransferDestinations.json().error.code, 'FORBIDDEN');
    assert.equal(
      inactiveTransferDestinations.json().error.message,
      RETAIL_STORE_OPERATION_FORBIDDEN_MESSAGE,
    );

    const adminCookie = cookieOf(await login('admin'));
    const htkdCookie = cookieOf(await login('htkd'));
    for (const [role, cookie] of [
      ['admin', adminCookie],
      ['htkd', htkdCookie],
    ]) {
      const delegatedInactive = await submitOrder(
        cookie,
        `${role}-inactive-store-order-request`,
        orderPayload(firstProduct.id, 1),
      );
      assert.equal(delegatedInactive.statusCode, 403);
      assert.equal(delegatedInactive.json().error.code, 'FORBIDDEN');
    }
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
    assert.doesNotThrow(() => OrderSessionSchema.parse(sessions.json().data[0]));

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

  test('persists line notes and cancels a request without reopening its quota slot', async () => {
    const storeCookie = cookieOf(await login('ds_nvt'));
    const adminCookie = cookieOf(await login('admin'));
    const productId = await firstProductId(storeCookie);
    const first = await submitOrder(storeCookie, 'request-with-note', {
      ...orderPayload(productId, 2),
      items: [{ productId, quantity: 2, note: 'Ưu tiên kiện loại A' }],
    });
    assert.equal(first.statusCode, 201);
    assert.equal(first.json().data.lines[0].note, 'Ưu tiên kiện loại A');
    const requestId = first.json().data.id;

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/order-requests/${requestId}/cancel`,
      headers: { cookie: storeCookie, 'idempotency-key': 'cancel-order-request' },
      payload: { reason: 'Cửa hàng nhập nhầm nhu cầu' },
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().data.status, 'CANCELLED');
    assert.equal(cancelled.json().data.cancellationReason, 'Cửa hàng nhập nhầm nhu cầu');
    assert.ok(cancelled.json().data.cancelledAt);

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/order-requests/${requestId}/cancel`,
      headers: { cookie: storeCookie, 'idempotency-key': 'cancel-order-request' },
      payload: { reason: 'Cửa hàng nhập nhầm nhu cầu' },
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.headers['idempotency-replayed'], 'true');

    const second = await submitOrder(
      storeCookie,
      'second-slot-after-cancel',
      orderPayload(productId, 1),
    );
    assert.equal(second.statusCode, 201);
    assert.equal(second.json().data.requestSequence, 2);
    const third = await submitOrder(
      storeCookie,
      'third-slot-after-cancel',
      orderPayload(productId, 1),
    );
    assert.equal(third.statusCode, 409);
    assert.equal(third.json().error.code, 'REQUEST_LIMIT_REACHED');

    const audit = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/audit-logs?action=ORDER_REQUEST_CANCELLED&entityId=${requestId}`,
      headers: { cookie: adminCookie },
    });
    assert.equal(audit.statusCode, 200);
    assert.equal(audit.json().pagination.totalItems, 1);
    assert.equal(audit.json().data[0].metadata.reason, 'Cửa hàng nhập nhầm nhu cầu');
  });

  test('rejects cancellation at the request cutoff without changing the submitted request', async () => {
    await app.close();
    let currentTime = new Date('2026-09-17T05:00:00.000Z');
    repository = await MemoryWarehouseRepository.create({
      bootstrapPassword: PASSWORD,
      now: () => currentTime,
    });
    app = await createApi({ repository, corsOrigin: 'http://localhost:5173' });

    const storeCookie = cookieOf(await login('ds_nvt'));
    const sessions = await app.inject({
      method: 'GET',
      url: '/api/v1/order-sessions?status=OPEN&page=1&pageSize=10',
      headers: { cookie: storeCookie },
    });
    assert.equal(sessions.statusCode, 200);
    const session = sessions.json().data[0];
    assert.ok(session);

    const productId = await firstProductId(storeCookie);
    const created = await submitOrder(
      storeCookie,
      'cutoff-cancellation-request',
      orderPayload(productId, 1),
    );
    assert.equal(created.statusCode, 201);

    currentTime = new Date(session.requestClosesAt);
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/v1/order-requests/${created.json().data.id}/cancel`,
      headers: { cookie: storeCookie, 'idempotency-key': 'cutoff-cancellation' },
      payload: { reason: 'Không được phép hủy sau giờ chốt' },
    });
    assert.equal(rejected.statusCode, 409);
    assert.equal(rejected.json().error.code, 'CONFLICT');

    const persisted = await app.inject({
      method: 'GET',
      url:
        `/api/v1/order-requests?sessionId=${session.id}` +
        `&storeId=${MEMORY_SEED_IDS.nvtStore}&page=1&pageSize=20`,
      headers: { cookie: storeCookie },
    });
    assert.equal(persisted.statusCode, 200);
    assert.equal(
      persisted.json().data.find((request) => request.id === created.json().data.id)?.status,
      'SUBMITTED',
    );
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

  test('scopes held priority goods to the stores the account may see', async () => {
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/held-allocations' });
    assert.equal(unauthenticated.statusCode, 401);

    const storeCookie = cookieOf(await login('ds_nvt'));
    const own = await app.inject({
      method: 'GET',
      url: `/api/v1/held-allocations?storeId=${MEMORY_SEED_IDS.nvtStore}`,
      headers: { cookie: storeCookie },
    });
    assert.equal(own.statusCode, 200);
    assert.deepEqual(own.json(), { data: [] });

    const otherStore = await app.inject({
      method: 'GET',
      url: `/api/v1/held-allocations?storeId=${MEMORY_SEED_IDS.bdStore}`,
      headers: { cookie: storeCookie },
    });
    assert.equal(otherStore.statusCode, 403);

    const adminCookie = cookieOf(await login('admin'));
    const all = await app.inject({
      method: 'GET',
      url: '/api/v1/held-allocations',
      headers: { cookie: adminCookie },
    });
    assert.equal(all.statusCode, 200);
    assert.ok(Array.isArray(all.json().data));

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/held-allocations?storeId=not-an-id',
      headers: { cookie: adminCookie },
    });
    assert.equal(invalid.statusCode, 400);
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
    assert.equal(source.requestNumber, 'PXK-000002');
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
      reason: 'SALE_KG',
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

  test('records sale by piece with count and rejects a missing count', async () => {
    const storeCookie = cookieOf(await login('ds_nvt'));
    const htkdCookie = cookieOf(await login('htkd'));
    const payload = {
      storeId: MEMORY_SEED_IDS.nvtStore,
      inventoryLotId: MEMORY_SEED_IDS.inventoryBag,
      expectedInventoryVersion: 0,
      weightKg: '1.250',
      reason: 'SALE_PIECE',
      revenueVnd: 100_000,
    };
    const missingCount = await mutateInventory(
      storeCookie,
      '/api/v1/store-outbounds',
      'outbound-piece-missing-count',
      payload,
    );
    assert.equal(missingCount.statusCode, 400);

    const retiredReason = await mutateInventory(
      storeCookie,
      '/api/v1/store-outbounds',
      'outbound-retired-reason',
      { ...payload, reason: 'TORN' },
    );
    assert.equal(retiredReason.statusCode, 400);

    const created = await mutateInventory(
      storeCookie,
      '/api/v1/store-outbounds',
      'outbound-piece-create',
      { ...payload, pieceCount: 2 },
    );
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().data.reason, 'SALE_PIECE');
    assert.equal(created.json().data.pieceCount, 2);

    const approved = await mutateInventory(
      htkdCookie,
      `/api/v1/store-outbounds/${created.json().data.id}/review`,
      'outbound-piece-approve',
      { decision: 'APPROVE', note: null, expectedVersion: 0 },
    );
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().data.pieceCount, 2);

    const inventory = await app.inject({
      method: 'GET',
      url: '/api/v1/store-inventory-bags',
      headers: { cookie: storeCookie },
    });
    assert.equal(inventory.json().data[0].remainingWeightKg, '23.250');

    const cancelled = await mutateInventory(
      storeCookie,
      '/api/v1/store-outbounds',
      'outbound-cancel-create',
      { ...payload, reason: 'CANCEL', revenueVnd: null, expectedInventoryVersion: 1 },
    );
    assert.equal(cancelled.statusCode, 201);
    assert.equal(cancelled.json().data.reason, 'CANCEL');
    assert.equal(cancelled.json().data.pieceCount, null);
  });

  test('transfers weighed Sale bags per product and credits destination after confirmation', async () => {
    const adminCookie = cookieOf(await login('admin'));
    const account = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/accounts',
      headers: { cookie: adminCookie },
      payload: {
        username: 'ds_bd',
        displayName: 'Cửa hàng DS BD',
        password: PASSWORD,
        role: 'STORE',
        storeId: MEMORY_SEED_IDS.bdStore,
      },
    });
    assert.equal(account.statusCode, 201);
    const sourceCookie = cookieOf(await login('ds_nvt'));
    const destinationCookie = cookieOf(await login('ds_bd'));
    const legacy = await mutateTransfer(sourceCookie, '/api/v1/store-transfers', 'legacy-blocked', {
      sourceStoreId: MEMORY_SEED_IDS.nvtStore,
      destinationStoreId: MEMORY_SEED_IDS.bdStore,
      sourceInventoryBagId: MEMORY_SEED_IDS.inventoryBag,
      weightKg: '1.000',
      expectedSourceBagVersion: 0,
      note: null,
    });
    assert.equal(legacy.statusCode, 409);

    const now = new Date();
    const period = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
    }).format(now);
    for (const [cookie, storeId] of [
      [sourceCookie, MEMORY_SEED_IDS.nvtStore],
      [destinationCookie, MEMORY_SEED_IDS.bdStore],
    ]) {
      const principal = (await repository.resolveSession(cookie.split('=')[1])).principal;
      const storeCode = repository.stores.get(storeId).code;
      const payload = idosiStatisticsPayload(300_000);
      await repository.recordIdosiStatisticsSuccess(
        principal,
        { storeId, period, date: null, shiftId: null, paymentMethod: null },
        {
          ...payload,
          storeId: storeCode,
          store: { ...payload.store, id: storeCode },
          filters: { ...payload.filters, period },
          generatedAt: now.toISOString(),
        },
        now,
        now,
        { requestId: 'sale-transfer-snapshot' },
      );
    }

    const sorted = await mutateTransfer(sourceCookie, '/api/v1/store-sortings', 'sort-sale-bags', {
      storeId: MEMORY_SEED_IDS.nvtStore,
      inventoryLotId: MEMORY_SEED_IDS.inventoryBag,
      expectedInventoryVersion: 0,
      reason: 'SALE',
      weightKg: '5.000',
    });
    assert.equal(sorted.statusCode, 201, sorted.body);
    const sourceBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/store-sorted-stocks',
      headers: { cookie: sourceCookie },
    });
    assert.equal(sourceBefore.json().data[0].saleWeightKg, '5.000');
    const stock = sourceBefore.json().data[0];
    const input = {
      sourceStoreId: MEMORY_SEED_IDS.nvtStore,
      destinationStoreId: MEMORY_SEED_IDS.bdStore,
      productId: stock.productId,
      bagWeightsKg: ['1.000', '1.500'],
      note: null,
    };
    const tooHeavy = await mutateTransfer(
      sourceCookie,
      '/api/v1/sorted-sale-transfers',
      'sorted-transfer-too-heavy',
      { ...input, bagWeightsKg: ['3.000', '2.001'] },
    );
    assert.equal(tooHeavy.statusCode, 409, tooHeavy.body);
    const zeroBag = await mutateTransfer(
      sourceCookie,
      '/api/v1/sorted-sale-transfers',
      'sorted-transfer-zero-bag',
      { ...input, bagWeightsKg: ['1.000', '0.000'] },
    );
    assert.equal(zeroBag.statusCode, 400, zeroBag.body);
    const transfer = await mutateTransfer(
      sourceCookie,
      '/api/v1/sorted-sale-transfers',
      'sorted-transfer-create',
      input,
    );
    assert.equal(transfer.statusCode, 201, transfer.body);
    assert.equal(transfer.json().data.status, 'IN_TRANSIT');
    assert.equal(transfer.json().data.weightKg, '2.500');
    assert.equal(transfer.json().data.bagQuantity, 2);
    assert.deepEqual(transfer.json().data.bagWeightsKg, ['1.000', '1.500']);
    const replay = await mutateTransfer(
      sourceCookie,
      '/api/v1/sorted-sale-transfers',
      'sorted-transfer-create',
      input,
    );
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    const sourceAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/store-sorted-stocks',
      headers: { cookie: sourceCookie },
    });
    assert.equal(sourceAfter.json().data[0].saleWeightKg, '2.500');
    const destinationBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/store-sorted-stocks',
      headers: { cookie: destinationCookie },
    });
    assert.equal(destinationBefore.json().data.length, 0);
    const transferId = transfer.json().data.id;
    const wrongReceiver = await mutateTransfer(
      sourceCookie,
      `/api/v1/sorted-sale-transfers/${transferId}/receive`,
      'wrong-receiver',
      { expectedVersion: 0 },
    );
    assert.equal(wrongReceiver.statusCode, 403);
    const received = await mutateTransfer(
      destinationCookie,
      `/api/v1/sorted-sale-transfers/${transferId}/receive`,
      'receive-sorted-transfer',
      { expectedVersion: 0 },
    );
    assert.equal(received.statusCode, 200, received.body);
    assert.equal(received.json().data.status, 'RECEIVED');
    const receivedReplay = await mutateTransfer(
      destinationCookie,
      `/api/v1/sorted-sale-transfers/${transferId}/receive`,
      'receive-sorted-transfer',
      { expectedVersion: 0 },
    );
    assert.equal(receivedReplay.headers['idempotency-replayed'], 'true');
    const destinationAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/store-sorted-stocks',
      headers: { cookie: destinationCookie },
    });
    assert.equal(destinationAfter.json().data[0].saleWeightKg, '2.500');
    const exceedsRemaining = await mutateTransfer(
      sourceCookie,
      '/api/v1/sorted-sale-transfers',
      'exceeds-remaining-sorted-transfer',
      { ...input, bagWeightsKg: ['2.000', '0.501'] },
    );
    assert.equal(exceedsRemaining.statusCode, 409);
  });

  test('moves charity back to Sale and exports charity bag by bag per product', async () => {
    const storeCookie = cookieOf(await login('ds_nvt'));
    const now = new Date();
    const period = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
    }).format(now);
    const principal = (await repository.resolveSession(storeCookie.split('=')[1])).principal;
    const storeCode = repository.stores.get(MEMORY_SEED_IDS.nvtStore).code;
    const payload = idosiStatisticsPayload(300_000);
    await repository.recordIdosiStatisticsSuccess(
      principal,
      { storeId: MEMORY_SEED_IDS.nvtStore, period, date: null, shiftId: null, paymentMethod: null },
      {
        ...payload,
        storeId: storeCode,
        store: { ...payload.store, id: storeCode },
        filters: { ...payload.filters, period },
        generatedAt: now.toISOString(),
      },
      now,
      now,
      { requestId: 'charity-snapshot' },
    );
    const sorted = await mutateTransfer(storeCookie, '/api/v1/store-sortings', 'sort-charity', {
      storeId: MEMORY_SEED_IDS.nvtStore,
      inventoryLotId: MEMORY_SEED_IDS.inventoryBag,
      expectedInventoryVersion: 0,
      reason: 'CHARITY',
      weightKg: '4.000',
    });
    assert.equal(sorted.statusCode, 201, sorted.body);
    const stocks = await app.inject({
      method: 'GET',
      url: '/api/v1/store-sorted-stocks',
      headers: { cookie: storeCookie },
    });
    const productId = stocks.json().data[0].productId;
    const moved = await mutateTransfer(
      storeCookie,
      '/api/v1/store-charity/move-to-sale',
      'charity-to-sale',
      { storeId: MEMORY_SEED_IDS.nvtStore, productId, weightKg: '1.000' },
    );
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(moved.json().data.charityWeightKg, '3.000');
    assert.equal(moved.json().data.saleWeightKg, '1.000');
    const exportInput = {
      storeId: MEMORY_SEED_IDS.nvtStore,
      productId,
      bagWeightsKg: ['1.000', '1.500'],
      note: null,
    };
    const tooHeavy = await mutateTransfer(
      storeCookie,
      '/api/v1/store-charity-exports',
      'charity-export-too-heavy',
      { ...exportInput, bagWeightsKg: ['2.000', '1.001'] },
    );
    assert.equal(tooHeavy.statusCode, 409, tooHeavy.body);
    const exported = await mutateTransfer(
      storeCookie,
      '/api/v1/store-charity-exports',
      'charity-export',
      exportInput,
    );
    assert.equal(exported.statusCode, 201, exported.body);
    assert.equal(exported.json().data.bagQuantity, 2);
    assert.equal(exported.json().data.weightKg, '2.500');
    assert.deepEqual(exported.json().data.bagWeightsKg, ['1.000', '1.500']);
    assert.match(exported.json().data.exportNumber, /^PTT-/);
    const replay = await mutateTransfer(
      storeCookie,
      '/api/v1/store-charity-exports',
      'charity-export',
      exportInput,
    );
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/store-sorted-stocks',
      headers: { cookie: storeCookie },
    });
    assert.equal(after.json().data[0].charityWeightKg, '0.500');
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/store-charity-exports',
      headers: { cookie: storeCookie },
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().data.length, 1);
    const adminCookie = cookieOf(await login('admin'));
    const adminExport = await mutateTransfer(
      adminCookie,
      '/api/v1/store-charity-exports',
      'admin-charity-export',
      exportInput,
    );
    assert.equal(adminExport.statusCode, 403);

    const history = await app.inject({
      method: 'GET',
      url: '/api/v1/store-sorting-history?page=1&pageSize=20',
      headers: { cookie: storeCookie },
    });
    assert.equal(history.statusCode, 200, history.body);
    assert.deepEqual(
      history.json().data.map((row) => [row.action, row.weightKg]),
      [
        ['CHARITY_EXPORT', '2.500'],
        ['CHARITY_TO_SALE', '1.000'],
        ['SORT_CHARITY', '4.000'],
      ],
    );
    assert.equal(history.json().pagination.totalItems, 3);
    const sortedRow = history.json().data[2];
    assert.equal(sortedRow.inventoryLotId, MEMORY_SEED_IDS.inventoryBag);
    assert.equal(sortedRow.productId, productId);
    assert.match(sortedRow.bagCode, /^MB-/);
    assert.ok(sortedRow.actorDisplayName);
    assert.ok(!Number.isNaN(Date.parse(sortedRow.occurredAt)));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(now);
    const todayHistory = await app.inject({
      method: 'GET',
      url: `/api/v1/store-sorting-history?date=${today}`,
      headers: { cookie: storeCookie },
    });
    assert.equal(todayHistory.json().pagination.totalItems, 3);
    const otherDay = await app.inject({
      method: 'GET',
      url: '/api/v1/store-sorting-history?date=2020-01-01',
      headers: { cookie: storeCookie },
    });
    assert.equal(otherDay.statusCode, 200);
    assert.equal(otherDay.json().data.length, 0);
    const invalidDate = await app.inject({
      method: 'GET',
      url: '/api/v1/store-sorting-history?date=2026-02-30',
      headers: { cookie: storeCookie },
    });
    assert.equal(invalidDate.statusCode, 400);
    const adminHistory = await app.inject({
      method: 'GET',
      url: `/api/v1/store-sorting-history?storeId=${MEMORY_SEED_IDS.nvtStore}`,
      headers: { cookie: adminCookie },
    });
    assert.equal(adminHistory.json().pagination.totalItems, 3);
    const otherStoreAccount = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/accounts',
      headers: { cookie: adminCookie },
      payload: {
        username: 'ds_bd',
        displayName: 'Cửa hàng DS BD',
        password: PASSWORD,
        role: 'STORE',
        storeId: MEMORY_SEED_IDS.bdStore,
      },
    });
    assert.equal(otherStoreAccount.statusCode, 201, otherStoreAccount.body);
    const otherStoreCookie = cookieOf(await login('ds_bd'));
    const foreignHistory = await app.inject({
      method: 'GET',
      url: `/api/v1/store-sorting-history?storeId=${MEMORY_SEED_IDS.nvtStore}`,
      headers: { cookie: otherStoreCookie },
    });
    assert.equal(foreignHistory.statusCode, 403);
    const ownHistory = await app.inject({
      method: 'GET',
      url: '/api/v1/store-sorting-history',
      headers: { cookie: otherStoreCookie },
    });
    assert.equal(ownHistory.json().data.length, 0);
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
    assert.equal(allStores.json().data.totals.vatCostVnd.value, '0');
    assert.equal(allStores.json().data.totals.vatCostVnd.unavailableReason, null);
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

  test('replaces a locked or disabled store account without restoring its access', async () => {
    const adminCookie = cookieOf(await login('admin'));
    const oldCookie = cookieOf(await login('ds_nvt'));
    const accountPath = `/api/v1/admin/accounts/${MEMORY_SEED_IDS.storeAccount}`;
    const locked = await app.inject({
      method: 'PATCH',
      url: accountPath,
      headers: { cookie: adminCookie },
      payload: { status: 'LOCKED', expectedSessionVersion: 0 },
    });
    assert.equal(locked.statusCode, 200, locked.body);
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
    const lockedLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'ds_nvt', password: PASSWORD },
    });
    assert.equal(lockedLogin.statusCode, 403);
    assert.equal(lockedLogin.json().error.code, 'ACCOUNT_INACTIVE');

    const replacementPassword = 'Replacement-store-password-2026!';
    const create = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/accounts',
        headers: { cookie: adminCookie },
        payload: {
          username: 'ds_nvt',
          displayName: 'Replacement NVT',
          password: replacementPassword,
          role: 'STORE',
          storeId: MEMORY_SEED_IDS.nvtStore,
        },
      });
    const replacement = await create();
    assert.equal(replacement.statusCode, 201, replacement.body);
    assert.notEqual(replacement.json().data.id, MEMORY_SEED_IDS.storeAccount);
    assert.equal((await create()).statusCode, 409);

    const oldPasswordLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'ds_nvt', password: PASSWORD },
    });
    assert.equal(oldPasswordLogin.statusCode, 401);
    const newPasswordLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'ds_nvt', password: replacementPassword },
    });
    assert.equal(newPasswordLogin.statusCode, 200, newPasswordLogin.body);
    assert.equal(newPasswordLogin.json().data.principal.accountId, replacement.json().data.id);

    const reactivateOld = await app.inject({
      method: 'PATCH',
      url: accountPath,
      headers: { cookie: adminCookie },
      payload: { status: 'ACTIVE', expectedSessionVersion: locked.json().data.sessionVersion },
    });
    assert.equal(reactivateOld.statusCode, 409, reactivateOld.body);
    assert.equal(reactivateOld.json().error.code, 'CONFLICT');

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/accounts/${replacement.json().data.id}`,
      headers: { cookie: adminCookie },
      payload: { status: 'DISABLED', expectedSessionVersion: 0 },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/auth/session',
          headers: { cookie: cookieOf(newPasswordLogin) },
        })
      ).statusCode,
      401,
    );
    const disabledLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'ds_nvt', password: replacementPassword },
    });
    assert.equal(disabledLogin.statusCode, 403);
    assert.equal(disabledLogin.json().error.code, 'ACCOUNT_INACTIVE');
    const third = await create();
    assert.equal(third.statusCode, 201, third.body);
  });

  test('lists and atomically replaces audited HTKD store assignments for ADMIN', async () => {
    const adminCookie = cookieOf(await login('admin'));
    const storeCookie = cookieOf(await login('ds_nvt'));
    const htkdCookie = cookieOf(await login('htkd'));
    const path = `/api/v1/admin/accounts/${MEMORY_SEED_IDS.htkdAccount}/assignments`;

    const denied = await app.inject({ method: 'GET', url: path, headers: { cookie: storeCookie } });
    assert.equal(denied.statusCode, 403);

    const initial = await app.inject({
      method: 'GET',
      url: path,
      headers: { cookie: adminCookie },
    });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.headers['cache-control'], 'no-store');
    assert.equal(initial.json().data.sessionVersion, 0);
    assert.deepEqual(
      initial
        .json()
        .data.assignments.map((assignment) => assignment.storeId)
        .sort(),
      [MEMORY_SEED_IDS.bdStore, MEMORY_SEED_IDS.nvtStore].sort(),
    );

    const replaced = await app.inject({
      method: 'PUT',
      url: path,
      headers: { cookie: adminCookie, 'x-request-id': 'replace-htkd-scope' },
      payload: {
        expectedSessionVersion: 0,
        reason: 'Điều chỉnh địa bàn phụ trách',
        storeIds: [MEMORY_SEED_IDS.nvtStore],
      },
    });
    assert.equal(replaced.statusCode, 200);
    assert.equal(replaced.json().data.sessionVersion, 1);
    assert.deepEqual(
      replaced.json().data.assignments.map((assignment) => assignment.storeId),
      [MEMORY_SEED_IDS.nvtStore],
    );

    const noOpReplay = await app.inject({
      method: 'PUT',
      url: path,
      headers: { cookie: adminCookie },
      payload: {
        expectedSessionVersion: 1,
        reason: 'Gửi lại cùng phạm vi không tạo thay đổi',
        storeIds: [MEMORY_SEED_IDS.nvtStore],
      },
    });
    assert.equal(noOpReplay.statusCode, 200);
    assert.equal(noOpReplay.json().data.sessionVersion, 1);

    const revokedSession = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: htkdCookie },
    });
    assert.equal(revokedSession.statusCode, 401);
    assert.equal(revokedSession.json().error.code, 'UNAUTHENTICATED');

    const stale = await app.inject({
      method: 'PUT',
      url: path,
      headers: { cookie: adminCookie },
      payload: {
        expectedSessionVersion: 0,
        reason: 'Thao tác trên dữ liệu cũ',
        storeIds: [],
      },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'VERSION_CONFLICT');

    const cleared = await app.inject({
      method: 'PUT',
      url: path,
      headers: { cookie: adminCookie, 'x-request-id': 'clear-htkd-scope' },
      payload: {
        expectedSessionVersion: 1,
        reason: 'Thu hồi toàn bộ phạm vi phụ trách',
        storeIds: [],
      },
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().data.sessionVersion, 2);
    assert.deepEqual(cleared.json().data.assignments, []);

    const audit = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs?action=HTKD_ASSIGNMENTS_REPLACED&pageSize=10',
      headers: { cookie: adminCookie },
    });
    assert.equal(audit.statusCode, 200);
    assert.equal(audit.json().pagination.totalItems, 2);
    const clearedAudit = audit.json().data.find((event) => event.requestId === 'clear-htkd-scope');
    assert.ok(clearedAudit);
    assert.equal(clearedAudit.before.assignments.length, 1);
    assert.equal(clearedAudit.after.assignments.length, 0);
    assert.equal(clearedAudit.metadata.reason, 'Thu hồi toàn bộ phạm vi phụ trách');

    const wholesaleStores = await app.inject({
      method: 'GET',
      url: '/api/v1/stores?kind=WHOLESALE&status=ACTIVE&pageSize=100',
      headers: { cookie: adminCookie },
    });
    const wholesaleStoreId = wholesaleStores.json().data[0]?.id;
    assert.ok(wholesaleStoreId);
    // HTKD được phân quyền quản lý cả cửa hàng sỉ, không chỉ cửa hàng bán lẻ.
    const wholesaleAccepted = await app.inject({
      method: 'PUT',
      url: path,
      headers: { cookie: adminCookie },
      payload: {
        expectedSessionVersion: 2,
        reason: 'Giao HTKD phụ trách cửa hàng sỉ',
        storeIds: [wholesaleStoreId],
      },
    });
    assert.equal(wholesaleAccepted.statusCode, 200);
    assert.equal(wholesaleAccepted.json().data.sessionVersion, 3);
    assert.deepEqual(
      wholesaleAccepted.json().data.assignments.map((assignment) => assignment.storeId),
      [wholesaleStoreId],
    );

    repository.setStoreOperationEligibility(MEMORY_SEED_IDS.bdStore, { status: 'INACTIVE' });
    const inactiveStoreRejected = await app.inject({
      method: 'PUT',
      url: path,
      headers: { cookie: adminCookie },
      payload: {
        expectedSessionVersion: 3,
        reason: 'Không được gán cửa hàng ngừng hoạt động',
        storeIds: [MEMORY_SEED_IDS.bdStore],
      },
    });
    assert.equal(inactiveStoreRejected.statusCode, 400);

    const wrongTarget = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/accounts/${MEMORY_SEED_IDS.storeAccount}/assignments`,
      headers: { cookie: adminCookie },
    });
    assert.equal(wrongTarget.statusCode, 409);
    const missingTarget = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/accounts/99999999-9999-4999-8999-999999999999/assignments',
      headers: { cookie: adminCookie },
    });
    assert.equal(missingTarget.statusCode, 404);

    repository.setAccountStatus(MEMORY_SEED_IDS.htkdAccount, 'LOCKED');
    const inactiveTarget = await app.inject({
      method: 'GET',
      url: path,
      headers: { cookie: adminCookie },
    });
    assert.equal(inactiveTarget.statusCode, 409);
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

  test('keeps confirmed totals unknown until deferred VAT is recorded', async () => {
    const adminCookie = cookieOf(await login('admin'));
    const productId = await firstProductId(adminCookie);
    const created = await mutateReceipt(
      adminCookie,
      'POST',
      '/api/v1/inbound-receipts',
      'unknown-vat-create',
      {
        referenceCode: 'UNKNOWN-VAT',
        supplierName: 'VAT test',
        receivedAt: new Date().toISOString(),
        bags: [{ productId, bagCode: 'UNKNOWN-VAT-BAG', weightKg: '2.000' }],
      },
    );
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().data.id;
    const confirmation = {
      expectedVersion: 0,
      productCosts: [{ productId, priceVndPerKg: 1000 }],
      transportationFeeVnd: 100,
      handlingFeeVnd: 50,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await mutateReceipt(
        adminCookie,
        'POST',
        `/api/v1/inbound-receipts/${id}/confirm-costs`,
        'unknown-vat-confirm',
        confirmation,
      );
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().data.vat, null);
      assert.equal(result.json().data.cost.vatAmountVnd, null);
      assert.equal(result.json().data.cost.totalCostVnd, null);
      assert.equal(result.json().data.cost.goodsCostVnd, 2000);
    }
    const updated = await mutateReceipt(
      adminCookie,
      'PATCH',
      `/api/v1/inbound-receipts/${id}/vat`,
      'unknown-vat-update',
      { expectedVersion: 1, vat: { amountVnd: 80, ratePercent: 8 }, reason: 'Bổ sung số tiền VAT' },
    );
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().data.cost.totalCostVnd, 2230);
  });

  test('allows only ADMIN to fill deferred VAT and correct a confirmed receipt with audit and replay', async () => {
    const adminCookie = cookieOf(await login('admin'));
    const productId = await firstProductId(adminCookie);
    const created = await mutateReceipt(
      adminCookie,
      'POST',
      '/api/v1/inbound-receipts',
      'vat-deferred-create',
      {
        referenceCode: 'VAT-LATER',
        supplierName: 'VAT test',
        receivedAt: new Date().toISOString(),
        bags: [{ productId, bagCode: 'VAT-LATER-BAG', weightKg: '2.000' }],
      },
    );
    assert.equal(created.statusCode, 201);
    const id = created.json().data.id;
    const url = `/api/v1/inbound-receipts/${id}/vat`;
    const input = {
      expectedVersion: 0,
      vat: { amountVnd: 1000000, ratePercent: 8 },
      reason: 'Bổ sung số tiền VAT',
    };
    const denied = await mutateReceipt(
      cookieOf(await login('htkd')),
      'PATCH',
      url,
      'vat-forbidden',
      input,
    );
    assert.equal(denied.statusCode, 403);
    const updated = await mutateReceipt(adminCookie, 'PATCH', url, 'vat-update', input);
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual(updated.json().data.vat, input.vat);
    assert.equal(
      (await mutateReceipt(adminCookie, 'PATCH', url, 'vat-update', input)).headers[
        'idempotency-replayed'
      ],
      'true',
    );
    assert.equal(
      (await mutateReceipt(adminCookie, 'PATCH', url, 'vat-stale', input)).statusCode,
      409,
    );
    const confirmed = await mutateReceipt(
      adminCookie,
      'POST',
      `/api/v1/inbound-receipts/${id}/confirm-costs`,
      'vat-confirm',
      {
        expectedVersion: 1,
        productCosts: [{ productId, priceVndPerKg: 1000 }],
        transportationFeeVnd: 0,
        handlingFeeVnd: 0,
      },
    );
    assert.equal(confirmed.json().data.cost.totalCostVnd, 1002000);
    const correction = await mutateReceipt(adminCookie, 'PATCH', url, 'vat-correct', {
      ...input,
      expectedVersion: 2,
      vat: { amountVnd: 0, ratePercent: 8 },
    });
    assert.equal(correction.statusCode, 200, correction.body);
    assert.equal(correction.json().data.cost.totalCostVnd, 2000);
    assert.equal(correction.json().data.cost.vatAmountVnd, 0);
    const audit = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/audit-logs?action=SUPPLIER_INBOUND_VAT_UPDATED&entityId=${id}`,
      headers: { cookie: adminCookie },
    });
    assert.equal(audit.json().pagination.totalItems, 2);
  });

  test('returns a retryable conflict after database contention without leaking SQL', async () => {
    const cookie = cookieOf(await login('admin'));
    const productId = await firstProductId(cookie);
    const receive = repository.receiveSupplierInbound.bind(repository);
    for (const code of ['40001', '40P01']) {
      repository.receiveSupplierInbound = async () => {
        throw new Error('sensitive SQL must not leave the server', {
          cause: Object.assign(new Error('database conflict'), { code }),
        });
      };
      const response = await mutateReceipt(
        cookie,
        'POST',
        '/api/v1/inbound-receipts',
        `contention-${code}`,
        {
          referenceCode: `CONTENTION-${code}`,
          supplierName: 'Test',
          receivedAt: '2026-09-17T08:00:00+07:00',
          bags: [{ productId, bagCode: `CONTENTION-BAG-${code}`, weightKg: '1.000' }],
        },
      );
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error.code, 'CONFLICT');
      assert.ok(!response.body.includes('sensitive SQL'));
    }
    repository.receiveSupplierInbound = receive;
  });

  test('creates a server-numbered receipt for three unweighed bags and replays it', async () => {
    const cookie = cookieOf(await login('admin'));
    const productId = await firstProductId(cookie);
    const payload = {
      supplierName: 'Three bags',
      receivedAt: '2026-09-20T01:00:00Z',
      bags: [1, 2, 3].map((n) => ({ productId, bagCode: `AUTO-BAG-${n}` })),
    };
    const first = await mutateReceipt(
      cookie,
      'POST',
      '/api/v1/inbound-receipts',
      'auto-three-bags',
      payload,
    );
    assert.equal(first.statusCode, 201, first.body);
    assert.match(first.json().data.referenceCode, /^PN\d{5,}-\d{2}\/\d{2}\/\d{4}$/);
    assert.equal(first.json().data.bags.length, 3);
    assert.equal(first.json().data.totalWeightKg, null);
    const replay = await mutateReceipt(
      cookie,
      'POST',
      '/api/v1/inbound-receipts',
      'auto-three-bags',
      payload,
    );
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    assert.deepEqual(replay.json().data, first.json().data);
    const costPath = `/api/v1/inbound-receipts/${first.json().data.id}/confirm-costs`;
    const costInput = {
      expectedVersion: 0,
      invoiceGoodsCostVnd: 0,
      transportationFeeVnd: 10000,
      handlingFeeVnd: 5000,
    };
    const priced = await mutateReceipt(cookie, 'POST', costPath, 'invoice-auto-bags', costInput);
    assert.equal(priced.statusCode, 200, priced.body);
    assert.equal(priced.json().data.status, 'COST_CONFIRMED');
    assert.equal(priced.json().data.cost.goodsCostVnd, 0);
    assert.equal(priced.json().data.cost.totalCostVnd, null);
    assert.equal(priced.json().data.totalWeightKg, null);
    const replayCost = await mutateReceipt(
      cookie,
      'POST',
      costPath,
      'invoice-auto-bags',
      costInput,
    );
    assert.equal(replayCost.headers['idempotency-replayed'], 'true');
  });

  test('accepts unknown supplier weights without fabricating kg or kg-based costs', async () => {
    const cookie = cookieOf(await login('admin'));
    const productId = await firstProductId(cookie);
    const payload = {
      referenceCode: 'OPTIONAL-WEIGHTS',
      supplierName: 'Supplier',
      receivedAt: '2026-09-20T01:00:00Z',
      bags: [
        { productId, bagCode: 'UNKNOWN-BAG' },
        { productId, bagCode: 'WEIGHED-BAG', weightKg: '2.333' },
      ],
    };
    const first = await mutateReceipt(
      cookie,
      'POST',
      '/api/v1/inbound-receipts',
      'optional-weights',
      payload,
    );
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(first.json().data.totalWeightKg, null);
    assert.equal(first.json().data.bags[0].weightKg, null);
    assert.equal(first.json().data.bags[1].weightKg, '2.333');
    const replay = await mutateReceipt(
      cookie,
      'POST',
      '/api/v1/inbound-receipts',
      'optional-weights',
      payload,
    );
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    const confirm = await mutateReceipt(
      cookie,
      'POST',
      `/api/v1/inbound-receipts/${first.json().data.id}/confirm-costs`,
      'unknown-costs',
      {
        expectedVersion: 0,
        productCosts: [{ productId, priceVndPerKg: 10000 }],
        transportationFeeVnd: 0,
        handlingFeeVnd: 0,
      },
    );
    assert.equal(confirm.statusCode, 400);
    assert.match(confirm.json().error.message, /khối lượng/);
    const invalid = await mutateReceipt(cookie, 'POST', '/api/v1/inbound-receipts', 'zero-weight', {
      ...payload,
      bags: [{ productId, bagCode: 'ZERO', weightKg: '0' }],
    });
    assert.equal(invalid.statusCode, 400);
  });

  test('receives supplier bags into warehouse stock and confirms exact costs idempotently', async () => {
    const adminCookie = cookieOf(await login('admin'));
    const storeCookie = cookieOf(await login('ds_nvt'));
    const productId = await firstProductId(adminCookie);
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/inbound-receipts',
      headers: { cookie: storeCookie },
    });
    assert.equal(denied.statusCode, 403);

    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/warehouse-balances',
      headers: { cookie: adminCookie },
    });
    assert.equal(before.statusCode, 200);
    const beforeBalance = before.json().data.find((balance) => balance.productId === productId);
    const payload = {
      referenceCode: 'SUPPLIER-TEST-001',
      vat: { amountVnd: 1000000, ratePercent: 8 },
      supplierName: 'Nhà cung cấp test',
      receivedAt: '2026-09-17T08:00:00+07:00',
      bags: [
        { productId, bagCode: 'SUP-BAG-001', weightKg: '1.234' },
        { productId, bagCode: 'SUP-BAG-002', weightKg: '2.001' },
      ],
    };
    const received = await mutateReceipt(
      adminCookie,
      'POST',
      '/api/v1/inbound-receipts',
      'supplier-receive-001',
      payload,
    );
    assert.equal(received.statusCode, 201);
    assert.equal(received.headers['idempotency-replayed'], 'false');
    assert.equal(received.json().data.status, 'COST_PENDING');
    assert.equal(received.json().data.totalWeightKg, '3.235');
    assert.deepEqual(received.json().data.vat, payload.vat);
    const receiptId = received.json().data.id;

    const replay = await mutateReceipt(
      adminCookie,
      'POST',
      '/api/v1/inbound-receipts',
      'supplier-receive-001',
      payload,
    );
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    assert.equal(replay.json().data.id, receiptId);
    const conflictReplay = await mutateReceipt(
      adminCookie,
      'POST',
      '/api/v1/inbound-receipts',
      'supplier-receive-001',
      { ...payload, supplierName: 'Nhà cung cấp khác' },
    );
    assert.equal(conflictReplay.statusCode, 409);
    assert.equal(conflictReplay.json().error.code, 'IDEMPOTENCY_CONFLICT');

    const duplicateReference = await mutateReceipt(
      adminCookie,
      'POST',
      '/api/v1/inbound-receipts',
      'supplier-receive-duplicate-reference',
      payload,
    );
    assert.equal(duplicateReference.statusCode, 409);
    assert.equal(duplicateReference.json().error.code, 'CONFLICT');

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/warehouse-balances',
      headers: { cookie: adminCookie },
    });
    const afterBalance = after.json().data.find((balance) => balance.productId === productId);
    assert.equal(
      afterBalance.available.quantity,
      beforeBalance.available.quantity + payload.bags.length,
    );
    assert.equal(afterBalance.version, beforeBalance.version + 1);

    const confirmed = await mutateReceipt(
      adminCookie,
      'POST',
      `/api/v1/inbound-receipts/${receiptId}/confirm-costs`,
      'supplier-cost-001',
      {
        productCosts: [{ productId, priceVndPerKg: 10_001 }],
        transportationFeeVnd: 100_000,
        handlingFeeVnd: 20_000,
        expectedVersion: 0,
      },
    );
    assert.equal(confirmed.statusCode, 200);
    assert.equal(confirmed.json().data.status, 'COST_CONFIRMED');
    assert.equal(confirmed.json().data.cost.goodsCostVnd, 32_353);
    assert.equal(confirmed.json().data.cost.totalCostVnd, 1_152_353);
    assert.equal(confirmed.json().data.cost.vatAmountVnd, 1_000_000);
    assert.equal(confirmed.json().data.version, 1);

    const cannotCancelConfirmed = await mutateReceipt(
      adminCookie,
      'POST',
      `/api/v1/inbound-receipts/${receiptId}/cancel`,
      'supplier-cancel-confirmed',
      { reason: 'Không được hủy sau khi chốt giá', expectedVersion: 1 },
    );
    assert.equal(cannotCancelConfirmed.statusCode, 409);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/inbound-receipts?status=COST_CONFIRMED&supplier=test',
      headers: { cookie: adminCookie },
    });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(
      listed.json().data.map((receipt) => receipt.id),
      [receiptId],
    );
  });

  test('warehouse inventory is admin-only and reconciles on-hand, reserved and dispatched bags', async () => {
    const url = '/api/v1/warehouse-inventory?pageSize=100';
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
    for (const username of ['htkd', 'ds_nvt']) {
      const denied = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: cookieOf(await login(username)) },
      });
      assert.equal(denied.statusCode, 403);
    }
    const headers = { cookie: cookieOf(await login('admin')) };
    const result = await app.inject({ method: 'GET', url, headers });
    assert.equal(result.statusCode, 200);
    const balances = (
      await app.inject({ method: 'GET', url: '/api/v1/warehouse-balances', headers })
    ).json().data;
    const outbounds = (
      await app.inject({ method: 'GET', url: '/api/v1/outbound-requests?pageSize=100', headers })
    ).json().data;
    for (const row of result.json().data) {
      const balance = balances.find((entry) => entry.productId === row.productId);
      assert.equal(row.availableBags, balance.available.quantity);
      assert.equal(row.reservedBags, balance.reserved.quantity);
      assert.equal(row.onHandBags, row.availableBags + row.reservedBags);
      assert.equal(
        row.dispatchedBags,
        outbounds
          .flatMap((entry) => entry.lines)
          .filter((line) => line.productId === row.productId)
          .reduce((sum, line) => sum + line.dispatchedUnits, 0),
      );
    }
    const page = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/warehouse-inventory?pageSize=1&page=2',
        headers,
      })
    ).json();
    assert.equal(page.data.length, 1);
    assert.equal(page.pagination.page, 2);
    const empty = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/warehouse-inventory?search=nonexistent-product-xyz',
        headers,
      })
    ).json();
    assert.equal(empty.data.length, 0);
  });

  test('cancels only pending supplier stock with optimistic locking and audit context', async () => {
    const adminCookie = cookieOf(await login('admin'));
    const productId = await firstProductId(adminCookie);
    const received = await mutateReceipt(
      adminCookie,
      'POST',
      '/api/v1/inbound-receipts',
      'supplier-receive-cancel',
      {
        referenceCode: 'SUPPLIER-CANCEL-001',
        supplierName: 'Nhà cung cấp hủy',
        receivedAt: '2026-09-17T08:15:00+07:00',
        bags: [{ productId, bagCode: 'SUP-CANCEL-BAG-001', weightKg: '1.000' }],
      },
    );
    const receiptId = received.json().data.id;
    const stale = await mutateReceipt(
      adminCookie,
      'POST',
      `/api/v1/inbound-receipts/${receiptId}/cancel`,
      'supplier-cancel-stale',
      { reason: 'Phiên bản cũ', expectedVersion: 1 },
    );
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'VERSION_CONFLICT');

    const cancelled = await mutateReceipt(
      adminCookie,
      'POST',
      `/api/v1/inbound-receipts/${receiptId}/cancel`,
      'supplier-cancel-ok',
      { reason: 'Nhà cung cấp giao nhầm lô', expectedVersion: 0 },
    );
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().data.status, 'CANCELLED');
    assert.equal(cancelled.json().data.version, 1);

    const audit = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/audit-logs?action=SUPPLIER_INBOUND_CANCELLED&entityId=${receiptId}`,
      headers: { cookie: adminCookie },
    });
    assert.equal(audit.statusCode, 200);
    assert.equal(audit.json().pagination.totalItems, 1);
    assert.equal(audit.json().data[0].metadata.reason, 'Nhà cung cấp giao nhầm lô');
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

  async function mutateTransfer(cookie, url, idempotencyKey, payload) {
    return app.inject({
      method: 'POST',
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

function idosiStatisticsPayload(revenue) {
  const bucket = {
    actualKg: 0,
    estimatedKg: 0,
    knownKg: 0,
    totalKg: 0,
    isComplete: true,
    missingFactorLines: 0,
    invalidLines: 0,
    unclassifiedOrders: 0,
  };
  const weight = {
    ...bucket,
    actualKg: 2.5,
    estimatedKg: 6,
    knownKg: 8.5,
    totalKg: 8.5,
    schemaVersion: 1,
    unit: 'KG',
    tableVersion: 'IDOSI-2026-09-15-v2',
    byRevenueType: {
      NORMAL: { ...bucket, estimatedKg: 5, knownKg: 5, totalKg: 5 },
      SALE_KG: { ...bucket, actualKg: 2.5, knownKg: 2.5, totalKg: 2.5 },
      SALE_PIECE: { ...bucket, estimatedKg: 1, knownKg: 1, totalKg: 1 },
    },
  };
  const typeWeight = (type) => ({
    ...weight,
    actualKg: weight.byRevenueType[type].actualKg,
    estimatedKg: weight.byRevenueType[type].estimatedKg,
    knownKg: weight.byRevenueType[type].knownKg,
    totalKg: weight.byRevenueType[type].totalKg,
    byRevenueType: {
      NORMAL: type === 'NORMAL' ? weight.byRevenueType.NORMAL : bucket,
      SALE_KG: type === 'SALE_KG' ? weight.byRevenueType.SALE_KG : bucket,
      SALE_PIECE: type === 'SALE_PIECE' ? weight.byRevenueType.SALE_PIECE : bucket,
    },
  });
  return {
    ok: true,
    apiVersion: 1,
    storeId: 'DS_NVT',
    currency: 'VND',
    timezone: 'Asia/Ho_Chi_Minh',
    revenueBasis: 'ACTIVE_ORDER_AMOUNT',
    generatedAt: '2026-09-17T02:00:00.000Z',
    store: { id: 'DS_NVT', name: 'DS NVT' },
    filters: { period: '2026-09', date: null, shiftId: null, paymentMethod: null },
    totals: {
      orders: 2,
      cash: revenue,
      transfer: 0,
      revenue,
      cashOrders: 2,
      transferOrders: 0,
      revenueByType: { NORMAL: revenue - 80_000, SALE_KG: 50_000, SALE_PIECE: 30_000 },
      unclassifiedRevenue: 0,
      unclassifiedOrders: 0,
      weight,
    },
    products: {
      totalQuantity: 18,
      salePieceQuantity: 3,
      totalWeightKg: 2.5,
      productTypes: 1,
      ordersWithItems: 2,
      unclassifiedOrders: 0,
      items: [
        {
          productId: 'P01',
          productCode: 'DO-NAM',
          productName: 'Đồ nam',
          quantity: 15,
          unit: 'PIECE',
          revenueType: 'NORMAL',
          classification: 'NORMAL',
          orders: 2,
          weight: typeWeight('NORMAL'),
        },
        {
          productId: 'P01',
          productCode: 'DO-NAM',
          productName: 'Đồ nam',
          quantity: 3,
          unit: 'PIECE',
          revenueType: 'SALE_PIECE',
          classification: 'SALE_PIECE',
          orders: 1,
          weight: typeWeight('SALE_PIECE'),
        },
        {
          productId: 'P01',
          productCode: 'DO-NAM',
          productName: 'Đồ nam',
          quantity: 2.5,
          unit: 'KG',
          revenueType: 'SALE_KG',
          classification: 'SALE_KG',
          orders: 1,
          weight: typeWeight('SALE_KG'),
        },
      ],
      weight,
      weightByProduct: [
        {
          productId: 'P01',
          productCode: 'DO-NAM',
          productName: 'Đồ nam',
          orders: 2,
          totalQuantity: 18,
          weight,
        },
      ],
    },
    groups: { shift: [], day: [], month: [] },
    serverTime: '2026-09-17T02:00:00.000Z',
    requestId: 'remote-idosi-request',
  };
}
