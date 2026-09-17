import { describe, expect, it } from 'vitest';

import {
  MonthlyOperationalReportQuerySchema,
  MonthlyOperationalReportResponseSchema,
} from '../src/index.js';

const STORE_ID = '88888888-8888-4888-8888-888888888888';
const PRODUCT_ID = '66666666-6666-4666-8666-666666666666';

function available(value: string, source = 'WAREHOUSE_RECEIPTS') {
  return { value, unavailableReason: null, source };
}

function unavailable(
  unavailableReason: 'MISSING_SALE_REVENUE' | 'VAT_NOT_CAPTURED' | 'COGS_NOT_RECORDED_PER_SALE',
  source: 'STORE_OUTBOUNDS' | 'NOT_AVAILABLE',
) {
  return { value: null, unavailableReason, source };
}

function validOperationalReport() {
  return {
    period: {
      start: '2026-08-31T17:00:00.000Z',
      endExclusive: '2026-09-30T17:00:00.000Z',
      startBusinessDate: '2026-09-01',
      endBusinessDateExclusive: '2026-10-01',
      timeZone: 'Asia/Ho_Chi_Minh',
    },
    scope: { kind: 'ALL' },
    generatedAt: '2026-10-01T00:00:00.000Z',
    dataOrigin: 'LOCAL_TRANSACTIONAL_DATA',
    counts: {
      inboundReceipts: 1,
      outboundOrdersReceived: 2,
      allocationBatchesCompleted: 1,
      waitTicketsQueued: 3,
      approvedDiscountSales: 2,
    },
    totals: {
      inboundWeightGrams: available('15500'),
      soldWeightGrams: available('3500', 'STORE_OUTBOUNDS'),
      revenueVnd: unavailable('MISSING_SALE_REVENUE', 'STORE_OUTBOUNDS'),
      inboundGoodsCostVnd: available('9007199254740993000'),
      transportationFeeVnd: available('50000'),
      handlingFeeVnd: available('25000'),
      otherInboundCostVnd: available('5000'),
      landedInboundCostVnd: available('9007199254741073000'),
      vatCostVnd: unavailable('VAT_NOT_CAPTURED', 'NOT_AVAILABLE'),
    },
    ratios: {
      averageInboundCostPerKgVnd: available('27742'),
      revenuePerInboundKgVnd: unavailable('MISSING_SALE_REVENUE', 'STORE_OUTBOUNDS'),
      effectiveCostPerSoldKgVnd: unavailable('COGS_NOT_RECORDED_PER_SALE', 'NOT_AVAILABLE'),
      grossMarginBasisPoints: unavailable('COGS_NOT_RECORDED_PER_SALE', 'NOT_AVAILABLE'),
    },
    products: [
      {
        productId: PRODUCT_ID,
        sku: 'SKU-001',
        productName: 'Áo dài',
        inboundWeightGrams: available('15500'),
        inboundGoodsCostVnd: available('9007199254740993000'),
        soldWeightGrams: available('3500', 'STORE_OUTBOUNDS'),
        revenueVnd: unavailable('MISSING_SALE_REVENUE', 'STORE_OUTBOUNDS'),
      },
    ],
  };
}

describe('monthly operational report contracts', () => {
  it('reuses the established month and scope query rules', () => {
    expect(
      MonthlyOperationalReportQuerySchema.parse({
        year: '2026',
        month: '9',
        scopeKind: 'STORE',
        scopeId: STORE_ID,
      }),
    ).toEqual({ year: 2026, month: 9, scopeKind: 'STORE', scopeId: STORE_ID });
    expect(
      MonthlyOperationalReportQuerySchema.safeParse({
        year: 2026,
        month: 9,
        scopeKind: 'GROUP',
      }).success,
    ).toBe(false);
  });

  it('keeps bigint-backed totals exact and JSON-safe', () => {
    const parsed = MonthlyOperationalReportResponseSchema.parse({
      data: validOperationalReport(),
    });

    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
    expect(parsed.data.totals.inboundGoodsCostVnd.value).toBe('9007199254740993000');
  });

  it('rejects bigint values, non-canonical integers, and contradictory metrics', () => {
    const report = validOperationalReport();

    expect(
      MonthlyOperationalReportResponseSchema.safeParse({
        data: {
          ...report,
          totals: {
            ...report.totals,
            inboundWeightGrams: {
              ...report.totals.inboundWeightGrams,
              value: 15_500n,
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      MonthlyOperationalReportResponseSchema.safeParse({
        data: {
          ...report,
          totals: {
            ...report.totals,
            inboundWeightGrams: {
              ...report.totals.inboundWeightGrams,
              value: '015500',
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      MonthlyOperationalReportResponseSchema.safeParse({
        data: {
          ...report,
          totals: {
            ...report.totals,
            inboundWeightGrams: {
              value: null,
              unavailableReason: null,
              source: 'WAREHOUSE_RECEIPTS',
            },
          },
        },
      }).success,
    ).toBe(false);
  });
});
