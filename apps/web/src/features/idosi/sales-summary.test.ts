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
        unclassifiedRevenue: 0,
        unclassifiedOrders: 0,
        weight,
      },
      products: {
        totalQuantity: 5,
        salePieceQuantity: 0,
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
            classification: 'NORMAL',
            orders: 1,
            weight,
          },
          {
            productId: 'A',
            productName: 'Áo',
            quantity: 2,
            unit: 'KG',
            revenueType: 'SALE_KG',
            classification: 'SALE_KG',
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
  it('projects sale revenue, pieces and distinct real versus estimated kilograms for one store', () => {
    const sale = structuredClone(state);
    const product = sale.snapshot!.payload.products.items[0]!;
    Object.assign(sale.snapshot!.payload.totals, {
      revenue: 350,
      revenueByType: { NORMAL: 100, SALE_KG: 200, SALE_PIECE: 50 },
      unclassifiedRevenue: 40,
      unclassifiedOrders: 1,
      weight: {
        ...weight,
        byRevenueType: {
          NORMAL: bucket,
          SALE_KG: { ...bucket, actualKg: 2 },
          SALE_PIECE: { ...bucket, estimatedKg: 1 },
        },
      },
    });
    Object.assign(sale.snapshot!.payload.products, {
      salePieceQuantity: 3,
      items: [
        ...sale.snapshot!.payload.products.items,
        {
          ...product,
          quantity: 3,
          revenueType: 'SALE_PIECE',
          classification: 'SALE_PIECE',
          weight: { ...weight, estimatedKg: 1, knownKg: 1, totalKg: 1 },
        },
      ],
    });
    expect(summarizeIdosiSales([sale])).toMatchObject({
      revenueVnd: 350n,
      normalRevenueVnd: 60n,
      salePieceRevenueVnd: 50n,
      saleKgRevenueVnd: 200n,
      unclassifiedRevenueVnd: 40n,
      salePieceQuantity: 3,
      salePieceEstimatedKg: 1,
      saleKgActualKg: 2,
      revenueUnclassifiedOrders: 1,
      reconciliationMismatches: 0,
    });
  });
  it('flags a source revenue mismatch while preserving every supplied amount', () => {
    const mismatched = structuredClone(state);
    mismatched.snapshot!.payload.totals.revenue = 301;
    const result = summarizeIdosiSales([mismatched]);
    expect(result.reconciliationMismatches).toBe(1);
    expect(result.revenueVnd).toBe(301n);
    expect(
      result.normalRevenueVnd +
        result.saleKgRevenueVnd +
        result.salePieceRevenueVnd +
        result.unclassifiedRevenueVnd,
    ).toBe(300n);
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

  // IDOSI đổi tên và ngừng mặt hàng, rồi cấp lại mã cũ cho mặt hàng khác. Vì vậy
  // productId trên dòng bán là định danh LÚC BÁN, không ổn định.
  const line = (overrides: Record<string, unknown>) => ({
    productId: 'A',
    productName: 'Áo',
    quantity: 1,
    unit: 'PIECE',
    revenueType: 'NORMAL',
    orders: 1,
    weight,
    ...overrides,
  });
  const withItems = (items: readonly Record<string, unknown>[]) => {
    const raw = JSON.parse(JSON.stringify(state)) as {
      snapshot: {
        payload: {
          products: { items: readonly Record<string, unknown>[]; salePieceQuantity: number };
        };
      };
    };
    raw.snapshot.payload.products.items = items.map((item) => ({
      ...item,
      classification: item.classification ?? item.revenueType,
    }));
    raw.snapshot.payload.products.salePieceQuantity = items.reduce(
      (sum, item) => sum + (item.revenueType === 'SALE_PIECE' ? Number(item.quantity) : 0),
      0,
    );
    return IdosiStatisticsStateSchema.parse(raw);
  };

  it('merges one product sold under two source IDs when IDOSI sends the canonical identity', () => {
    const result = summarizeIdosiSales([
      withItems([
        line({
          productId: 'order-product-004',
          productCode: 'PRD-004',
          canonicalProductId: 'order-product-003',
          canonicalProductCode: 'PRD-003',
          productName: 'Áo nữ',
          quantity: 742,
        }),
        line({
          productId: 'order-product-003',
          productCode: 'PRD-003',
          canonicalProductId: 'order-product-003',
          canonicalProductCode: 'PRD-003',
          productName: 'Áo nữ',
          quantity: 26,
          revenueType: 'SALE_PIECE',
        }),
      ]),
    ]);
    expect(result.productTotals).toHaveLength(1);
    expect(result.productTotals[0]).toMatchObject({
      productId: 'order-product-003',
      productCode: 'PRD-003',
      productName: 'Áo nữ',
      pieces: 768,
    });
    expect(result.ambiguousProducts).toBe(0);
  });

  it('keeps two products apart when IDOSI reused one code for both', () => {
    const result = summarizeIdosiSales([
      withItems([
        line({
          productId: 'order-product-004',
          productCode: 'PRD-004',
          canonicalProductId: 'order-product-003',
          productName: 'Áo nữ',
          quantity: 742,
        }),
        line({
          productId: 'order-product-030',
          productCode: 'PRD-004',
          canonicalProductId: 'order-product-030',
          productName: 'Áo khoác',
          quantity: 55,
        }),
      ]),
    ]);
    expect(result.productTotals.map((row) => [row.productId, row.pieces])).toEqual([
      ['order-product-030', 55],
      ['order-product-003', 742],
    ]);
  });

  it('flags a source ID that appears under several names instead of silently summing it', () => {
    const result = summarizeIdosiSales([
      withItems([
        line({ productId: 'A', productName: 'Áo nữ', quantity: 5 }),
        line({ productId: 'A', productName: 'Áo khoác', quantity: 3 }),
      ]),
    ]);
    expect(result.ambiguousProducts).toBe(1);
    expect(result.productTotals).toHaveLength(1);
  });
});
