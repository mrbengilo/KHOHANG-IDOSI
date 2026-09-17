import type { ExactIntegerReportMetric, MonthlyOperationalReport } from '@idosi/contracts';
import { describe, expect, it } from 'vitest';
import { buildMonthlyReportCsv, reportQueryForSelection } from './ReportsPage';

const storeId = '20000000-0000-4000-8000-000000000001';
const productId = '40000000-0000-4000-8000-000000000001';

const available = (
  value: string,
  source: ExactIntegerReportMetric['source'] = 'WAREHOUSE_RECEIPTS',
): ExactIntegerReportMetric => ({ source, unavailableReason: null, value });

const unavailable = (
  reason: NonNullable<ExactIntegerReportMetric['unavailableReason']>,
): ExactIntegerReportMetric => ({
  source: 'NOT_AVAILABLE',
  unavailableReason: reason,
  value: null,
});

const report: MonthlyOperationalReport = {
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
  products: [
    {
      inboundGoodsCostVnd: available('9007199254740993'),
      inboundWeightGrams: available('41000000'),
      productId,
      productName: 'Đầm, loại A',
      revenueVnd: available('1271000000', 'STORE_OUTBOUNDS'),
      sku: 'DAM-001',
      soldWeightGrams: available('18000000', 'STORE_OUTBOUNDS'),
    },
  ],
  ratios: {
    averageInboundCostPerKgVnd: available('22000'),
    effectiveCostPerSoldKgVnd: unavailable('COGS_NOT_RECORDED_PER_SALE'),
    grossMarginBasisPoints: {
      source: 'NOT_AVAILABLE',
      unavailableReason: 'COGS_NOT_RECORDED_PER_SALE',
      value: null,
    },
    revenuePerInboundKgVnd: available('31000', 'WAREHOUSE_RECEIPTS_AND_STORE_OUTBOUNDS'),
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
};

describe('monthly report UI helpers', () => {
  it('allows Admin global or store scopes and limits HTKD to an assigned store', () => {
    expect(reportQueryForSelection('ADMIN', '2026-09', 'ALL')).toEqual({
      month: 9,
      scopeKind: 'ALL',
      year: 2026,
    });
    expect(reportQueryForSelection('ADMIN', '2026-09', storeId)).toEqual({
      month: 9,
      scopeId: storeId,
      scopeKind: 'STORE',
      year: 2026,
    });
    expect(reportQueryForSelection('HTKD', '2026-09', storeId)).toEqual({
      month: 9,
      scopeId: storeId,
      scopeKind: 'STORE',
      year: 2026,
    });
    expect(reportQueryForSelection('HTKD', '2026-09', 'ALL')).toBeNull();
    expect(reportQueryForSelection('STORE', '2026-09', storeId)).toBeNull();
  });

  it('exports loaded values exactly and retains explicit unavailable reasons', () => {
    const csv = buildMonthlyReportCsv(report);

    expect(csv).toContain('9007199254740993');
    expect(csv).toContain('VAT_NOT_CAPTURED');
    expect(csv).toContain('COGS_NOT_RECORDED_PER_SALE');
    expect(csv).toContain('"Đầm, loại A"');
    expect(csv).toContain(`STORE:${storeId}`);
  });
});
