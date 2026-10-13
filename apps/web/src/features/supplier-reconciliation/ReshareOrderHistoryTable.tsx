import type { ReshareOrderHistoryRow, ReshareOrderHistoryStatus } from '@idosi/contracts';
import { Link } from 'react-router-dom';

import { Badge } from '../../components/Badge';
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
    return row.decisionStatus === 'PENDING'
      ? 'Chờ cửa hàng/HTKD xác nhận kết quả phân bổ.'
      : 'Kết quả đã chấp nhận trước khi có đơn RE: chưa đủ căn cứ lập đơn.';
  }
  const parts: string[] = [];
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
 * the order total once. Desktop: a grouped table; narrow screens: one card per order.
 */
export function ReshareOrderHistoryTable({
  rows,
  caption,
}: {
  readonly rows: readonly ReshareOrderHistoryRow[];
  readonly caption: string;
}) {
  return (
    <>
      <div className="responsive-table reshare-history reshare-history__table">
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
                  <td rowSpan={span}>
                    <SessionCell row={row} />
                  </td>
                  <td rowSpan={span}>
                    <CodeCell row={row} />
                  </td>
                  <td rowSpan={span}>{row.storeName}</td>
                  <td className="reshare-history__product">{first ? first.productName : '—'}</td>
                  <td className="reshare-history__number">
                    {first ? formatInteger(first.quantity) : '—'}
                  </td>
                  <td rowSpan={span} className="reshare-history__number">
                    <strong>{formatInteger(row.totalQuantity)}</strong>
                  </td>
                  <td rowSpan={span}>
                    <StatusCell row={row} />
                  </td>
                </tr>
                {rest.map((line) => (
                  <tr key={line.productId}>
                    <td className="reshare-history__product">{line.productName}</td>
                    <td className="reshare-history__number">{formatInteger(line.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table>
      </div>
      <ul className="reshare-history__cards" aria-label={caption}>
        {rows.map((row) => (
          <li key={row.decisionId} className="reshare-history__card">
            <div className="reshare-history__card-head">
              <span className="reshare-history__card-code">{row.order?.code ?? '—'}</span>
              <Badge tone={RESHARE_STATUS_TONE[row.status]}>
                {RESHARE_STATUS_LABEL[row.status]}
              </Badge>
            </div>
            <p className="reshare-history__card-store">{row.storeName}</p>
            <dl className="reshare-history__card-meta">
              <div>
                <dt>Mã phiên phân bổ</dt>
                <dd>
                  <SessionCell row={row} />
                </dd>
              </div>
            </dl>
            <table className="reshare-history__card-lines">
              <thead>
                <tr>
                  <th scope="col">Mặt hàng</th>
                  <th scope="col">Số lượng (bao)</th>
                </tr>
              </thead>
              <tbody>
                {row.lines.map((line) => (
                  <tr key={line.productId}>
                    <td>{line.productName}</td>
                    <td>{formatInteger(line.quantity)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Tổng số lượng (bao)</th>
                  <td>{formatInteger(row.totalQuantity)}</td>
                </tr>
              </tfoot>
            </table>
            <p className="reshare-history__card-note">{reshareStatusNote(row)}</p>
            <Link to={`/allocations?decision=${encodeURIComponent(row.decisionId)}`}>
              Xem phiếu kết quả
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
