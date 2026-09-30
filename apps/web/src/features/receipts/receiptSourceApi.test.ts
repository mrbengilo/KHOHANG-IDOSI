import { afterEach, expect, it, vi } from 'vitest';
import { listStoreReceiptSources } from './receiptSourceApi';
import { listStoreTransfers } from '../transfers/transferApi';
import { loadDashboardBootstrap } from '../dashboard/dashboardApi';
import { listActiveStoresForAccounts, listAdminStoreGroupDirectory } from '../admin/adminApi';

afterEach(() => vi.unstubAllGlobals());

it.each([
  ['receipt sources', listStoreReceiptSources],
  ['transfers', listStoreTransfers],
  ['dashboard stores', async () => (await loadDashboardBootstrap()).stores],
  ['account store directory', listActiveStoresForAccounts],
  ['store group directory', listAdminStoreGroupDirectory],
] as const)(
  'loads all %s pages with at most three in flight, without dropping a page',
  async (_name, load) => {
    let active = 0;
    let peak = 0;
    const pages: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.endsWith('/auth/session'))
          return new Response(
            JSON.stringify({
              data: {
                id: '90000000-0000-4000-8000-000000000001',
                createdAt: '2026-09-17T00:00:00Z',
                expiresAt: '2026-09-18T00:00:00Z',
                lastSeenAt: '2026-09-17T00:01:00Z',
                principal: {
                  accountId: '10000000-0000-4000-8000-000000000001',
                  assignedStoreIds: [],
                  displayName: 'Admin',
                  role: 'ADMIN',
                  status: 'ACTIVE',
                  storeId: null,
                  username: 'audit.admin',
                },
              },
            }),
          );
        const page = Number(new URL(input, 'http://localhost').searchParams.get('page'));
        pages.push(page);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return new Response(
          JSON.stringify({
            data: [],
            pagination: { page, pageSize: 100, totalPages: 8, totalItems: 800 },
          }),
        );
      }),
    );
    await expect(load()).resolves.toEqual([]);
    expect(peak).toBe(3);
    expect(pages.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  },
);
