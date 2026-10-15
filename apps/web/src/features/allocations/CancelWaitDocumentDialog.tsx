import type { StoreWaitDocumentCancelPreview, StoreWaitDocumentDetail } from '@idosi/contracts';
import { useQuery } from '@tanstack/react-query';
import { RotateCcw, X } from 'lucide-react';
import { useId } from 'react';

import { Button } from '../../components/Button';
import { ApiClientError, previewWaitDocumentCancellation } from '../../lib/api';
import { useDialogAccessibility } from '../../lib/use-dialog-accessibility';

export const waitDocumentCancelPreviewKey = (accountKey: string, documentId: string) =>
  ['wait-document-cancel-preview', accountKey, documentId] as const;

const protectedLabel = {
  RESHARE_ORDER: 'đã tạo đơn Reshare',
  SHIPPED_OR_RECEIVED: 'đã xuất/nhận',
  ACCEPTED_LEGACY: 'đã chấp nhận theo quy trình cũ',
} as const;

/**
 * "Hủy phiếu chờ" of a whole store document: the server preview lists, line by line, the waiting
 * demand, priority holds and unconfirmed goods that are cancelled or revoked, the goods that are
 * protected, and the goods that only wait for the store's answer (not cancellable here). Nothing
 * is written until the account confirms; the preview fingerprint goes with the confirmation.
 */
export function CancelWaitDocumentDialog({
  accountKey,
  busy,
  document,
  error,
  onCancel,
  onConfirm,
  onReasonChange,
  reason,
}: {
  readonly accountKey: string;
  readonly busy: boolean;
  readonly document: StoreWaitDocumentDetail;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: (preview: StoreWaitDocumentCancelPreview) => void;
  readonly onReasonChange: (value: string) => void;
  readonly reason: string;
}) {
  const dialogRef = useDialogAccessibility<HTMLElement>(busy ? undefined : onCancel);
  const titleId = useId();
  const reasonErrorId = useId();
  const previewQuery = useQuery({
    queryFn: ({ signal }) => previewWaitDocumentCancellation(document.id, signal),
    queryKey: waitDocumentCancelPreviewKey(accountKey, document.id),
    retry: false,
    staleTime: 0,
  });
  const preview = previewQuery.data;
  const productName = (productId: string) =>
    document.lines.find((line) => line.productId === productId)?.productName ?? 'Mặt hàng';
  const invalid = reason.trim().length < 3;
  const cancellable = (preview?.tickets.length ?? 0) > 0;
  const cancelledTotal =
    preview?.tickets.reduce((total, ticket) => total + ticket.cancelledQuantity, 0) ?? 0;
  const revokedTotal =
    preview?.tickets.reduce(
      (total, ticket) => total + ticket.revocable.reduce((sum, row) => sum + row.quantity, 0),
      0,
    ) ?? 0;
  return (
    <div className="dialog-backdrop">
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="dialog waitlist-dialog wait-document-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="dialog__header">
          <div>
            <h2 id={titleId}>Hủy phiếu chờ {document.code}</h2>
            <p>
              <span className="store-name">{document.storeName}</span>. Mọi mặt hàng còn chờ của
              phiếu bị hủy; xem kỹ phạm vi trước khi xác nhận. Thao tác được ghi vào lịch sử phiếu.
            </p>
          </div>
          <button
            aria-label="Đóng hộp thoại hủy phiếu chờ"
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
        {preview ? (
          <div className="waitlist-dialog__body">
            {cancellable ? (
              <ul className="allocation-decision__carried">
                {preview.tickets.map((ticket) => (
                  <li key={ticket.waitTicketId}>
                    <span>
                      {productName(ticket.productId)} · dòng {ticket.code}: hủy{' '}
                      {ticket.cancelledQuantity} bao
                    </span>
                    <small>
                      {ticket.waitingQuantity} bao còn chờ
                      {ticket.revocable.length > 0
                        ? `; thu hồi ${ticket.revocable
                            .map(
                              (row) => `${row.quantity} bao khỏi kết quả phiên ${row.sessionCode}`,
                            )
                            .join(', ')}`
                        : ''}
                      {ticket.offers.length > 0
                        ? `; hủy ${ticket.offers.length} lượt ưu tiên (trả hàng đang giữ về kho)`
                        : ''}
                      {ticket.protected.length > 0
                        ? `; giữ nguyên ${ticket.protected
                            .map((row) => `${row.quantity} bao ${protectedLabel[row.kind]}`)
                            .join(', ')}`
                        : ''}
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="inline-notice" role="status">
                Không còn phần nào của phiếu có thể hủy: phần còn lại chỉ đang chờ cửa hàng xác nhận
                kết quả phân bổ.
              </div>
            )}
            {preview.awaitingAnswer.length > 0 ? (
              <p className="allocation-decision__hint">
                Không hủy ở đây{' '}
                {preview.awaitingAnswer
                  .map((row) => `${row.quantity} bao ${productName(row.productId)}`)
                  .join(', ')}{' '}
                đang chờ xác nhận kết quả của dòng đã hủy trước đó: hãy chọn “Xác nhận phân bổ” hoặc
                “Chuyển phiếu chờ” trên kết quả đó.
              </p>
            ) : null}
            {cancellable ? (
              <>
                <p className="allocation-decision__hint">
                  Tổng hủy {cancelledTotal} bao
                  {revokedTotal > 0 ? ` (gồm ${revokedTotal} bao thu hồi chưa xuất kho)` : ''}. Hàng
                  đã có đơn Reshare hoặc đã xuất/nhận được giữ nguyên; tồn cửa hàng không đổi.
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
              </>
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
            disabled={invalid || !cancellable || previewQuery.isFetching}
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
