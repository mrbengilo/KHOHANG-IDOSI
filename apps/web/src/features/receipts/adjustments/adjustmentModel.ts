import type {
  AdjustmentAccount,
  AuditActorRole,
  ReceiptAdjustment,
  ReceiptAdjustmentBlocker,
  ReceiptAdjustmentCause,
  ReceiptAdjustmentHistoryEventType,
  ReceiptAdjustmentListItem,
  ReceiptAdjustmentStatus,
  ReceiptMoney,
  ReceiptReturnStatus,
  ReceiptShortageEntitlement,
} from '@idosi/contracts';

import type { StatusTone } from '../../../lib/types';

/**
 * The one label set for a document's status on every screen and role. "Đã xử lý" means the
 * admin applied the adjustment successfully; a return still travelling or a make-up unit still
 * owed is shown as its own progress, and rejected/cancelled are other final outcomes.
 */
export const adjustmentStatusCopy: Record<
  ReceiptAdjustmentStatus,
  { readonly label: string; readonly tone: StatusTone }
> = {
  PENDING_HTKD: { label: 'Chờ HTKD xác minh', tone: 'warning' },
  NEEDS_INFO: { label: 'Cần cửa hàng bổ sung', tone: 'info' },
  PENDING_ADMIN: { label: 'Chờ Admin duyệt', tone: 'priority' },
  APPLIED: { label: 'Đã xử lý', tone: 'success' },
  REJECTED: { label: 'Bị từ chối', tone: 'danger' },
  CANCELLED: { label: 'Đã hủy', tone: 'neutral' },
};

export const ADJUSTMENT_STATUSES = Object.keys(adjustmentStatusCopy) as ReceiptAdjustmentStatus[];

export const historyEventCopy: Record<ReceiptAdjustmentHistoryEventType, string> = {
  REPORTED: 'Cửa hàng báo sai lệch',
  RESUBMITTED: 'Cửa hàng bổ sung và gửi lại',
  VERIFIED: 'Xác minh, gửi Admin duyệt',
  INFO_REQUESTED: 'Yêu cầu cửa hàng bổ sung',
  RETURNED_TO_VERIFIER: 'Admin trả HTKD xác minh lại',
  REJECTED: 'Từ chối hồ sơ',
  CANCELLED: 'Hủy hồ sơ',
  APPLIED: 'Admin duyệt và áp dụng',
  RETURN_CREATED: 'Tạo phiếu trả kho',
  RETURN_HANDED_OVER: 'Bàn giao hàng trả',
  RETURN_RECEIVED: 'Kho tổng nhận hàng trả',
  RETURN_DISPUTED: 'Kho tổng nhận thiếu/sai – đối soát',
  RETURN_RECEIVED_AFTER_RECONCILIATION: 'Đối soát xong – kho đã nhận',
  RETURN_LOST: 'Đối soát xong – thất lạc',
  RETURN_CANCELLED: 'Hủy phiếu trả, giữ bán',
  OTHER: 'Thao tác khác',
};

export const auditRoleCopy: Record<AuditActorRole, string> = {
  ADMIN: 'Admin',
  HTKD: 'HTKD',
  STORE: 'Cửa hàng',
  WHOLESALE: 'Quầy sỉ',
};

export const NOT_RECORDED = 'Chưa ghi nhận';
const NO_LONGER_AVAILABLE = 'Không còn thông tin';

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

/** Name of an account on a document; an unreadable account keeps its id, never a guess. */
export function accountLabel(
  account: Pick<AdjustmentAccount, 'displayName' | 'username'> & {
    readonly accountId: string | null;
  },
): string {
  if (account.displayName) return account.displayName;
  if (account.username) return account.username;
  return account.accountId
    ? `Tài khoản ${shortId(account.accountId)} · ${NO_LONGER_AVAILABLE}`
    : NOT_RECORDED;
}

export function storeLabel(store: {
  readonly storeId: string | null;
  readonly code: string | null;
  readonly name: string | null;
}): string {
  if (store.code && store.name) return `${store.code} · ${store.name}`;
  if (store.name || store.code) return (store.name ?? store.code)!;
  return store.storeId
    ? `Cửa hàng ${shortId(store.storeId)} · ${NO_LONGER_AVAILABLE}`
    : NOT_RECORDED;
}

/**
 * The goods delta of a list row, labelled by whether it is in force: verified figures are only
 * a draft until the admin applies them, and closed documents never took effect.
 */
