import { describe, expect, it } from 'vitest';
import {
  readReportNavigation,
  reportDrilldownPath,
  updateReportNavigation,
} from './report-navigation';

const store = '20000000-0000-4000-8000-000000000001';

describe('report drill-down filters', () => {
  it('round trips the selected historical month and store', () => {
    const path = reportDrilldownPath('2024-02', store);
    expect(
      readReportNavigation(new URL(path, 'https://example.test').searchParams, '2026-09', true),
    ).toEqual({ period: '2024-02', scope: store });
  });
  it('allows whole-chain scope only for Admin', () => {
    const search = new URLSearchParams('period=2026-09&scope=ALL');
    expect(readReportNavigation(search, '2026-08', true).scope).toBe('ALL');
    expect(readReportNavigation(search, '2026-08', false).scope).toBe('');
  });
  it.each(['2026-13', '1999-12', '2101-01', 'bad', '2026-1'])(
    'rejects malformed or unsupported period %s',
    (period) => {
      expect(
        readReportNavigation(new URLSearchParams({ period, scope: '<script>' }), '2026-09', true),
      ).toEqual({ period: '2026-09', scope: 'ALL' });
    },
  );
  it('updates one filter without mutating or discarding the other', () => {
    const search = new URLSearchParams({ period: '2026-09', scope: store });
    const next = updateReportNavigation(search, 'period', '2026-08');
    expect(next.get('scope')).toBe(store);
    expect(next.get('period')).toBe('2026-08');
    expect(search.get('period')).toBe('2026-09');
  });
});
