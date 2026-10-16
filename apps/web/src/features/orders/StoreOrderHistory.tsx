import { DataTable } from '../../components/DataTable';
import type { OrderHistoryEntry, OrderSession, Store } from '@idosi/contracts';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FileText, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { listCatalog, listOrderHistory } from '../../lib/api';
import {
  formatBusinessDate,
  formatClock,
  formatDateTime,
  sessionKindCopy,
  sessionLabel,
} from '../../lib/session-label';
import {
  clearOrderHistoryFilters,
  orderHistoryStatusCopy,
  orderHistoryStatusTone,
  readOrderHistoryFilters,
  requestTotals,
  unitLabel,
  withOrderHistoryFilters,
} from './orderHistoryNavigation';
import './order-history.css';

const PAGE_SIZE = 20;

/**
 * Every original order request of the stores in the account's scope, as submitted. It reads its
 * own paged endpoint, so it is independent of the recent-session window of the other tabs and of
 * the one-row-per-store navigation of allocated sessions.
 */
export function StoreOrderHistory({
  accountKey,
  onOpenDocument,
  sessions,
  stores,
}: {
  /** Account identity in the query key: a different login never sees cached pages. */
  readonly accountKey: string;
  readonly onOpenDocument: (sessionId: string, storeId: string) => void;
  readonly sessions: readonly OrderSession[];
  readonly stores: readonly Pick<Store, 'id' | 'code' | 'name'>[];
}) {
  const [params, setParams] = useSearchParams();
  const filters = readOrderHistoryFilters(params);
  const [draftCode, setDraftCode] = useState(filters.code);
  useEffect(() => setDraftCode(filters.code), [filters.code]);
  const catalog = useQuery({ queryFn: listCatalog, queryKey: ['catalog'], retry: false });
  const history = useQuery({
    queryKey: ['order-history', accountKey, filters],
    queryFn: ({ signal }) =>
      listOrderHistory(
        {
          page: filters.page,
          pageSize: PAGE_SIZE,
          ...(filters.storeId ? { storeId: filters.storeId } : {}),
          ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
          ...(filters.status ? { status: filters.status } : {}),
          ...(filters.productId ? { productId: filters.productId } : {}),
          ...(filters.code ? { code: filters.code } : {}),
          ...(filters.from ? { submittedFrom: filters.from } : {}),
          ...(filters.to ? { submittedTo: filters.to } : {}),
        },
        signal,
      ),
    // Keep the confirmed page on screen while the next one loads; never blank it on refetch.
    placeholderData: (previous) => previous,
    retry: false,
  });
  const update = (changes: Parameters<typeof withOrderHistoryFilters>[1]) =>
    setParams((current) => withOrderHistoryFilters(current, changes), { replace: true });
  const sessionOptions = useMemo(() => {
    const byId = new Map<
      string,
      Pick<OrderSession, 'id' | 'code' | 'businessDate' | 'requestClosesAt' | 'allocationStartsAt'>
    >();
    for (const session of sessions) byId.set(session.id, session);
    // A session reached through a row link stays selectable even outside the recent window.
    for (const entry of history.data?.data ?? []) byId.set(entry.session.id, entry.session);
    return [...byId.values()].toSorted(
      (left, right) =>
        right.businessDate.localeCompare(left.businessDate) ||
        right.requestClosesAt.localeCompare(left.requestClosesAt) ||
        left.id.localeCompare(right.id),
    );
  }, [sessions, history.data]);
  const products = (catalog.data ?? []).toSorted((left, right) =>
    left.name.localeCompare(right.name, 'vi'),
  );
  const hasFilter = Boolean(
    filters.storeId ||
    filters.sessionId ||
    filters.status ||
    filters.productId ||
    filters.code ||
    filters.from ||
    filters.to,
  );
  const data = history.data;

  return (
    <section aria-labelledby="order-history-heading" className="panel order-history">
      <div className="section-heading section-heading--compact">
        <div>
          <h2 id="order-history-heading">Lịch sử đặt hàng theo cửa hàng</h2>
          <p>
            Từng phiếu gốc với thời gian gửi, mặt hàng và số lượng đã đặt. Phiếu đã gộp vẫn giữ
            nguyên số lượng gốc; kết quả cấp hàng xem ở chứng từ của đúng phiên.
          </p>
        </div>
        <Badge tone="info">
          {(data?.pagination.totalItems ?? 0).toLocaleString('vi-VN')} phiếu
        </Badge>
      </div>
      <form
        aria-label="Bộ lọc lịch sử đặt hàng"
        className="filter-card order-history__filters"
        onSubmit={(event) => {
          event.preventDefault();
          update({ code: draftCode });
        }}
      >
        <label>
          Cửa hàng
          <select
            className="store-name"
            onChange={(event) => update({ storeId: event.target.value })}
            value={filters.storeId}
          >
            <option value="">Tất cả cửa hàng được phép xem</option>
            {stores.map((store) => (
              <option className="store-name" key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Phiên
          <select
            onChange={(event) => update({ sessionId: event.target.value })}
            value={filters.sessionId}
          >
            <option value="">Tất cả phiên</option>
            {sessionOptions.map((session) => (
              <option key={session.id} value={session.id}>
                {sessionLabel(session)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Trạng thái phiếu
          <select
            onChange={(event) => update({ status: event.target.value as typeof filters.status })}
            value={filters.status}
          >
            <option value="">Tất cả trạng thái</option>
            <option value="SUBMITTED">Chờ phân bổ</option>
            <option value="MERGED">Đã gộp / đã phân bổ</option>
            <option value="CANCELLED">Đã hủy</option>
          </select>
        </label>
        <label>
          Mặt hàng
          <select
            onChange={(event) => update({ productId: event.target.value })}
            value={filters.productId}
          >
            <option value="">Tất cả mặt hàng</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Gửi từ ngày
          <input
            onChange={(event) => update({ from: event.target.value })}
            type="date"
            value={filters.from}
          />
        </label>
        <label>
          Gửi đến ngày
          <input
            onChange={(event) => update({ to: event.target.value })}
            type="date"
            value={filters.to}
          />
        </label>
        <label>
          Mã phiếu
          <input
            maxLength={20}
            onChange={(event) => setDraftCode(event.target.value)}
            placeholder="PDT-000123"
            type="search"
            value={draftCode}
          />
        </label>
        <div className="order-history__filter-actions">
          <Button type="submit" tone="secondary">
            Tìm mã phiếu
          </Button>
          <Button
            disabled={!hasFilter}
            onClick={() =>
              setParams((current) => clearOrderHistoryFilters(current), { replace: true })
            }
            tone="secondary"
          >
            <RotateCcw aria-hidden="true" size={16} /> Xóa bộ lọc
          </Button>
        </div>
      </form>
      <p className="order-history__note">
        “Gửi từ/đến ngày” lọc theo thời điểm cửa hàng gửi phiếu (giờ Việt Nam), khác với ngày nghiệp
        vụ của phiên.
      </p>

      {history.isPending ? (
        <p aria-live="polite" className="allocation-session-state">
          Đang tải lịch sử đặt hàng…
        </p>
      ) : null}
      {history.isError && !data ? (
        <div className="allocation-session-state allocation-session-state--error" role="alert">
          <span>
            Không tải được lịch sử đặt hàng. Dữ liệu chưa được hiển thị, không phải 0 phiếu.
          </span>
          <Button onClick={() => void history.refetch()} tone="secondary">
            <RotateCcw aria-hidden="true" size={16} /> Thử lại
          </Button>
        </div>
      ) : null}
      {data && history.isError ? (
        <div className="allocation-session-state allocation-session-state--error" role="alert">
          <span>Không cập nhật được trang mới; bảng đang giữ dữ liệu đã tải lần trước.</span>
          <Button onClick={() => void history.refetch()} tone="secondary">
            <RotateCcw aria-hidden="true" size={16} /> Thử lại
          </Button>
        </div>
      ) : null}
      {data && data.data.length === 0 ? (
        <EmptyState
          detail={
            hasFilter
              ? 'Không có phiếu khớp bộ lọc. Đổi hoặc xóa bộ lọc để xem thêm.'
              : 'Chưa có cửa hàng nào trong phạm vi gửi phiếu đặt hàng.'
          }
          title="Chưa có phiếu đặt hàng"
        />
      ) : null}
      {data && data.data.length > 0 ? (
        <>
          {history.isFetching ? (
            <p aria-live="polite" className="allocation-result-refreshing">
              Đang cập nhật lịch sử…
            </p>
          ) : null}
          <div className="document-history order-history__scroll">
            <DataTable className="table-density order-history__table">
              <thead>
                <tr>
                  <th scope="col" className="table-index">
                    STT
                  </th>
                  <th scope="col">Thời gian gửi</th>
                  <th scope="col">Phiếu đặt hàng</th>
                  <th scope="col">Cửa hàng</th>
                  <th scope="col">Phiên</th>
                  <th scope="col">Mặt hàng</th>
                  <th scope="col">Số lượng</th>
                  <th scope="col">Trạng thái</th>
                </tr>
              </thead>
              {data.data.map((entry, rowIndex) => (
                <OrderHistoryRows
                  rowNumber={(data.pagination.page - 1) * data.pagination.pageSize + rowIndex + 1}
                  entry={entry}
                  filteredProduct={Boolean(filters.productId)}
                  key={entry.id}
                  onFilterSession={() => update({ sessionId: entry.session.id })}
                  onOpenDocument={onOpenDocument}
                />
              ))}
            </DataTable>
          </div>
          <div className="allocation-result-pagination">
            <span>
              Trang {data.pagination.page} / {Math.max(1, data.pagination.totalPages)} ·{' '}
              {data.pagination.totalItems.toLocaleString('vi-VN')} phiếu gốc
            </span>
            <div>
              <Button
                disabled={filters.page <= 1 || history.isFetching}
                onClick={() => update({ page: filters.page - 1 })}
                tone="secondary"
              >
                <ChevronLeft aria-hidden="true" size={16} /> Trang trước
              </Button>
              <Button
                disabled={filters.page >= data.pagination.totalPages || history.isFetching}
                onClick={() => update({ page: filters.page + 1 })}
                tone="secondary"
              >
                Trang sau <ChevronRight aria-hidden="true" size={16} />
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

/**
 * One order = one tbody: a row per product line so "Mặt hàng" and "Số lượng" stay on the same
 * line, the order-level cells span every line. Under 1100px the tbody becomes one card.
 */
function OrderHistoryRows({
  rowNumber,
  entry,
  filteredProduct,
  onFilterSession,
  onOpenDocument,
}: {
  readonly rowNumber: number;
  readonly entry: OrderHistoryEntry;
  readonly filteredProduct: boolean;
  readonly onFilterSession: () => void;
  readonly onOpenDocument: (sessionId: string, storeId: string) => void;
}) {
  const document = entry.mergedDocument;
  // A legacy order without lines still renders one row so the order itself stays visible.
  const lines = entry.lines.length > 0 ? entry.lines : [null];
  const span = lines.length;
  return (
    <tbody className="order-history__group">
      {lines.map((line, lineIndex) => {
        const highlighted = Boolean(line && filteredProduct && line.matchesFilter);
        return (
          <tr key={line?.id ?? 'empty'}>
            {lineIndex === 0 ? (
              <>
                <td className="table-index" data-label="STT" rowSpan={span}>
                  {rowNumber}
                </td>
                <td data-label="Thời gian gửi" rowSpan={span}>
                  <strong>{formatDateTime(entry.submittedAt)}</strong>
                  {entry.submittedBy ? (
                    <small>Người gửi: {entry.submittedBy.displayName}</small>
                  ) : null}
                </td>
                <td data-label="Phiếu đặt hàng" rowSpan={span}>
                  <strong>{entry.code}</strong>
                  <small>Lượt {entry.requestSequence}/2 của phiên</small>
                  <small>
                    {entry.lines.length} mặt hàng · tổng đặt {requestTotals(entry)}
                  </small>
                </td>
                <td data-label="Cửa hàng" rowSpan={span}>
                  <span className="store-name order-history__store">{entry.storeName}</span>
                </td>
                <td data-label="Phiên" rowSpan={span}>
                  <button
                    aria-label={`Lọc theo phiên ${sessionLabel(entry.session)}`}
                    className="link-button"
                    onClick={onFilterSession}
                    type="button"
                  >
                    {entry.session.code}
                  </button>
                  <small>
                    {sessionKindCopy[entry.session.kind]} · ngày nghiệp vụ{' '}
                    {formatBusinessDate(entry.session.businessDate)}
                  </small>
                  <small>
                    Chốt nhận {formatClock(entry.session.requestClosesAt)} · phân bổ{' '}
                    {formatClock(entry.session.allocationStartsAt)}
                  </small>
                </td>
              </>
            ) : null}
            <td
              className={`order-history__product${highlighted ? ' order-history__line--match' : ''}`}
              data-label="Mặt hàng"
            >
              {line ? line.productName : 'Không có mặt hàng'}
              {highlighted ? <span className="sr-only"> (khớp bộ lọc mặt hàng)</span> : null}
            </td>
            <td
              className={`order-history__quantity${highlighted ? ' order-history__line--match' : ''}`}
              data-label="Số lượng"
            >
              {line
                ? `${line.requestedQuantity.toLocaleString('vi-VN')} ${unitLabel(line.unit)}`
                : '—'}
            </td>
            {lineIndex === 0 ? (
              <td data-label="Trạng thái" rowSpan={span}>
                <div className="order-history__status">
                  <Badge tone={orderHistoryStatusTone[entry.status]}>
                    {orderHistoryStatusCopy[entry.status]}
                  </Badge>
                  {entry.status === 'CANCELLED' && entry.cancellationReason ? (
                    <small>Lý do: {entry.cancellationReason}</small>
                  ) : null}
                  {document ? (
                    <button
                      aria-label={`Xem chứng từ phiên ${entry.session.code} của ${entry.storeName}`}
                      className="link-button"
                      onClick={() => onOpenDocument(document.sessionId, document.storeId)}
                      type="button"
                    >
                      <FileText aria-hidden="true" size={15} /> Xem chứng từ phiên
                    </button>
                  ) : null}
                </div>
              </td>
            ) : null}
          </tr>
        );
      })}
    </tbody>
  );
}
