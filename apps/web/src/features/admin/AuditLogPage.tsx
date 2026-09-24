import type { AdminAuditLog, ListAuditLogsQuery } from '@idosi/contracts';
import { useQuery } from '@tanstack/react-query';
import { FileSearch, RefreshCw, Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { AdminAccess } from './AdminAccess';
import { adminErrorMessage, listAdminAuditLogs } from './adminApi';

const pageSize = 30;

export interface AuditFilterDraft {
  readonly action: string;
  readonly actorAccountId: string;
  readonly createdFrom: string;
  readonly createdTo: string;
  readonly entityId: string;
  readonly entityType: string;
  readonly requestId: string;
}

const emptyAuditFilters: AuditFilterDraft = {
  action: '',
  actorAccountId: '',
  createdFrom: '',
  createdTo: '',
  entityId: '',
  entityType: '',
  requestId: '',
};

export function auditQueryFromFilters(
  filters: AuditFilterDraft,
  page: number,
): { readonly query: ListAuditLogsQuery | null; readonly error: string | null } {
  const createdFrom = localDateTimeToIso(filters.createdFrom);
  const createdTo = localDateTimeToIso(filters.createdTo);
  if (filters.createdFrom && !createdFrom) {
    return { error: 'Thời gian bắt đầu không hợp lệ.', query: null };
  }
  if (filters.createdTo && !createdTo) {
    return { error: 'Thời gian kết thúc không hợp lệ.', query: null };
  }
  if (createdFrom && createdTo && createdFrom > createdTo) {
    return { error: 'Thời gian kết thúc không được trước thời gian bắt đầu.', query: null };
  }
  return {
    error: null,
    query: {
      page,
      pageSize,
      ...(filters.action.trim() ? { action: filters.action.trim() } : {}),
      ...(filters.actorAccountId.trim() ? { actorAccountId: filters.actorAccountId.trim() } : {}),
      ...(createdFrom ? { createdFrom } : {}),
      ...(createdTo ? { createdTo } : {}),
      ...(filters.entityId.trim() ? { entityId: filters.entityId.trim() } : {}),
      ...(filters.entityType.trim() ? { entityType: filters.entityType.trim() } : {}),
      ...(filters.requestId.trim() ? { requestId: filters.requestId.trim() } : {}),
    },
  };
}

export function formatAuditJson(value: Record<string, unknown> | null): string {
  return value === null ? 'Không có' : JSON.stringify(value, null, 2);
}

export function AuditLogPage() {
  return (
    <AdminAccess>
      <AuditLogContent />
    </AdminAccess>
  );
}

function AuditLogContent() {
  const [filterDraft, setFilterDraft] = useState<AuditFilterDraft>(emptyAuditFilters);
  const [filters, setFilters] = useState<AuditFilterDraft>(emptyAuditFilters);
  const [filterError, setFilterError] = useState('');
  const [page, setPage] = useState(1);
  const parsedQuery = auditQueryFromFilters(filters, page).query ?? { page, pageSize };
  const auditQuery = useQuery({
    queryFn: () => listAdminAuditLogs(parsedQuery),
    queryKey: ['admin', 'audit-logs', parsedQuery],
    retry: false,
  });

  const submitFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = auditQueryFromFilters(filterDraft, 1);
    if (!parsed.query) {
      setFilterError(parsed.error ?? 'Bộ lọc chưa hợp lệ.');
      return;
    }
    setFilterError('');
    setPage(1);
    setFilters({ ...filterDraft });
  };

  const rows = auditQuery.data?.data ?? [];
  const pagination = auditQuery.data?.pagination;

  return (
    <>
      <PageHeader
        description="Nhật ký bất biến từ backend; chỉ đọc, có request ID và before/after đã lọc bí mật"
        title="Nhật ký hệ thống"
      />
      <section className="admin-panel">
        <form className="admin-audit-filters" onSubmit={submitFilters}>
          <label className="admin-field">
            <span>Hành động</span>
            <span className="admin-input-with-icon">
              <Search aria-hidden="true" size={16} />
              <input
                onChange={(event) =>
                  setFilterDraft((current) => ({ ...current, action: event.target.value }))
                }
                placeholder="ACCOUNT_PASSWORD_RESET"
                value={filterDraft.action}
              />
            </span>
          </label>
          <label className="admin-field">
            <span>Loại đối tượng</span>
            <input
              onChange={(event) =>
                setFilterDraft((current) => ({ ...current, entityType: event.target.value }))
              }
              placeholder="user, product, store…"
              value={filterDraft.entityType}
            />
          </label>
          <label className="admin-field">
            <span>ID đối tượng</span>
            <input
              inputMode="text"
              onChange={(event) =>
                setFilterDraft((current) => ({ ...current, entityId: event.target.value }))
              }
              placeholder="UUID"
              value={filterDraft.entityId}
            />
          </label>
          <label className="admin-field">
            <span>ID tài khoản thao tác</span>
            <input
              inputMode="text"
              onChange={(event) =>
                setFilterDraft((current) => ({ ...current, actorAccountId: event.target.value }))
              }
              placeholder="UUID"
              value={filterDraft.actorAccountId}
            />
          </label>
          <label className="admin-field">
            <span>Request ID</span>
            <input
              onChange={(event) =>
                setFilterDraft((current) => ({ ...current, requestId: event.target.value }))
              }
              placeholder="Mã truy vết"
              value={filterDraft.requestId}
            />
          </label>
          <label className="admin-field">
            <span>Từ thời điểm</span>
            <input
              onChange={(event) =>
                setFilterDraft((current) => ({ ...current, createdFrom: event.target.value }))
              }
              type="datetime-local"
              value={filterDraft.createdFrom}
            />
          </label>
          <label className="admin-field">
            <span>Đến thời điểm</span>
            <input
              onChange={(event) =>
                setFilterDraft((current) => ({ ...current, createdTo: event.target.value }))
              }
              type="datetime-local"
              value={filterDraft.createdTo}
            />
          </label>
          <div className="admin-form-actions admin-form-actions--filters">
            <Button busy={auditQuery.isFetching} className="admin-clickable" type="submit">
              Áp dụng bộ lọc
            </Button>
            <Button
              className="admin-clickable"
              onClick={() => {
                setFilterDraft(emptyAuditFilters);
                setFilters(emptyAuditFilters);
                setFilterError('');
                setPage(1);
              }}
              tone="secondary"
            >
              Xóa lọc
            </Button>
          </div>
        </form>
        {filterError ? (
          <p className="admin-feedback admin-feedback--error" role="alert">
            {filterError}
          </p>
        ) : null}

        {auditQuery.isPending ? <AuditLoading /> : null}
        {auditQuery.isError ? (
          <div className="admin-state admin-state--error" role="alert">
            <FileSearch aria-hidden="true" size={28} />
            <strong>Không thể tải nhật ký hệ thống</strong>
            <p>{adminErrorMessage(auditQuery.error)}</p>
            <Button
              className="admin-clickable"
              onClick={() => void auditQuery.refetch()}
              tone="secondary"
            >
              <RefreshCw aria-hidden="true" size={15} /> Thử lại
            </Button>
          </div>
        ) : null}
        {auditQuery.isSuccess && rows.length === 0 ? (
          <EmptyState
            detail="Không có sự kiện phù hợp với phạm vi thời gian và điều kiện đã chọn."
            title="Chưa có sự kiện trong nhật ký"
          />
        ) : null}
        {rows.length > 0 ? <AuditRows rows={rows} /> : null}

        {pagination && pagination.totalPages > 1 ? (
          <nav aria-label="Phân trang nhật ký hệ thống" className="admin-pagination">
            <button
              className="admin-action"
              disabled={page <= 1 || auditQuery.isFetching}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              type="button"
            >
              Trang trước
            </button>
            <span>
              Trang {pagination.page}/{pagination.totalPages} · {pagination.totalItems} sự kiện
            </span>
            <button
              className="admin-action"
              disabled={page >= pagination.totalPages || auditQuery.isFetching}
              onClick={() => setPage((current) => current + 1)}
              type="button"
            >
              Trang sau
            </button>
          </nav>
        ) : null}
      </section>
    </>
  );
}

