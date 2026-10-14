import type { ReshareOrderHistoryRow, ReshareOrderHistoryStatus } from '@idosi/contracts';
import { Link } from 'react-router-dom';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { formatDocumentTime } from '../../lib/business-time';
import { formatInteger } from '../../lib/format';
import type { StatusTone } from '../../lib/types';

export const RESHARE_STATUS_LABEL: Record<ReshareOrderHistoryStatus, string> = {
  ORDERED: 'Đã đặt Reshare',
  NOT_ORDERED: 'Chưa đặt Reshare',
  CANCELLED: 'Hủy',
};

export const RESHARE_STATUS_TONE: Record<ReshareOrderHistoryStatus, StatusTone> = {
  ORDERED: 'success',
  NOT_ORDERED: 'warning',
  CANCELLED: 'danger',
};

const ROLE_LABEL: Record<NonNullable<ReshareOrderHistoryRow['order']>['actorRole'], string> = {
  STORE: 'cửa hàng',
  WHOLESALE: 'quầy sỉ',
  HTKD: 'HTKD',
  ADMIN: 'Admin',
};

/** Why the status reads as it does; delivery facts stay apart from the order status. */
export function reshareStatusNote(row: ReshareOrderHistoryRow): string {
  if (row.status === 'CANCELLED') {
    return row.order?.cancelReason ? `Lý do hủy: ${row.order.cancelReason}` : 'Đơn đã hủy.';
  }
  if (row.status === 'NOT_ORDERED') {
    if (row.statusControl?.updatedAt) return adminStatusNote(row);
    return row.decisionStatus === 'PENDING'
      ? 'Chờ cửa hàng/HTKD xác nhận kết quả phân bổ.'
      : 'Kết quả đã chấp nhận trước khi có đơn RE: chưa đủ căn cứ lập đơn.';
  }
  const parts: string[] = [];
  if (row.statusControl?.updatedAt) parts.push(adminStatusNote(row));
  if (row.order) {
    parts.push(
      `Lập lúc ${formatDocumentTime(row.order.orderedAt)}${
        row.order.actorName
          ? ` bởi ${row.order.actorName} (${ROLE_LABEL[row.order.actorRole]})`
          : ''
      }`,
    );
  }
  if (row.delivery) {
    parts.push(`Đã xuất kho ${formatInteger(row.delivery.issuedQuantity)} bao`);
    if (row.delivery.receivedQuantity > 0) {
      parts.push(`đã nhận ${formatInteger(row.delivery.receivedQuantity)}`);
    }
    if (row.delivery.shortageQuantity > 0) {
      parts.push(`thiếu ${formatInteger(row.delivery.shortageQuantity)} đang xử lý`);
    }
    if (row.delivery.awaitingReceiptQuantity > 0) {
      parts.push(
        row.delivery.onShipmentQuantity > 0
          ? `chờ nhận ${formatInteger(row.delivery.awaitingReceiptQuantity)}`
          : `chờ ghép chuyến ${formatInteger(row.delivery.awaitingReceiptQuantity)}`,
      );
    }
  }
  return parts.join(' · ');
}

