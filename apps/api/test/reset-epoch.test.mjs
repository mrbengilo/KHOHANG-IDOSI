import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../dist/app.js';

test('old tab and old replay are rejected before any handler, accounts/sessions remain usable', async () => {
  let epoch = '0';
  const app = await createApi({
    resetEpoch: async () => epoch,
    resetReplayKey: async (key) => key === 'old-key',
  });
  try {
    const before = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    assert.equal(before.headers['x-idosi-reset-epoch'], '0');
    epoch = 'reset-operation-id';
    for (const supplied of [undefined, '0', 'other-reset']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'fixture', password: 'fixture' },
        headers: supplied ? { 'x-idosi-reset-epoch': supplied } : {},
      });
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error.code, 'RESET_REQUIRED');
    }
    const fresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'fixture', password: 'fixture' },
      headers: { 'x-idosi-reset-epoch': epoch },
    });
    assert.notEqual(fresh.json().error?.code, 'RESET_REQUIRED');
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'fixture', password: 'fixture' },
      headers: { 'x-idosi-reset-epoch': epoch, 'idempotency-key': 'old-key' },
    });
    assert.equal(replay.statusCode, 409);
    const read = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    assert.equal(read.headers['x-idosi-reset-epoch'], epoch);
    assert.equal(read.headers['cache-control'], 'no-store');
  } finally {
    await app.close();
  }
});
