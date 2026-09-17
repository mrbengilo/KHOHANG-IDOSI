import type { IdosiStatisticsScope } from '@idosi/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getIdosiStatistics, syncIdosiStatistics } from './idosiStatisticsApi';

const scope: IdosiStatisticsScope = {
  date: null,
  paymentMethod: null,
  period: '2026-09',
  shiftId: null,
  storeId: '20000000-0000-4000-8000-000000000001',
};

const emptyWeightBucket = {
  actualKg: 0,
  estimatedKg: 0,
  invalidLines: 0,
  isComplete: true,
  knownKg: 0,
  missingFactorLines: 0,
  totalKg: 0,
  unclassifiedOrders: 0,
} as const;

const weight = {
  ...emptyWeightBucket,
  byRevenueType: {
    NORMAL: emptyWeightBucket,
    SALE_KG: emptyWeightBucket,
    SALE_PIECE: emptyWeightBucket,
  },
  schemaVersion: 1,
  tableVersion: '2026-09',
  unit: 'KG',
} as const;

const response = {
  data: {
    freshness: 'CURRENT',
    integrationStatus: 'CONFIGURED',
    latestAttempt: {
      completedAt: '2026-09-17T03:00:01.000Z',
      errorCode: null,
      errorMessage: null,
      id: '40000000-0000-4000-8000-000000000001',
      source: 'MANUAL',
      startedAt: '2026-09-17T03:00:00.000Z',
      status: 'SUCCEEDED',
    },
    scope,
    snapshot: {
      firstSyncedAt: '2026-09-17T03:00:01.000Z',
      id: '30000000-0000-4000-8000-000000000001',
      lastSyncedAt: '2026-09-17T03:00:01.000Z',
      payload: {
        apiVersion: 1,
        currency: 'VND',
        filters: { date: null, paymentMethod: null, period: '2026-09', shiftId: null },
        generatedAt: '2026-09-17T03:00:00.000Z',
        groups: { day: [], month: [], shift: [] },
        ok: true,
        products: {
          items: [],
          ordersWithItems: 0,
          productTypes: 0,
          totalQuantity: 0,
          totalWeightKg: 0,
          unclassifiedOrders: 0,
          weight,
          weightByProduct: [],
        },
        requestId: 'idosi-request-1',
        revenueBasis: 'ACTIVE_ORDER_AMOUNT',
        serverTime: '2026-09-17T03:00:00.000Z',
        store: { id: 'HCM-01', name: 'IDOSI Hồ Chí Minh' },
        storeId: 'HCM-01',
        timezone: 'Asia/Ho_Chi_Minh',
        totals: {
          cash: 0,
          cashOrders: 0,
          orders: 0,
          revenue: 0,
          revenueByType: { NORMAL: 0, SALE_KG: 0, SALE_PIECE: 0 },
          transfer: 0,
          transferOrders: 0,
          weight,
        },
      },
      scopeKey: 'period=2026-09&date=*&shift=*&payment=*',
      storeId: scope.storeId,
    },
  },
} as const;

describe('IDOSI statistics API client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads one exact monthly store scope with the authenticated session', async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(response), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getIdosiStatistics(scope)).resolves.toMatchObject({
      freshness: 'CURRENT',
      scope,
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('/integrations/idosi/order-statistics?');
    expect(String(url)).toContain(`storeId=${scope.storeId}`);
    expect(String(url)).toContain('period=2026-09');
    expect(String(url)).not.toContain('date=');
    expect(init).toEqual(expect.objectContaining({ cache: 'no-store', credentials: 'include' }));
  });

  it('posts only the validated scope and never exposes an integration secret', async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual(scope);
      expect(String(init?.body)).not.toMatch(/secret|bearer|authorization/iu);
      return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(syncIdosiStatistics(scope)).resolves.toMatchObject({
      integrationStatus: 'CONFIGURED',
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      '/api/v1/integrations/idosi/order-statistics/sync',
    );
  });

  it('surfaces structured server failures instead of substituting zero statistics', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 'INTEGRATION_UNAVAILABLE',
                message: 'IDOSI tạm thời không phản hồi.',
                requestId: 'req-idosi-1',
              },
            }),
            { status: 502 },
          ),
        ),
      ),
    );

    await expect(syncIdosiStatistics(scope)).rejects.toMatchObject({
      code: 'INTEGRATION_UNAVAILABLE',
      message: 'IDOSI tạm thời không phản hồi.',
      requestId: 'req-idosi-1',
      status: 502,
    });
  });
});
