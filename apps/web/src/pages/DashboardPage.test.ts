import type { MonthlyOperationalReport, Session, Store } from '@idosi/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDashboardBootstrap, loadDashboardSnapshot } from '../features/dashboard/dashboardApi';
import {
  dashboardRetryTarget,
  dashboardRouteForAction,
  dashboardViewState,
  formatExactGrams,
  formatExactVnd,
  resolveDashboardScope,
} from './DashboardPage';

const accountId = '10000000-0000-4000-8000-000000000001';
const sessionId = '90000000-0000-4000-8000-000000000001';
const storeId = '20000000-0000-4000-8000-000000000001';
const secondStoreId = '20000000-0000-4000-8000-000000000002';
const groupId = '30000000-0000-4000-8000-000000000001';
const timestamp = '2026-09-17T03:00:00.000Z';

const stores: Store[] = [
  {
    address: 'Gò Vấp',
    code: 'GV',
    createdAt: timestamp,
    groupId,
    id: storeId,
    kind: 'RETAIL',
    name: 'Gò Vấp',
    status: 'ACTIVE',
    updatedAt: timestamp,
  },
  {
    address: null,
    code: 'LX',
    createdAt: timestamp,
    groupId,
    id: secondStoreId,
    kind: 'WHOLESALE',
    name: 'Long Xuyên',
    status: 'ACTIVE',
    updatedAt: timestamp,
  },
];

const sessionFor = (role: Session['principal']['role']): Session => ({
  createdAt: timestamp,
  expiresAt: '2026-09-18T03:00:00.000Z',
  id: sessionId,
  lastSeenAt: timestamp,
  principal: {
    accountId,
    assignedStoreIds: role === 'HTKD' ? [storeId] : [],
    displayName: role,
    role,
    status: 'ACTIVE',
    storeId: role === 'STORE' ? secondStoreId : null,
    username: `${role.toLocaleLowerCase('en-US')}.test`,
  },
});

const available = (value: string) => ({
  source: 'STORE_RECEIPTS' as const,
  unavailableReason: null,
  value,
});

const unavailable = () => ({
  source: 'NOT_AVAILABLE' as const,
  unavailableReason: 'VAT_NOT_CAPTURED' as const,
  value: null,
});

const report: MonthlyOperationalReport = {
  counts: {
    allocationBatchesCompleted: 0,
    approvedDiscountSales: 0,
    inboundReceipts: 0,
    outboundOrdersReceived: 0,
    waitTicketsQueued: 0,
  },
  dataOrigin: 'LOCAL_TRANSACTIONAL_DATA',
  generatedAt: timestamp,
  period: {
    endBusinessDateExclusive: '2026-10-01',
    endExclusive: '2026-09-30T17:00:00.000Z',
    start: '2026-08-31T17:00:00.000Z',
    startBusinessDate: '2026-09-01',
    timeZone: 'Asia/Ho_Chi_Minh',
  },
  products: [],
  ratios: {
    averageInboundCostPerKgVnd: available('0'),
    effectiveCostPerSoldKgVnd: unavailable(),
    grossMarginBasisPoints: unavailable(),
    revenuePerInboundKgVnd: available('0'),
  },
  scope: { kind: 'STORE', storeId },
  totals: {
    handlingFeeVnd: available('0'),
    inboundGoodsCostVnd: available('0'),
    inboundWeightGrams: available('0'),
    landedInboundCostVnd: available('0'),
    otherInboundCostVnd: available('0'),
    revenueVnd: available('9007199254740993'),
    soldWeightGrams: available('0'),
    transportationFeeVnd: available('0'),
    vatCostVnd: unavailable(),
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dashboard authorization scope', () => {
  it('allows Admin to select ALL or one accessible store', () => {
    expect(resolveDashboardScope(sessionFor('ADMIN'), stores, 'ALL')).toEqual({ kind: 'ALL' });
    expect(resolveDashboardScope(sessionFor('ADMIN'), stores, secondStoreId)).toEqual({
      kind: 'STORE',
      storeId: secondStoreId,
    });
  });

  it('locks STORE to its own store and HTKD to an assigned store', () => {
    expect(resolveDashboardScope(sessionFor('STORE'), stores, storeId)).toEqual({
      kind: 'STORE',
      storeId: secondStoreId,
    });
    expect(resolveDashboardScope(sessionFor('HTKD'), stores, secondStoreId)).toEqual({
      kind: 'STORE',
      storeId,
    });
    expect(resolveDashboardScope(sessionFor('HTKD'), [], storeId)).toBeNull();
  });
});

