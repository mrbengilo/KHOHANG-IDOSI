import { describe, expect, it } from 'vitest';

import {
  defaultInventoryTab,
  inventoryTabsFor,
  KEYS,
  matchesQueryPrefix,
  readInventoryNavigation,
  refreshQueryKeys,
  withAdjustmentFilters,
  withInventoryTab,
  withParams,
  withStoreScope,
} from './inventoryNavigation';

const storeA = '20000000-0000-4000-8000-00000000000a';
const storeB = '20000000-0000-4000-8000-00000000000b';
const bag = '30000000-0000-4000-8000-000000000001';

const read = (query: string) => readInventoryNavigation(new URLSearchParams(query));

describe('inventory URL navigation', () => {
  it('defaults to the warehouse stock and the admin-pending discrepancy slice', () => {
    const navigation = read('');
    expect(navigation.tab).toBe('warehouse');
    expect(navigation.warehouse).toEqual({
      tab: 'stock',
      search: '',
      page: 1,
      historyPage: 1,
      adjustments: { page: 1, productId: '', direction: 'ALL', from: '', to: '' },
    });
    expect(navigation.store).toEqual({
      tab: 'stock',
      storeId: '',
      status: 'ALL',
      bagCode: '',
      bagId: '',
    });
    expect(navigation.adjustments).toEqual({
      status: 'PENDING_HTKD',
      storeId: '',
      q: '',
      dateField: 'REPORTED',
      from: '',
      to: '',
      page: 1,
      openId: '',
    });
  });

  it('falls back safely on invalid values instead of sending them to the server', () => {
    const navigation = read(
      [
        'tab=secret',
        'kt=everything',
        'kt.page=-3',
        'ch.store=not-a-uuid',
        'ch.status=BURNT',
        'psl.status=DONE',
        'psl.date=APPLIED',
        'psl.from=2026-02-30',
        'psl.page=1e9',
        `psl.open=${bag}'--`,
      ].join('&'),
    );
    expect(navigation.tab).toBe('warehouse');
    expect(navigation.warehouse.tab).toBe('stock');
    expect(navigation.warehouse.page).toBe(1);
    expect(navigation.store.storeId).toBe('');
    expect(navigation.store.status).toBe('ALL');
    expect(navigation.adjustments.status).toBe('PENDING_HTKD');
    expect(navigation.adjustments.dateField).toBe('REPORTED');
    expect(navigation.adjustments.from).toBe('');
    expect(navigation.adjustments.page).toBe(1);
    expect(navigation.adjustments.openId).toBe('');
  });

  it('drops a reversed date window as a whole', () => {
    const { adjustments } = read('psl.from=2026-09-30&psl.to=2026-09-01');
    expect([adjustments.from, adjustments.to]).toEqual(['', '']);
  });

  it('keeps each tab state in its own namespace across tab switches', () => {
    const params = new URLSearchParams(
      `tab=store&ch=ledger&ch.store=${storeA}&ch.bag=${bag}&psl.status=APPLIED&kt=history`,
    );
    const switched = readInventoryNavigation(withParams(params, { [KEYS.tab]: 'adjustments' }));
    expect(switched.tab).toBe('adjustments');
    expect(switched.store).toMatchObject({ tab: 'ledger', storeId: storeA, bagId: bag });
    expect(switched.adjustments.status).toBe('APPLIED');
    expect(switched.warehouse.tab).toBe('history');
  });

  it('leaves defaults out of the URL', () => {
    const params = withParams(new URLSearchParams('tab=store'), {
      [KEYS.tab]: 'warehouse',
      [KEYS.adjustmentStatus]: 'PENDING_HTKD',
      [KEYS.adjustmentPage]: 1,
      [KEYS.adjustmentSearch]: '',
    });
    expect(params.toString()).toBe('');
  });

  it('returns to the first page whenever a discrepancy filter changes', () => {
    const params = new URLSearchParams('tab=adjustments&psl.page=4&psl.status=ALL');
    const next = readInventoryNavigation(withAdjustmentFilters(params, { q: ' PSL-01 ' }));
    expect(next.adjustments.page).toBe(1);
    expect(next.adjustments.q).toBe('PSL-01');
    expect(next.adjustments.status).toBe('ALL');
  });

  it('drops a selection of another store when the store scope changes', () => {
    const params = new URLSearchParams(`ch.store=${storeA}&ch.bag=${bag}`);
    expect(
      readInventoryNavigation(withStoreScope(params, KEYS.store, storeB, storeA)).store,
    ).toMatchObject({
      storeId: storeB,
      bagId: '',
    });
    expect(
      readInventoryNavigation(withStoreScope(params, KEYS.store, storeB, storeB)).store.bagId,
    ).toBe(bag);
    expect(
      readInventoryNavigation(withStoreScope(params, KEYS.store, '', storeA)).store.bagId,
    ).toBe(bag);
    // Unknown ownership cannot be shown to match, so it is dropped too.
    expect(
      readInventoryNavigation(withStoreScope(params, KEYS.store, storeB, null)).store.bagId,
    ).toBe('');
    const adjustment = new URLSearchParams(`psl.open=${bag}&psl.page=3`);
    const scoped = readInventoryNavigation(
      withStoreScope(adjustment, KEYS.adjustmentStore, storeB, storeA),
    ).adjustments;
    expect(scoped).toMatchObject({ storeId: storeB, openId: '', page: 1 });
  });

  it('refreshes only the open tab', () => {
    expect(refreshQueryKeys(read(''))).toEqual([['warehouse-inventory']]);
    expect(refreshQueryKeys(read('kt=history'))).toContainEqual(['warehouse-outbound-history']);
    expect(refreshQueryKeys(read('tab=store'))).toContainEqual(['store-sorted-stocks']);
    expect(refreshQueryKeys(read('tab=store'))).not.toContainEqual(['store-inventory-ledger']);
    expect(refreshQueryKeys(read('tab=store&ch=ledger'))).toContainEqual([
      'store-inventory-ledger',
    ]);
    const adjustments = refreshQueryKeys(read('tab=adjustments'));
    expect(adjustments).toContainEqual(['receipt-adjustments']);
    expect(adjustments).not.toContainEqual(['warehouse-inventory']);
    expect(matchesQueryPrefix(['receipt-adjustments', 'admin', 'ALL'], adjustments)).toBe(true);
    expect(matchesQueryPrefix(['warehouse-inventory', 1, ''], adjustments)).toBe(false);
  });

  it('keeps the stock adjustment history filters in their own namespace', () => {
    const product = '30000000-0000-4000-8000-0000000000aa';
    const navigation = read(
      `kt=adjustments&kt.dpage=3&kt.dproduct=${product}&kt.ddir=DECREASE&kt.dfrom=2026-10-01&kt.dto=2026-09-01`,
    );
    expect(navigation.warehouse.tab).toBe('adjustments');
    // A reversed window is dropped rather than sent to the server.
    expect(navigation.warehouse.adjustments).toEqual({
      page: 3,
      productId: product,
      direction: 'DECREASE',
      from: '',
      to: '',
    });
    expect(read('kt.ddir=SET').warehouse.adjustments.direction).toBe('ALL');
    expect(refreshQueryKeys(read('kt=adjustments'))).toEqual([
      ['warehouse-adjustments'],
      ['catalog'],
    ]);
  });
});

