import { describe, expect, it } from 'vitest';

import {
  kilogramsToGramsForReport,
  mergeScopedInboundRows,
  monthWindowInHoChiMinh,
  summarizeMonthlyReport,
  vndPerKilogram,
  type MonthlyReportRows,
} from '../src/monthly-report.js';

const emptyRows: MonthlyReportRows = {
  inboundSource: 'WAREHOUSE_RECEIPTS',
  inboundHeaders: [],
  inboundProducts: [],
  sales: [],
  outboundOrderIds: [],
  allocationRunIds: [],
  waitTicketIds: [],
};

describe('monthly report period', () => {
  it('uses half-open Vietnam-calendar boundaries', () => {
    const period = monthWindowInHoChiMinh(2026, 9);

    expect(period).toEqual({
      start: new Date('2026-08-31T17:00:00.000Z'),
      endExclusive: new Date('2026-09-30T17:00:00.000Z'),
      startBusinessDate: '2026-09-01',
      endBusinessDateExclusive: '2026-10-01',
      timeZone: 'Asia/Ho_Chi_Minh',
    });
  });

  it('rolls December into the next year and rejects invalid months', () => {
    expect(monthWindowInHoChiMinh(2026, 12).endBusinessDateExclusive).toBe('2027-01-01');
    expect(() => monthWindowInHoChiMinh(2026, 13)).toThrow(RangeError);
  });
});

describe('exact report arithmetic', () => {
  it('parses grams and rounds VND per kg without floating point', () => {
    expect(kilogramsToGramsForReport('12.345')).toBe(12_345n);
    expect(vndPerKilogram(430_000n, 15_500n)).toBe(27_742n);
    expect(() => kilogramsToGramsForReport('1.2345')).toThrow(RangeError);
    expect(() => vndPerKilogram(1n, 0n)).toThrow(RangeError);
  });

  it('aggregates store receipt line cost once while summing its bag weights', () => {
    expect(
      mergeScopedInboundRows(
        [
          {
            productId: 'p1',
            sku: 'SKU-1',
            productName: 'Product 1',
            goodsCostVnd: 220_000n,
          },
          {
            productId: 'p1',
            sku: 'SKU-1',
            productName: 'Product 1',
            goodsCostVnd: 110_000n,
          },
        ],
        [
          { productId: 'p1', sku: 'SKU-1', productName: 'Product 1', weightKg: '10.000' },
          { productId: 'p1', sku: 'SKU-1', productName: 'Product 1', weightKg: '5.500' },
        ],
      ),
    ).toEqual([
      {
        productId: 'p1',
        sku: 'SKU-1',
        productName: 'Product 1',
        weightKg: '15.500',
        goodsCostVnd: 330_000n,
      },
    ]);
  });
});

