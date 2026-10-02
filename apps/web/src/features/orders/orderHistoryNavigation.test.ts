import { describe, expect, it } from 'vitest';

import {
  clearOrderHistoryFilters,
  ORDER_HISTORY_KEYS,
  readOrderHistoryFilters,
  requestTotals,
  withOrderHistoryFilters,
} from './orderHistoryNavigation';

const store = '20000000-0000-4000-8000-00000000000a';
const session = '10000000-0000-4000-8000-000000000003';
const read = (query: string) => readOrderHistoryFilters(new URLSearchParams(query));

describe('order history URL filters', () => {
  it('defaults to no filter on the first page and drops invalid values', () => {
    expect(read('')).toEqual({
      storeId: '',
      sessionId: '',
      status: '',
      productId: '',
      code: '',
      from: '',
      to: '',
      page: 1,
    });
    expect(
      read('ls.store=x&ls.session=1&ls.status=OPEN&ls.from=2026-02-30&ls.page=0&ls.product=1'),
    ).toMatchObject({ storeId: '', sessionId: '', status: '', from: '', page: 1, productId: '' });
  });

  it('drops a reversed submission window instead of sending it', () => {
    expect(read('ls.from=2026-10-02&ls.to=2026-10-01')).toMatchObject({ from: '', to: '' });
    expect(read('ls.from=2026-10-01&ls.to=2026-10-02')).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-02',
    });
  });

  it('resets the page whenever a filter changes and keeps other tabs untouched', () => {
    const start = new URLSearchParams(`tab=history&ls.page=4&ls.store=${store}&kt=stock`);
    const next = withOrderHistoryFilters(start, { sessionId: session });
    expect(next.get(ORDER_HISTORY_KEYS.page)).toBeNull();
    expect(next.get(ORDER_HISTORY_KEYS.session)).toBe(session);
    expect(next.get(ORDER_HISTORY_KEYS.store)).toBe(store);
    expect(next.get('tab')).toBe('history');
    expect(next.get('kt')).toBe('stock');
    expect(withOrderHistoryFilters(start, { page: 5 }).get(ORDER_HISTORY_KEYS.page)).toBe('5');
    expect(withOrderHistoryFilters(start, { storeId: '' }).has(ORDER_HISTORY_KEYS.store)).toBe(
      false,
    );
    const cleared = clearOrderHistoryFilters(next);
    expect([...cleared.keys()]).toEqual(['tab', 'kt']);
  });

  it('totals requested quantities per unit without adding different units', () => {
    const line = (unit: 'BAG' | 'ITEM', requestedQuantity: number) => ({
      id: '30000000-0000-4000-8000-000000000001',
      productId: '30000000-0000-4000-8000-000000000002',
      sku: 'SKU',
      productName: 'Mặt hàng',
      unit,
      requestedQuantity,
      matchesFilter: true,
    });
    expect(requestTotals({ lines: [line('BAG', 2), line('BAG', 3)] })).toBe('5 bao');
    expect(requestTotals({ lines: [line('BAG', 2), line('ITEM', 3)] })).toBe('2 bao + 3 cái');
  });
});
