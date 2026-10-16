import type {
  StoreWaitDocument,
  StoreWaitDocumentEvent,
  StoreWaitDocumentLine,
  StoreWaitDocumentStatus,
} from '@idosi/contracts';

import type { StatusTone } from '../../lib/types';

/**
 * URL state of the "Phiếu chờ" tab (docs/store-active-wait-document.md). Parameters carry a `wd`
 * prefix so they never collide with the per-product ticket list kept on the same tab.
 */
export interface WaitDocumentListFilters {
  readonly view: 'ACTIVE' | 'HISTORY';
  readonly status: '' | Exclude<StoreWaitDocumentStatus, 'CURRENT'>;
  readonly storeId: string;
  readonly productId: string;
  readonly q: string;
  readonly from: string;
  readonly to: string;
  readonly page: number;
}

const HISTORY_STATUSES = ['MERGED', 'ROLLED_OVER', 'COMPLETED', 'CANCELLED'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function readWaitDocumentFilters(params: URLSearchParams): WaitDocumentListFilters {
  const view = params.get('wdView') === 'HISTORY' ? 'HISTORY' : 'ACTIVE';
  const status = params.get('wdStatus') ?? '';
  const page = Number(params.get('wdPage') ?? '1');
  const from = params.get('wdFrom') ?? '';
  const to = params.get('wdTo') ?? '';
  return {
    view,
    status:
      view === 'HISTORY' && (HISTORY_STATUSES as readonly string[]).includes(status)
        ? (status as WaitDocumentListFilters['status'])
        : '',
    storeId: params.get('wdStore') ?? '',
    productId: params.get('wdProduct') ?? '',
    q: (params.get('wdQ') ?? '').slice(0, 80),
    from: DATE.test(from) ? from : '',
    to: DATE.test(to) && (!DATE.test(from) || to >= from) ? to : '',
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

const PARAM: Record<Exclude<keyof WaitDocumentListFilters, 'page'>, string> = {
  view: 'wdView',
  status: 'wdStatus',
  storeId: 'wdStore',
  productId: 'wdProduct',
  q: 'wdQ',
  from: 'wdFrom',
  to: 'wdTo',
};

/** Applies filter changes; any change other than the page returns to page 1. */
export function withWaitDocumentFilters(
  params: URLSearchParams,
  changes: Partial<WaitDocumentListFilters>,
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [key, name] of Object.entries(PARAM) as [keyof typeof PARAM, string][]) {
    if (!(key in changes)) continue;
    const value = String(changes[key] ?? '').trim();
    if (value && !(key === 'view' && value === 'ACTIVE')) next.set(name, value);
    else next.delete(name);
  }
  // The history status filter means nothing for the active view.
  if (changes.view === 'ACTIVE') next.delete('wdStatus');
  if (changes.page !== undefined && changes.page > 1) next.set('wdPage', String(changes.page));
  else next.delete('wdPage');
  return next;
}

export function clearWaitDocumentFilters(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const name of [...Object.values(PARAM), 'wdPage']) {
    if (name !== 'wdView') next.delete(name);
  }
  return next;
}

/** The document opened in the detail panel (deep link, Back/Forward). */
export function readOpenWaitDocument(params: URLSearchParams): string | null {
  const id = params.get('wdOpen');
  return id && /^[0-9a-f-]{36}$/iu.test(id) ? id : null;
}

export function withOpenWaitDocument(params: URLSearchParams, id: string | null): URLSearchParams {
  const next = new URLSearchParams(params);
  if (id) next.set('wdOpen', id);
  else next.delete('wdOpen');
  return next;
}

/**
 * "Phiếu chờ tổng" (default) or the per-product ticket lines (PC) kept for search and history.
 * A link carrying the ticket list's own filters (`wt.*`, e.g. a PC code) still opens that list.
 */
export function readWaitTicketTabView(params: URLSearchParams): 'documents' | 'lines' {
  if (params.get('waitView') === 'lines') return 'lines';
  return [...params.keys()].some((key) => key.startsWith('wt.')) ? 'lines' : 'documents';
}

export function withWaitTicketTabView(
  params: URLSearchParams,
  view: 'documents' | 'lines',
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (view === 'lines') {
    next.set('waitView', 'lines');
    return next;
  }
  next.delete('waitView');
  for (const key of [...next.keys()]) if (key.startsWith('wt.')) next.delete(key);
  return next;
}

export const waitDocumentStatusFilterLabel: Record<
  Exclude<StoreWaitDocumentStatus, 'CURRENT'>,
  string
> = {
  MERGED: 'Đã xử lý · Gộp vào phiếu mới',
  ROLLED_OVER: 'Đã xử lý · Chuyển phần còn lại',
  COMPLETED: 'Đã xử lý xong',
  CANCELLED: 'Đã hủy',
};

/** The exact tag of a document, naming the successor it went to. */
export function waitDocumentLabel(
  document: Pick<StoreWaitDocument, 'status' | 'successor'>,
): string {
  switch (document.status) {
    case 'CURRENT':
      return 'Đang hoạt động';
    case 'MERGED':
      return `Đã xử lý · Gộp vào phiếu ${document.successor?.code ?? 'mới'}`;
    case 'ROLLED_OVER':
      return `Đã xử lý · Chuyển phần còn lại sang phiếu ${document.successor?.code ?? 'mới'}`;
    case 'COMPLETED':
      return 'Đã xử lý xong';
    case 'CANCELLED':
      return 'Đã hủy';
  }
}

export function waitDocumentTone(status: StoreWaitDocumentStatus): StatusTone {
  switch (status) {
    case 'CURRENT':
      return 'priority';
    case 'MERGED':
    case 'ROLLED_OVER':
      return 'info';
    case 'COMPLETED':
      return 'success';
    case 'CANCELLED':
      return 'neutral';
  }
}

/** Detail of a current document: what its open bags are waiting for. */
export function currentDocumentDetail(lines: readonly StoreWaitDocumentLine[]): string {
  const remaining = lines.reduce((sum, line) => sum + (line.remainingQuantity ?? 0), 0);
  const pending = lines.reduce((sum, line) => sum + (line.pendingQuantity ?? 0), 0);
  if (remaining === 0 && pending > 0) return 'Chờ xác nhận kết quả';
  if (pending > 0) return 'Còn chờ phân bổ · có hàng chờ xác nhận';
  return 'Còn chờ phân bổ';
}

export function lineOpenQuantity(line: StoreWaitDocumentLine): number {
  return line.carriedInQuantity + line.addedQuantity;
}

export function waitDocumentTotals(document: Pick<StoreWaitDocument, 'lines'>) {
  return document.lines.reduce(
    (totals, line) => ({
      products: totals.products + 1,
      open: totals.open + lineOpenQuantity(line),
      remaining: totals.remaining + (line.remainingQuantity ?? 0),
      pending: totals.pending + (line.pendingQuantity ?? 0),
      confirmed: totals.confirmed + (line.confirmedQuantity ?? 0),
      cancelled: totals.cancelled + (line.cancelledQuantity ?? 0),
      adjusted: totals.adjusted + (line.adjustedQuantity ?? 0),
      carriedOut: totals.carriedOut + (line.carriedOutQuantity ?? 0),
    }),
    {
      products: 0,
      open: 0,
      remaining: 0,
      pending: 0,
      confirmed: 0,
      cancelled: 0,
      adjusted: 0,
      carriedOut: 0,
    },
  );
}

const roleLabel = { ADMIN: 'Admin', HTKD: 'HTKD', STORE: 'Cửa hàng', WHOLESALE: 'Quầy sỉ' };

export function waitDocumentActor(event: StoreWaitDocumentEvent): string {
  if (!event.actor) return 'Hệ thống';
  const role = event.actor.role ? roleLabel[event.actor.role] : null;
  const name = event.actor.displayName ?? 'Tài khoản';
  return role ? `${name} (${role})` : name;
}

/** What happened, in words, from the structured event (never a stored free-text note). */
export function waitDocumentEventDescription(event: StoreWaitDocumentEvent): string {
  const session = event.session ? ` phiên ${event.session.code}` : '';
  switch (event.kind) {
    case 'ALLOCATION_RUN':
      return `Phân bổ 09:00${session}`;
    case 'RESULT_ACCEPTED':
      return `Xác nhận phân bổ kết quả${session}${
        event.reshareOrderCode ? ` · đơn ${event.reshareOrderCode}` : ''
      }`;
    case 'RESULT_WAITLISTED':
      return `Chuyển phiếu chờ kết quả${session}`;
    case 'WAIT_TICKET_CANCELLED':
      return `Hủy dòng ${event.waitTicket?.code ?? 'phiếu chờ'}${
        event.reason ? ` · lý do: ${event.reason}` : ''
      }`;
    case 'WAIT_DOCUMENT_CANCELLED':
      return `Hủy phiếu chờ${event.reason ? ` · lý do: ${event.reason}` : ''}`;
    case 'PRIORITY_OFFER_RESPONSE':
      return `Phản hồi lượt ưu tiên ${event.priorityOffer?.code ?? ''}`.trim();
    case 'RECEIPT_SHORTAGE':
      return `Khai nhận thiếu${event.storeReceipt ? ` phiếu nhận ${event.storeReceipt.number}` : ''}`;
    case 'RECEIPT_ADJUSTMENT':
      return `Duyệt sai lệch nhận hàng${
        event.storeReceipt ? ` phiếu nhận ${event.storeReceipt.number}` : ''
      }`;
    case 'SYSTEM_SYNC':
      return 'Đồng bộ hệ thống';
    case 'MIGRATION_BACKFILL':
      return 'Khởi tạo từ phiếu chờ đang có';
  }
}

/**
 * The closing event of a document, with what the 09:00 run resolved on it. A run never confirms
 * anything: the only bags it declares cancelled are wait tickets whose full priority offer went
 * unanswered, and any other drop it records as an adjustment. Without this the history would show
 * "Phân bổ 09:00" next to cancelled bags and leave the store guessing why.
 */
export function waitDocumentClosingDescription(
  document: Pick<StoreWaitDocument, 'lines'> & { readonly closedEvent: StoreWaitDocumentEvent },
): string {
  const description = waitDocumentEventDescription(document.closedEvent);
  if (document.closedEvent.kind !== 'ALLOCATION_RUN') return description;
  const totals = waitDocumentTotals(document);
  const notes = [
    totals.cancelled > 0
      ? `hủy ${totals.cancelled} bao do quá hạn phản hồi đề nghị nhận đủ hàng`
      : null,
    totals.confirmed + totals.adjusted > 0
      ? `điều chỉnh ${totals.confirmed + totals.adjusted} bao`
      : null,
  ].filter((note): note is string => note !== null);
  return notes.length ? `${description} · ${notes.join(' · ')}` : description;
}
