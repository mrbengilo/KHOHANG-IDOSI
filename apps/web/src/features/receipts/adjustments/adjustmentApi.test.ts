import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ADJUSTMENT_SYNC_INTERVAL_MS,
  adjustmentPageQuery,
  adjustmentSyncOptions,
  listReceiptAdjustmentHistory,
  listReceiptAdjustmentsPage,
} from './adjustmentApi';

const id = '10000000-0000-4000-8000-000000000001';
const storeId = '20000000-0000-4000-8000-000000000001';

const listItem = {
  id,
  code: 'PSL-000001',
  receiptId: '30000000-0000-4000-8000-000000000001',
  receiptNumber: 'PNH-000001',
  storeId,
  storeCode: 'Q1',
  storeName: 'Cửa hàng Quận 1',
  status: 'PENDING_ADMIN',
  version: 1,
  reason: 'Bao là jeans',
  cause: 'SOURCE_MISCLASSIFICATION',
  lineCount: 1,
  shortageQuantity: 1,
  goodsDeltaVnd: -200_000,
  reportedBy: { accountId: id, displayName: 'Cửa hàng Q1', username: 'store.q1' },
  reportedAt: '2026-09-25T01:00:00.000Z',
  verifiedBy: { accountId: storeId, displayName: 'HTKD Lan', username: 'htkd.lan' },
  verifiedAt: '2026-09-25T02:00:00.000Z',
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  appliedAt: null,
  updatedAt: '2026-09-25T02:00:00.000Z',
};

function respond(body: unknown) {
  const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('receipt adjustment API client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds one server page query and only sends a date field with a date window', () => {
    expect(adjustmentPageQuery({ page: 2, pageSize: 20 }).toString()).toBe('page=2&pageSize=20');
    const query = adjustmentPageQuery({
      page: 1,
      pageSize: 20,
      status: 'APPLIED',
      storeId,
      q: '  PSL-00 ',
      dateField: 'DECIDED',
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(Object.fromEntries(query)).toEqual({
      page: '1',
      pageSize: '20',
      status: 'APPLIED',
      storeId,
      q: 'PSL-00',
      dateField: 'DECIDED',
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(
      adjustmentPageQuery({ page: 1, pageSize: 20, dateField: 'DECIDED', q: '   ' }).toString(),
    ).toBe('page=1&pageSize=20');
  });

  it('reads exactly one page and keeps its pagination metadata', async () => {
    const pagination = { page: 3, pageSize: 20, totalItems: 41, totalPages: 3 };
    const fetchMock = respond({ data: [listItem], pagination });
    const page = await listReceiptAdjustmentsPage({ page: 3, pageSize: 20, storeId });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'http://localhost');
    expect(url.pathname).toMatch(/\/receipt-adjustments$/u);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page: '3',
      pageSize: '20',
      storeId,
    });
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('include');
    expect(page.pagination).toEqual(pagination);
    expect(page.data[0]?.verifiedBy?.displayName).toBe('HTKD Lan');
  });

  it('reads a paged history of one document', async () => {
    const fetchMock = respond({
      data: [],
      pagination: { page: 2, pageSize: 20, totalItems: 21, totalPages: 2 },
    });
    const history = await listReceiptAdjustmentHistory(id, 2);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'http://localhost');
    expect(url.pathname).toMatch(new RegExp(`/receipt-adjustments/${id}/history$`, 'u'));
    expect(Object.fromEntries(url.searchParams)).toEqual({ page: '2', pageSize: '20' });
    expect(history.pagination.totalItems).toBe(21);
  });

  it('rejects a response that does not match the contract instead of showing wrong data', async () => {
    respond({ data: [{ ...listItem, status: 'DONE' }], pagination: listItem });
    await expect(listReceiptAdjustmentsPage({ page: 1, pageSize: 20 })).rejects.toThrow();
  });

  it('polls visible screens every 15 s and catches up at once on focus and reconnect', () => {
    expect(ADJUSTMENT_SYNC_INTERVAL_MS).toBe(15_000);
    expect(adjustmentSyncOptions).toEqual({
      refetchInterval: 15_000,
      refetchIntervalInBackground: false,
      refetchOnReconnect: 'always',
      refetchOnWindowFocus: 'always',
    });
  });
});
