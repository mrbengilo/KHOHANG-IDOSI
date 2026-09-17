import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdminApiError } from './adminApi';
import { listAdminAccounts, resetAdminAccountPassword, updateAdminAccount } from './adminApi';

const account = {
  createdAt: '2026-09-17T00:00:00.000Z',
  displayName: 'Điều phối HTKD',
  id: '11111111-1111-4111-8111-111111111111',
  role: 'HTKD',
  sessionVersion: 2,
  status: 'ACTIVE',
  storeId: null,
  updatedAt: '2026-09-17T00:00:00.000Z',
  username: 'htkd.test',
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('admin API client', () => {
  it('queries real paginated accounts without a mock fallback', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        data: [account],
        pagination: { page: 2, pageSize: 20, totalItems: 21, totalPages: 2 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      listAdminAccounts({ page: 2, pageSize: 20, role: 'HTKD', search: 'test' }),
    ).resolves.toEqual({
      data: [account],
      pagination: { page: 2, pageSize: 20, totalItems: 21, totalPages: 2 },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('/api/v1/admin/accounts?');
    expect(String(url)).toContain('page=2');
    expect(String(url)).toContain('role=HTKD');
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'include' });
  });

  it('sends optimistic versions for status and password mutations', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: { ...account, sessionVersion: 3, status: 'LOCKED' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: { accountId: account.id, sessionVersion: 4, sessionsRevoked: 2 } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await updateAdminAccount(account.id, { expectedSessionVersion: 2, status: 'LOCKED' });
    await resetAdminAccountPassword(account.id, {
      expectedSessionVersion: 3,
      newPassword: 'new-secure-password',
      revokeSessions: true,
    });

    const statusInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const resetInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(statusInit.body))).toEqual({
      expectedSessionVersion: 2,
      status: 'LOCKED',
    });
    expect(JSON.parse(String(resetInit.body))).toEqual({
      expectedSessionVersion: 3,
      newPassword: 'new-secure-password',
      revokeSessions: true,
    });
  });

  it('retains backend error code and request id for safe recovery', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: 'VERSION_CONFLICT',
              message: 'Tài khoản đã thay đổi',
              requestId: 'request-version-1',
            },
          },
          409,
        ),
      ),
    );

    await expect(
      updateAdminAccount(account.id, { expectedSessionVersion: 1, status: 'LOCKED' }),
    ).rejects.toMatchObject<Partial<AdminApiError>>({
      code: 'VERSION_CONFLICT',
      requestId: 'request-version-1',
      status: 409,
    });
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}
