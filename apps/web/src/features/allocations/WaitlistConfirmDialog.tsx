import type { AllocationDecision } from '@idosi/contracts';
import { X } from 'lucide-react';
import { useId } from 'react';

import { Button } from '../../components/Button';
import { useDialogAccessibility } from '../../lib/use-dialog-accessibility';
import { actionableLines, decisionCode } from './allocationDecisionApi';

/**
 * Confirmation of "Chuyển phiếu chờ": names the result and exactly the bags that go back to the
 * warehouse and wait again. Nothing is sent before the account confirms.
 */
export function WaitlistConfirmDialog({
  busy,
  decision,
  error,
  onCancel,
  onConfirm,
  productName,
}: {
  readonly busy: boolean;
  readonly decision: AllocationDecision;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly productName: (productId: string) => string;
}) {
  const dialogRef = useDialogAccessibility<HTMLElement>(busy ? undefined : onCancel);
  const titleId = useId();
  const lines = actionableLines(decision).filter((line) => line.actionableQuantity > 0);
  const total = lines.reduce((sum, line) => sum + line.actionableQuantity, 0);
  const carried = decision.carried.filter(
    (row) => row.reservationStatus === 'ACTIVE' || row.reservationStatus === 'ISSUED',
  );
  const carriedQuantity = carried.reduce((sum, row) => sum + row.quantity, 0);
  return (
    <div className="dialog-backdrop">
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="dialog allocation-decision-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="dialog__header">
          <div>
            <h2 id={titleId}>Chuyển phiếu {decisionCode(decision)} về phiếu chờ?</h2>
            <p>
              {total} bao còn hiệu lực sẽ trả lại kho tổng (không tạo đơn RE, không xuất kho) và
              được cộng vào phiếu chờ đang có của từng mặt hàng, hoặc tạo phiếu chờ mới. Phần chưa
              được cấp của phiên đã ở phiếu chờ và không bị cộng thêm lần nữa.
            </p>
          </div>
          <button aria-label="Đóng hộp xác nhận" disabled={busy} onClick={onCancel} type="button">
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <ul className="allocation-decision__carried">
          {lines.map((line) => (
            <li key={line.productId}>
              <span>{productName(line.productId)}</span>
              <small>{line.actionableQuantity} bao chuyển về phiếu chờ</small>
            </li>
          ))}
        </ul>
        {carriedQuantity > 0 ? (
          <p className="allocation-decision__hint">
            {carriedQuantity} bao hàng đã xác nhận từ phiên trước không bị ảnh hưởng: vẫn giữ cho
            cửa hàng và giao chung với đơn thường kế tiếp.
          </p>
        ) : null}
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="dialog__actions">
          <Button data-dialog-initial-focus disabled={busy} onClick={onCancel} tone="secondary">
            Quay lại
          </Button>
          <Button busy={busy} onClick={onConfirm} tone="primary">
            Xác nhận chuyển phiếu chờ
          </Button>
        </div>
      </section>
    </div>
  );
}
