import { afterEach, expect, it, vi } from 'vitest';
import { request } from './api';
import { requestJson } from './http-request';
import { AdminApiError } from '../features/admin/adminApi';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('bounds a response body that stalls after headers and keeps the command result uncertain', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init: RequestInit) => ({
      status: 200,
      ok: true,
      json: () =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    })),
  );
  const pending = request('/receipts/fixture/finalize', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'original-key' },
    body: '{}',
  });
  const outcome = expect(pending).rejects.toMatchObject({
    code: 'REQUEST_TIMEOUT',
    message: expect.stringContaining('Chưa xác định'),
  });
  await vi.advanceTimersByTimeAsync(120_001);
  await outcome;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([400, 401, 403, 409, 429, 500, 503])(
  'preserves HTTP %i and request ID without retrying',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'CONFLICT', message: 'Server detail', requestId: 'audit-request' },
            }),
            { status },
          ),
      ),
    );
    await expect(
      requestJson('/admin/accounts', { method: 'POST', body: '{}' }, AdminApiError),
    ).rejects.toMatchObject({
      name: 'AdminApiError',
      status,
      code: 'CONFLICT',
      requestId: 'audit-request',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it('rejects malformed success JSON explicitly and clears timers', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('invalid json', { status: 200 })),
  );
  await expect(request('/warehouse-inventory')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(vi.getTimerCount()).toBe(0);
});

it('does not start a request with an already cancelled signal', async () => {
  const controller = new AbortController();
  controller.abort();
  vi.stubGlobal('fetch', vi.fn());
  await expect(
    request('/warehouse-inventory', { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).not.toHaveBeenCalled();
});

it('ends an unresponsive read within a finite deadline and aborts the network operation', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url, init: RequestInit) => {
      signal = init.signal;
      return new Promise((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(signal?.reason)),
      );
    }),
  );
  let failure: unknown;
  const pending = request('/warehouse-inventory').catch((error: unknown) => {
    failure = error;
  });
  await vi.advanceTimersByTimeAsync(60_001);
  expect(failure).toMatchObject({ code: 'REQUEST_TIMEOUT', status: 0 });
  expect(signal?.aborted).toBe(true);
  await pending;
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves deliberate cancellation instead of reporting a network failure', async () => {
  const controller = new AbortController();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    ),
  );
  const pending = request('/warehouse-inventory', { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
