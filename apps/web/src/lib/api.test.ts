import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  declareStoreReceipt,
  finalizeStoreReceipt,
  getMonthlyOperationalReport,
  getStoreReceipt,
  listCatalog,
  listOpenOrderSessions,
  listStoreReceipts,
  returnStoreReceiptForCorrection,
  submitStoreOrderRequest,
  submitStoreReceipt,
} from './api';

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

  it('loads receipt detail and sends every receipt transition with idempotency', async () => {
    const receiptId = '70000000-0000-4000-8000-000000000001';
    const storeId = '20000000-0000-4000-8000-000000000001';
    const outboundRequestId = '30000000-0000-4000-8000-000000000001';
    const productId = '40000000-0000-4000-8000-000000000001';
    const accountId = '50000000-0000-4000-8000-000000000001';
    const requestedUrls: string[] = [];
    const mutationRequests: Array<{ body: unknown; key: string | null; url: string }> = [];
    const receipt = (status: 'DRAFT' | 'PENDING_HTKD' | 'RETURNED' | 'FINALIZED') => ({
      createdAt: '2026-09-17T00:00:00.000Z',
      declaredByAccountId: accountId,
      discrepancyNote: 'Thiếu một bao khi giao nhận',
      freightVnd: status === 'FINALIZED' ? 100_000 : 0,
      handlingVnd: status === 'FINALIZED' ? 50_000 : 0,
      id: receiptId,
      lines: [
        {
          approvedUnits: 2,
          bagWeightsKg: status === 'FINALIZED' ? ['92.500'] : [],
          pricePerKgVnd: status === 'FINALIZED' ? 25_000 : null,
          productId,
          receivedUnits: 1,
        },
      ],
      outboundRequestId,
      receiptNumber: 'SR-2026-0001',
      reviewNote: status === 'RETURNED' ? 'Bổ sung bằng chứng' : null,
      reviewedByAccountId: status === 'FINALIZED' ? accountId : null,
      status,
      storeId,
      totalCostVnd: status === 'FINALIZED' ? 2_462_500 : null,
      updatedAt: '2026-09-17T00:10:00.000Z',
      version: status === 'DRAFT' ? 0 : 1,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requestedUrls.push(url);
        if (init?.method === 'POST') {
          mutationRequests.push({
            body: JSON.parse(String(init.body)),
            key: new Headers(init.headers).get('idempotency-key'),
            url,
          });
        }
        const status = url.endsWith('/submit')
          ? 'PENDING_HTKD'
          : url.endsWith('/return')
            ? 'RETURNED'
            : url.endsWith('/finalize')
              ? 'FINALIZED'
              : 'DRAFT';
        const payload =
          init?.method !== 'POST' && url.includes('/store-receipts?')
            ? { data: [receipt('DRAFT')], pagination }
            : { data: receipt(status) };
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
      }),
    );

    await expect(listStoreReceipts({ status: 'DRAFT', storeId })).resolves.toHaveLength(1);
    await expect(getStoreReceipt(receiptId)).resolves.toEqual(
      expect.objectContaining({ id: receiptId, receiptNumber: 'SR-2026-0001' }),
    );
    await declareStoreReceipt(
      {
        discrepancyNote: 'Thiếu một bao khi giao nhận',
        lines: [{ approvedUnits: 2, productId, receivedUnits: 1 }],
        outboundRequestId,
        storeId,
      },
      'receipt-declare-key',
    );
    await submitStoreReceipt(
      receiptId,
      {
        discrepancyNote: 'Thiếu một bao khi giao nhận',
        expectedVersion: 0,
        lines: [{ approvedUnits: 2, productId, receivedUnits: 1 }],
      },
      'receipt-submit-key',
    );
    await returnStoreReceiptForCorrection(
      receiptId,
      { expectedVersion: 1, reason: 'Bổ sung bằng chứng' },
      'receipt-return-key',
    );
    await finalizeStoreReceipt(
      receiptId,
      {
        expectedVersion: 1,
        freightVnd: 100_000,
        handlingVnd: 50_000,
        lines: [
          {
            approvedUnits: 2,
            bagWeightsKg: ['92.500'],
            pricePerKgVnd: 25_000,
            productId,
            receivedUnits: 1,
          },
        ],
      },
      'receipt-finalize-key',
    );

    expect(requestedUrls[0]).toContain(
      `/store-receipts?page=1&pageSize=100&status=DRAFT&storeId=${storeId}`,
    );
    expect(requestedUrls[1]).toContain(`/store-receipts/${receiptId}`);
    expect(mutationRequests.map((request) => request.key)).toEqual([
      'receipt-declare-key',
      'receipt-submit-key',
      'receipt-return-key',
      'receipt-finalize-key',
    ]);
    expect(mutationRequests.map((request) => request.url)).toEqual([
      expect.stringMatching(/\/store-receipts$/),
      expect.stringContaining(`/store-receipts/${receiptId}/submit`),
      expect.stringContaining(`/store-receipts/${receiptId}/return`),
      expect.stringContaining(`/store-receipts/${receiptId}/finalize`),
    ]);
  });

  it('loads a scoped monthly report and preserves exact integer totals as strings', async () => {
    const storeId = '20000000-0000-4000-8000-000000000001';
    const available = (value: string, source = 'WAREHOUSE_RECEIPTS') => ({
      source,
      unavailableReason: null,
      value,
    });
    const unavailable = (reason: string) => ({
      source: 'NOT_AVAILABLE',
      unavailableReason: reason,
      value: null,
    });
    const fetchMock = vi.fn((_input: string | URL | Request) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              counts: {
                allocationBatchesCompleted: 1,
                approvedDiscountSales: 0,
                inboundReceipts: 2,
                outboundOrdersReceived: 3,
                waitTicketsQueued: 0,
              },
              dataOrigin: 'LOCAL_TRANSACTIONAL_DATA',
              generatedAt: '2026-09-17T03:00:00.000Z',
              period: {
                endBusinessDateExclusive: '2026-10-01',
                endExclusive: '2026-09-30T17:00:00.000Z',
                start: '2026-08-31T17:00:00.000Z',
                startBusinessDate: '2026-09-01',
                timeZone: 'Asia/Ho_Chi_Minh',
              },
              products: [],
              ratios: {
                averageInboundCostPerKgVnd: available('22000'),
                effectiveCostPerSoldKgVnd: unavailable('COGS_NOT_RECORDED_PER_SALE'),
                grossMarginBasisPoints: unavailable('COGS_NOT_RECORDED_PER_SALE'),
                revenuePerInboundKgVnd: available(
                  '31000',
                  'WAREHOUSE_RECEIPTS_AND_STORE_OUTBOUNDS',
                ),
              },
              scope: { kind: 'STORE', storeId },
              totals: {
                handlingFeeVnd: available('120000'),
                inboundGoodsCostVnd: available('9007199254740993'),
                inboundWeightGrams: available('41000000'),
                landedInboundCostVnd: available('9007199255360993'),
                otherInboundCostVnd: available('0'),
                revenueVnd: available('1271000000', 'STORE_OUTBOUNDS'),
                soldWeightGrams: available('18000000', 'STORE_OUTBOUNDS'),
                transportationFeeVnd: available('500000'),
                vatCostVnd: unavailable('VAT_NOT_CAPTURED'),
              },
            },
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const report = await getMonthlyOperationalReport({
      month: 9,
      scopeId: storeId,
      scopeKind: 'STORE',
      year: 2026,
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `/reports/monthly?month=9&scopeKind=STORE&year=2026&scopeId=${storeId}`,
    );
    expect(report.totals.inboundGoodsCostVnd.value).toBe('9007199254740993');
    expect(report.totals.vatCostVnd).toEqual(
      expect.objectContaining({ unavailableReason: 'VAT_NOT_CAPTURED', value: null }),
    );
  });
});
