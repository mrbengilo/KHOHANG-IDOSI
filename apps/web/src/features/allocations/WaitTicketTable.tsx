import type { WaitTicket } from '@idosi/contracts';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import {
  amountLabel,
  CancellationNote,
  ticketStatusLabel,
} from '../../components/WaitTicketPresentation';
import './wait-ticket-list.css';

export function waitTicketTime(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date(value))
    .replace(',', '');
}

export function WaitTicketTable({
  tickets,
  offset,
  onHistory,
  onCancel,
}: {
  readonly tickets: readonly WaitTicket[];
  readonly offset: number;
  readonly onHistory: (id: string) => void;
  readonly onCancel: (ticket: WaitTicket) => void;
}) {
  return (
    <div
      className="wait-ticket-table-scroll"
      tabIndex={0}
      role="region"
      aria-label="Danh sách phiếu chờ, cuộn ngang để xem đủ cột"
    >
      <table className="table-density wait-ticket-table">
        <thead>
          <tr>
            {[
              'STT',
              'Thời gian',
              'Mã phiếu ưu tiên',
              'Tên cửa hàng',
              'Mặt hàng',
              'Số lượng (bao)',
              'Trạng thái',
              'Thao tác',
              'Ghi chú',
            ].map((label) => (
              <th key={label}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket, index) => (
            <tr key={ticket.id}>
              <td>{offset + index + 1}</td>
              <td>
                <time dateTime={ticket.createdAt}>{waitTicketTime(ticket.createdAt)}</time>
              </td>
              <td>
                <strong>{ticket.latestOffer?.code ?? 'Chưa phát sinh phiếu ưu tiên'}</strong>
                <small>{ticket.code ?? ticket.id}</small>
              </td>
              <td>{ticket.storeName ?? ticket.storeId}</td>
              <td>
                <strong>{ticket.productName ?? ticket.productId}</strong>
                <small>{ticket.sku ?? ticket.productId}</small>
              </td>
              <td>
                {amountLabel(ticket.remaining)}
                {ticket.remaining.kind !== 'UNIT' ? (
                  <small>Đơn vị gốc; không quy đổi sang bao</small>
                ) : null}
              </td>
              <td>
                <Badge
                  tone={
                    ticket.status === 'CANCELLED'
                      ? 'danger'
                      : ticket.status === 'FULFILLED'
                        ? 'success'
                        : 'info'
                  }
                >
                  {ticketStatusLabel[ticket.status]}
                </Badge>
              </td>
              <td>
                <div className="wait-ticket-actions">
                  <Button tone="secondary" onClick={() => onHistory(ticket.id)}>
                    Xem chi tiết / lịch sử
                  </Button>
                  {['WAITING', 'OFFERED', 'PARTIALLY_FULFILLED'].includes(ticket.status) ? (
                    <Button tone="danger" onClick={() => onCancel(ticket)}>
                      Hủy phiếu chờ
                    </Button>
                  ) : null}
                </div>
              </td>
              <td>
                {ticket.status === 'CANCELLED' ? (
                  <>
                    <CancellationNote ticket={ticket} />
                    <small>
                      {ticket.cancellationActor
                        ? ticket.cancellationActor.role
                          ? `${ticket.cancellationActor.role} · ${ticket.cancellationActor.accountId ?? ''}`
                          : 'Hệ thống'
                        : 'Chưa ghi nhận người thực hiện'}
                    </small>
                  </>
                ) : null}
                {ticket.latestOffer ? (
                  <small>
                    {ticket.latestOffer.sessionCode ??
                      ticket.latestOffer.sessionId ??
                      'Phiên cũ chưa ghi nhận'}{' '}
                    · hạn {waitTicketTime(ticket.latestOffer.deadline)}
                    {['pending', 'PENDING', 'offered'].includes(ticket.latestOffer.status) &&
                    new Date(ticket.latestOffer.deadline).getTime() <= Date.now()
                      ? ' · Lượt đã hết hạn/chờ hệ thống xử lý'
                      : ['expired', 'EXPIRED'].includes(ticket.latestOffer.status)
                        ? ' · Lượt ưu tiên đã hết hạn'
                        : ['declined', 'DECLINED'].includes(ticket.latestOffer.status)
                          ? ' · Lượt ưu tiên đã từ chối'
                          : ''}
                  </small>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