describe('dashboard state and actions', () => {
  it('maps loading and failures to the correct retry query', () => {
    const bootstrapLoading = dashboardViewState({
      bootstrapError: false,
      bootstrapPending: true,
      hasScope: false,
      hasSnapshot: false,
      snapshotError: false,
      snapshotPending: false,
    });
    const bootstrapError = dashboardViewState({
      bootstrapError: true,
      bootstrapPending: false,
      hasScope: false,
      hasSnapshot: false,
      snapshotError: false,
      snapshotPending: false,
    });
    const snapshotError = dashboardViewState({
      bootstrapError: false,
      bootstrapPending: false,
      hasScope: true,
      hasSnapshot: false,
      snapshotError: true,
      snapshotPending: false,
    });

    expect(bootstrapLoading).toBe('BOOTSTRAP_LOADING');
    expect(dashboardRetryTarget(bootstrapError)).toBe('BOOTSTRAP');
    expect(dashboardRetryTarget(snapshotError)).toBe('SNAPSHOT');
  });

  it('routes operational buttons to functional pages for each role', () => {
    expect(dashboardRouteForAction('PRIMARY', 'ADMIN', null)).toBe('/reports');
    expect(dashboardRouteForAction('PRIMARY', 'STORE', 'RETAIL')).toBe('/receive');
    expect(dashboardRouteForAction('PRIMARY', 'STORE', 'WHOLESALE')).toBe('/requests');
    expect(dashboardRouteForAction('WAITING', 'HTKD', null)).toBe('/allocations');
  });

  it('formats backend integers without losing precision', () => {
    expect(formatExactVnd('9007199254740993')).toContain('9.007.199.254.740.993');
    expect(formatExactGrams('9007199254740993')).toBe('9.007.199.254.740,993 kg');
  });
});

describe('dashboard API integration', () => {
  it('loads every dashboard source with cookie auth and store scoping', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(init).toMatchObject({ cache: 'no-store', credentials: 'include' });
      if (url.includes('/auth/session')) return jsonResponse({ data: sessionFor('HTKD') });
      if (url.includes('/stores?')) return jsonResponse(page(stores.slice(0, 1)));
      if (url.includes('/reports/monthly?')) return jsonResponse({ data: report });
      return jsonResponse(page([]));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadDashboardBootstrap()).resolves.toEqual({
      session: sessionFor('HTKD'),
      stores: stores.slice(0, 1),
    });
    await expect(
      loadDashboardSnapshot({ month: 9, scope: { kind: 'STORE', storeId }, year: 2026 }),
    ).resolves.toMatchObject({
      orderRequests: [],
      orderSessions: [],
      priorityOffers: [],
      receipts: [],
      report,
      waitTickets: [],
    });

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes('/auth/session'))).toBe(true);
    expect(urls.some((url) => url.includes('/stores?'))).toBe(true);
    expect(urls.some((url) => url.includes('/reports/monthly?'))).toBe(true);
    expect(urls.some((url) => url.includes('/store-receipts?'))).toBe(true);
    expect(urls.some((url) => url.includes('/wait-tickets?'))).toBe(true);
    expect(urls.some((url) => url.includes('/priority-offers?'))).toBe(true);
    expect(urls.some((url) => url.includes('/order-sessions?'))).toBe(true);
    expect(urls.some((url) => url.includes('/order-requests?'))).toBe(true);
    expect(
      urls
        .filter((url) => !url.includes('/order-sessions?') && !url.includes('/auth/session'))
        .some((url) => url.includes(`storeId=${storeId}`)),
    ).toBe(true);
  });

  it('surfaces a network failure instead of inventing a mock dashboard', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );

    await expect(loadDashboardBootstrap()).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      status: 0,
    });
  });
});

function page(data: unknown[]) {
  return {
    data,
    pagination: {
      page: 1,
      pageSize: 100,
      totalItems: data.length,
      totalPages: data.length > 0 ? 1 : 0,
    },
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}
