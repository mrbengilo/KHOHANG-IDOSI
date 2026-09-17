import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cancelStoreTransfer,
  createStoreTransfer,
  dispatchStoreTransfer,
  listStoreTransferDestinations,
  listStoreTransfers,
  receiveStoreTransfer,
} from './transferApi';

const sourceStoreId = '10000000-0000-4000-8000-000000000001';
const destinationStoreId = '10000000-0000-4000-8000-000000000002';
const sourceBagId = '20000000-0000-4000-8000-000000000001';
const transferId = '30000000-0000-4000-8000-000000000001';

const store = {
  id: destinationStoreId,
  code: 'BD',
  name: 'Bình Dương',
  groupId: '40000000-0000-4000-8000-000000000001',
  kind: 'RETAIL',
  status: 'ACTIVE',
  address: null,
  version: 0,
  createdAt: '2026-09-17T01:00:00.000Z',
  updatedAt: '2026-09-17T01:00:00.000Z',
} as const;

const draftTransfer = {
  id: transferId,
  transferNumber: 'TR-20260917-0001',
  sourceStoreId,
  destinationStoreId,
  sourceInventoryBagId: sourceBagId,
  destinationInventoryBagId: null,
  productId: '50000000-0000-4000-8000-000000000001',
  weightKg: '5.250',
  costVnd: null,
  status: 'DRAFT',
  note: null,
  cancellationReason: null,
  version: 0,
  createdByAccountId: '60000000-0000-4000-8000-000000000001',
  dispatchedByAccountId: null,
  receivedByAccountId: null,
  createdAt: '2026-09-17T02:00:00.000Z',
  dispatchedAt: null,
  receivedAt: null,
  cancelledAt: null,
  updatedAt: '2026-09-17T02:00:00.000Z',
} as const;

describe('transfer API client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads the safe destination directory with session credentials', async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ data: [store] }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listStoreTransferDestinations()).resolves.toEqual([store]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('/store-transfers/destinations');
    expect(init).toEqual(expect.objectContaining({ credentials: 'include' }));
  });

  it('loads every filtered transfer page without truncating at 100 rows', async () => {
    const receivedTransfer = {
      ...draftTransfer,
      id: '30000000-0000-4000-8000-000000000002',
      destinationInventoryBagId: '70000000-0000-4000-8000-000000000001',
      costVnd: 525_000,
      status: 'RECEIVED',
      version: 2,
      dispatchedByAccountId: draftTransfer.createdByAccountId,
      receivedByAccountId: '60000000-0000-4000-8000-000000000002',
      dispatchedAt: '2026-09-17T03:00:00.000Z',
      receivedAt: '2026-09-17T04:00:00.000Z',
    } as const;
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const page = String(input).includes('page=2') ? 2 : 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [page === 1 ? receivedTransfer : { ...receivedTransfer, id: transferId }],
            pagination: { page, pageSize: 100, totalItems: 101, totalPages: 2 },
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(listStoreTransfers({ status: 'RECEIVED' })).resolves.toHaveLength(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('status=RECEIVED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends validated, versioned transfer mutations with unique caller keys', async () => {
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe('POST');
      expect(headers.get('idempotency-key')).toMatch(/-key$/u);

      if (url.endsWith('/dispatch')) {
        expect(payload).toEqual({ expectedVersion: 0, expectedSourceBagVersion: 3 });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                ...draftTransfer,
                costVnd: 525_000,
                status: 'IN_TRANSIT',
                version: 1,
                dispatchedByAccountId: draftTransfer.createdByAccountId,
                dispatchedAt: '2026-09-17T03:00:00.000Z',
              },
            }),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith('/receive')) {
        expect(payload).toEqual({ expectedVersion: 1 });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                ...draftTransfer,
                destinationInventoryBagId: '70000000-0000-4000-8000-000000000001',
                costVnd: 525_000,
                status: 'RECEIVED',
                version: 2,
                dispatchedByAccountId: draftTransfer.createdByAccountId,
                receivedByAccountId: '60000000-0000-4000-8000-000000000002',
                dispatchedAt: '2026-09-17T03:00:00.000Z',
                receivedAt: '2026-09-17T04:00:00.000Z',
              },
            }),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith('/cancel')) {
        expect(payload).toEqual({ expectedVersion: 0, reason: 'Sai cửa hàng đích' });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                ...draftTransfer,
                cancellationReason: 'Sai cửa hàng đích',
                status: 'CANCELLED',
                version: 1,
                cancelledAt: '2026-09-17T03:00:00.000Z',
              },
            }),
            { status: 200 },
          ),
        );
      }
      expect(payload).toEqual({
        sourceStoreId,
        destinationStoreId,
        sourceInventoryBagId: sourceBagId,
        weightKg: '5.250',
        expectedSourceBagVersion: 3,
        note: null,
      });
      return Promise.resolve(
        new Response(JSON.stringify({ data: draftTransfer }), { status: 201 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await createStoreTransfer(
      {
        sourceStoreId,
        destinationStoreId,
        sourceInventoryBagId: sourceBagId,
        weightKg: '5.250',
        expectedSourceBagVersion: 3,
        note: null,
      },
      'create-key',
    );
    await dispatchStoreTransfer(
      transferId,
      { expectedVersion: 0, expectedSourceBagVersion: 3 },
      'dispatch-key',
    );
    await receiveStoreTransfer(transferId, { expectedVersion: 1 }, 'receive-key');
    await cancelStoreTransfer(
      transferId,
      { expectedVersion: 0, reason: 'Sai cửa hàng đích' },
      'cancel-key',
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
