import type { InboundMetric, InboundStatisticsQuery } from '@idosi/contracts';

export const inboundStatisticsKey = (query: InboundStatisticsQuery) =>
  ['inbound-statistics', query] as const;
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
