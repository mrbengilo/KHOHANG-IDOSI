import { describe, expect, it } from 'vitest';
import { IdosiStatisticsStateSchema } from '@idosi/contracts';
import { summarizeIdosiSales } from './sales-summary';

const bucket = {
  actualKg: 2,
  estimatedKg: 1.25,
  knownKg: 3.25,
  totalKg: 3.25,
  isComplete: true,
  missingFactorLines: 0,
  invalidLines: 0,
  unclassifiedOrders: 0,
};
const weight = {
  ...bucket,
  schemaVersion: 1,
  unit: 'KG',
  tableVersion: 'test',
  byRevenueType: { NORMAL: bucket, SALE_KG: bucket, SALE_PIECE: bucket },
};
const state = IdosiStatisticsStateSchema.parse({
  scope: { storeId: '20000000-0000-4000-8000-000000000001', period: '2026-09' },
  integrationStatus: 'CONFIGURED',
  freshness: 'CURRENT',
  latestAttempt: null,
  snapshot: {
    id: '30000000-0000-4000-8000-000000000001',
    storeId: '20000000-0000-4000-8000-000000000001',
    scopeKey: 'test',
    firstSyncedAt: '2026-09-20T01:00:00Z',
    lastSyncedAt: '2026-09-20T01:00:00Z',
    payload: {
      ok: true,
      apiVersion: 1,
      storeId: 'external',
      store: { id: 'external', name: 'Test store' },
      currency: 'VND',
      timezone: 'Asia/Ho_Chi_Minh',
      revenueBasis: 'ACTIVE_ORDER_AMOUNT',
      generatedAt: '2026-09-20T01:00:00Z',
      serverTime: '2026-09-20T01:00:00Z',
      requestId: 'test',
      filters: { period: '2026-09', date: null, shiftId: null, paymentMethod: null },
      totals: {
        orders: 2,
        cash: 100,
        transfer: 200,
        revenue: 300,
        cashOrders: 1,
        transferOrders: 1,
        revenueByType: { NORMAL: 100, SALE_KG: 200, SALE_PIECE: 0 },
        weight,
      },
      products: {
        totalQuantity: 5,
        totalWeightKg: 2,
        productTypes: 1,
        ordersWithItems: 2,
        unclassifiedOrders: 0,
        weight,
        weightByProduct: [],
        items: [
          {
            productId: 'A',
            productName: 'Áo',
            quantity: 5,
            unit: 'PIECE',
            revenueType: 'NORMAL',
            orders: 1,
            weight,
          },
          {
            productId: 'A',
            productName: 'Áo',
            quantity: 2,
            unit: 'KG',
            revenueType: 'SALE_KG',
            orders: 1,
            weight,
          },
        ],
      },
      groups: { day: [], month: [], shift: [] },
    },
  },
});

describe('sales snapshot summary', () => {
  it('groups all stores and sale types by source product ID without mixing kg into pieces', () => {
    const copy = structuredClone(state);
    const second = {
      ...copy,
      snapshot: { ...copy.snapshot!, storeId: '20000000-0000-4000-8000-000000000002' },
    };
    second.snapshot!.payload.products.items[0]!.productName = 'Tên mới';
    second.snapshot!.payload.products.items[0]!.weight.isComplete = false;
    const result = summarizeIdosiSales([state, second]);
    expect(result.productTotals).toHaveLength(1);
    expect(result.productTotals[0]).toMatchObject({
      productId: 'A',
      pieces: 10,
      knownKg: 13,
      isComplete: false,
    });
    expect(state.snapshot!.payload.products.items[0]!.quantity).toBe(5);
  });
  it('keeps money exact and never adds kilograms to piece counts or duplicates weight buckets', () => {
    expect(summarizeIdosiSales([state])).toMatchObject({
      revenueVnd: 300n,
      pieces: 5,
      knownKg: 3.25,
      actualKg: 2,
      estimatedKg: 1.25,
      missingStores: 0,
    });
  });
  it('preserves missing-store and incomplete-weight coverage rather than treating unknown as zero', () => {
    const incomplete = structuredClone(state);
    incomplete.snapshot!.payload.products.weight.isComplete = false;
    incomplete.snapshot!.payload.products.weight.totalKg = null;
    const result = summarizeIdosiSales([
      incomplete,
      { ...state, snapshot: null, freshness: 'EMPTY' },
    ]);
    expect(result.missingStores).toBe(1);
    expect(result.incompleteWeight).toBe(true);
    expect(result.revenueVnd).toBe(300n);
    expect(summarizeIdosiSales([]).snapshots).toHaveLength(0);
  });
});
