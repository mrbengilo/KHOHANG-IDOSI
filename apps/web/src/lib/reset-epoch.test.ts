import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it('pins the tab epoch and drops the old document instead of retrying a stale mutation', async () => {
  vi.resetModules();
  const reload = vi.fn();
  vi.stubGlobal('window', {
    crypto: globalThis.crypto,
    location: { reload },
    sessionStorage: { getItem: () => null, setItem: vi.fn() },
  });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('{}', { headers: { 'x-idosi-reset-epoch': 'before' } }))
    .mockResolvedValueOnce(
      new Response('{}', { status: 409, headers: { 'x-idosi-reset-epoch': 'after' } }),
    );
  vi.stubGlobal('fetch', fetcher);
  const { requestJson } = await import('./http-request');
  class ClientError extends Error {
    constructor(
      message: string,
      public status: number,
      public code?: string,
    ) {
      super(message);
    }
  }
  await requestJson('/auth/session', undefined, ClientError);
  await expect(
    requestJson('/orders', { method: 'POST', body: '{}' }, ClientError),
  ).rejects.toMatchObject({ status: 409, code: 'RESET_REQUIRED' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1]![1].headers.get('x-idosi-reset-epoch')).toBe('before');
  expect(reload).toHaveBeenCalledOnce();
});
