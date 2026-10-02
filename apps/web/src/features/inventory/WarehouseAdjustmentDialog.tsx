import {
  MAX_WAREHOUSE_ADJUSTMENT_BAGS,
  previewWarehouseStockAdjustment,
  type WarehouseAdjustmentDirection,
  type WarehouseAdjustmentReason,
  type WarehouseInventoryRow,
  type WarehouseStockAdjustment,
} from '@idosi/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useRef, useState } from 'react';

import { Button } from '../../components/Button';
import { ApiClientError } from '../../lib/api';
import { formatInteger } from '../../lib/format';
import { retainIdempotencyForExactRetry, type RetryAttempt } from '../../lib/idempotency-retry';
import { useDialogAccessibility } from '../../lib/use-dialog-accessibility';
import { createWarehouseAdjustment } from './inventoryApi';

export const warehouseAdjustmentReasonLabel: Record<WarehouseAdjustmentReason, string> = {
  COUNT_CORRECTION: 'Kiểm kê lệch số',
  DAMAGE: 'Hư hỏng, loại bỏ',
  RETURN: 'Hàng trả về kho',
  RECEIPT_CORRECTION: 'Sửa sai nhập kho',
  OUTBOUND_CORRECTION: 'Sửa sai xuất kho',
  OTHER: 'Lý do khác',
};

export interface AdjustmentDraft {
  readonly direction: WarehouseAdjustmentDirection;
  readonly quantity: string;
  readonly reasonCode: WarehouseAdjustmentReason;
  readonly reason: string;
}

export type AdjustmentDraftCheck =
  | {
      readonly ok: true;
      readonly quantity: number;
      readonly delta: number;
      readonly after: { onHand: number; reserved: number; available: number };
    }
  | { readonly ok: false; readonly message: string };

/** Client-side check of the draft; the server repeats every rule under the balance lock. */
export function checkAdjustmentDraft(
  row: Pick<
    WarehouseInventoryRow,
    'onHandBags' | 'reservedBags' | 'availableBags' | 'productActive'
  >,
  draft: AdjustmentDraft,
): AdjustmentDraftCheck {
  if (!/^\d+$/u.test(draft.quantity.trim())) {
    return { ok: false, message: 'Nhập số bao là số nguyên dương.' };
  }
  const quantity = Number(draft.quantity.trim());
  if (draft.direction === 'INCREASE' && !row.productActive) {
    return { ok: false, message: 'Mặt hàng đã ngừng kinh doanh; chỉ được giảm tồn.' };
  }
  const preview = previewWarehouseStockAdjustment(
    { onHand: row.onHandBags, reserved: row.reservedBags, available: row.availableBags },
    draft.direction,
    quantity,
  );
  if (!preview.ok) {
    return {
      ok: false,
      message:
        preview.reason === 'INVALID_QUANTITY'
          ? `Số bao phải từ 1 đến ${formatInteger(MAX_WAREHOUSE_ADJUSTMENT_BAGS)}.`
          : `Chỉ giảm được tối đa ${formatInteger(row.availableBags)} bao đang khả dụng; hàng đang giữ/chờ xuất không được giảm.`,
    };
  }
  if (draft.reason.trim().length < 3) {
    return { ok: false, message: 'Ghi lý do điều chỉnh tối thiểu 3 ký tự.' };
  }
  return { ok: true, quantity, delta: preview.delta, after: preview.after };
}

