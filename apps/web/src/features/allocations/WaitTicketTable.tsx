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

export const displayStatusLabel: Record<
  NonNullable<WaitTicket['lineage']>['displayStatus'],
  string
> = {
  UNPROCESSED: 'Chưa xử lý',
  PROCESSED: 'Đã xử lý',
  CANCELLED: 'Đã hủy',
};

export const displayDetailLabel: Record<
  NonNullable<WaitTicket['lineage']>['displayDetail'],
  string
> = {
  WAITING: 'Đang chờ hàng',
  OFFERED: 'Đang có lượt ưu tiên chờ phản hồi',
  PARTIALLY_FULFILLED: 'Đã cấp một phần, phần còn lại đang chờ',
  PENDING_DECISION: 'Đã phân bổ, chờ xác nhận kết quả',
  PROCESSED: 'Không còn phần chờ (chưa phải đã nhận hàng)',
  CANCELLED: 'Nhu cầu đã hủy',
  EXPIRED_LEGACY: 'Hết hạn · dữ liệu cũ cần đối chiếu',
};

function canCancelTicket(ticket: WaitTicket): boolean {
  return ticket.lineage
    ? ticket.lineage.canCancel
    : ['WAITING', 'OFFERED', 'PARTIALLY_FULFILLED'].includes(ticket.status);
}

