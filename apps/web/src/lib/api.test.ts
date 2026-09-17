import { afterEach, describe, expect, it, vi } from 'vitest';
import { listCatalog, listOpenOrderSessions, submitStoreOrderRequest } from './api';

const pagination = { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 };

describe('API projections', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a missing conversion explicit instead of inventing a one-to-one ratio', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        const payload = url.includes('/product-conversions')
          ? { data: [], pagination: { ...pagination, totalItems: 0, totalPages: 0 } }
          : {
              data: [
                {
                  createdAt: '2026-09-17T00:00:00.000Z',
                  id: '00000000-0000-4000-8000-000000000001',
                  measurement: 'UNIT',
                  name: 'Mặt hàng chưa quy đổi',
                  sku: 'MISSING-001',
                  status: 'ACTIVE',
                  unitLabel: 'cái',
                  updatedAt: '2026-09-17T00:00:00.000Z',
                },
              ],
              pagination,
            };
        return Promise.resolve(
          new Response(JSON.stringify(payload), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          }),
        );
      }),
    );

    await expect(listCatalog()).resolves.toEqual([
      expect.objectContaining({
        conversionMissing: true,
        itemQuantity: null,
        weightKilograms: null,
      }),
    ]);
  });

  it('loads the active order session and sends an explicit idempotency key', async () => {
    const sessionId = '10000000-0000-4000-8000-000000000001';
    const storeId = '20000000-0000-4000-8000-000000000001';
    const productId = '40000000-0000-4000-8000-000000000001';
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/order-sessions')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  allocationStartsAt: '2026-09-17T02:00:00.000Z',
                  businessDate: '2026-09-17',
                  createdAt: '2026-09-16T23:00:00.000Z',
                  id: sessionId,
                  requestClosesAt: '2026-09-17T01:00:00.000Z',
                  requestOpensAt: '2026-09-17T00:00:00.000Z',
                  status: 'OPEN',
                  updatedAt: '2026-09-16T23:00:00.000Z',
                },
              ],
              pagination,
            }),
            { status: 200 },
          ),
        );
      }
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('request-key-2026');
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              cancelledAt: null,
              id: '60000000-0000-4000-8000-000000000001',
              lines: [
                {
                  priority: 'P1',
                  productId,
                  requested: { kind: 'UNIT', quantity: 2 },
                },
              ],
              requestSequence: 1,
              sessionId,
              status: 'SUBMITTED',
              storeId,
              submittedAt: '2026-09-17T00:10:00.000Z',
              submittedByAccountId: '00000000-0000-4000-8000-000000000001',
            },
          }),
          { status: 201 },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(listOpenOrderSessions()).resolves.toEqual([
      expect.objectContaining({ id: sessionId, status: 'OPEN' }),
    ]);
    await expect(
      submitStoreOrderRequest(
        { businessSessionId: sessionId, items: [{ productId, quantity: 2 }], storeId },
        'request-key-2026',
      ),
    ).resolves.toEqual(expect.objectContaining({ requestSequence: 1, status: 'SUBMITTED' }));
  });
});
