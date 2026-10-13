import type {
  SupplierCommitment,
  SupplierOrderState,
  SupplierPosition,
  SupplierProductStatus,
  SupplierReconciliationState,
} from '@idosi/contracts';

import type { Role, StatusTone } from '../../lib/types';

/**
 * Tabs of the workspace. Every role starts on its RE orders ("Đơn đặt Reshare"); only Admin
 * updates Reshare stock and configures sources. "legacy" (manual order records from before RE
 * orders) is reachable by link, never part of the main flow.
 */
export type SupplierTab = 'orders' | 'reconcile' | 'history' | 'settings' | 'legacy';

export function supplierTabsFor(role: Role): readonly SupplierTab[] {
  if (role === 'ADMIN') return ['orders', 'reconcile', 'history', 'settings'];
  return ['orders'];
}

/** Tabs reachable by URL but not shown in the tab bar. */
function hiddenTabsFor(role: Role): readonly SupplierTab[] {
  return role === 'ADMIN' || role === 'HTKD' ? ['legacy'] : [];
}

export const SUPPLIER_TAB_LABELS: Record<SupplierTab, string> = {
  orders: 'Đơn đặt Reshare',
  reconcile: 'Cập nhật tồn Reshare',
  history: 'Lịch sử cập nhật tồn',
  settings: 'Cấu hình nguồn',
  legacy: 'Đơn ghi nhận thủ công (trước khi có đơn RE)',
};

/** Old deep links keep working: the previous "status" tab is now the order history. */
const TAB_ALIASES: Record<string, SupplierTab> = { status: 'orders' };

export function readSupplierTab(value: string | null, role: Role): SupplierTab {
  const allowed = [...supplierTabsFor(role), ...hiddenTabsFor(role)];
  const resolved = value === null ? null : (TAB_ALIASES[value] ?? value);
  return resolved !== null && (allowed as readonly string[]).includes(resolved)
    ? (resolved as SupplierTab)
    : allowed[0]!;
}

export const STATE_LABEL: Record<SupplierReconciliationState, string> = {
  NO_BASELINE: 'Chưa có số đối chiếu',
  NEEDS_RECONCILIATION: 'Cần đối chiếu lại',
  SHORTFALL: 'Thiếu nguồn',
  RECONCILED: 'Đã đối chiếu',
};

export const STATE_TONE: Record<SupplierReconciliationState, StatusTone> = {
  NO_BASELINE: 'warning',
  NEEDS_RECONCILIATION: 'warning',
  SHORTFALL: 'danger',
  RECONCILED: 'success',
};

export const STATUS_LABEL: Record<SupplierProductStatus, string> = {
  PENDING_BASELINE: 'Chờ số đối chiếu đầu tiên',
  ACTIVE: 'Đang đối chiếu',
  NEEDS_RECONCILIATION: 'Tạm khóa cấp mới',
};

export const ORDER_STATE_LABEL: Record<SupplierOrderState, string> = {
  UNKNOWN: 'Chưa xác định (trước khi bật đối chiếu)',
  NOT_ORDERED: 'Chưa đặt Reshare',
  PARTIALLY_ORDERED: 'Đã đặt một phần',
  ORDERED: 'Đã đặt đủ',
  CANCEL_PENDING: 'Cần hủy bên Reshare',
  CANCELLED_CONFIRMED: 'Reshare đã hủy — cần đặt lại',
};

export const ORDER_STATE_TONE: Record<SupplierOrderState, StatusTone> = {
  UNKNOWN: 'warning',
  NOT_ORDERED: 'info',
  PARTIALLY_ORDERED: 'accent',
  ORDERED: 'success',
  CANCEL_PENDING: 'danger',
  CANCELLED_CONFIRMED: 'warning',
};

export const NOT_ORDERABLE_LABEL: Record<
  NonNullable<SupplierCommitment['notOrderableReason']>,
  string
> = {
  PRIORITY_OFFER: 'Đề nghị ưu tiên đang chờ phản hồi — chưa đặt Reshare',
  DECISION_PENDING: 'Chờ cửa hàng chấp nhận kết quả',
  NO_BASELINE_SOURCE: 'Mặt hàng chưa có số đối chiếu đầu tiên',
  FULLY_ORDERED: 'Đã đặt đủ',
};

