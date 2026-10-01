import { expect, it } from 'vitest';
import { InboundStatisticsQuerySchema } from '@idosi/contracts';
import {
  formatInboundValue,
  inboundShare,
  inboundStatisticsKey,
  inboundStoreDetailKey,
  inboundStoreDetailQuery,
  sameInboundDetailScope,
} from './inboundStatisticsModel';

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

const store = { id: '00000000-0000-4000-8000-000000000101', kind: 'RETAIL' as const };
const busyParent = () =>
  InboundStatisticsQuerySchema.parse({
    month: '2026-09',
    storeKind: 'RETAIL',
    source: 'PARTNER',
    storeSearch: 'Alpha',
    productSearch: 'nam',
    sortBy: 'weight',
    sortDirection: 'asc',
    storePage: 3,
    productPage: 7,
    pageSize: 10,
  });

it('builds a store detail query without touching the parent query', () => {
  const parent = Object.freeze(busyParent());
  const snapshot = structuredClone(parent);
  const detail = inboundStoreDetailQuery(parent, store, 2);
  expect(parent).toEqual(snapshot);
  expect(detail).toEqual({
    periodType: 'MONTH',
    month: '2026-09',
    storeKind: 'RETAIL',
    storeId: store.id,
    source: 'PARTNER',
    storeSearch: '',
    productSearch: '',
    sortBy: 'weight',
    sortDirection: 'asc',
    storePage: 1,
    productPage: 2,
    pageSize: 10,
  });
  // Detail starts on its own first page instead of the parent's product page 7.
  expect(inboundStoreDetailQuery(parent, store, 1).productPage).toBe(1);
  expect(InboundStatisticsQuerySchema.safeParse(detail).success).toBe(true);
});

it('sends only the date or the month of the selected period', () => {
  const day = InboundStatisticsQuerySchema.parse({ periodType: 'DAY', date: '2026-09-15' });
  const detail = inboundStoreDetailQuery(day, store, 1);
  expect(detail).toMatchObject({ periodType: 'DAY', date: '2026-09-15' });
  expect('month' in detail).toBe(false);
  expect(InboundStatisticsQuerySchema.safeParse(detail).success).toBe(true);
  const month = inboundStoreDetailQuery(busyParent(), store, 1);
  expect('date' in month).toBe(false);
  expect(InboundStatisticsQuerySchema.safeParse(month).success).toBe(true);
});

it('keys store details apart from the parent and by every data-affecting field', () => {
  const parent = busyParent();
  const detail = inboundStoreDetailQuery(parent, store, 1);
  const key = inboundStoreDetailKey(detail);
  expect(key[0]).toBe(inboundStatisticsKey(parent)[0]);
  expect(key).not.toEqual(inboundStatisticsKey(detail));
  const variants = [
    inboundStoreDetailQuery(
      parent,
      { id: '00000000-0000-4000-8000-000000000102', kind: 'WHOLESALE' },
      1,
    ),
    inboundStoreDetailQuery({ ...parent, month: '2026-08' }, store, 1),
    inboundStoreDetailQuery({ ...parent, source: 'ALL' }, store, 1),
    inboundStoreDetailQuery({ ...parent, sortBy: 'bags' }, store, 1),
    inboundStoreDetailQuery({ ...parent, sortDirection: 'desc' }, store, 1),
    inboundStoreDetailQuery({ ...parent, pageSize: 20 }, store, 1),
    inboundStoreDetailQuery(parent, store, 2),
  ];
  for (const variant of variants) expect(inboundStoreDetailKey(variant)).not.toEqual(key);
  // Parent-only fields (searches, store page) do not split the detail cache.
  expect(
    inboundStoreDetailKey(
      inboundStoreDetailQuery(
        { ...parent, storeSearch: '', productPage: 1, storePage: 1 },
        store,
        1,
      ),
    ),
  ).toEqual(key);
});

it('reuses a previous detail page only for the same store and scope', () => {
  const page1 = inboundStoreDetailQuery(busyParent(), store, 1);
  expect(sameInboundDetailScope(page1, inboundStoreDetailQuery(busyParent(), store, 2))).toBe(true);
  expect(
    sameInboundDetailScope(
      page1,
      inboundStoreDetailQuery(
        busyParent(),
        { ...store, id: '00000000-0000-4000-8000-000000000102' },
        2,
      ),
    ),
  ).toBe(false);
  expect(
    sameInboundDetailScope(
      page1,
      inboundStoreDetailQuery({ ...busyParent(), month: '2026-08' }, store, 1),
    ),
  ).toBe(false);
  expect(
    sameInboundDetailScope(
      page1,
      inboundStoreDetailQuery({ ...busyParent(), source: 'ALL' }, store, 1),
    ),
  ).toBe(false);
});
