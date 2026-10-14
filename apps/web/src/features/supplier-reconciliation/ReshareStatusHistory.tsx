import type {
  ReshareActorRole,
  ReshareOrderHistoryRow,
  ReshareOrderHistoryStatus,
  ReshareStatusHistoryEvent,
} from '@idosi/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useId, useState } from 'react';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ApiClientError } from '../../lib/api';
import { formatDocumentTime } from '../../lib/business-time';
import { useDialogAccessibility } from '../../lib/use-dialog-accessibility';
import { Pager } from './ReconciliationWorkspace';
import { loadReshareStatusHistory } from './supplierApi';

export const RESHARE_ROLE_LABEL: Record<ReshareActorRole, string> = {
  ADMIN: 'Admin',
  HTKD: 'HTKD',
  STORE: 'Cửa hàng',
  WHOLESALE: 'Quầy sỉ',
};

const STATUS_LABEL: Record<ReshareOrderHistoryStatus, string> = {
  ORDERED: 'Đã đặt Reshare',
  NOT_ORDERED: 'Chưa đặt Reshare',
  CANCELLED: 'Hủy',
};

const STATUS_TONE = { ORDERED: 'success', NOT_ORDERED: 'warning', CANCELLED: 'danger' } as const;

function StatusValue({ status }: { readonly status: ReshareOrderHistoryStatus | null }) {
  return status ? (
    <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
  ) : (
    <span className="reshare-status-history__missing">Chưa ghi nhận</span>
  );
}

/** Who acted, as recorded with the event; never a guess and never relabelled as Admin. */
export function historyActorName(event: ReshareStatusHistoryEvent): string {
  if (event.actor.nameAtEvent) return event.actor.nameAtEvent;
  if (event.actor.currentName) return `${event.actor.currentName} (tên hiện tại)`;
  return event.actor.accountId ? 'Chưa ghi nhận tên' : 'Hệ thống';
}

/** What happened, in words: RE creation (by acceptance or the cutover) or a status change. */
export function historyContent(event: ReshareStatusHistoryEvent): string {
  if (event.kind === 'CREATED') {
    const code = event.orderCode ? ` ${event.orderCode}` : '';
    return event.source === 'BACKFILL'
      ? `Tạo đơn${code} khi chuyển đổi dữ liệu cũ`
      : `Tạo đơn${code} khi chấp nhận kết quả phân bổ`;
  }
  return `Cập nhật trạng thái đặt Reshare${event.version === null ? '' : ` (lần ${event.version})`}`;
}

function errorText(error: unknown): string {
  if (error instanceof ApiClientError && (error.status === 403 || error.status === 404)) {
    return 'Tài khoản không có quyền xem lịch sử của đơn này hoặc đơn không còn tồn tại.';
  }
  return 'Không tải được lịch sử thay đổi. Kiểm tra mạng rồi thử lại.';
}

/**
 * "Lịch sử thay đổi" of one allocation result, read from the server only while the dialog is
 * open (no per-row requests on the list). Newest first, paged on the server.
 */
export function ReshareStatusHistoryDialog({
  row,
  accountId,
  onClose,
}: {
  readonly row: ReshareOrderHistoryRow;
  readonly accountId: string;
  readonly onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const dialogRef = useDialogAccessibility<HTMLElement>(onClose);
  const titleId = useId();
  const history = useQuery({
    queryKey: ['reshare-status-history', accountId, row.decisionId, page],
    queryFn: ({ signal }) => loadReshareStatusHistory(row.decisionId, page, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const data = history.data;
  const lastPage = data ? page >= data.pagination.totalPages : false;

  return (
    <div className="dialog-backdrop">
      <section
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-modal="true"
        className="dialog reshare-status-history"
        role="dialog"
        tabIndex={-1}
      >
        <div className="dialog__header">
          <div>
            <h2 id={titleId}>Lịch sử thay đổi trạng thái</h2>
            <p className="reshare-status-history__subject">
              {row.order?.code ?? 'Chưa có mã RE'} · {row.sessionCode} · {row.storeName}
            </p>
          </div>
          <button
            aria-label={`Đóng lịch sử thay đổi của ${row.order?.code ?? row.sessionCode}`}
            data-dialog-initial-focus
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" size={22} />
          </button>
        </div>
        {history.isPending ? (
          <p role="status">Đang tải lịch sử thay đổi…</p>
        ) : history.isError && !data ? (
          <div className="supplier-error" role="alert">
            <p>{errorText(history.error)}</p>
            <Button tone="secondary" onClick={() => void history.refetch()}>
              Thử lại
            </Button>
          </div>
        ) : data ? (
          <>
            {history.isError ? (
              <div className="supplier-error" role="alert">
                <p>Không làm mới được; đang hiển thị dữ liệu đã tải trước đó.</p>
                <Button tone="secondary" onClick={() => void history.refetch()}>
                  Thử lại
                </Button>
              </div>
            ) : null}
            {data.data.length === 0 ? (
              <p className="supplier-empty">
                Chưa ghi nhận thay đổi trạng thái nào. Trạng thái hiện tại:{' '}
                <strong>{STATUS_LABEL[row.status]}</strong>.
              </p>
            ) : (
              <div className="responsive-table reshare-status-history__table">
                <table className="supplier-table">
                  <caption className="sr-only">Lịch sử thay đổi trạng thái, mới nhất trước</caption>
                  <thead>
                    <tr>
                      <th scope="col">Thời gian</th>
                      <th scope="col">Trạng thái trước</th>
                      <th scope="col">Trạng thái sau</th>
                      <th scope="col">Người thay đổi</th>
                      <th scope="col">Vai trò</th>
                      <th scope="col">Nội dung</th>
                    </tr>
                  </thead>
                  <tbody aria-busy={history.isFetching}>
                    {data.data.map((event) => (
                      <tr key={event.id}>
                        <td data-label="Thời gian">
                          <time dateTime={event.occurredAt}>
                            {formatDocumentTime(event.occurredAt)}
                          </time>
                        </td>
                        <td data-label="Trạng thái trước">
                          {event.kind === 'CREATED' && event.statusBefore === null ? (
                            <span className="reshare-status-history__missing">—</span>
                          ) : (
                            <StatusValue status={event.statusBefore} />
                          )}
                        </td>
                        <td data-label="Trạng thái sau">
                          <StatusValue status={event.statusAfter} />
                        </td>
                        <td data-label="Người thay đổi">{historyActorName(event)}</td>
                        <td data-label="Vai trò">
                          {event.actor.role
                            ? RESHARE_ROLE_LABEL[event.actor.role]
                            : 'Chưa ghi nhận'}
                        </td>
                        <td data-label="Nội dung">{historyContent(event)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {lastPage || data.data.length === 0 ? (
              <p className="supplier-hint reshare-status-history__origin">
                Kết quả phân bổ công bố lúc {formatDocumentTime(data.decision.publishedAt)}. Không
                có dữ liệu lịch sử nào trước các dòng trên; thay đổi trước khi hệ thống lưu lịch sử
                không được dựng lại.
              </p>
            ) : null}
            <Pager
              disabled={history.isFetching}
              onPage={setPage}
              page={page}
              totalPages={data.pagination.totalPages}
            />
          </>
        ) : null}
        <div className="dialog__actions">
          <Button tone="secondary" onClick={onClose}>
            Đóng
          </Button>
        </div>
      </section>
    </div>
  );
}
