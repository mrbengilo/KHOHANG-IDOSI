import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { createApi } from '../dist/app.js';
import { MemoryWarehouseRepository } from '../dist/memory-repository.js';

const PASSWORD = 'IDOSI-test-password-2026!';

describe('store and store-group lifecycle API', () => {
  let app;

  beforeEach(async () => {
    const repository = await MemoryWarehouseRepository.create({ bootstrapPassword: PASSWORD });
    app = await createApi({ repository, corsOrigin: 'http://localhost:5173' });
  });

  afterEach(async () => app.close());

  test('enforces ADMIN scope, idempotency, optimistic versions and immutable audit history', async () => {
    const adminCookie = cookieOf(await login('admin'));
    const storeCookie = cookieOf(await login('ds_nvt'));

    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/store-groups',
      headers: { cookie: storeCookie },
    });
    assert.equal(denied.statusCode, 403);

    const missingKey = await app.inject({
      method: 'POST',
      url: '/api/v1/store-groups',
      headers: { cookie: adminCookie },
      payload: { code: 'LIFECYCLE_TEST', name: 'Nhóm vòng đời' },
    });
    assert.equal(missingKey.statusCode, 400);

    const createdGroup = await mutate(adminCookie, 'POST', '/api/v1/store-groups', 'group-create', {
      code: 'LIFECYCLE_TEST',
      name: 'Nhóm vòng đời',
    });
    assert.equal(createdGroup.statusCode, 201);
    assert.equal(createdGroup.headers['idempotency-replayed'], 'false');
    assert.equal(createdGroup.json().data.version, 0);
    const group = createdGroup.json().data;

    const replayedGroup = await mutate(
      adminCookie,
      'POST',
      '/api/v1/store-groups',
      'group-create',
      { code: 'LIFECYCLE_TEST', name: 'Nhóm vòng đời' },
    );
    assert.equal(replayedGroup.statusCode, 201);
    assert.equal(replayedGroup.headers['idempotency-replayed'], 'true');
    assert.deepEqual(replayedGroup.json(), createdGroup.json());

    const mismatchedReplay = await mutate(
      adminCookie,
      'POST',
      '/api/v1/store-groups',
      'group-create',
      { code: 'LIFECYCLE_OTHER', name: 'Nội dung khác' },
    );
    assert.equal(mismatchedReplay.statusCode, 409);
    assert.equal(mismatchedReplay.json().error.code, 'IDEMPOTENCY_CONFLICT');

    const createdStore = await mutate(adminCookie, 'POST', '/api/v1/stores', 'store-create', {
      code: 'DS_LIFECYCLE',
      name: 'DS Lifecycle',
      groupId: group.id,
      kind: 'RETAIL',
      address: null,
    });
    assert.equal(createdStore.statusCode, 201);
    assert.equal(createdStore.json().data.version, 0);
    const store = createdStore.json().data;

    const blockedGroup = await mutate(
      adminCookie,
      'PATCH',
      `/api/v1/store-groups/${group.id}`,
      'group-disable',
      { expectedVersion: 0, status: 'INACTIVE' },
    );
    assert.equal(blockedGroup.statusCode, 409);
    assert.equal(blockedGroup.json().error.code, 'CONFLICT');

    const staleStore = await mutate(
      adminCookie,
      'PATCH',
      `/api/v1/stores/${store.id}`,
      'store-stale',
      { expectedVersion: 99, status: 'INACTIVE' },
    );
    assert.equal(staleStore.statusCode, 409);
    assert.equal(staleStore.json().error.code, 'VERSION_CONFLICT');

    const disabledStore = await mutate(
      adminCookie,
      'PATCH',
      `/api/v1/stores/${store.id}`,
      'store-disable',
      { expectedVersion: 0, status: 'INACTIVE' },
    );
    assert.equal(disabledStore.statusCode, 200);
    assert.equal(disabledStore.json().data.status, 'INACTIVE');
    assert.equal(disabledStore.json().data.version, 1);

    const renamedStore = await mutate(
      adminCookie,
      'PATCH',
      `/api/v1/stores/${store.id}`,
      'store-rename',
      { expectedVersion: 1, name: 'DS Lifecycle Updated' },
    );
    assert.equal(renamedStore.statusCode, 200);
    assert.equal(renamedStore.json().data.version, 2);

    const exactReplay = await mutate(
      adminCookie,
      'PATCH',
      `/api/v1/stores/${store.id}`,
      'store-disable',
      { expectedVersion: 0, status: 'INACTIVE' },
    );
    assert.equal(exactReplay.statusCode, 200);
    assert.equal(exactReplay.headers['idempotency-replayed'], 'true');
    assert.deepEqual(exactReplay.json(), disabledStore.json());

    const disabledGroup = await mutate(
      adminCookie,
      'PATCH',
      `/api/v1/store-groups/${group.id}`,
      'group-disable',
      { expectedVersion: 0, status: 'INACTIVE' },
    );
    assert.equal(disabledGroup.statusCode, 200);
    assert.equal(disabledGroup.json().data.version, 1);

    const groups = await app.inject({
      method: 'GET',
      url: '/api/v1/store-groups?status=INACTIVE&search=v%C3%B2ng',
      headers: { cookie: adminCookie },
    });
    assert.equal(groups.statusCode, 200);
    assert.deepEqual(
      groups.json().data.map((item) => item.id),
      [group.id],
    );

    const audit = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs?entityType=store_group',
      headers: { cookie: adminCookie },
    });
    assert.equal(audit.statusCode, 200);
    assert.deepEqual(
      audit
        .json()
        .data.map((event) => event.action)
        .sort(),
      ['STORE_GROUP_CREATED', 'STORE_GROUP_UPDATED'],
    );
  });

  test('publishes all lifecycle operations in OpenAPI', async () => {
    const specification = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    assert.ok(specification.paths['/api/v1/store-groups'].get);
    assert.ok(specification.paths['/api/v1/store-groups'].post);
    assert.ok(specification.paths['/api/v1/store-groups/{groupId}'].patch);
    assert.ok(specification.paths['/api/v1/stores/{storeId}'].patch);
    assert.equal(specification.paths['/api/v1/stores'].post.parameters[0].name, 'idempotency-key');
  });

  async function login(username) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password: PASSWORD },
    });
  }

  async function mutate(cookie, method, url, idempotencyKey, payload) {
    return app.inject({
      method,
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