it('restricts HTKD deep links to warehouse stock and scoped store stock', () => {
  const n = readInventoryNavigation(
    new URLSearchParams('tab=adjustments&kt=history&kt.q=SKU'),
    'HTKD',
  );
  expect(n.tab).toBe('warehouse');
  expect(n.warehouse.tab).toBe('stock');
  expect(n.warehouse.search).toBe('SKU');
  expect(
    readInventoryNavigation(new URLSearchParams('tab=store&ch=ledger'), 'HTKD').store.tab,
  ).toBe('ledger');
});

describe('read-only warehouse scope for store accounts and the wholesale desk', () => {
  it('lists the tabs each principal may open, Admin-only scopes excluded', () => {
    expect(inventoryTabsFor('ADMIN')).toEqual(['warehouse', 'store', 'adjustments']);
    expect(inventoryTabsFor('HTKD')).toEqual(['warehouse', 'store']);
    expect(inventoryTabsFor('STORE', 'RETAIL')).toEqual(['warehouse', 'store']);
    expect(inventoryTabsFor('STORE', 'WHOLESALE')).toEqual(['warehouse']);
    expect(inventoryTabsFor('STORE', null)).toEqual(['warehouse']);
    expect(inventoryTabsFor('WHOLESALE')).toEqual(['warehouse']);
  });

  it('keeps a retail store landing on its own stock and lets it open the warehouse', () => {
    expect(defaultInventoryTab('STORE', 'RETAIL')).toBe('store');
    expect(defaultInventoryTab('WHOLESALE')).toBe('warehouse');
    expect(readInventoryNavigation(new URLSearchParams(''), 'STORE', 'RETAIL').tab).toBe('store');
    const warehouse = withInventoryTab(new URLSearchParams('ch=ledger'), 'warehouse', 'store');
    expect(warehouse.get('tab')).toBe('warehouse');
    expect(readInventoryNavigation(warehouse, 'STORE', 'RETAIL').tab).toBe('warehouse');
    const back = withInventoryTab(warehouse, 'store', 'store');
    expect(back.has('tab')).toBe(false);
    expect(back.get('ch')).toBe('ledger');
    expect(withInventoryTab(new URLSearchParams(''), 'warehouse', 'warehouse').has('tab')).toBe(
      false,
    );
  });

  it('pulls privileged deep links back to read-only warehouse stock', () => {
    for (const [role, storeKind] of [
      ['STORE', 'RETAIL'],
      ['STORE', 'WHOLESALE'],
      ['WHOLESALE', null],
    ] as const) {
      const n = readInventoryNavigation(
        new URLSearchParams('tab=adjustments&kt=adjustments&kt.q=SKU'),
        role,
        storeKind,
      );
      expect(n.tab).toBe(role === 'STORE' && storeKind === 'RETAIL' ? 'store' : 'warehouse');
      expect(n.warehouse.tab).toBe('stock');
      expect(n.warehouse.search).toBe('SKU');
    }
    expect(readInventoryNavigation(new URLSearchParams('tab=store'), 'WHOLESALE', null).tab).toBe(
      'warehouse',
    );
  });
});
