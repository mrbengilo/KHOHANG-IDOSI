import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdminApiError } from './adminApi';
import {
  createAdminStore,
  createAdminStoreGroup,
  getAdminOperationalSettings,
  getAdminHtkdAssignments,
  listActiveRetailStoresForAccounts,
  listAdminAccounts,
  listAdminStoreGroups,
  listAdminStores,
  replaceAdminHtkdAssignments,
  resetAdminAccountPassword,
  updateAdminAccount,
  updateAdminOperationalSettings,
  updateAdminStore,
  updateAdminStoreGroup,
} from './adminApi';

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

const group = {
  id: '22222222-2222-4222-8222-222222222222',
  code: 'MIEN_NAM',
  name: 'Miền Nam',
  status: 'ACTIVE',
  version: 2,
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
} as const;

const store = {
  id: '33333333-3333-4333-8333-333333333333',
  code: 'DS_TEST',
  name: 'DS Test',
  groupId: group.id,
  kind: 'RETAIL',
  status: 'ACTIVE',
  address: null,
  version: 4,
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
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

  it('loads and replaces HTKD assignments with the optimistic account version', async () => {
    const assignment = {
      id: '22222222-2222-4222-8222-222222222222',
      htkdAccountId: account.id,
      storeId: '33333333-3333-4333-8333-333333333333',
      assignedAt: '2026-09-17T01:00:00.000Z',
      assignedByAccountId: '44444444-4444-4444-8444-444444444444',
      revokedAt: null,
      revokedByAccountId: null,
    } as const;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: { assignments: [assignment], htkdAccountId: account.id, sessionVersion: 2 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: { assignments: [], htkdAccountId: account.id, sessionVersion: 3 },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAdminHtkdAssignments(account.id)).resolves.toMatchObject({
      assignments: [assignment],
      sessionVersion: 2,
    });
    await expect(
      replaceAdminHtkdAssignments(account.id, {
        expectedSessionVersion: 2,
        reason: 'Thu hồi toàn bộ phạm vi',
        storeIds: [],
      }),
    ).resolves.toMatchObject({ assignments: [], sessionVersion: 3 });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `/api/v1/admin/accounts/${account.id}/assignments`,
    );
    const replaceInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(replaceInit.method).toBe('PUT');
    expect(JSON.parse(String(replaceInit.body))).toEqual({
      expectedSessionVersion: 2,
      reason: 'Thu hồi toàn bộ phạm vi',
      storeIds: [],
    });
  });

  it('loads one filtered page of active retail store choices without page fan-out', async () => {
    const store = (id: string, code: string) => ({
      address: null,
      code,
      createdAt: '2026-09-17T00:00:00.000Z',
      groupId: '55555555-5555-4555-8555-555555555555',
      id,
      kind: 'RETAIL',
      name: code,
      status: 'ACTIVE',
      updatedAt: '2026-09-17T00:00:00.000Z',
      version: 0,
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        data: [store('66666666-6666-4666-8666-666666666666', 'DS_1')],
        pagination: { page: 2, pageSize: 24, totalItems: 49, totalPages: 3 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      listActiveRetailStoresForAccounts({ page: 2, pageSize: 24, search: 'BMT' }),
    ).resolves.toMatchObject({
      data: [expect.objectContaining({ code: 'DS_1' })],
      pagination: { page: 2, totalPages: 3 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('page=2');
    expect(url).toContain('pageSize=24');
    expect(url).toContain('kind=RETAIL');
    expect(url).toContain('status=ACTIVE');
    expect(url).toContain('search=BMT');
  });

  it('loads and versions operational settings without a secret field', async () => {
    const version = {
      id: '22222222-2222-4222-8222-222222222222',
      version: 1,
      timezone: 'Asia/Ho_Chi_Minh',
      snapshotTime: '08:00',
      cutoffTime: '09:00',
      maxRequestsPerStore: 2,
      policyVersion: 'ALLOC-v1.2',
      idosiSyncIntervalMinutes: 15,
      createdByAccountId: null,
      requestId: 'migration:0003',
      createdAt: '2026-09-17T00:00:00.000Z',
    } as const;
    const overview = {
      current: version,
      history: [version],
      integration: {
        endpoint: 'https://idosi.io.vn/api/integrations/warehouse/v1/order-statistics',
        status: 'CONFIGURED',
      },
    } as const;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: overview }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            ...overview,
            current: {
              ...version,
              id: '33333333-3333-4333-8333-333333333333',
              version: 2,
            },
            history: [
              {
                ...version,
                id: '33333333-3333-4333-8333-333333333333',
                version: 2,
              },
              version,
            ],
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAdminOperationalSettings(10)).resolves.toEqual(overview);
    await updateAdminOperationalSettings({
      expectedVersion: 1,
      timezone: 'Asia/Ho_Chi_Minh',
      snapshotTime: '08:00',
      cutoffTime: '09:00',
      maxRequestsPerStore: 2,
      policyVersion: 'ALLOC-v1.3',
      idosiSyncIntervalMinutes: 30,
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/api/v1/admin/operational-settings?historyLimit=10',
    );
    const updateInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(updateInit.method).toBe('PUT');
    expect(JSON.parse(String(updateInit.body))).toEqual({
      expectedVersion: 1,
      timezone: 'Asia/Ho_Chi_Minh',
      snapshotTime: '08:00',
      cutoffTime: '09:00',
      maxRequestsPerStore: 2,
      policyVersion: 'ALLOC-v1.3',
      idosiSyncIntervalMinutes: 30,
    });
    expect(String(updateInit.body)).not.toContain('secret');
  });

  it('queries store and group lifecycle pages with server-side filters', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [group],
          pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [store],
          pagination: { page: 2, pageSize: 20, totalItems: 21, totalPages: 2 },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      listAdminStoreGroups({ page: 1, pageSize: 20, search: '%_Nam', status: 'ACTIVE' }),
    ).resolves.toMatchObject({ data: [group] });
    await expect(
      listAdminStores({
        page: 2,
        pageSize: 20,
        groupId: group.id,
        kind: 'RETAIL',
        status: 'ACTIVE',
      }),
    ).resolves.toMatchObject({ data: [store] });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('search=%25_Nam');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('status=ACTIVE');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(`groupId=${group.id}`);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('kind=RETAIL');
  });

  it('sends idempotency keys and optimistic versions for store lifecycle mutations', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { ...group, version: 0 } }, 201))
      .mockResolvedValueOnce(jsonResponse({ data: { ...group, name: 'Miền Nam mới', version: 3 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { ...store, version: 0 } }, 201))
      .mockResolvedValueOnce(jsonResponse({ data: { ...store, status: 'INACTIVE', version: 5 } }));
    vi.stubGlobal('fetch', fetchMock);

    await createAdminStoreGroup({ code: group.code, name: group.name }, 'group-create-key');
    await updateAdminStoreGroup(
      group.id,
      { expectedVersion: 2, name: 'Miền Nam mới' },
      'group-update-key',
    );
    await createAdminStore(
      {
        address: null,
        code: store.code,
        groupId: group.id,
        kind: store.kind,
        name: store.name,
      },
      'store-create-key',
    );
    await updateAdminStore(
      store.id,
      { expectedVersion: 4, status: 'INACTIVE' },
      'store-update-key',
    );

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      body: JSON.parse(String((init as RequestInit | undefined)?.body)),
      key: new Headers((init as RequestInit | undefined)?.headers).get('idempotency-key'),
      method: (init as RequestInit | undefined)?.method,
      url: String(url),
    }));
    expect(requests).toEqual([
      expect.objectContaining({
        key: 'group-create-key',
        method: 'POST',
        url: expect.stringContaining('/store-groups'),
      }),
      expect.objectContaining({
        body: { expectedVersion: 2, name: 'Miền Nam mới' },
        key: 'group-update-key',
        method: 'PATCH',
      }),
      expect.objectContaining({
        key: 'store-create-key',
        method: 'POST',
        url: expect.stringContaining('/stores'),
      }),
      expect.objectContaining({
        body: { expectedVersion: 4, status: 'INACTIVE' },
        key: 'store-update-key',
        method: 'PATCH',
      }),
    ]);
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}
