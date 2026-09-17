import type { MonthlyOperationalReport as ApiMonthlyOperationalReport } from '@idosi/contracts';
import type {
  MonthlyOperationalReport as DatabaseMonthlyOperationalReport,
  ReportMetric,
} from '@idosi/database';

export function monthlyOperationalReportDto(
  report: DatabaseMonthlyOperationalReport,
): ApiMonthlyOperationalReport {
  return {
    period: {
      start: report.period.start.toISOString(),
      endExclusive: report.period.endExclusive.toISOString(),
      startBusinessDate: report.period.startBusinessDate,
      endBusinessDateExclusive: report.period.endBusinessDateExclusive,
      timeZone: report.period.timeZone,
    },
    scope:
      report.scope.kind === 'ALL'
        ? { kind: 'ALL' }
        : report.scope.kind === 'GROUP'
          ? { kind: 'GROUP', groupId: report.scope.id }
          : { kind: 'STORE', storeId: report.scope.id },
    generatedAt: report.generatedAt.toISOString(),
    dataOrigin: report.dataOrigin,
    counts: { ...report.counts },
    totals: {
      inboundWeightGrams: exactMetric(report.totals.inboundWeightGrams),
      soldWeightGrams: exactMetric(report.totals.soldWeightGrams),
      revenueVnd: exactMetric(report.totals.revenueVnd),
      inboundGoodsCostVnd: exactMetric(report.totals.inboundGoodsCostVnd),
      transportationFeeVnd: exactMetric(report.totals.transportationFeeVnd),
      handlingFeeVnd: exactMetric(report.totals.handlingFeeVnd),
      otherInboundCostVnd: exactMetric(report.totals.otherInboundCostVnd),
      landedInboundCostVnd: exactMetric(report.totals.landedInboundCostVnd),
      vatCostVnd: exactMetric(report.totals.vatCostVnd),
    },
    ratios: {
      averageInboundCostPerKgVnd: exactMetric(report.ratios.averageInboundCostPerKgVnd),
      revenuePerInboundKgVnd: exactMetric(report.ratios.revenuePerInboundKgVnd),
      effectiveCostPerSoldKgVnd: exactMetric(report.ratios.effectiveCostPerSoldKgVnd),
      grossMarginBasisPoints: { ...report.ratios.grossMarginBasisPoints },
    },
    products: report.products.map((product) => ({
      productId: product.productId,
      sku: product.sku,
      productName: product.productName,
      inboundWeightGrams: exactMetric(product.inboundWeightGrams),
      inboundGoodsCostVnd: exactMetric(product.inboundGoodsCostVnd),
      soldWeightGrams: exactMetric(product.soldWeightGrams),
      revenueVnd: exactMetric(product.revenueVnd),
    })),
  };
}

function exactMetric(metric: ReportMetric<bigint>) {
  return {
    value: metric.value?.toString() ?? null,
    unavailableReason: metric.unavailableReason,
    source: metric.source,
  };
}
