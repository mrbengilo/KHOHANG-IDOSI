import { describe, expect, it } from 'vitest';
import { InboundStatisticsQuerySchema, InboundStatisticsSchema } from '@idosi/contracts';
import {
  inboundPeriod,
  summarizeInboundStatistics,
  type InboundAggregate,
  type InboundStore,
} from '../src/inbound-statistics.js';

const stores: InboundStore[] = ['A', 'B', 'C'].map((name, index) => ({
  id: `20000000-0000-4000-8000-00000000000${index}`,
  code: name,
  name,
  kind: index === 2 ? 'WHOLESALE' : 'RETAIL',
}));
const productNames = ['Đồ nam', 'Đồ nữ', 'Áo vest'];
const rows: InboundAggregate[] = [
  [0, 0, 'WAREHOUSE', 30, 430],
  [0, 1, 'WAREHOUSE', 19, 125],
  [0, 2, 'WAREHOUSE', 1, 45],
  [0, 0, 'PARTNER', 5, 70],
  [0, 1, 'PARTNER', 3, 30],
  [1, 0, 'WAREHOUSE', 10, 150],
  [1, 2, 'WAREHOUSE', 5, 100],
  [1, 2, 'PARTNER', 2, 40],
  [2, 0, 'WAREHOUSE', 20, 300],
  [2, 1, 'WAREHOUSE', 10, 200],
].map(([store, product, source, bags, kg]) => ({
  storeId: stores[Number(store)]!.id,
  productId: String(product),
  sku: String(product),
  productName: productNames[Number(product)]!,
  source: source as 'WAREHOUSE' | 'PARTNER',
  bagQuantity: String(bags),
  weightGrams: String(Number(kg) * 1000),
  bagsComplete: true,
  weightComplete: true,
}));
const query = (patch = {}) => InboundStatisticsQuerySchema.parse({ month: '2026-09', ...patch });

describe('inbound statistics exact aggregation', () => {
  it('reconciles the 105 bag / 1490 kg fixture across both sources, kinds, stores and products', () => {
    const report = InboundStatisticsSchema.parse(summarizeInboundStatistics(query(), rows, stores));
    expect(report.overviewAllSources.total).toMatchObject({
      bagQuantity: '105',
      weightGrams: '1490000',
    });
    expect(report.overviewAllSources.warehouse).toMatchObject({
      bagQuantity: '95',
      weightGrams: '1350000',
    });
    expect(report.overviewAllSources.partner).toMatchObject({
      bagQuantity: '10',
      weightGrams: '140000',
    });
    expect(report.groupRows.map((r) => r.amounts.total.bagQuantity)).toEqual(['75', '30', '105']);
    expect(report.storeRows.find((s) => s.code === 'A')?.amounts.total.weightGrams).toBe('700000');
    expect(report.productRows.map((p) => [p.selected.bagQuantity, p.selected.weightGrams])).toEqual(
      [
        ['65', '950000'],
        ['32', '355000'],
        ['8', '185000'],
      ],
    );
    expect(report.ranking.most?.productName).toBe('Đồ nam');
    expect(report.ranking.least?.productName).toBe('Áo vest');
  });
  it('keeps overview, charts and global shares invariant under source, search and pagination', () => {
    const report = summarizeInboundStatistics(
      query({ source: 'PARTNER', productSearch: 'vest', pageSize: 1, storeSearch: 'B' }),
      rows,
      stores,
    );
    expect(report.overviewAllSources.total.bagQuantity).toBe('105');
    expect(report.selectedTotal.bagQuantity).toBe('10');
    expect(report.productRows[0]?.bagShareBasisPoints).toBe(2000);
    expect(report.charts.bags.reduce((s, p) => s + BigInt(p.selected.bagQuantity), 0n)).toBe(10n);
    expect(report.storeRows).toHaveLength(1);
  });
  it('rejects mismatched or nonexistent store scope and preserves wholesale zero partner totals', () => {
    expect(() =>
      summarizeInboundStatistics(
        query({ storeKind: 'RETAIL', storeId: stores[2]!.id }),
        rows,
        stores,
      ),
    ).toThrow();
    expect(() =>
      summarizeInboundStatistics(
        query({ storeId: '99999999-0000-4000-8000-000000000000' }),
        rows,
        stores,
      ),
    ).toThrow();
    expect(
      summarizeInboundStatistics(query({ storeKind: 'WHOLESALE' }), rows, stores).overviewAllSources
        .partner.bagQuantity,
    ).toBe('0');
  });
  it('handles empty data, one product, ties, unknown weights and exact values above MAX_SAFE_INTEGER', () => {
    expect(summarizeInboundStatistics(query(), [], stores).ranking.most).toBeNull();
    const huge = {
      ...rows[0]!,
      bagQuantity: '9007199254740993',
      weightGrams: '999999999999999999999',
    };
    const report = summarizeInboundStatistics(query(), [huge], stores);
    expect(report.overviewAllSources.total.weightGrams).toBe(huge.weightGrams);
    expect(report.ranking.most).toEqual(report.ranking.least);
    const missing = summarizeInboundStatistics(
      query(),
      [{ ...rows[0]!, bagsComplete: false, weightComplete: false }],
      stores,
    );
    expect(missing.dataCompleteness).toEqual({ bagsComplete: false, weightComplete: false });
    expect(missing.productRows[0]?.bagShareBasisPoints).toBeNull();
    expect(missing.ranking.complete).toBe(false);
    const tied = summarizeInboundStatistics(
      query(),
      [rows[0]!, { ...rows[0]!, productId: 'other', sku: 'Z', weightGrams: '1000' }],
      stores,
    );
    expect(tied.ranking.mostTied).toBe(true);
    expect(tied.ranking.least?.productId).toBe('other');
  });
  it('keeps distinct IDs and the source breakdown of Other in charts', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      ...rows[0]!,
      source: i % 2 ? ('PARTNER' as const) : ('WAREHOUSE' as const),
      productId: String(i),
      bagQuantity: '1',
    }));
    const report = summarizeInboundStatistics(query(), many, stores);
    expect(report.productPagination.totalItems).toBe(15);
    expect(report.charts.bags).toHaveLength(11);
    expect(report.charts.bags.at(-1)?.productName).toBe('Khác');
    expect(report.charts.bags.reduce((s, p) => s + BigInt(p.selected.bagQuantity), 0n)).toBe(15n);
  });
});

describe('Vietnam half-open calendar periods', () => {
  it.each(['2026-02-29', '2026-04-31', '2026-13-01', '', 'garbage'])(
    'rejects invalid date %s',
    (date) => {
      expect(InboundStatisticsQuerySchema.safeParse({ periodType: 'DAY', date }).success).toBe(
        false,
      );
    },
  );
  it('accepts leap days, rolls December and does not use machine timezone', () => {
    expect(
      inboundPeriod(query({ periodType: 'DAY', month: undefined, date: '2028-02-29' })),
    ).toMatchObject({
      start: '2028-02-28T17:00:00.000Z',
      endExclusive: '2028-02-29T17:00:00.000Z',
    });
    expect(inboundPeriod(query({ month: '2026-12' })).endExclusive).toBe(
      '2026-12-31T17:00:00.000Z',
    );
    expect(inboundPeriod(query()).start).toBe('2026-08-31T17:00:00.000Z');
    expect(
      InboundStatisticsQuerySchema.safeParse({ month: '2026-09', date: '2026-09-01' }).success,
    ).toBe(false);
    expect(
      InboundStatisticsQuerySchema.safeParse({ month: '2026-09', source: 'TRANSFER' }).success,
    ).toBe(false);
  });
});
