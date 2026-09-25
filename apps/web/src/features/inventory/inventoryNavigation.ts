import type { ReceiptAdjustmentDateField, ReceiptAdjustmentStatus } from '@idosi/contracts';

/**
 * URL state of "Tồn kho & lịch sử". Every key is namespaced so the tabs never read each other's
 * filters, invalid values fall back to safe defaults, and defaults are left out of the URL so a
 * shared link stays short. Tab switches are history entries; filter edits replace the entry.
 */
export type InventoryTab = 'warehouse' | 'store' | 'adjustments';
export type WarehouseTab = 'stock' | 'shortage' | 'history';
export type StoreTab = 'stock' | 'ledger';
export type AdjustmentStatusFilter = ReceiptAdjustmentStatus | 'ALL';

const INVENTORY_TABS: readonly InventoryTab[] = ['warehouse', 'store', 'adjustments'];
const WAREHOUSE_TABS: readonly WarehouseTab[] = ['stock', 'shortage', 'history'];
const STORE_TABS: readonly StoreTab[] = ['stock', 'ledger'];
const ADJUSTMENT_STATUSES: readonly AdjustmentStatusFilter[] = [
  'ALL',
  'PENDING_HTKD',
  'NEEDS_INFO',
  'PENDING_ADMIN',
  'APPLIED',
  'REJECTED',
  'CANCELLED',
];
const STORE_BAG_STATUSES = [
  'ALL',
  'IN_TRANSIT',
  'AVAILABLE',
  'OPEN',
  'EMPTY',
  'QUARANTINED',
  'RETURNED',
  'LOST',
] as const;
export type StoreBagStatusFilter = (typeof STORE_BAG_STATUSES)[number];

export const DEFAULT_ADJUSTMENT_STATUS: AdjustmentStatusFilter = 'PENDING_ADMIN';
export const ADJUSTMENT_PAGE_SIZE = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u;

export const KEYS = {
  tab: 'tab',
  warehouseTab: 'kt',
  warehouseSearch: 'kt.q',
  warehousePage: 'kt.page',
  warehouseHistoryPage: 'kt.hpage',
  storeTab: 'ch',
  store: 'ch.store',
  bagStatus: 'ch.status',
  bagCode: 'ch.bag-code',
  bag: 'ch.bag',
  adjustmentStatus: 'psl.status',
  adjustmentStore: 'psl.store',
  adjustmentSearch: 'psl.q',
  adjustmentDateField: 'psl.date',
  adjustmentFrom: 'psl.from',
  adjustmentTo: 'psl.to',
  adjustmentPage: 'psl.page',
  adjustmentOpen: 'psl.open',
} as const;

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function uuidOrEmpty(value: string | null): string {
  return value !== null && UUID.test(value) ? value.toLowerCase() : '';
}

function positivePage(value: string | null): number {
  if (value === null || !/^[1-9]\d{0,5}$/u.test(value)) return 1;
  return Number(value);
}

function validDate(value: string | null): string {
  if (value === null || !DATE.test(value)) return '';
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : '';
}

function text(value: string | null, max: number): string {
  return (value ?? '').trim().slice(0, max);
}

export interface AdjustmentFilters {
  readonly status: AdjustmentStatusFilter;
  readonly storeId: string;
  readonly q: string;
  readonly dateField: ReceiptAdjustmentDateField;
  readonly from: string;
  readonly to: string;
  readonly page: number;
}

export interface InventoryNavigation {
  readonly tab: InventoryTab;
  readonly warehouse: {
    readonly tab: WarehouseTab;
    readonly search: string;
    readonly page: number;
    readonly historyPage: number;
  };
  readonly store: {
    readonly tab: StoreTab;
    readonly storeId: string;
    readonly status: StoreBagStatusFilter;
    readonly bagCode: string;
    readonly bagId: string;
  };
  readonly adjustments: AdjustmentFilters & { readonly openId: string };
}

export function readInventoryNavigation(params: URLSearchParams): InventoryNavigation {
  const from = validDate(params.get(KEYS.adjustmentFrom));
  const to = validDate(params.get(KEYS.adjustmentTo));
  return {
    tab: oneOf(params.get(KEYS.tab), INVENTORY_TABS, 'warehouse'),
    warehouse: {
      tab: oneOf(params.get(KEYS.warehouseTab), WAREHOUSE_TABS, 'stock'),
      search: text(params.get(KEYS.warehouseSearch), 120),
      page: positivePage(params.get(KEYS.warehousePage)),
      historyPage: positivePage(params.get(KEYS.warehouseHistoryPage)),
    },
    store: {
      tab: oneOf(params.get(KEYS.storeTab), STORE_TABS, 'stock'),
      storeId: uuidOrEmpty(params.get(KEYS.store)),
      status: oneOf(params.get(KEYS.bagStatus), STORE_BAG_STATUSES, 'ALL'),
      bagCode: text(params.get(KEYS.bagCode), 60),
      bagId: uuidOrEmpty(params.get(KEYS.bag)),
    },
    adjustments: {
      status: oneOf(
        params.get(KEYS.adjustmentStatus),
        ADJUSTMENT_STATUSES,
        DEFAULT_ADJUSTMENT_STATUS,
      ),
      storeId: uuidOrEmpty(params.get(KEYS.adjustmentStore)),
      q: text(params.get(KEYS.adjustmentSearch), 40),
      dateField: oneOf(params.get(KEYS.adjustmentDateField), ['REPORTED', 'DECIDED'], 'REPORTED'),
      // A reversed window is dropped rather than sent: the server would refuse it anyway.
      from: from && to && from > to ? '' : from,
      to: from && to && from > to ? '' : to,
      page: positivePage(params.get(KEYS.adjustmentPage)),
      openId: uuidOrEmpty(params.get(KEYS.adjustmentOpen)),
    },
  };
}