function AuditRows({ rows }: { readonly rows: readonly AdminAuditLog[] }) {
  return (
    <div className="admin-audit-list">
      {rows.map((event) => (
        <article className="admin-audit-event" key={event.id}>
          <div className="admin-audit-event__heading">
            <div>
              <strong>{event.action}</strong>
              <span>{formatDateTime(event.createdAt)}</span>
            </div>
            <Badge tone="info">{event.actorRole ?? 'SYSTEM'}</Badge>
          </div>
          <dl className="admin-audit-meta">
            <div>
              <dt>Đối tượng</dt>
              <dd>
                {event.entityType} · {event.entityId ?? 'Không có ID'}
              </dd>
            </div>
            <div>
              <dt>Tài khoản</dt>
              <dd>{event.actorAccountId ?? 'Hệ thống'}</dd>
            </div>
            <div>
              <dt>Request ID</dt>
              <dd>{event.requestId ?? 'Không có'}</dd>
            </div>
          </dl>
          <details className="admin-audit-details">
            <summary>Chi tiết before / after / metadata</summary>
            <div className="admin-audit-json-grid">
              <AuditJson label="Trước thay đổi" value={event.before} />
              <AuditJson label="Sau thay đổi" value={event.after} />
              <AuditJson label="Metadata" value={event.metadata} />
            </div>
          </details>
        </article>
      ))}
    </div>
  );
}

function AuditJson({
  label,
  value,
}: {
  readonly label: string;
  readonly value: Record<string, unknown> | null;
}) {
  return (
    <section>
      <h3>{label}</h3>
      <pre>{formatAuditJson(value)}</pre>
    </section>
  );
}

function AuditLoading() {
  return (
    <div aria-live="polite" className="admin-state" role="status">
      <span aria-hidden="true" className="admin-spinner" />
      <strong>Đang tải nhật ký hệ thống…</strong>
    </div>
  );
}

function localDateTimeToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value));
}