export function listMoneyCopy(item: Pick<ReceiptAdjustmentListItem, 'status' | 'goodsDeltaVnd'>): {
  readonly label: string;
  readonly value: string | null;
} {
  switch (item.status) {
    case 'APPLIED':
      return { label: 'Đã có hiệu lực', value: formatSignedVnd(item.goodsDeltaVnd) };
    case 'PENDING_ADMIN':
      return { label: 'Tạm tính, chưa hiệu lực', value: formatSignedVnd(item.goodsDeltaVnd) };
    case 'REJECTED':
    case 'CANCELLED':
      return { label: 'Không phát sinh', value: null };
    default:
      return { label: 'Chờ HTKD xác minh giá', value: null };
  }
}

export const returnStatusCopy: Record<
  ReceiptReturnStatus,
  { readonly label: string; readonly tone: StatusTone }
> = {
  PENDING_HANDOVER: { label: 'Chờ bàn giao trả', tone: 'warning' },
  IN_TRANSIT: { label: 'Đang vận chuyển về kho', tone: 'info' },
  RECEIVED: { label: 'Kho đã nhận', tone: 'success' },
  DISPUTED: { label: 'Đang đối soát', tone: 'danger' },
  LOST: { label: 'Xác nhận thất lạc', tone: 'danger' },
  CANCELLED: { label: 'Đã hủy – giữ bán', tone: 'neutral' },
};

export const causeCopy: Record<ReceiptAdjustmentCause, string> = {
  SOURCE_MISCLASSIFICATION: 'Phân loại sai từ nguồn nhập',
  WAREHOUSE_MISPICK: 'Kho tổng giao nhầm',
};

export const causeHint: Record<ReceiptAdjustmentCause, string> = {
  SOURCE_MISCLASSIFICATION: 'Sổ kho tổng không đổi: bao đã xuất đúng số lượng như ghi nhận.',
  WAREHOUSE_MISPICK:
    'Kho ghi giảm 1 mặt hàng thực tế đã giao nhầm; mặt hàng duyệt được giữ chờ kiểm kệ, chưa phân bổ.',
};

export const blockerCopy: Record<ReceiptAdjustmentBlocker, string> = {
  BAG_NOT_HELD: 'Bao không còn được hồ sơ này giữ',
  BAG_STATE_CHANGED: 'Mặt hàng, kg hoặc giá trị bao đã đổi sau khi xác minh',
  BAG_PARTIALLY_CONSUMED: 'Bao đã bán/xuất/phân loại một phần',
  BAG_DEPLETED: 'Bao đã hết hàng',
  BAG_TRANSFERRED: 'Bao đã chuyển sang cửa hàng khác',
  BAG_SORTED: 'Bao đã lọc/phân loại',
  BAG_SOLD: 'Bao đã có phiếu bán/xuất được duyệt hoặc bán qua IDOSI',
  BAG_PENDING_OUTBOUND: 'Bao có phiếu xuất đang chờ duyệt (cần từ chối trước)',
  BAG_PENDING_TRANSFER: 'Bao có phiếu chuyển nháp (cần hủy trước)',
  BAG_RETURNED_OR_LOST: 'Bao đã trả kho hoặc thất lạc',
};

export function describeEntitlement(entitlement: ReceiptShortageEntitlement): string {
  if (entitlement.receivedQuantity > 0) return 'Đã nhận bù';
  if (entitlement.shippingQuantity > 0) return 'Đang giao bù';
  if (entitlement.heldQuantity > 0) return 'Đã cấp, giữ chờ giao cùng đơn kế tiếp';
  if (entitlement.hasOpenOffer) return 'Có đề nghị ưu tiên chờ cửa hàng xác nhận';
  if (entitlement.waitStatus === 'ACTIVE') return 'Chờ cấp (ưu tiên P0B)';
  if (entitlement.waitStatus === 'FULFILLED') return 'Đã cấp theo phiếu chờ';
  return 'Phiếu chờ đã đóng – xem lịch sử phiếu chờ';
}

export type AdjustmentAudience = 'ADMIN' | 'HTKD' | 'STORE';

/**
 * The side of the discrepancy workflow a signed-in role works on. The wholesale desk receives
 * for the wholesale stores, so it is their store side: it reports, answers and hands returns
 * over, and never verifies or approves. The server applies the same mapping and scope.
 */
export function adjustmentAudience(role: string): AdjustmentAudience | null {
  if (role === 'ADMIN' || role === 'HTKD' || role === 'STORE') return role;
  if (role === 'WHOLESALE') return 'STORE';
  return null;
}