const DEFAULTS: Partial<Record<string, string>> = {
  [KEYS.tab]: 'warehouse',
  [KEYS.warehouseTab]: 'stock',
  [KEYS.warehousePage]: '1',
  [KEYS.warehouseHistoryPage]: '1',
  [KEYS.storeTab]: 'stock',
  [KEYS.bagStatus]: 'ALL',
  [KEYS.adjustmentStatus]: DEFAULT_ADJUSTMENT_STATUS,
  [KEYS.adjustmentDateField]: 'REPORTED',
  [KEYS.adjustmentPage]: '1',
};

/** Returns new params with `changes` applied; empty or default values are removed. */
export function withParams(
  params: URLSearchParams,
  changes: Readonly<Record<string, string | number | null | undefined>>,
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [key, raw] of Object.entries(changes)) {
    const value = raw === null || raw === undefined ? '' : String(raw);
    if (value === '' || DEFAULTS[key] === value) next.delete(key);
    else next.set(key, value);
  }
  return next;
}

/** Any adjustment filter change starts again from the first page. */
export function withAdjustmentFilters(
  params: URLSearchParams,
  changes: Partial<Omit<AdjustmentFilters, 'page'>>,
): URLSearchParams {
  const mapped: Record<string, string | undefined> = {
    [KEYS.adjustmentPage]: '1',
  };
  if (changes.status !== undefined) mapped[KEYS.adjustmentStatus] = changes.status;
  if (changes.storeId !== undefined) mapped[KEYS.adjustmentStore] = changes.storeId;
  if (changes.q !== undefined) mapped[KEYS.adjustmentSearch] = changes.q.trim();
  if (changes.dateField !== undefined) mapped[KEYS.adjustmentDateField] = changes.dateField;
  if (changes.from !== undefined) mapped[KEYS.adjustmentFrom] = changes.from;
  if (changes.to !== undefined) mapped[KEYS.adjustmentTo] = changes.to;
  return withParams(params, mapped);
}

/**
 * Changing the store scope drops a selected bag or document that is not known to belong to the
 * new store; a selection in the new store (or with "all stores") is kept.
 */
export function withStoreScope(
  params: URLSearchParams,
  key: typeof KEYS.store | typeof KEYS.adjustmentStore,
  storeId: string,
  selectionStoreId: string | null,
): URLSearchParams {
  const selectionKey = key === KEYS.store ? KEYS.bag : KEYS.adjustmentOpen;
  // An unknown selection store cannot be shown to belong to the new store, so it is dropped.
  const keepSelection = storeId === '' || selectionStoreId === storeId;
  const base =
    key === KEYS.adjustmentStore
      ? withAdjustmentFilters(params, { storeId })
      : withParams(params, { [key]: storeId });
  return keepSelection ? base : withParams(base, { [selectionKey]: null });
}

/**
 * Query-key prefixes the page "Làm mới" button refreshes for the open tab only. Queries of
 * other tabs are not mounted, so they are never fetched by it.
 */
export function refreshQueryKeys(navigation: InventoryNavigation): readonly (readonly string[])[] {
  const names = [['catalog'], ['stores', 'accessible']] as const;
  if (navigation.tab === 'adjustments') {
    return [
      ['receipt-adjustments'],
      ['receipt-adjustment'],
      ['receipt-adjustment-history'],
      ['receipt-adjustment-context'],
      ['stores', 'accessible'],
    ];
  }
  if (navigation.tab === 'store') {
    return navigation.store.tab === 'ledger'
      ? [['store-inventory-bags'], ['store-inventory-ledger'], ...names]
      : [['store-inventory-bags'], ['store-sorted-stocks'], ...names];
  }
  switch (navigation.warehouse.tab) {
    case 'shortage':
      return [['warehouse-shortage-checks'], ...names];
    case 'history':
      return [['warehouse-outbound-history'], ...names];
    default:
      return [['warehouse-inventory']];
  }
}

export function matchesQueryPrefix(
  queryKey: readonly unknown[],
  prefixes: readonly (readonly string[])[],
): boolean {
  return prefixes.some((prefix) => prefix.every((part, index) => queryKey[index] === part));
}
