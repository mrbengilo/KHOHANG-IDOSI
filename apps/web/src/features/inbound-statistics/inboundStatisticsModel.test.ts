import { expect, it } from 'vitest';
import { InboundStatisticsQuerySchema } from '@idosi/contracts';
import { formatInboundValue, inboundShare, inboundStatisticsKey } from './inboundStatisticsModel';

it('formats exact grams and large quantities without floating point loss', () => {
  expect(formatInboundValue('9007199254740993001', true)).toBe('9.007.199.254.740.993,001');
  expect(inboundShare('0', '0', true)).toBe('0%');
  expect(inboundShare('1', '2', false)).toBe('Chưa xác định');
});
it('keys every data-affecting filter, including source, scope, searches and pages', () => {
  const query = InboundStatisticsQuerySchema.parse({ month: '2026-09' });
  expect(inboundStatisticsKey(query)[1]).toEqual(query);
  for (const patch of [
    { source: 'PARTNER' },
    { storeKind: 'RETAIL' },
    { storePage: 2 },
    { productPage: 2 },
    { storeSearch: 'A' },
    { productSearch: 'B' },
    { sortBy: 'weight' },
  ]) {
    expect(inboundStatisticsKey({ ...query, ...patch } as typeof query)).not.toEqual(
      inboundStatisticsKey(query),
    );
  }
});
