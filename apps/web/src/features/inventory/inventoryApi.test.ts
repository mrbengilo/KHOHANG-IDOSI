import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createStoreOutbound,
  listInventoryBags,
  openInventoryBag,
  reviewStoreOutbound,
} from './inventoryApi';

const bag = {
  id: '10000000-0000-4000-8000-000000000001',
  storeId: '20000000-0000-4000-8000-000000000001',
  productId: '30000000-0000-4000-8000-000000000001',
  sourceReceiptBagId: '40000000-0000-4000-8000-000000000001',
  outboundOrderId: '50000000-0000-4000-8000-000000000001',
  bagCode: 'GV-DAM-014',
  originalWeightKg: '100.000',
  receivedWeightKg: '99.500',
  remainingWeightKg: '99.500',
  status: 'AVAILABLE',
  version: 2,
  receivedAt: '2026-09-17T01:00:00.000Z',
  updatedAt: '2026-09-17T01:00:00.000Z',
} as const;

const outbound = {
  id: '60000000-0000-4000-8000-000000000001',
  storeId: bag.storeId,
  inventoryLotId: bag.id,
  weightKg: '1.250',
  reason: 'DISCOUNT_SALE',
  revenueVnd: 250_000,
  status: 'PENDING',
  createdByAccountId: '70000000-0000-4000-8000-000000000001',
  reviewedByAccountId: null,
  reviewNote: null,
  version: 0,
  createdAt: '2026-09-17T02:00:00.000Z',
  updatedAt: '2026-09-17T02:00:00.000Z',
} as const;

describe('inventory API client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads scoped bags with credentials and exact decimal strings', async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [bag],
            pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listInventoryBags({ storeId: bag.storeId, status: 'AVAILABLE' })).resolves.toEqual(
      [bag],
    );
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain(`storeId=${bag.storeId}`);
    expect(String(url)).toContain('status=AVAILABLE');
    expect(init).toEqual(expect.objectContaining({ credentials: 'include' }));
  });

  it('loads every inventory page instead of silently truncating at 100 rows', async () => {
    const secondBag = { ...bag, id: '10000000-0000-4000-8000-000000000002' };
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const page = String(input).includes('page=2') ? 2 : 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [page === 1 ? bag : secondBag],
            pagination: { page, pageSize: 100, totalItems: 101, totalPages: 2 },
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(listInventoryBags()).resolves.toEqual([bag, secondBag]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends the supplied idempotency key and expected bag version when opening', async () => {
    const opened = { ...bag, status: 'OPEN', version: 3 } as const;
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('open-key');
      expect(JSON.parse(String(init?.body))).toEqual({ expectedVersion: 2 });
      return Promise.resolve(new Response(JSON.stringify({ data: opened }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(openInventoryBag(bag.id, { expectedVersion: 2 }, 'open-key')).resolves.toEqual(
      opened,
    );
  });

  it('creates and reviews an outbound with versioned, validated payloads', async () => {
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const isReview = String(input).includes('/review');
      expect(new Headers(init?.headers).get('idempotency-key')).toBe(
        isReview ? 'review-key' : 'create-key',
      );
      if (isReview) {
        expect(JSON.parse(String(init?.body))).toEqual({
          decision: 'APPROVE',
          expectedVersion: 0,
          note: null,
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                ...outbound,
                status: 'APPROVED',
                reviewedByAccountId: '80000000-0000-4000-8000-000000000001',
                version: 1,
              },
            }),
            { status: 200 },
          ),
        );
      }
      expect(JSON.parse(String(init?.body))).toEqual({
        expectedInventoryVersion: 2,
        inventoryLotId: bag.id,
        reason: 'DISCOUNT_SALE',
        revenueVnd: 250_000,
        storeId: bag.storeId,
        weightKg: '1.250',
      });
      return Promise.resolve(new Response(JSON.stringify({ data: outbound }), { status: 201 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createStoreOutbound(
        {
          expectedInventoryVersion: 2,
          inventoryLotId: bag.id,
          reason: 'DISCOUNT_SALE',
          revenueVnd: 250_000,
          storeId: bag.storeId,
          weightKg: '1.250',
        },
        'create-key',
      ),
    ).resolves.toEqual(outbound);
    await expect(
      reviewStoreOutbound(
        outbound.id,
        { decision: 'APPROVE', expectedVersion: 0, note: null },
        'review-key',
      ),
    ).resolves.toEqual(expect.objectContaining({ status: 'APPROVED', version: 1 }));
  });

  it('surfaces structured backend errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 'VERSION_CONFLICT',
                message: 'Bao tồn kho đã thay đổi',
                requestId: 'req-1',
              },
            }),
            { status: 409 },
          ),
        ),
      ),
    );

    await expect(
      openInventoryBag(bag.id, { expectedVersion: 2 }, 'open-key'),
    ).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      message: 'Bao tồn kho đã thay đổi',
      requestId: 'req-1',
    });
  });
});