export function WaitTicketTable({
  tickets,
  offset,
  onHistory,
  onCancel,
  variant = 'admin',
  showStore = true,
}: {
  readonly tickets: readonly WaitTicket[];
  readonly offset: number;
  readonly onHistory: (id: string) => void;
  readonly onCancel: (ticket: WaitTicket) => void;
  readonly variant?: 'admin' | 'scoped';
  readonly showStore?: boolean;
}) {
  if (variant === 'scoped') {
    return (
      <ScopedWaitTicketTable
        onCancel={onCancel}
        onHistory={onHistory}
        showStore={showStore}
        tickets={tickets}
      />
    );
  }
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
                  {canCancelTicket(ticket) ? (
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

/**
 * HTKD, store and wholesale list: one row per PC ticket (paged by ticket on the server), its
 * proven sessions, bags, and the three labels. Admin keeps its own 9-column table above.
 */
function ScopedWaitTicketTable({
  tickets,
  onHistory,
  onCancel,
  showStore,
}: {
  readonly tickets: readonly WaitTicket[];
  readonly onHistory: (id: string) => void;
  readonly onCancel: (ticket: WaitTicket) => void;
  readonly showStore: boolean;
}) {
  const headers = [
    'Mã phiếu chờ',
    ...(showStore ? ['Cửa hàng'] : []),
    'Phiên phân bổ',
    'Mặt hàng',
    'Số lượng (bao)',
    'Trạng thái',
    'Thao tác',
  ];
  return (
    <div
      className="wait-ticket-table-scroll"
      tabIndex={0}
      role="region"
      aria-label="Phiếu chờ ưu tiên, cuộn ngang để xem đủ cột"
    >
      <table className="table-density wait-ticket-table wait-ticket-table--scoped">
        <thead>
          <tr>
            {headers.map((label) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket) => {
            const lineage = ticket.lineage;
            const display = lineage?.displayStatus;
            const sessions = lineage?.sessions ?? [];
            const origin = sessions.find((session) => session.origin) ?? sessions[0];
            const unit = ticket.remaining.kind === 'UNIT';
            const fulfilled = ticket.fulfilled.kind === 'UNIT' ? ticket.fulfilled.quantity : 0;
            return (
              <tr key={ticket.id}>
                <td data-label="Mã phiếu chờ">
                  <strong className="wait-ticket-code">{ticket.code ?? 'PC chưa có mã'}</strong>
                  <small>
                    Chờ từ:{' '}
                    <time dateTime={lineage?.waitingSince ?? ticket.createdAt}>
                      {waitTicketTime(lineage?.waitingSince ?? ticket.createdAt)}
                    </time>
                  </small>
                  {ticket.updatedAt !== ticket.createdAt ? (
                    <small>
                      Cập nhật:{' '}
                      <time dateTime={ticket.updatedAt}>{waitTicketTime(ticket.updatedAt)}</time>
                    </small>
                  ) : null}
                </td>
                {showStore ? (
                  <td data-label="Cửa hàng">{ticket.storeName ?? ticket.storeId}</td>
                ) : null}
                <td data-label="Phiên phân bổ">
                  {origin ? (
                    <>
                      <strong>{origin.sessionCode}</strong>
                      <small>
                        {origin.sessionAt
                          ? waitTicketTime(origin.sessionAt)
                          : `Ngày ${origin.businessDate}`}
                      </small>
                    </>
                  ) : (
                    <small>Chưa ghi nhận phiên</small>
                  )}
                  {sessions.length > 1 ? (
                    <details>
                      <summary>{sessions.length} phiên · xem nguồn</summary>
                      <ul className="wait-ticket-sources">
                        {sessions.map((session) => (
                          <li key={session.sessionId}>
                            {session.sessionCode}
                            {session.origin ? ' (mở phiếu)' : ''}
                            {session.quantity !== null ? ` · +${session.quantity} bao` : ''}
                          </li>
                        ))}
                        {(lineage?.sources ?? []).map((source) => (
                          <li key={source.id}>
                            {source.kind === 'RESULT_RESTORED'
                              ? 'Hoàn chờ'
                              : source.kind === 'RESULT_WAITLISTED'
                                ? 'Chuyển chờ'
                                : 'Phần chưa cấp'}{' '}
                            {source.quantity} bao · {source.sessionCode ?? 'phiên ?'} ·{' '}
                            {waitTicketTime(source.createdAt)}
                            {source.actorName ? ` · ${source.actorName}` : ''}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {lineage && lineage.legacyUnsourcedQuantity > 0 ? (
                    <small>Dữ liệu cũ cần đối chiếu ({lineage.legacyUnsourcedQuantity} bao)</small>
                  ) : null}
                </td>
                <td data-label="Mặt hàng">
                  <strong>{ticket.productName ?? ticket.productId}</strong>
                  {ticket.sku ? <small>{ticket.sku}</small> : null}
                </td>
                <td data-label="Số lượng (bao)">
                  <strong>
                    {ticket.status === 'CANCELLED' ? 'Đã hủy ' : 'Còn chờ '}
                    {amountLabel(ticket.remaining)}
                  </strong>
                  {unit && fulfilled > 0 ? (
                    <small>
                      Đã phân bổ {amountLabel(ticket.fulfilled)} / Còn chờ{' '}
                      {ticket.status === 'CANCELLED' ? '0 bao' : amountLabel(ticket.remaining)}
                    </small>
                  ) : null}
                  {lineage && lineage.pendingDecisionQuantity > 0 ? (
                    <small>{lineage.pendingDecisionQuantity} bao chờ xác nhận kết quả</small>
                  ) : null}
                  {lineage && lineage.revokedQuantity > 0 ? (
                    <small>{lineage.revokedQuantity} bao đã thu hồi khỏi kết quả</small>
                  ) : null}
                  {!unit ? <small>Đơn vị gốc; không quy đổi sang bao</small> : null}
                </td>
                <td data-label="Trạng thái">
                  <Badge
                    tone={
                      display === 'CANCELLED'
                        ? 'danger'
                        : display === 'PROCESSED'
                          ? 'success'
                          : 'info'
                    }
                  >
                    {display ? displayStatusLabel[display] : ticketStatusLabel[ticket.status]}
                  </Badge>
                  {lineage ? <small>{displayDetailLabel[lineage.displayDetail]}</small> : null}
                  {ticket.status === 'CANCELLED' ? <CancellationNote ticket={ticket} /> : null}
                </td>
                <td data-label="Thao tác">
                  <div className="wait-ticket-actions">
                    <Button tone="secondary" onClick={() => onHistory(ticket.id)}>
                      Xem chi tiết
                    </Button>
                    {canCancelTicket(ticket) ? (
                      <Button tone="danger" onClick={() => onCancel(ticket)}>
                        Hủy phiếu chờ
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