/** Last acknowledgement: the person and the role recorded with it (never assumed Admin). */
function adminStatusNote(row: ReshareOrderHistoryRow): string {
  const role = row.statusControl?.updatedByRole;
  const who = [
    row.statusControl?.updatedByName ?? 'Chưa ghi nhận tên',
    role ? `(${ROLE_LABEL[role]})` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `Cập nhật lần cuối bởi ${who} lúc ${formatDocumentTime(row.statusControl?.updatedAt ?? null)}.${row.order ? '' : ' Chưa có chứng từ RE.'}${row.decisionStatus === 'PENDING' ? ' Cửa hàng/HTKD chưa xác nhận kết quả phân bổ.' : ''}`;
}

function SessionCell({ row }: { readonly row: ReshareOrderHistoryRow }) {
  return (
    <>
      <strong>{row.sessionCode}</strong>
      <small>Mở phiên: {formatDocumentTime(row.sessionOpenedAt)}</small>
      <small>Hoàn tất phân bổ: {formatDocumentTime(row.allocationCompletedAt)}</small>
      {row.acceptedAt ? <small>Xác nhận: {formatDocumentTime(row.acceptedAt)}</small> : null}
    </>
  );
}

function CodeCell({ row }: { readonly row: ReshareOrderHistoryRow }) {
  return (
    <>
      {row.order ? <strong className="reshare-history__code">{row.order.code}</strong> : '—'}
      <small>
        <Link to={`/allocations?decision=${encodeURIComponent(row.decisionId)}`}>
          Xem phiếu kết quả
        </Link>
      </small>
    </>
  );
}

function StatusCell({ row }: { readonly row: ReshareOrderHistoryRow }) {
  const note = reshareStatusNote(row);
  return (
    <>
      <Badge tone={RESHARE_STATUS_TONE[row.status]}>{RESHARE_STATUS_LABEL[row.status]}</Badge>
      {note ? <small>{note}</small> : null}
    </>
  );
}

/**
 * "Lịch sử đặt hàng theo phân bổ": one group per result (one RE order), one line per product,
 * the order total once. Narrow screens render the same table as one card per order (CSS only),
 * so every viewport shows the same records.
 */
export function ReshareOrderHistoryTable({
  rows,
  caption,
  onChangeStatus,
  onShowHistory,
  busyDecisionId,
  disabled = false,
}: {
  readonly rows: readonly ReshareOrderHistoryRow[];
  readonly caption: string;
  readonly onChangeStatus?: (row: ReshareOrderHistoryRow) => void;
  /** Opens "Lịch sử thay đổi" of the row; its data loads only then. */
  readonly onShowHistory?: (row: ReshareOrderHistoryRow) => void;
  readonly busyDecisionId?: string | null;
  readonly disabled?: boolean;
}) {
  return (
    <div className="responsive-table reshare-history">
      <table className="supplier-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Mã phiên phân bổ</th>
            <th scope="col">Mã đặt hàng Reshare</th>
            <th scope="col">Tên cửa hàng</th>
            <th scope="col">Mặt hàng</th>
            <th scope="col">Số lượng (bao)</th>
            <th scope="col">Tổng số lượng (bao)</th>
            <th scope="col">Trạng thái</th>
          </tr>
        </thead>
        {rows.map((row) => {
          const span = Math.max(1, row.lines.length);
          const [first, ...rest] = row.lines;
          return (
            <tbody key={row.decisionId} className="reshare-history__group">
              <tr>
                <td rowSpan={span} className="reshare-history__session" data-label="Mã phiên">
                  <SessionCell row={row} />
                </td>
                <td rowSpan={span} className="reshare-history__order" data-label="Mã đặt hàng">
                  <CodeCell row={row} />
                </td>
                <td rowSpan={span} className="reshare-history__store" data-label="Cửa hàng">
                  {row.storeName}
                </td>
                <td className="reshare-history__product" data-label="Mặt hàng">
                  {first ? first.productName : '—'}
                </td>
                <td className="reshare-history__number reshare-history__line" data-label="Số bao">
                  {first ? formatInteger(first.quantity) : '—'}
                </td>
                <td
                  rowSpan={span}
                  className="reshare-history__number reshare-history__total"
                  data-label="Tổng số bao"
                >
                  <strong>{formatInteger(row.totalQuantity)}</strong>
                </td>
                <td rowSpan={span} className="reshare-history__status" data-label="Trạng thái">
                  <StatusCell row={row} />
                  {onChangeStatus &&
                  row.status !== 'CANCELLED' &&
                  row.statusControl &&
                  row.totalQuantity > 0 ? (
                    <Button
                      className="reshare-history__status-button"
                      tone={row.status === 'ORDERED' ? 'secondary' : 'primary'}
                      busy={busyDecisionId === row.decisionId}
                      disabled={disabled || Boolean(busyDecisionId)}
                      onClick={() => onChangeStatus(row)}
                    >
                      {row.status === 'ORDERED' ? 'Đánh dấu chưa đặt' : 'Đánh dấu đã đặt'}
                    </Button>
                  ) : null}
                  {onShowHistory ? (
                    <Button
                      aria-label={`Lịch sử thay đổi của ${row.order?.code ?? row.sessionCode} · ${row.storeName}`}
                      className="reshare-history__history-button"
                      onClick={() => onShowHistory(row)}
                      tone="secondary"
                    >
                      Lịch sử thay đổi
                    </Button>
                  ) : null}
                </td>
              </tr>
              {rest.map((line) => (
                <tr key={line.productId}>
                  <td className="reshare-history__product" data-label="Mặt hàng">
                    {line.productName}
                  </td>
                  <td className="reshare-history__number reshare-history__line" data-label="Số bao">
                    {formatInteger(line.quantity)}
                  </td>
                </tr>
              ))}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