function parseGrams(weightKg: string): bigint | null {
  if (!/^(?:0\.\d{1,3}|[1-9]\d*(?:\.\d{1,3})?)$/.test(weightKg)) return null;
  const [whole = '0', fraction = ''] = weightKg.split('.');
  const grams = BigInt(whole) * 1_000n + BigInt(fraction.padEnd(3, '0'));
  return grams > 0n ? grams : null;
}

function parseSigned(value: string): bigint | null {
  return /^-?\d{1,16}$/.test(value.trim()) ? BigInt(value.trim()) : null;
}

export interface VerificationDraftLine {
  readonly recordedCostVnd: number;
  readonly weightKg: string;
  readonly pricePerKgVnd: string;
}

export interface AdjustmentPreview {
  readonly lineCosts: readonly (bigint | null)[];
  readonly delta: { goods: bigint; freight: bigint; handling: bigint; vat: bigint } | null;
  readonly after: {
    goods: bigint;
    freight: bigint;
    handling: bigint;
    cost: bigint;
    vat: bigint | null;
    total: bigint | null;
  } | null;
  readonly problem: string | null;
}

/**
 * Same rounding as the server (each bag half-up to a whole VND). Only a preview for HTKD: the
 * server recomputes on verification and again when the admin applies.
 */
export function previewAdjustment(
  before: ReceiptMoney,
  lines: readonly VerificationDraftLine[],
  fees: { readonly freight: string; readonly handling: string; readonly vat: string },
): AdjustmentPreview {
  const lineCosts = lines.map((line) => {
    const grams = parseGrams(line.weightKg);
    const price = /^\d{1,15}$/.test(line.pricePerKgVnd) ? BigInt(line.pricePerKgVnd) : null;
    return grams === null || price === null ? null : (grams * price + 500n) / 1_000n;
  });
  const freight = parseSigned(fees.freight || '0');
  const handling = parseSigned(fees.handling || '0');
  const vat = parseSigned(fees.vat || '0');
  if (
    lineCosts.some((cost) => cost === null) ||
    freight === null ||
    handling === null ||
    vat === null
  ) {
    return {
      lineCosts,
      delta: null,
      after: null,
      problem: 'Chưa nhập đủ kg, giá/kg hoặc chênh lệch phí hợp lệ.',
    };
  }
  const goods = lineCosts.reduce<bigint>(
    (total, cost, index) => total + (cost ?? 0n) - BigInt(lines[index]!.recordedCostVnd),
    0n,
  );
  if (before.vatVnd === null && vat !== 0n) {
    return {
      lineCosts,
      delta: null,
      after: null,
      problem: 'Phiếu gốc chưa ghi nhận VAT nên không điều chỉnh VAT.',
    };
  }
  const after = {
    goods: BigInt(before.goodsVnd) + goods,
    freight: BigInt(before.freightVnd) + freight,
    handling: BigInt(before.handlingVnd) + handling,
    cost: 0n,
    vat: before.vatVnd === null ? null : BigInt(before.vatVnd) + vat,
    total: null as bigint | null,
  };
  after.cost = after.goods + after.freight + after.handling;
  after.total = after.vat === null ? null : after.cost + after.vat;
  const negative = [after.goods, after.freight, after.handling, after.vat ?? 0n].some(
    (value) => value < 0n,
  );
  return {
    lineCosts,
    delta: { goods, freight, handling, vat },
    after,
    problem: negative ? 'Giá trị sau điều chỉnh không được âm.' : null,
  };
}

export function formatSignedVnd(value: bigint | number): string {
  const amount = typeof value === 'bigint' ? value : BigInt(value);
  const sign = amount > 0n ? '+' : amount < 0n ? '−' : '';
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${new Intl.NumberFormat('vi-VN').format(absolute)} ₫`;
}

export function formatExactVnd(value: bigint | number | null, missing = 'Chưa ghi nhận'): string {
  if (value === null) return missing;
  const amount = typeof value === 'bigint' ? value : BigInt(value);
  return `${amount < 0n ? '−' : ''}${new Intl.NumberFormat('vi-VN').format(amount < 0n ? -amount : amount)} ₫`;
}

export function openForRole(adjustment: Pick<ReceiptAdjustment, 'status'>, role: string): boolean {
  if (role === 'STORE') return adjustment.status === 'NEEDS_INFO';
  if (role === 'HTKD') return adjustment.status === 'PENDING_HTKD';
  if (role === 'ADMIN')
    return adjustment.status === 'PENDING_ADMIN' || adjustment.status === 'PENDING_HTKD';
  return false;
}
