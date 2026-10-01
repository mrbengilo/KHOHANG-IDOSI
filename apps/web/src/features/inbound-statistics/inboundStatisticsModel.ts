import type { InboundMetric, InboundStatisticsQuery } from '@idosi/contracts';

export const inboundStatisticsKey = (query: InboundStatisticsQuery) =>
  ['inbound-statistics', query] as const;

export interface InboundDetailStore {
  id: string;
  kind: 'RETAIL' | 'WHOLESALE';
}

/**
 * Builds the request for one expanded store from the report scope that is on screen. The parent
 * query stays the single source of the page-wide filters; the detail only narrows to the store and
 * owns its own product page, so it never inherits the parent's searches or product page.
 */
export function inboundStoreDetailQuery(
  scope: InboundStatisticsQuery,
  store: InboundDetailStore,
  productPage: number,
): InboundStatisticsQuery {
  return {
    periodType: scope.periodType,
    ...(scope.periodType === 'DAY' ? { date: scope.date } : { month: scope.month }),
    storeKind: store.kind,
    storeId: store.id,
    source: scope.source,
    storeSearch: '',
    productSearch: '',
    sortBy: scope.sortBy,
    sortDirection: scope.sortDirection,
    storePage: 1,
    productPage,
    pageSize: scope.pageSize,
  };
}

// Same 'inbound-statistics' prefix as the parent so "Làm mới" can refetch both together.
export const inboundStoreDetailKey = (query: InboundStatisticsQuery) =>
  ['inbound-statistics', 'store-detail', query] as const;

/** True when two detail queries differ only by product page, so a previous page may stay visible. */
export function sameInboundDetailScope(a: InboundStatisticsQuery, b: InboundStatisticsQuery) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof InboundStatisticsQuery>;
  return [...keys].every((key) => key === 'productPage' || a[key] === b[key]);
}

export function formatInboundValue(value: string, grams = false): string {
  const number = BigInt(value);
  if (!grams) return number.toLocaleString('vi-VN');
  const decimal = (number % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${(number / 1000n).toLocaleString('vi-VN')}${decimal ? `,${decimal}` : ''}`;
}
export function inboundShare(value: string, total: string, complete: boolean) {
  if (!complete) return 'Chưa xác định';
  if (BigInt(total) === 0n) return '0%';
  return `${(Number((BigInt(value) * 10_000n) / BigInt(total)) / 100).toLocaleString('vi-VN')}%`;
}
export function inboundMetricLabel(value: InboundMetric) {
  return `${formatInboundValue(value.bagQuantity)} bao${value.bagsComplete ? '' : ' (đã biết)'} · ${formatInboundValue(value.weightGrams, true)} kg${value.weightComplete ? '' : ' (đã biết)'}`;
}