/** One sentence that says what the numbers mean, so nobody reads F as "stock at B". */
export function positionSentence(position: SupplierPosition): string {
  if (position.state === 'NO_BASELINE') {
    return 'Chưa có số tồn Reshare đã xác nhận: chưa cấp mới mặt hàng này.';
  }
  const issued = position.issuedUnreflectedQuantity ?? 0;
  const parts = [
    `Reshare còn đặt được ${position.effectiveSupplierQuantity ?? 0} bao`,
    issued > 0
      ? `IDOSI đã giữ/cấp hoặc đã lập đơn RE nhưng số tồn chưa trừ ${position.unorderedCommitmentQuantity} bao (gồm ${issued} bao đơn RE)`
      : `IDOSI đã giữ/cấp nhưng chưa đặt ${position.unorderedCommitmentQuantity} bao`,
  ];
  if (position.shortfallQuantity > 0) {
    return `${parts.join(', ')} → thiếu nguồn ${position.shortfallQuantity} bao, không cấp mới.`;
  }
  return `${parts.join(', ')} → còn phân bổ được ${position.freeQuantity} bao.`;
}

/** Change of free stock a confirmation would cause, phrased for the success notice. */
export function freeChangeSentence(sku: string, before: number, after: number): string {
  if (before === after) return `${sku}: khả dụng giữ nguyên ${after} bao.`;
  return `${sku}: khả dụng ${before} → ${after} bao (${after > before ? '+' : ''}${after - before}).`;
}

const VN_OFFSET = '+07:00';

/**
 * `datetime-local` value (business time, Asia/Ho_Chi_Minh, to the second) for an instant.
 * Seconds matter: two observations of one SKU must be strictly ordered in time.
 */
export function toBusinessLocalInput(date: Date): string {
  const shifted = new Date(date.getTime() + 7 * 3_600_000);
  return shifted.toISOString().slice(0, 19);
}

/** ISO instant of a `datetime-local` value typed in business time; null when invalid. */
export function fromBusinessLocalInput(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/u.exec(value);
  if (!match) return null;
  const date = new Date(`${match[1]}${match[2] ?? ':00'}${VN_OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Whole bags only: empty, negative, fractional or oversized input is not a quantity. */
export function parseBags(value: string, max = 1_000_000): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : null;
}

export interface OrderDraftLine {
  readonly reservationId: string;
  readonly quantity: number;
  readonly externalLineRef: string;
}

/**
 * Lines of one B order from the rows HTKD picked: same store only (B order per store), each
 * quantity within what is still not ordered. Returns the problem instead of throwing.
 */
export function buildOrderLines(
  rows: readonly SupplierCommitment[],
  quantities: ReadonlyMap<string, string>,
  lineRefs: ReadonlyMap<string, string>,
): { readonly lines: OrderDraftLine[]; readonly error: string | null } {
  const picked = rows.filter((row) => quantities.has(row.id));
  if (picked.length === 0) return { lines: [], error: 'Chọn ít nhất một dòng chờ đặt.' };
  if (new Set(picked.map((row) => row.storeId)).size > 1) {
    return { lines: [], error: 'Một đơn Reshare chỉ ghi cho một cửa hàng.' };
  }
  const lines: OrderDraftLine[] = [];
  for (const row of picked) {
    const quantity = parseBags(quantities.get(row.id) ?? '', row.unorderedQuantity);
    if (quantity === null || quantity < 1) {
      return {
        lines: [],
        error: `${row.sku} (${row.storeCode}): nhập từ 1 đến ${row.unorderedQuantity} bao Reshare đã nhận.`,
      };
    }
    const ref = (lineRefs.get(row.id) ?? row.sku).trim();
    if (ref.length < 1 || ref.length > 100) {
      return { lines: [], error: `${row.sku}: dòng đơn Reshare cần 1–100 ký tự.` };
    }
    lines.push({ reservationId: row.id, quantity, externalLineRef: ref });
  }
  return { lines, error: null };
}

/** Totals of a page, for the "this page vs all pages" caption. */
export function pageTotals(rows: readonly SupplierCommitment[]) {
  return rows.reduce(
    (total, row) => ({
      quantity: total.quantity + row.quantity,
      orderedQuantity: total.orderedQuantity + row.orderedQuantity,
      unorderedQuantity: total.unorderedQuantity + row.unorderedQuantity,
    }),
    { quantity: 0, orderedQuantity: 0, unorderedQuantity: 0 },
  );
}
