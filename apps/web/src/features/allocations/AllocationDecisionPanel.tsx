import type { AllocationDecision, AllocationDecisionDetail } from '@idosi/contracts';
import { CheckCircle2, PackageCheck, Undo2, X } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import {
  actionableLines,
  decisionActions,
  decisionCode,
  decisionStatusLabel,
  decisionStatusTone,
  reshareOrderLink,
  shipmentProgressLabel,
} from './allocationDecisionApi';
import type { useAllocationDecisionResponder } from './useAllocationDecisionResponder';
import { WaitlistConfirmDialog } from './WaitlistConfirmDialog';
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
  /** The viewer answers on the store's behalf (assigned HTKD), with its own audit identity. */
  readonly actingForStore?: boolean;
}

/** One published result: what was granted, carried goods, the store's answer and delivery. */
export function AllocationDecisionPanel({
  actingForStore = false,
  canReceive = false,
  decision,
  onClose,
  productName,
  responder,
  storeName,
}: AllocationDecisionPanelProps) {
  const headingId = useId();
  const [confirmingWaitlist, setConfirmingWaitlist] = useState(false);
  const busy = responder.busy?.decisionId === decision.id ? responder.busy.action : null;
  const anyBusy = responder.busy !== null;
  const error = responder.error?.decisionId === decision.id ? responder.error : null;
  const success = responder.success?.decisionId === decision.id ? responder.success : null;
  // Riding the shipment: still on-hand (ACTIVE) or issued with its own RE order (ISSUED).
  const riding = (status: string) => status === 'ACTIVE' || status === 'ISSUED';
  const carried = decision.carried.filter((row) => riding(row.reservationStatus));
  const carriedHistory = decision.carried.filter((row) => !riding(row.reservationStatus));
  const actions = decisionActions(decision);
  const reshareOrder = decision.reshareOrder ?? null;
  const carriedQuantity = carried.reduce((total, row) => total + row.quantity, 0);
  const waitlisted = decision.lines.reduce((total, line) => total + line.waitlistedQuantity, 0);
  const actionable = actionableLines(decision);
  const revocations = decision.revocations ?? [];
  const revoked = decision.revokedQuantity ?? 0;
  const actionableTotal = decision.actionableQuantity ?? decision.grantedQuantity;
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
          {reshareOrder ? (
            <Link
              aria-label={`Đã lập đơn Reshare, mở đơn ${reshareOrder.code}`}
              className="allocation-decision__reshare-tag"
              to={reshareOrderLink(reshareOrder.code)}
            >
              <Badge tone="success">Đã lập đơn Reshare · {reshareOrder.code}</Badge>
            </Link>
          ) : null}
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
                  {revoked > 0 ? <th>Đã thu hồi (bao)</th> : null}
                  {revoked > 0 ? <th>Còn hiệu lực (bao)</th> : null}
                  <th>Chưa được cấp (bao)</th>
                </tr>
              </thead>
              <tbody>
                {decision.lines.map((line) => {
                  const row = actionable.find((item) => item.productId === line.productId);
                  return (
                    <tr key={line.productId}>
                      <td data-label="Mặt hàng">{productName(line.productId)}</td>
                      <td data-label="Được cấp">
                        {row && row.revokedQuantity > 0 ? (
                          <s aria-label={`Cấp ban đầu ${line.allocatedQuantity} bao`}>
                            {line.allocatedQuantity}
                          </s>
                        ) : (
                          line.allocatedQuantity
                        )}
                      </td>
                      {revoked > 0 ? (
                        <td data-label="Đã thu hồi">{row?.revokedQuantity ?? 0}</td>
                      ) : null}
                      {revoked > 0 ? (
                        <td data-label="Còn hiệu lực">
                          <strong>{row?.actionableQuantity ?? line.allocatedQuantity}</strong>
                        </td>
                      ) : null}
                      <td data-label="Chưa được cấp">{line.waitlistedQuantity}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th>Tổng</th>
                  <td>{decision.grantedQuantity}</td>
                  {revoked > 0 ? <td>{revoked}</td> : null}
                  {revoked > 0 ? <td>{actionableTotal}</td> : null}
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

      {revocations.length > 0 ? (
        <section aria-label="Phần hàng đã thu hồi" className="allocation-decision__group">
          <h4>Phần hàng đã thu hồi · {revoked} bao</h4>
          <p className="allocation-decision__hint">
            Ảnh chụp phân bổ ban đầu giữ nguyên; các phần dưới đây đã trả lại kho tổng và không được
            xác nhận hay xuất kho.
          </p>
          <ul className="allocation-decision__carried">
            {revocations.map((row) => (
              <li key={row.allocationLineId}>
                <span>
                  <s>
                    {productName(row.productId)}: {row.quantity} bao
                  </s>
                </span>
                <small>
                  {row.kind === 'WAIT_TICKET_CANCELLED'
                    ? `Thu hồi do hủy phiếu chờ ${row.waitTicketCode ?? ''}`
                    : 'Chuyển về phiếu chờ'}
                  {row.actorName ? ` · ${row.actorName}` : ''} ·{' '}
                  {timeFormatter.format(new Date(row.createdAt))}
                </small>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {(decision.requeued ?? []).length > 0 ? (
        <section aria-label="Phiếu chờ nhận lại hàng" className="allocation-decision__group">
          <h4>Đã chuyển về phiếu chờ</h4>
          <ul className="allocation-decision__carried">
            {(decision.requeued ?? []).map((row) => (
              <li key={`${row.waitTicketId}:${row.mode}`}>
                <span>
                  {row.waitTicketCode} · {productName(row.productId)}
                </span>
                <small>
                  {row.mode === 'RESTORE_SOURCE'
                    ? `${row.quantity} bao trở lại phần còn chờ của chính phiếu`
                    : row.createdTicket
                      ? `Tạo phiếu chờ mới ${row.quantity} bao`
                      : `Cộng thêm ${row.quantity} bao vào phiếu chờ đang có`}
                </small>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
                  {row.reservationStatus === 'ISSUED'
                    ? 'Đi cùng chuyến này (đã xuất kho theo đơn RE của phiên trước)'
                    : row.reservationStatus === 'ACTIVE'
                      ? 'Đi cùng chuyến này'
                      : row.reservationStatus === 'CANCELLED'
                        ? 'Đã tách khỏi chuyến bị hủy, vẫn giữ cho cửa hàng'
                        : row.reservationStatus === 'CONSUMED'
                          ? 'Đã xử lý theo thực nhận'
                          : 'Đã giải phóng phần giữ hàng'}
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
          {reshareOrder ? (
            <span>
              Đã xuất {reshareOrder.totalQuantity} bao khỏi kho tổng theo đơn {reshareOrder.code}{' '}
              lúc {timeFormatter.format(new Date(reshareOrder.orderedAt))}. Xuất kho không phải đã
              nhận: tồn cửa hàng chỉ tăng khi phiếu nhận được duyệt.
            </span>
          ) : null}
          {decision.respondedAt ? (
            <span>
              {decision.status === 'ACCEPTED'
                ? 'Xác nhận phân bổ'
                : decision.status === 'WAITLISTED'
                  ? 'Chuyển phiếu chờ'
                  : 'Từ chối'}{' '}
              bởi {decision.respondedByName ?? 'tài khoản cửa hàng'} lúc{' '}
              {timeFormatter.format(new Date(decision.respondedAt))}
              {decision.reason ? ` · Lý do: ${decision.reason}` : ''}
            </span>
          ) : null}
          {(decision.status === 'REJECTED' || decision.status === 'WAITLISTED') &&
          decision.releasedQuantity > 0 ? (
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

      {actions.length > 0 ? (
        <div className="allocation-decision__actions">
          <p>
            {actingForStore ? 'Bạn thao tác thay cửa hàng được phân công. ' : ''}
            “Xác nhận phân bổ” tự tạo đơn đặt Reshare (mã RE) đúng các mặt hàng và số bao còn hiệu
            lực ({actionableTotal} bao), đồng thời xuất số hàng này khỏi kho tổng IDOSI. “Chuyển
            phiếu chờ” trả hàng về kho và đưa nhu cầu trở lại phiếu chờ.
          </p>
          <div className="allocation-decision__buttons">
            {actions.includes('WAITLIST') ? (
              <Button
                busy={busy === 'WAITLIST'}
                disabled={anyBusy}
                onClick={() => setConfirmingWaitlist(true)}
                tone="secondary"
              >
                <Undo2 aria-hidden="true" size={18} /> Chuyển phiếu chờ
              </Button>
            ) : null}
            {actions.includes('ACCEPT') ? (
              <Button busy={busy === 'ACCEPT'} disabled={anyBusy} onClick={accept} tone="primary">
                <CheckCircle2 aria-hidden="true" size={18} /> Xác nhận phân bổ
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {confirmingWaitlist ? (
        <WaitlistConfirmDialog
          busy={busy === 'WAITLIST'}
          decision={decision}
          error={error?.message ?? null}
          onCancel={() => setConfirmingWaitlist(false)}
          onConfirm={async () => {
            const done = await responder.respond(decision, {
              action: 'WAITLIST',
              expectedVersion: decision.version,
            });
            if (done) setConfirmingWaitlist(false);
          }}
          productName={productName}
        />
      ) : null}
    </article>
  );
}
