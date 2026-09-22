import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { createApi } from '../dist/app.js';
import { MEMORY_SEED_IDS, MemoryWarehouseRepository } from '../dist/memory-repository.js';

const PASSWORD = 'IDOSI-test-password-2026!';

describe('partner inbound', () => {
  let repository;
  let app;

  beforeEach(async () => {
    repository = await MemoryWarehouseRepository.create({ bootstrapPassword: PASSWORD });
    app = await createApi({ repository, corsOrigin: 'http://localhost:5173' });
  });

  afterEach(async () => {
    await app.close();
  });

  test('records partner goods as store stock and replays the same slip on retry', async () => {
    const cookie = cookieOf(await login(app, 'ds_nvt'));
    const productId = await firstProductId(app, cookie);
    const before = await inventoryBagCount(app, cookie);

    const payload = slipPayload(productId);
    const created = await recordSlip(app, cookie, 'partner-key-1', payload);
    assert.equal(created.statusCode, 201, created.body);
    const slip = created.json().data;
    assert.match(slip.referenceCode, /^PNDT\d{5}-\d{2}\/\d{2}\/\d{4}$/);
    assert.equal(slip.storeId, MEMORY_SEED_IDS.nvtStore);
    assert.equal(slip.totalQuantity, 3);
    assert.equal(slip.totalWeightKg, '95.750');

    // Saving the slip is what puts the goods in stock: three units, three bags.
    assert.equal(await inventoryBagCount(app, cookie), before + 3);

    const replay = await recordSlip(app, cookie, 'partner-key-1', payload);
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    assert.equal(replay.json().data.id, slip.id);
    // A retried save must not stock the same goods twice.
    assert.equal(await inventoryBagCount(app, cookie), before + 3);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/store-partner-inbounds',
      headers: { cookie },
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.json().data.length, 1);
    assert.equal(listed.json().data[0].partnerName, 'Đối tác Bình Minh');
  });

  test('refuses a reused idempotency key carrying different goods', async () => {
    const cookie = cookieOf(await login(app, 'ds_nvt'));
    const productId = await firstProductId(app, cookie);
    await recordSlip(app, cookie, 'partner-key-2', slipPayload(productId));
    const conflict = await recordSlip(app, cookie, 'partner-key-2', {
      ...slipPayload(productId),
      partnerName: 'Đối tác khác',
    });
    assert.equal(conflict.statusCode, 409, conflict.body);
  });

  test('keeps partner inbound out of reach of other accounts and other stores', async () => {
    const storeCookie = cookieOf(await login(app, 'ds_nvt'));
    const productId = await firstProductId(app, storeCookie);

    for (const username of ['admin', 'htkd']) {
      const response = await recordSlip(
        app,
        cookieOf(await login(app, username)),
        `partner-${username}`,
        slipPayload(productId),
      );
      assert.equal(response.statusCode, 403, `${username}: ${response.body}`);
    }

    const otherStore = await recordSlip(app, storeCookie, 'partner-other-store', {
      ...slipPayload(productId),
      storeId: MEMORY_SEED_IDS.bdStore,
    });
    assert.equal(otherStore.statusCode, 403, otherStore.body);
  });
});

function slipPayload(productId) {
  return {
    storeId: MEMORY_SEED_IDS.nvtStore,
    partnerName: 'Đối tác Bình Minh',
    note: null,
    receivedAt: new Date().toISOString(),
    lines: [{ productId, quantity: 3, bagWeightsKg: ['45.500', '40.000', '10.250'] }],
  };
}

function recordSlip(app, cookie, idempotencyKey, payload) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/store-partner-inbounds',
    headers: { cookie, 'idempotency-key': idempotencyKey },
    payload,
  });
}

async function inventoryBagCount(app, cookie) {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/store-inventory-bags?page=1&pageSize=100',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().pagination.totalItems;
}

async function firstProductId(app, cookie) {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/products',
    headers: { cookie },
  });
  return response.json().data[0].id;
}

function login(app, username) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password: PASSWORD },
  });
}

function cookieOf(response) {
  const header = response.headers['set-cookie'];
  if (!header || typeof header === 'number') throw new Error('Login did not set a cookie');
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(';')[0] ?? '';
}
