import { RefreshCw, WifiOff } from 'lucide-react';

import { Button } from '../../../components/Button';
import { ApiClientError } from '../../../lib/api';

interface SyncState {
  readonly data: unknown;
  readonly dataUpdatedAt: number;
  readonly error: unknown;
  readonly isError: boolean;
  readonly isFetching: boolean;
  readonly refetch: () => unknown;
}

export function formatSyncTime(updatedAt: number): string {
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(updatedAt));
}

/** Null while the data is current; otherwise what the screen shows and why it is not newer. */
export function syncNoticeText(
  state: Pick<SyncState, 'data' | 'dataUpdatedAt' | 'error' | 'isError'>,
): string | null {
  if (!state.isError || state.data === undefined) return null;
  const reason =
    state.error instanceof ApiClientError && state.error.status === 0
      ? 'Mất kết nối máy chủ'
      : state.error instanceof ApiClientError && state.error.status === 403
        ? 'Tài khoản không còn quyền xem dữ liệu này'
        : 'Không cập nhật được dữ liệu mới';
  return `${reason}. Đang hiển thị dữ liệu lúc ${formatSyncTime(state.dataUpdatedAt)}; trạng thái có thể đã thay đổi.`;
}

/**
 * A failed background refresh keeps the last data on screen (never an empty list) and says so,
 * with a retry. Nothing is shown while the data is current.
 */
export function SyncNotice({ query }: { readonly query: SyncState }) {
  const text = syncNoticeText(query);
  if (text === null) return null;
  return (
    <div className="adjustment-sync-notice" role="status">
      <WifiOff aria-hidden="true" size={16} />
      <span>{text}</span>
      <Button busy={query.isFetching} onClick={() => void query.refetch()} tone="secondary">
        <RefreshCw aria-hidden="true" size={14} /> Thử lại
      </Button>
    </div>
  );
}