/** Write outcome a browser cannot know: the response was lost after the request left. */
export function isUnknownWriteOutcome(error: unknown): boolean {
  if (error instanceof ApiClientError) return error.code === 'NETWORK_ERROR' || error.status >= 500;
  return (
    error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

function adjustmentErrorMessage(error: unknown): string {
  if (isUnknownWriteOutcome(error)) {
    return 'Chưa xác định được kết quả vì mất phản hồi từ máy chủ. Bấm “Gửi lại đúng thao tác này” (giữ nguyên nội dung) để hệ thống trả lại kết quả cũ thay vì ghi thêm lần nữa, hoặc tải lại số liệu để kiểm tra.';
  }
  if (error instanceof ApiClientError) {
    const reference = error.requestId ? ` Mã yêu cầu: ${error.requestId}.` : '';
    return `${error.message}${reference}`;
  }
  return 'Không điều chỉnh được tồn kho vì phản hồi máy chủ không hợp lệ.';
}

export function WarehouseAdjustmentDialog({
  onClose,
  onDone,
  onReload,
  reloading,
  row,
}: {
  readonly onClose: () => void;
  readonly onDone: (adjustment: WarehouseStockAdjustment) => void;
  readonly onReload: () => void;
  readonly reloading: boolean;
  readonly row: WarehouseInventoryRow;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AdjustmentDraft>({
    direction: 'INCREASE',
    quantity: '',
    reasonCode: 'COUNT_CORRECTION',
    reason: '',
  });
  const [touched, setTouched] = useState(false);
  const attempt = useRef<RetryAttempt | null>(null);
  const titleId = `warehouse-adjustment-title-${row.productId}`;
  const check = checkAdjustmentDraft(row, draft);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!check.ok) throw new Error(check.message);
      const input = {
        productId: row.productId,
        direction: draft.direction,
        quantity: check.quantity,
        reasonCode: draft.reasonCode,
        reason: draft.reason.trim(),
        expectedVersion: row.balanceVersion,
      };
      // Same payload and same balance version → same key, so a retry replays on the server.
      attempt.current = retainIdempotencyForExactRetry(attempt.current, JSON.stringify(input));
      return createWarehouseAdjustment(input, attempt.current.key);
    },
    retry: false,
    onSuccess: async (adjustment) => {
      attempt.current = null;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['warehouse-inventory'] }),
        queryClient.invalidateQueries({ queryKey: ['warehouse-adjustments'] }),
        queryClient.invalidateQueries({ queryKey: ['warehouse-balances'] }),
      ]);
      onDone(adjustment);
    },
  });
  const busy = mutation.isPending;
  const dialogRef = useDialogAccessibility(busy ? undefined : onClose);
  const update = <Key extends keyof AdjustmentDraft>(key: Key, value: AdjustmentDraft[Key]) => {
    mutation.reset();
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const unknownOutcome = mutation.isError && isUnknownWriteOutcome(mutation.error);
  const conflict =
    mutation.error instanceof ApiClientError && mutation.error.code === 'VERSION_CONFLICT';
  const submit = () => {
    setTouched(true);
    if (!check.ok || busy) return;
    mutation.mutate();
  };
  const verb = draft.direction === 'INCREASE' ? 'tăng' : 'giảm';

  return (
    <div className="dialog-backdrop">
      <section
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-modal="true"
        className="dialog warehouse-adjustment-dialog"
        role="dialog"
        tabIndex={-1}
      >
        <div className="dialog__header">
          <div>
            <h2 id={titleId}>Điều chỉnh tồn kho tổng</h2>
            <p>
              {row.productName} · {row.sku} · đơn vị bao. Chỉ thay đổi số bao đang có tại kho; hàng
              đang giữ cho ưu tiên/phân bổ/chờ xuất không bị đổi.
            </p>
          </div>
          <button
            aria-label={`Đóng điều chỉnh tồn ${row.productName}`}
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <dl className="warehouse-adjustment-dialog__position" aria-label="Tồn hiện tại">
          <div>
            <dt>Đang có tại kho</dt>
            <dd>{formatInteger(row.onHandBags)} bao</dd>
          </div>
          <div>
            <dt>Đang giữ / chờ xuất</dt>
            <dd>{formatInteger(row.reservedBags)} bao</dd>
          </div>
          <div>
            <dt>Có thể xuất</dt>
            <dd>{formatInteger(row.availableBags)} bao</dd>
          </div>
        </dl>
        <fieldset className="warehouse-adjustment-dialog__direction" disabled={busy}>
          <legend className="field-label">Hướng điều chỉnh</legend>
          <label>
            <input
              checked={draft.direction === 'INCREASE'}
              disabled={!row.productActive}
              name={`direction-${row.productId}`}
              onChange={() => update('direction', 'INCREASE')}
              type="radio"
            />
            Tăng tồn
          </label>
          <label>
            <input
              checked={draft.direction === 'DECREASE'}
              name={`direction-${row.productId}`}
              onChange={() => update('direction', 'DECREASE')}
              type="radio"
            />
            Giảm tồn
          </label>
        </fieldset>
        <div className="warehouse-adjustment-dialog__fields">
          <label>
            <span className="field-label">Số bao {verb}</span>
            <input
              autoFocus
              disabled={busy}
              inputMode="numeric"
              max={MAX_WAREHOUSE_ADJUSTMENT_BAGS}
              min={1}
              onChange={(event) => update('quantity', event.target.value)}
              required
              step={1}
              type="number"
              value={draft.quantity}
            />
          </label>
          <label>
            <span className="field-label">Nhóm lý do</span>
            <select
              disabled={busy}
              onChange={(event) =>
                update('reasonCode', event.target.value as WarehouseAdjustmentReason)
              }
              value={draft.reasonCode}
            >
              {(Object.keys(warehouseAdjustmentReasonLabel) as WarehouseAdjustmentReason[]).map(
                (code) => (
                  <option key={code} value={code}>
                    {warehouseAdjustmentReasonLabel[code]}
                  </option>
                ),
              )}
            </select>
          </label>
          <label className="warehouse-adjustment-dialog__wide">
            <span className="field-label">Lý do chi tiết (bắt buộc)</span>
            <textarea
              disabled={busy}
              maxLength={500}
              minLength={3}
              onChange={(event) => update('reason', event.target.value)}
              placeholder="Ví dụ: kiểm kê ngày 02/10 thấy dư 3 bao trên kệ B2"
              required
              rows={3}
              value={draft.reason}
            />
          </label>
        </div>
        <section className="warehouse-adjustment-dialog__preview" aria-label="Xem trước điều chỉnh">
          <h3>Xem trước trước khi xác nhận</h3>
          {check.ok ? (
            <p>
              <span>Tồn trước {formatInteger(row.onHandBags)} bao</span>
              <span aria-hidden="true">→</span>
              <strong className={check.delta > 0 ? 'text-success' : 'text-danger'}>
                {check.delta > 0 ? '+' : '−'}
                {formatInteger(Math.abs(check.delta))} bao
              </strong>
              <span aria-hidden="true">→</span>
              <span>
                Tồn sau <strong>{formatInteger(check.after.onHand)} bao</strong> · khả dụng{' '}
                {formatInteger(check.after.available)} bao
              </span>
            </p>
          ) : (
            <p className={touched || draft.quantity !== '' ? 'form-error' : undefined}>
              {touched || draft.quantity !== ''
                ? check.message
                : 'Nhập số bao và lý do để xem trước.'}
            </p>
          )}
        </section>
        {mutation.isError ? (
          <div className="form-error" role="alert">
            <span>{adjustmentErrorMessage(mutation.error)}</span>
            {conflict || unknownOutcome ? (
              <Button busy={reloading} disabled={busy} onClick={onReload} tone="secondary">
                Tải lại số liệu tồn
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="dialog__actions">
          <Button disabled={busy} onClick={onClose} tone="secondary">
            Không điều chỉnh
          </Button>
          <Button
            busy={busy}
            disabled={!check.ok || reloading}
            onClick={submit}
            tone={draft.direction === 'DECREASE' ? 'danger' : 'primary'}
          >
            {unknownOutcome
              ? 'Gửi lại đúng thao tác này'
              : check.ok
                ? `Xác nhận ${verb} ${formatInteger(check.quantity)} bao`
                : `Xác nhận ${verb} tồn`}
          </Button>
        </div>
      </section>
    </div>
  );
}
