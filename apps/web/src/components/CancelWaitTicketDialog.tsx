import type { WaitTicket, WaitTicketCancelPreview } from '@idosi/contracts';
import { useQuery } from '@tanstack/react-query';
import { RotateCcw, X } from 'lucide-react';
import { useId } from 'react';

import { ApiClientError, previewWaitTicketCancellation } from '../lib/api';
import { useDialogAccessibility } from '../lib/use-dialog-accessibility';
import { Button } from './Button';

export const waitTicketCancelPreviewKey = (accountId: string, waitTicketId: string) =>
  ['wait-ticket-cancel-preview', accountId, waitTicketId] as const;

const protectedLabel: Record<WaitTicketCancelPreview['protected'][number]['kind'], string> = {
  RESHARE_ORDER: 'Đã tạo đơn Reshare, không hủy',
  SHIPPED_OR_RECEIVED: 'Đã xuất/nhận, không hủy',
  ACCEPTED_LEGACY: 'Đã chấp nhận theo quy trình cũ, không hủy',
};

/**
 * "Hủy phiếu chờ" with the server's read-only preview: exactly which waiting demand, priority
 * holds and unconfirmed allocation goods are cancelled, and which RE-issued or shipped goods are
 * protected. Nothing is written until the account confirms; the confirmation carries the
 * preview fingerprint so a scope that changed meanwhile is refused instead of applied.
 */
export function CancelWaitTicketDialog({
  accountId,
  busy,
  error,
  onCancel,
  onConfirm,
  onReasonChange,
  productName,
  reason,
  storeName,
  ticket,
}: {
  readonly accountId: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: (preview: WaitTicketCancelPreview) => void;
  readonly onReasonChange: (value: string) => void;
  readonly productName: string;
  readonly reason: string;
  readonly storeName: string | null;
  readonly ticket: WaitTicket;
}) {
  const dialogRef = useDialogAccessibility(busy ? undefined : onCancel);
  const titleId = useId();
  const reasonErrorId = useId();
  const previewQuery = useQuery({
    queryFn: ({ signal }) => previewWaitTicketCancellation(ticket.id, signal),
    queryKey: waitTicketCancelPreviewKey(accountId, ticket.id),
    retry: false,
    staleTime: 0,
  });
  const preview = previewQuery.data;
  const invalid = reason.trim().length < 3;
  const revokedTotal = preview?.revocable.reduce((total, row) => total + row.quantity, 0) ?? 0;
  const protectedTotal = preview?.protected.reduce((total, row) => total + row.quantity, 0) ?? 0;
  return (
    <div className="dialog-backdrop">
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="dialog waitlist-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="dialog__header">
          <div>
            <h2 id={titleId}>Hủy phiếu chờ {ticket.code ?? ''}</h2>
            <p>
              {storeName ? `${storeName} • ` : ''}
              {productName}. Xem kỹ phạm vi trước khi xác nhận; thao tác được ghi vào nhật ký.
            </p>
          </div>
          <button
            aria-label="Đóng hộp thoại hủy phiếu"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        {previewQuery.isPending ? <p aria-live="polite">Đang tải phạm vi hủy…</p> : null}
        {previewQuery.isError ? (
          <div className="form-error" role="alert">
            {previewQuery.error instanceof ApiClientError
              ? previewQuery.error.message
              : 'Không tải được phạm vi hủy.'}
            <Button onClick={() => void previewQuery.refetch()} tone="secondary">
              <RotateCcw aria-hidden="true" size={15} /> Thử lại
            </Button>
          </div>
        ) : null}
        {preview && !preview.cancellable ? (
          <div className="inline-notice" role="status">
            {preview.refusal === 'ALREADY_CANCELLED'
              ? 'Phiếu chờ này đã được hủy trước đó.'
              : 'Không còn phần nào của phiếu chờ có thể hủy: hàng đã tạo đơn Reshare hoặc đã xuất/nhận được giữ nguyên.'}
          </div>
        ) : null}
        {preview && preview.cancellable ? (
          <div className="waitlist-dialog__body">
            <ul className="allocation-decision__carried">
              <li>
                <span>Nhu cầu còn chờ bị hủy</span>
                <small>{preview.waitingQuantity} bao</small>
              </li>
              {preview.offers.map((offer) => (
                <li key={offer.offerId}>
                  <span>Lượt ưu tiên {offer.code} bị hủy</span>
                  <small>
                    {offer.heldQuantity > 0
                      ? `trả ${offer.heldQuantity} bao đang giữ về kho tổng`
                      : 'không có hàng đang giữ'}
                  </small>
                </li>
              ))}
              {preview.revocable.map((row) => (
                <li key={row.allocationLineId}>
                  <span>
                    Thu hồi {row.quantity} bao khỏi kết quả phiên {row.sessionCode}
                    {row.shipmentNumber ? ` (chuyến ${row.shipmentNumber})` : ''}
                  </span>
                  <small>
                    {row.closesResult
                      ? 'Kết quả không còn hàng: chuyển “Đã thu hồi”'
                      : 'Phần còn lại của kết quả vẫn chờ xác nhận'}
                  </small>
                </li>
              ))}
              {preview.protected.map((row, index) => (
                <li key={`${row.allocationDecisionId ?? 'legacy'}:${index}`}>
                  <span>
                    Giữ nguyên {row.quantity} bao
                    {row.sessionCode ? ` của phiên ${row.sessionCode}` : ''}
                    {row.reshareOrderCode ? ` · đơn ${row.reshareOrderCode}` : ''}
                  </span>
                  <small>{protectedLabel[row.kind]}</small>
                </li>
              ))}
            </ul>
            <p className="allocation-decision__hint">
              Tổng hủy {preview.cancelledQuantity} bao
              {revokedTotal > 0 ? ` (gồm ${revokedTotal} bao thu hồi chưa xuất kho)` : ''}.
              {protectedTotal > 0
                ? ` ${protectedTotal} bao đã có đơn Reshare hoặc đã xuất được bảo vệ, không hoàn kho.`
                : ''}{' '}
              Thu hồi chỉ trả phần hàng đang giữ (không nhập kho), tồn cửa hàng không đổi.
            </p>
            <label>
              <span className="field-label">Lý do hủy</span>
              <textarea
                aria-describedby={invalid && reason.length > 0 ? reasonErrorId : undefined}
                disabled={busy}
                maxLength={500}
                minLength={3}
                onChange={(event) => onReasonChange(event.target.value)}
                placeholder="Nhập ít nhất 3 ký tự"
                required
                rows={3}
                value={reason}
              />
            </label>
            {invalid && reason.length > 0 ? (
              <div className="form-error" id={reasonErrorId} role="alert">
                Lý do phải có ít nhất 3 ký tự.
              </div>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="dialog__actions">
          <Button data-dialog-initial-focus disabled={busy} onClick={onCancel} tone="secondary">
            Giữ phiếu
          </Button>
          <Button
            busy={busy}
            disabled={invalid || !preview?.cancellable || previewQuery.isFetching}
            onClick={() => preview && onConfirm(preview)}
            tone="danger"
          >
            Xác nhận hủy phiếu chờ
          </Button>
        </div>
      </section>
    </div>
  );
}
