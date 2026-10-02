import type {
  OrderHistoryEntry,
  OrderHistoryStatus,
  StoreOrderRequestStatus,
} from '@idosi/contracts';

/**
 * URL state of "Lịch sử đặt hàng". Keys are namespaced (ls.*) so they never collide with the
 * other allocation tabs; invalid values fall back to "no filter", and every filter change goes
 * back to page 1 so a page number never points into a different result set.
 */
export const ORDER_HISTORY_KEYS = {
  store: 'ls.store',
  session: 'ls.session',
  status: 'ls.status',
  product: 'ls.product',
  code: 'ls.code',
  from: 'ls.from',
  to: 'ls.to',
  page: 'ls.page',
} as const;

export interface OrderHistoryFilterState {
  readonly storeId: string;
  readonly sessionId: string;
  readonly status: '' | StoreOrderRequestStatus;
  readonly productId: string;
  readonly code: string;
  readonly from: string;
  readonly to: string;
  readonly page: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u;
const STATUSES: readonly StoreOrderRequestStatus[] = ['SUBMITTED', 'MERGED', 'CANCELLED'];

function uuid(value: string | null): string {
  return value !== null && UUID.test(value) ? value.toLowerCase() : '';
}

function date(value: string | null): string {
  if (value === null || !DATE.test(value)) return '';
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value ? value : '';
}

export function readOrderHistoryFilters(params: URLSearchParams): OrderHistoryFilterState {
  const from = date(params.get(ORDER_HISTORY_KEYS.from));
  const to = date(params.get(ORDER_HISTORY_KEYS.to));
  const reversed = from !== '' && to !== '' && from > to;
  const status = params.get(ORDER_HISTORY_KEYS.status);
  const page = params.get(ORDER_HISTORY_KEYS.page);
  return {
    storeId: uuid(params.get(ORDER_HISTORY_KEYS.store)),
    sessionId: uuid(params.get(ORDER_HISTORY_KEYS.session)),
    status:
      status !== null && (STATUSES as readonly string[]).includes(status)
        ? (status as StoreOrderRequestStatus)
        : '',
    productId: uuid(params.get(ORDER_HISTORY_KEYS.product)),
    code: (params.get(ORDER_HISTORY_KEYS.code) ?? '').trim().slice(0, 20),
    // A reversed window is dropped rather than sent: the server would refuse it.
    from: reversed ? '' : from,
    to: reversed ? '' : to,
    page: page !== null && /^[1-9]\d{0,5}$/u.test(page) ? Number(page) : 1,
  };
}

export function withOrderHistoryFilters(
  params: URLSearchParams,
  changes: Partial<Omit<OrderHistoryFilterState, 'page'>> & { readonly page?: number },
): URLSearchParams {
  const next = new URLSearchParams(params);
  const resetPage = Object.keys(changes).some((key) => key !== 'page');
  const entries: [string, string | number | undefined][] = [
    [ORDER_HISTORY_KEYS.store, changes.storeId],
    [ORDER_HISTORY_KEYS.session, changes.sessionId],
    [ORDER_HISTORY_KEYS.status, changes.status],
    [ORDER_HISTORY_KEYS.product, changes.productId],
    [ORDER_HISTORY_KEYS.code, changes.code?.trim()],
    [ORDER_HISTORY_KEYS.from, changes.from],
    [ORDER_HISTORY_KEYS.to, changes.to],
    [ORDER_HISTORY_KEYS.page, resetPage ? 1 : changes.page],
  ];
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    if (value === '' || (key === ORDER_HISTORY_KEYS.page && value === 1)) next.delete(key);
    else next.set(key, String(value));
  }
  return next;
}

export function clearOrderHistoryFilters(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of Object.values(ORDER_HISTORY_KEYS)) next.delete(key);
  return next;
}

export const orderHistoryStatusCopy: Record<OrderHistoryStatus, string> = {
  SUBMITTED: 'Chờ phân bổ',
  MERGED: 'Đã gộp',
  ALLOCATED: 'Đã gộp · cấp đủ',
  PARTIALLY_ALLOCATED: 'Đã gộp · cấp một phần',
  WAITLISTED: 'Đã gộp · chuyển phiếu chờ',
  CANCELLED: 'Đã hủy',
};

export const orderHistoryStatusTone: Record<
  OrderHistoryStatus,
  'neutral' | 'info' | 'success' | 'warning' | 'danger'
> = {
  SUBMITTED: 'info',
  MERGED: 'info',
  ALLOCATED: 'success',
  PARTIALLY_ALLOCATED: 'warning',
  WAITLISTED: 'warning',
  CANCELLED: 'neutral',
};

const unitCopy: Record<OrderHistoryEntry['lines'][number]['unit'], string> = {
  BAG: 'bao',
  ITEM: 'cái',
  KILOGRAM: 'kg',
};

export function unitLabel(unit: OrderHistoryEntry['lines'][number]['unit']): string {
  return unitCopy[unit];
}

/** Requested totals of one request per unit; different units are never added together. */
export function requestTotals(entry: Pick<OrderHistoryEntry, 'lines'>): string {
  const totals = new Map<string, number>();
  for (const line of entry.lines) {
    totals.set(line.unit, (totals.get(line.unit) ?? 0) + line.requestedQuantity);
  }
  return [...totals]
    .map(([unit, quantity]) => `${quantity.toLocaleString('vi-VN')} ${unitLabel(unit as never)}`)
    .join(' + ');
}
