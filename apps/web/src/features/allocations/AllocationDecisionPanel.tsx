import type { AllocationDecision, AllocationDecisionDetail } from '@idosi/contracts';
import { CheckCircle2, PackageCheck, X, XCircle } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { useDialogAccessibility } from '../../lib/use-dialog-accessibility';
import {
  decisionCode,
  decisionStatusLabel,
  decisionStatusTone,
  shipmentProgressLabel,
} from './allocationDecisionApi';
import type { useAllocationDecisionResponder } from './useAllocationDecisionResponder';
import './allocation-decisions.css';

const timeFormatter = new Intl.DateTimeFormat('vi-VN', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Ho_Chi_Minh',
});

export interface AllocationDecisionPanelProps {
  readonly decision: AllocationDecision | AllocationDecisionDetail;
  readonly productName: (productId: string) => string;
  readonly storeName: string;
  readonly responder: ReturnType<typeof useAllocationDecisionResponder>;
  readonly onClose?: () => void;
  /** Show the receive-page link for the store side once goods are on their way. */
  readonly canReceive?: boolean;
}

/** One published result: what was granted, carried goods, the store's answer and delivery. */
export function AllocationDecisionPanel({
  canReceive = false,
  decision,
  onClose,
  productName,
  responder,
  storeName,
}: AllocationDecisionPanelProps) {
  const headingId = useId();
  const [confirmingReject, setConfirmingReject] = useState(false);
  const busy = responder.busy?.decisionId === decision.id ? responder.busy.action : null;
  const anyBusy = responder.busy !== null;
  const error = responder.error?.decisionId === decision.id ? responder.error : null;
  const success = responder.success?.decisionId === decision.id ? responder.success : null;
  const carried = decision.carried.filter((row) => row.reservationStatus === 'ACTIVE');
  const carriedHistory = decision.carried.filter((row) => row.reservationStatus !== 'ACTIVE');
  const carriedQuantity = carried.reduce((total, row) => total + row.quantity, 0);
  const waitlisted = decision.lines.reduce((total, line) => total + line.waitlistedQuantity, 0);
  const shipment = decision.shipment;

  const accept = () =>
    void responder.respond(decision, { action: 'ACCEPT', expectedVersion: decision.version });

  return (
    <article aria-labelledby={headingId} className="panel allocation-decision">
      <header className="allocation-decision__header">
        <div className="allocation-decision__title">
          <h3 id={headingId}>Phiếu kết quả {decisionCode(decision)}</h3>
          <p>
            {storeName} · Phiên {decision.sessionCode} · Ngày {decision.businessDate} · Phiên bản
            kết quả {decision.runVersion}
          </p>
        </div>
        <div className="allocation-decision__status">
          <Badge tone={decisionStatusTone[decision.status]}>
            {decisionStatusLabel[decision.status]}
          </Badge>
          {onClose ? (
            <button
              aria-label={`Đóng phiếu ${decisionCode(decision)}`}
              className="allocation-decision__close"
              onClick={onClose}
              type="button"
            >
              <X aria-hidden="true" size={20} />
            </button>
          ) : null}
        </div>
      </header>

      <section aria-label="Phân bổ phiên này" className="allocation-decision__group">
        <h4>Phân bổ phiên này</h4>
        {decision.lines.length === 0 ? (
          <p>Phiếu không có dòng mặt hàng.</p>
        ) : (
          <div className="document-history">
            <table className="table-density table-density--metrics">
              <thead>
                <tr>
                  <th>Mặt hàng</th>
                  <th>Được cấp (bao)</th>
                  <th>Chưa được cấp (bao)</th>
                </tr>
              </thead>
              <tbody>
                {decision.lines.map((line) => (
                  <tr key={line.productId}>
                    <td data-label="Mặt hàng">{productName(line.productId)}</td>
                    <td data-label="Được cấp">{line.allocatedQuantity}</td>
                    <td data-label="Chưa được cấp">{line.waitlistedQuantity}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>Tổng</th>
                  <td>{decision.grantedQuantity}</td>
                  <td>{waitlisted}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {waitlisted > 0 ? (
          <p className="allocation-decision__hint">
            Phần chưa được cấp vẫn ở phiếu chờ theo chính sách hiện hành, không phụ thuộc phản hồi
            của phiếu này.
          </p>
        ) : null}
      </section>

      {carried.length > 0 || carriedHistory.length > 0 ? (
        <section aria-label="Hàng đã giữ từ phiên trước" className="allocation-decision__group">
          <h4>Hàng đã giữ từ phiên trước · {carriedQuantity} bao</h4>
          <p className="allocation-decision__hint">
            Đã cấp và được chấp nhận ở phiên trước, đi cùng chuyến giao này. Không cộng vào lượng
            cấp mới của phiên này.
          </p>
          <ul className="allocation-decision__carried">
            {decision.carried.map((row) => (
              <li key={row.reservationId}>
                <span>
                  {productName(row.productId)}: {row.quantity} bao
                </span>
                <small>
                  {row.reservationStatus === 'ACTIVE'
                    ? 'Đi cùng chuyến này'
                    : 'Đã tách khỏi chuyến bị hủy, vẫn giữ cho cửa hàng'}
                </small>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Tiến độ giao nhận" className="allocation-decision__progress">
        <PackageCheck aria-hidden="true" size={18} />
        <div>
          <strong>{shipmentProgressLabel(decision)}</strong>
          {shipment ? (
            <span>
              Phiếu xuất {shipment.requestNumber}
              {shipment.receiptNumber ? ` · Phiếu nhận ${shipment.receiptNumber}` : ''}
            </span>
          ) : null}
          {decision.respondedAt ? (
            <span>
              {decision.status === 'ACCEPTED' ? 'Chấp nhận' : 'Từ chối'} bởi{' '}
              {decision.respondedByName ?? 'tài khoản cửa hàng'} lúc{' '}
              {timeFormatter.format(new Date(decision.respondedAt))}
              {decision.reason ? ` · Lý do: ${decision.reason}` : ''}
            </span>
          ) : null}
          {decision.status === 'REJECTED' && decision.releasedQuantity > 0 ? (
            <span>{decision.releasedQuantity} bao đã được trả lại kho tổng.</span>
          ) : null}
        </div>
        {canReceive &&
        decision.status === 'ACCEPTED' &&
        shipment?.status === 'DISPATCHED' &&
        shipment.receiptStatus !== 'FINALIZED' ? (
          <Link className="button button--secondary" to="/receive">
            Khai nhận thực tế
          </Link>
        ) : null}
      </section>

      {success ? (
        <div className="inline-notice inline-notice--success" role="status">
          {success.message}
        </div>
      ) : null}
      {error ? (
        <div className="form-error" role="alert">
          {error.message}
        </div>
      ) : null}

      {decision.canRespond ? (
        <div className="allocation-decision__actions">
          <p>
            Chấp nhận là đồng ý nhận đúng kết quả trên; khi hàng đến, cửa hàng vẫn khai nhận đủ hoặc
            thiếu theo thực tế.
          </p>
          <div className="allocation-decision__buttons">
            <Button
              busy={busy === 'REJECT'}
              className="allocation-decision__reject"
              disabled={anyBusy}
              onClick={() => setConfirmingReject(true)}
              tone="secondary"
            >
              <XCircle aria-hidden="true" size={18} /> Từ chối
            </Button>
            <Button busy={busy === 'ACCEPT'} disabled={anyBusy} onClick={accept} tone="primary">
              <CheckCircle2 aria-hidden="true" size={18} /> Chấp nhận
            </Button>
          </div>
        </div>
      ) : null}

      {confirmingReject ? (
        <RejectDialog
          busy={busy === 'REJECT'}
          carriedQuantity={carriedQuantity}
          decision={decision}
          error={error?.message ?? null}
          onCancel={() => setConfirmingReject(false)}
          onConfirm={async (reason) => {
            const done = await responder.respond(decision, {
              action: 'REJECT',
              expectedVersion: decision.version,
              ...(reason ? { reason } : {}),
            });
            if (done) setConfirmingReject(false);
          }}
          productName={productName}
        />
      ) : null}
    </article>
  );
}

function RejectDialog({
  busy,
  carriedQuantity,
  decision,
  error,
  onCancel,
  onConfirm,
  productName,
}: {
  readonly busy: boolean;
  readonly carriedQuantity: number;
  readonly decision: AllocationDecision;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: (reason: string) => Promise<void>;
  readonly productName: (productId: string) => string;
}) {
  const dialogRef = useDialogAccessibility<HTMLFormElement>(busy ? undefined : onCancel);
  const titleId = useId();
  const [reason, setReason] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onConfirm(reason.trim());
  };
  return (
    <div className="dialog-backdrop">
      <form
        aria-labelledby={titleId}
        aria-modal="true"
        className="dialog allocation-decision-dialog"
        onSubmit={submit}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="dialog__header">
          <div>
            <h2 id={titleId}>Từ chối nhận phiếu {decisionCode(decision)}?</h2>
            <p>
              {decision.grantedQuantity} bao của phiếu này sẽ trả lại kho tổng và không được giao.
              Phiếu vẫn được lưu trong lịch sử với nhãn “đã từ chối nhận”.
            </p>
          </div>
          <button aria-label="Đóng hộp xác nhận" disabled={busy} onClick={onCancel} type="button">
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <ul className="allocation-decision__carried">
          {decision.lines
            .filter((line) => line.allocatedQuantity > 0)
            .map((line) => (
              <li key={line.productId}>
                <span>{productName(line.productId)}</span>
                <small>{line.allocatedQuantity} bao</small>
              </li>
            ))}
        </ul>
        {carriedQuantity > 0 ? (
          <p className="allocation-decision__hint">
            {carriedQuantity} bao hàng đã giữ từ phiên trước không bị hủy: vẫn được giữ cho cửa hàng
            và giao chung với đơn thường kế tiếp.
          </p>
        ) : null}
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
        <label className="allocation-decision-dialog__reason">
          <span className="field-label">Lý do (không bắt buộc)</span>
          <textarea
            disabled={busy}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            value={reason}
          />
        </label>
        <div className="dialog__actions">
          <Button data-dialog-initial-focus disabled={busy} onClick={onCancel} tone="secondary">
            Quay lại
          </Button>
          <Button busy={busy} tone="danger" type="submit">
            Xác nhận từ chối
          </Button>
        </div>
      </form>
    </div>
  );
}