describe('monthly operational summary', () => {
  it('reports captured VAT exactly and distinguishes legacy unknown VAT', () => {
    const rows = {
      inboundSource: 'WAREHOUSE_RECEIPTS' as const,
      inboundHeaders: [
        {
          receiptId: 'vat-1',
          goodsCostVnd: 5000000n,
          transportationFeeVnd: 0n,
          handlingFeeVnd: 0n,
          otherCostVnd: 0n,
          vatAmountVnd: 1000000n as bigint | null,
        },
      ],
      inboundProducts: [
        {
          productId: 'vat-product',
          sku: 'VAT',
          productName: 'VAT product',
          weightKg: '2.000',
          goodsCostVnd: 5000000n,
        },
      ],
      sales: [],
      outboundOrderIds: [],
      allocationRunIds: [],
      waitTicketIds: [],
    };
    const input = { year: 2026, month: 9, scope: { kind: 'ALL' as const } };
    const result = summarizeMonthlyReport(input, rows);
    expect(result.totals.vatCostVnd.value).toBe(1000000n);
    expect(result.totals.landedInboundCostVnd.value).toBe(6000000n);
    rows.inboundHeaders[0]!.vatAmountVnd = null;
    expect(summarizeMonthlyReport(input, rows).totals.landedInboundCostVnd.value).toBeNull();
    expect(
      summarizeMonthlyReport(input, rows).ratios.averageInboundCostPerKgVnd.unavailableReason,
    ).toBe('VAT_NOT_CAPTURED');
    expect(summarizeMonthlyReport(input, rows).totals.vatCostVnd.unavailableReason).toBe(
      'VAT_NOT_CAPTURED',
    );
  });
  it('reports trustworthy totals and refuses revenue or margin when source data is incomplete', () => {
    const generatedAt = new Date('2026-10-01T00:00:00.000Z');
    const report = summarizeMonthlyReport(
      { year: 2026, month: 9, scope: { kind: 'ALL' } },
      {
        inboundSource: 'WAREHOUSE_RECEIPTS',
        inboundHeaders: [
          {
            receiptId: 'receipt-1',
            goodsCostVnd: 350_000n,
            transportationFeeVnd: 50_000n,
            handlingFeeVnd: 25_000n,
            otherCostVnd: 5_000n,
            vatAmountVnd: 0n,
          },
        ],
        inboundProducts: [
          {
            productId: 'p1',
            sku: 'SKU-1',
            productName: 'Product 1',
            weightKg: '10.000',
            goodsCostVnd: 200_000n,
          },
          {
            productId: 'p2',
            sku: 'SKU-2',
            productName: 'Product 2',
            weightKg: '5.500',
            goodsCostVnd: 150_000n,
          },
        ],
        sales: [
          {
            outboundId: 'sale-1',
            productId: 'p1',
            sku: 'SKU-1',
            productName: 'Product 1',
            weightKg: '2.500',
            revenueVnd: 300_000n,
          },
          {
            outboundId: 'sale-2',
            productId: 'p2',
            sku: 'SKU-2',
            productName: 'Product 2',
            weightKg: '1.000',
            revenueVnd: null,
          },
        ],
        outboundOrderIds: ['order-1', 'order-1'],
        allocationRunIds: ['run-1', 'run-1', 'run-2'],
        waitTicketIds: ['wait-1'],
      },
      generatedAt,
    );

    expect(report.generatedAt).toBe(generatedAt);
    expect(report.dataOrigin).toBe('LOCAL_TRANSACTIONAL_DATA');
    expect(report.counts).toEqual({
      inboundReceipts: 1,
      outboundOrdersReceived: 1,
      allocationBatchesCompleted: 2,
      waitTicketsQueued: 1,
      approvedDiscountSales: 2,
    });
    expect(report.totals.inboundWeightGrams.value).toBe(15_500n);
    expect(report.totals.soldWeightGrams.value).toBe(3_500n);
    expect(report.totals.landedInboundCostVnd.value).toBe(430_000n);
    expect(report.ratios.averageInboundCostPerKgVnd.value).toBe(27_742n);
    expect(report.totals.revenueVnd).toEqual({
      value: null,
      unavailableReason: 'MISSING_SALE_REVENUE',
      source: 'STORE_OUTBOUNDS',
    });
    expect(report.ratios.revenuePerInboundKgVnd.unavailableReason).toBe('MISSING_SALE_REVENUE');
    expect(report.ratios.grossMarginBasisPoints).toEqual({
      value: null,
      unavailableReason: 'COGS_NOT_RECORDED_PER_SALE',
      source: 'NOT_AVAILABLE',
    });
    expect(report.products.find((product) => product.productId === 'p1')?.revenueVnd.value).toBe(
      300_000n,
    );
    expect(
      report.products.find((product) => product.productId === 'p2')?.revenueVnd.unavailableReason,
    ).toBe('MISSING_SALE_REVENUE');
  });

  it('propagates missing inbound weight instead of manufacturing an estimate', () => {
    const report = summarizeMonthlyReport(
      { year: 2026, month: 9, scope: { kind: 'ALL' } },
      {
        ...emptyRows,
        inboundHeaders: [
          {
            receiptId: 'receipt-1',
            goodsCostVnd: 100n,
            transportationFeeVnd: 0n,
            handlingFeeVnd: 0n,
            otherCostVnd: 0n,
          },
        ],
        inboundProducts: [
          {
            productId: 'p1',
            sku: 'SKU-1',
            productName: 'Product 1',
            weightKg: null,
            goodsCostVnd: 100n,
          },
        ],
      },
    );

    expect(report.totals.inboundWeightGrams.unavailableReason).toBe('MISSING_INBOUND_WEIGHT');
    expect(report.ratios.averageInboundCostPerKgVnd.unavailableReason).toBe(
      'MISSING_INBOUND_WEIGHT',
    );
  });

  it('distinguishes a zero denominator from incomplete data and marks VAT unavailable', () => {
    const report = summarizeMonthlyReport(
      { year: 2026, month: 9, scope: { kind: 'STORE', id: 'store-1' } },
      { ...emptyRows, inboundSource: 'STORE_RECEIPTS' },
    );

    expect(report.totals.inboundWeightGrams.value).toBe(0n);
    expect(report.ratios.averageInboundCostPerKgVnd.unavailableReason).toBe('ZERO_INBOUND_WEIGHT');
    expect(report.totals.vatCostVnd).toEqual({
      value: null,
      unavailableReason: 'VAT_NOT_CAPTURED',
      source: 'NOT_AVAILABLE',
    });
  });
});
