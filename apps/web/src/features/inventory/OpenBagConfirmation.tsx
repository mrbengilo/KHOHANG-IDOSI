import type { StoreInventoryBag } from '@idosi/contracts';
import { Button } from '../../components/Button';
import { formatKg } from '../../lib/format';

export function isOpenBagSelectionCurrent(
  selected: StoreInventoryBag,
  current: StoreInventoryBag | undefined,
  principalStoreId: string,
): boolean {
  return Boolean(
    principalStoreId &&
    current &&
    selected.id === current.id &&
    selected.storeId === principalStoreId &&
    current.storeId === principalStoreId &&
    selected.version === current.version &&
    selected.remainingWeightKg === current.remainingWeightKg &&
    selected.status === 'AVAILABLE' &&
    current.status === 'AVAILABLE',
  );
}

export function OpenBagConfirmation({
  bag,
  busy,
  canConfirm,
  onCancel,
  onConfirm,
}: {
  readonly bag: StoreInventoryBag;
  readonly busy: boolean;
  readonly canConfirm: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <section className="open-bag-preview" aria-label={`Kiểm tra bao ${bag.bagCode}`}>
      <h3>Kiểm tra trước khi khui</h3>
      <p>Thao tác áp dụng cho bao {bag.bagCode}.</p>
      <dl>
        <div>
          <dt>Trước khi khui</dt>
          <dd>Chưa khui · 1 bao · {formatKg(bag.remainingWeightKg)}</dd>
        </div>
        <div>
          <dt>Sau khi khui</dt>
          <dd>Đang bán tại CH · 1 bao · {formatKg(bag.remainingWeightKg)}</dd>
        </div>
      </dl>
      <p>Tồn chưa khui giảm 1 bao, tồn đang bán tăng 1 bao. Tổng kg và giá vốn không đổi.</p>
      {!canConfirm && !busy ? (
        <p role="alert">
          Dữ liệu đã thay đổi hoặc đang được tải lại. Hãy kiểm tra và chọn lại bao trước khi xác
          nhận.
        </p>
      ) : null}
      <div className="inventory-actions">
        <Button tone="secondary" disabled={busy} onClick={onCancel}>
          Bỏ chọn
        </Button>
        <Button busy={busy} disabled={!canConfirm} onClick={onConfirm}>
          Khui 1 bao
        </Button>
      </div>
    </section>
  );
}
