import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { InboundStatisticsResponseSchema } from '@idosi/contracts';
import { createApi } from '../dist/app.js';
import { MEMORY_SEED_IDS, MemoryWarehouseRepository } from '../dist/memory-repository.js';

const password = 'Inbound-statistics-test-2026!';
describe('Admin inbound statistics API', () => {
  let app, repository;
  beforeEach(async () => {
    repository = await MemoryWarehouseRepository.create({
      bootstrapPassword: password,
      now: () => new Date('2026-09-15T05:00:00Z'),
    });
    app = await createApi({ repository });
  });
  afterEach(async () => {
    await app.close();
  });
  const login = async (username) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    assert.equal(response.statusCode, 200);
    const cookies = response.headers['set-cookie'];
    return {
      cookie: (Array.isArray(cookies) ? cookies : [cookies]).map((c) => c.split(';')[0]).join('; '),
      principal: response.json().data.principal,
    };
  };
  const get = (cookie, query = 'month=2026-09') =>
    app.inject({
      method: 'GET',
      url: `/api/v1/reports/inbound-statistics?${query}`,
      headers: cookie ? { cookie } : {},
    });
  test('requires active Admin, validates period and store scope, and documents endpoint', async () => {
    assert.equal((await get()).statusCode, 401);
    for (const username of ['htkd', 'ds_nvt'])
      assert.equal((await get((await login(username)).cookie)).statusCode, 403);
    const admin = await login('admin');
    const wholesale = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/accounts',
      headers: { cookie: admin.cookie },
      payload: {
        username: 'statistics.wholesale',
        displayName: 'Statistics wholesale',
        password,
        role: 'WHOLESALE',
      },
    });
    assert.equal(wholesale.statusCode, 201);
    assert.equal((await get((await login('statistics.wholesale')).cookie)).statusCode, 403);
    assert.equal((await get(admin.cookie, 'periodType=DAY&date=2026-02-29')).statusCode, 400);
    assert.equal((await get(admin.cookie, 'month=2026-13')).statusCode, 400);
    assert.equal((await get(admin.cookie, 'month=2026-09&source=TRANSFER')).statusCode, 400);
    assert.equal(
      (await get(admin.cookie, `month=2026-09&storeId=${randomUUID()}`)).statusCode,
      400,
    );
    const stores = await app.inject({
      method: 'GET',
      url: '/api/v1/stores?pageSize=100',
      headers: { cookie: admin.cookie },
    });
    const retail = stores.json().data.find((s) => s.kind === 'RETAIL');
    assert.equal(
      (await get(admin.cookie, `month=2026-09&storeKind=WHOLESALE&storeId=${retail.id}`))
        .statusCode,
      400,
    );
    const response = await get(admin.cookie);
    assert.equal(response.statusCode, 200);
    InboundStatisticsResponseSchema.parse(response.json());
    const openapi = await app.inject({ method: 'GET', url: '/openapi.json' });
    assert.ok(openapi.json().paths['/api/v1/reports/inbound-statistics']);
    repository.setAccountStatus(admin.principal.accountId, 'LOCKED');
    assert.equal((await get(admin.cookie)).statusCode, 401);
  });
  test('memory adapter aggregates warehouse and partner command results and isolates detail source', async () => {
    const admin = await login('admin'),
      store = await login('ds_nvt'),
      htkd = await login('htkd');
    const receipt = await repository.getReceipt(store.principal, MEMORY_SEED_IDS.storeReceipt);
    const lines = receipt.lines.map((l) => ({
      productId: l.productId,
      approvedUnits: l.approvedUnits,
      receivedUnits: l.receivedUnits,
    }));
    const context = { requestId: randomUUID(), ipAddress: null, userAgent: 'test' };
    const submitted = await repository.submitStoreReceipt(
      store.principal,
      receipt.id,
      { lines, expectedVersion: receipt.version, discrepancyNote: 'Thiếu một bao' },
      randomUUID(),
      randomUUID(),
      context,
    );
    await repository.finalizeStoreReceipt(
      htkd.principal,
      receipt.id,
      {
        expectedVersion: submitted.data.version,
        lines: lines.map((l) => ({
          ...l,
          bagWeightsKg: Array(l.receivedUnits).fill('2.125'),
          pricePerKgVnd: 0,
        })),
        freightVnd: 0,
        handlingVnd: 0,
        vat: { amountVnd: 0, ratePercent: 8 },
      },
      randomUUID(),
      randomUUID(),
      context,
    );
    await repository.createStorePartnerInbound(
      store.principal,
      {
        storeId: receipt.storeId,
        partnerName: 'Đối tác test',
        note: null,
        receivedAt: '2026-09-15T05:00:00.000Z',
        lines: [{ productId: lines[0].productId, quantity: 2, bagWeightsKg: ['1.001', '2.002'] }],
      },
      randomUUID(),
      randomUUID(),
      context,
    );
    const response = await get(
      admin.cookie,
      `month=2026-09&storeId=${receipt.storeId}&source=PARTNER`,
    );
    assert.equal(response.statusCode, 200);
    const { data } = InboundStatisticsResponseSchema.parse(response.json());
    assert.equal(data.overviewAllSources.warehouse.bagQuantity, '4');
    assert.equal(data.overviewAllSources.partner.bagQuantity, '2');
    assert.equal(data.overviewAllSources.total.weightGrams, '11503');
    assert.equal(data.selectedTotal.bagQuantity, '2');
    await assert.rejects(
      repository.getInboundStatistics(
        { ...admin.principal, role: 'WHOLESALE' },
        { month: '2026-09' },
      ),
      (e) => e.statusCode === 403,
    );
  });
});
