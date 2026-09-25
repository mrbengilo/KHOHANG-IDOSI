import type { AccountRole, Store, StoreBagOpening } from '@idosi/contracts';
import { useId, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { formatKgExact } from '../../lib/format';
import { useDialogAccessibility } from '../../lib/use-dialog-accessibility';
import { bagStatusCopy } from './bag-status';

const unknown = 'Chưa ghi nhận';
const roleLabels: Record<AccountRole, string> = {
  ADMIN: 'Quản trị',
  HTKD: 'HTKD',
  STORE: 'Cửa hàng',
  WHOLESALE: 'Cửa hàng sỉ',
};
const sourceLabels: Record<StoreBagOpening['source'], string> = {
  BUTTON: 'Xác nhận khui bán',
  SORTING: 'Mở do lọc hàng',
  TRANSFER: 'Mở do xuất chuyển',
  OUTBOUND: 'Mở do duyệt xuất hàng',
  IDOSI: 'Mở do đồng bộ IDOSI (legacy)',
  LEGACY: 'Chưa ghi nhận',
};
export { formatDocumentTime as formatOpeningTime } from '../../lib/business-time';
import { formatDocumentTime as formatOpeningTime } from '../../lib/business-time';
const weight = (value: string | null) => (value === null ? unknown : formatKgExact(value));
const storeLabel = (stores: readonly Store[], id: string) => {
  const store = stores.find((s) => s.id === id);
  return store ? `${store.code} · ${store.name}` : unknown;
};

export function BagOpeningHistoryTable({
  rows,
  stores,
  productName,
  showStore,
}: {
  readonly rows: readonly StoreBagOpening[];
  readonly stores: readonly Store[];
  readonly productName: (id: string | null) => string;
  readonly showStore: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rows.find((row) => row.id === selectedId);
  const noteId = useId();
  return (
    <div className="bag-opening-history">
      <p id={noteId} className="bag-opening-history__note">
        Khối lượng ngay trước khi khui. Trạng thái là trạng thái hiện tại của bao. Chọn mã bao để
        xem chi tiết.
      </p>
      <div
        className="bag-opening-history__scroll"
        role="region"
        aria-label="Bảng lịch sử khui kiện, cuộn ngang để xem đủ cột"
        tabIndex={0}
      >
        <table aria-label="Lịch sử khui kiện" aria-describedby={noteId}>
          <thead>
            <tr>
              <th scope="col">Thời gian khui</th>
              <th scope="col">Mã bao</th>
              <th scope="col">Mặt hàng</th>
              <th scope="col" className="bag-opening-history__weight">
                Khối lượng
              </th>
              <th scope="col">Người thực hiện</th>
              <th scope="col">Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <time dateTime={row.openedAt ?? undefined}>
                    {formatOpeningTime(row.openedAt)}
                  </time>
                </td>
                <td>
                  <button
                    className="bag-opening-history__code"
                    type="button"
                    aria-haspopup="dialog"
                    onClick={() => setSelectedId(row.id)}
                  >
                    {row.bagCode || unknown}
                  </button>
                  {showStore ? (
                    <small className="bag-opening-history__store">
                      {storeLabel(stores, row.storeId)}
                    </small>
                  ) : null}
                </td>
                <td>{productName(row.productId)}</td>
                <td className="bag-opening-history__weight">{weight(row.weightBeforeKg)}</td>
                <td>
                  <div className="bag-opening-history__actor">
                    <span>{row.actorDisplayName || unknown}</span>
                    <Badge tone={row.actorRole ? 'info' : 'neutral'}>
                      {row.actorRole ? roleLabels[row.actorRole] : unknown}
                    </Badge>
                  </div>
                </td>
                <td>
                  <Badge tone={bagStatusCopy[row.currentStatus].tone}>
                    {bagStatusCopy[row.currentStatus].label}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected ? (
        <OpeningDetails
          row={selected}
          store={storeLabel(stores, selected.storeId)}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  );
}

function OpeningDetails({
  row,
  store,
  onClose,
}: {
  readonly row: StoreBagOpening;
  readonly store: string;
  readonly onClose: () => void;
}) {
  const dialogRef = useDialogAccessibility(onClose);
  const titleId = useId();
  return (
    <div className="bag-opening-history__backdrop">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="bag-opening-history__details"
      >
        <h3 id={titleId}>Chi tiết khui · {row.bagCode || unknown}</h3>
        <dl>
          <dt>Cửa hàng</dt>
          <dd>{store}</dd>
          <dt>Thời gian khui</dt>
          <dd>{formatOpeningTime(row.openedAt)}</dd>
          <dt>Nguồn khui</dt>
          <dd>{sourceLabels[row.source]}</dd>
          <dt>Khối lượng trước khui</dt>
          <dd>{weight(row.weightBeforeKg)}</dd>
          <dt>Bù bán IDOSI</dt>
          <dd>{weight(row.normalSaleAppliedKg)}</dd>
          <dt>Khối lượng sau thao tác</dt>
          <dd>{weight(row.weightAfterKg)}</dd>
          <dt>Người thực hiện</dt>
          <dd>{row.actorDisplayName || unknown}</dd>
          <dt>Vai trò khi khui</dt>
          <dd>{row.actorRole ? roleLabels[row.actorRole] : unknown}</dd>
        </dl>
        <p>
          Tên người thực hiện và tên mặt hàng lấy từ danh mục hiện tại, không phải tên lưu tại thời
          điểm khui. Vai trò chỉ hiển thị khi có ghi nhận trong lịch sử thao tác.
        </p>
        <Button tone="secondary" onClick={onClose}>
          Đóng chi tiết
        </Button>
      </section>
    </div>
  );
}
