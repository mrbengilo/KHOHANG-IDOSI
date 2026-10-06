import type { InventoryAmount, WaitTicket } from '@idosi/contracts';
import { formatKg } from '../lib/format';

export const ticketStatusLabel: Record<WaitTicket['status'], string> = {
  CANCELLED: 'Đã bị hủy',
  EXPIRED: 'Hết hạn',
  FULFILLED: 'Đã cấp đủ',
  OFFERED: 'Đang ưu tiên',
  PARTIALLY_FULFILLED: 'Đã cấp một phần',
  WAITING: 'Đang chờ',
};

const cancellationKindLabel: Record<NonNullable<WaitTicket['cancellationKind']>, string> = {
  ADMIN_CANCELLED: 'Admin hủy phiếu',
  HTKD_CANCELLED: 'HTKD hủy phiếu',
  FULL_OFFER_DECLINED: 'Cửa hàng không nhận đề nghị đủ hàng',
  FULL_OFFER_TIMEOUT: 'Quá hạn phản hồi đề nghị đủ hàng',
  STORE_CANCELLED: 'Cửa hàng hủy phiếu',
};

export function amountLabel(amount: InventoryAmount): string {
  return amount.kind === 'UNIT' ? `${amount.quantity} bao` : formatKg(amount.value);
}

export function CancellationNote({ ticket }: { readonly ticket: WaitTicket }) {
  const label = ticket.cancellationKind ? cancellationKindLabel[ticket.cancellationKind] : null;
  return (
    <span className="waitlist-panel__cancellation">
      {ticket.resolutionReason ? (label ?? 'Đã hủy') : 'Dữ liệu cũ chưa ghi nhận lý do hủy'}
      {ticket.resolutionReason && ticket.resolutionReason !== label
        ? ` — ${ticket.resolutionReason}`
        : ''}
      {ticket.resolvedAt
        ? ` • ${new Date(ticket.resolvedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`
        : ''}
    </span>
  );
}
