import { DataTable } from '../../components/DataTable';
import type { Store, StoreWaitDocument } from '@idosi/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ApiClientError, listWaitDocuments } from '../../lib/api';
import { formatDateTime } from '../../lib/session-label';
import type { ProductConversion as CatalogProduct, Role } from '../../lib/types';
import { WaitDocumentDetail } from './WaitDocumentDetail';
import {
  clearWaitDocumentFilters,
  currentDocumentDetail,
  lineOpenQuantity,
  readOpenWaitDocument,
  readWaitDocumentFilters,
  waitDocumentEventDescription,
  waitDocumentLabel,
  waitDocumentStatusFilterLabel,
  waitDocumentTone,
  waitDocumentTotals,
  withOpenWaitDocument,
  withWaitDocumentFilters,
  type WaitDocumentListFilters,
} from './waitDocumentNavigation';
import './wait-documents.css';

const PAGE_SIZE = 20;

/**
 * "Phiếu chờ": the store wait documents in the account's scope (server-side), one current
 * document per store by default, with the processed history (merged, rolled over, completed,
 * cancelled) one switch away. Filters and the opened document live in the URL.
 */
export function WaitDocumentList({
  accountKey,
  onOpenDecision,
  products,
  role,
  stores,
}: {
  readonly accountKey: string;
  readonly onOpenDecision: (decisionId: string) => void;
  readonly products: readonly CatalogProduct[];
  readonly role: Role;
  readonly stores: readonly Pick<Store, 'id' | 'code' | 'name'>[];
}) {
  const [params, setParams] = useSearchParams();
  const filters = readWaitDocumentFilters(params);
  const openId = readOpenWaitDocument(params);
  const [draftQ, setDraftQ] = useState(filters.q);
  useEffect(() => setDraftQ(filters.q), [filters.q]);
  const multiStore = role !== 'STORE' && stores.length > 1;
  const query = useQuery({
    queryKey: ['wait-documents', accountKey, filters],
    queryFn: ({ signal }) =>
      listWaitDocuments(
        {
          page: filters.page,
          pageSize: PAGE_SIZE,
          view: filters.view,
          ...(filters.status ? { status: filters.status } : {}),
          ...(filters.storeId ? { storeId: filters.storeId } : {}),
          ...(filters.productId ? { productId: filters.productId } : {}),
          ...(filters.q ? { q: filters.q } : {}),
          ...(filters.from ? { openedFrom: filters.from } : {}),
          ...(filters.to ? { openedTo: filters.to } : {}),
        },
        signal,
      ),
    // Keep the confirmed page while the next one loads; never blank the list on refetch.
    placeholderData: keepPreviousData,
    retry: false,
  });
  const update = (changes: Partial<WaitDocumentListFilters>) =>
    setParams((current) => withWaitDocumentFilters(current, changes));
  const openDocument = (id: string | null) =>
    setParams((current) => withOpenWaitDocument(current, id));
  const hasFilter = Boolean(
    filters.status ||
    filters.storeId ||
    filters.productId ||
    filters.q ||
    filters.from ||
    filters.to,
  );
  const data = query.data;
  const productOptions = products.toSorted((left, right) =>
    left.name.localeCompare(right.name, 'vi'),
  );

  return (
    <section aria-labelledby="wait-documents-heading" className="panel wait-documents">
      <div className="section-heading section-heading--compact">
        <div>
          <h2 id="wait-documents-heading">Phiếu chờ</h2>
          <p>
            Mỗi cửa hàng có tối đa một phiếu chờ đang hoạt động gồm mọi mặt hàng còn chờ. Khi có nhu
            cầu mới hoặc cửa hàng xác nhận hàng được cấp, phiếu cũ được lưu lại và liên kết sang
            phiếu mới.
          </p>
        </div>
        <Badge tone="info">
          {(data?.pagination.totalItems ?? 0).toLocaleString('vi-VN')} phiếu
        </Badge>
      </div>

      <div className="wait-documents__views" role="group" aria-label="Chế độ xem phiếu chờ">
        {(['ACTIVE', 'HISTORY'] as const).map((view) => (
          <button
            aria-pressed={filters.view === view}
            className="wait-documents__view"
            key={view}
            onClick={() => update({ view, status: '' })}
            type="button"
          >
            {view === 'ACTIVE' ? 'Đang hoạt động' : 'Lịch sử đã xử lý'}
          </button>
        ))}
      </div>

      <form
        aria-label="Bộ lọc phiếu chờ"
        className="filter-card wait-documents__filters"
        key={`${filters.view}:${params.get('wdFrom') ?? ''}:${params.get('wdTo') ?? ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const from = String(form.get('from') ?? '');
          const to = String(form.get('to') ?? '');
          const toInput = event.currentTarget.elements.namedItem('to') as HTMLInputElement;
          toInput.setCustomValidity(
            from && to && from > to ? 'Ngày kết thúc phải từ ngày bắt đầu trở đi' : '',
          );
          if (!event.currentTarget.reportValidity()) return;
          update({ q: draftQ, from, to });
        }}
      >
        <label>
          Mã phiếu (PCT, PC, PUT) / mặt hàng
          <input
            maxLength={80}
            name="q"
            onChange={(event) => setDraftQ(event.target.value)}
            type="search"
            value={draftQ}
          />
        </label>
        {filters.view === 'HISTORY' ? (
          <label>
            Kết quả xử lý
            <select
              onChange={(event) =>
                update({ status: event.target.value as WaitDocumentListFilters['status'] })
              }
              value={filters.status}
            >
              <option value="">Tất cả phiếu đã xử lý</option>
              {Object.entries(waitDocumentStatusFilterLabel).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {multiStore ? (
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
                  {store.code} · {store.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          Mặt hàng
          <select
            onChange={(event) => update({ productId: event.target.value })}
            value={filters.productId}
          >
            <option value="">Tất cả mặt hàng</option>
            {productOptions.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tạo từ ngày (giờ Việt Nam)
          <input
            defaultValue={filters.from}
            max={filters.to || undefined}
            name="from"
            type="date"
          />
        </label>
        <label>
          Đến ngày (giờ Việt Nam)
          <input defaultValue={filters.to} min={filters.from || undefined} name="to" type="date" />
        </label>
        <div className="wait-documents__filter-actions">
          <Button type="submit">Lọc phiếu</Button>
          {hasFilter ? (
            <Button
              onClick={() => setParams((current) => clearWaitDocumentFilters(current))}
              tone="secondary"
            >
              <RotateCcw aria-hidden="true" size={15} /> Xóa lọc
            </Button>
          ) : null}
        </div>
      </form>

      {openId ? (
        <WaitDocumentDetail
          accountKey={accountKey}
          documentId={openId}
          key={openId}
          onClose={() => openDocument(null)}
          onOpenDecision={onOpenDecision}
          onOpenDocument={openDocument}
          showStore={role !== 'STORE'}
        />
      ) : null}

      {query.isPending ? (
        <p aria-live="polite" className="wait-documents__state">
          Đang tải phiếu chờ…
        </p>
      ) : query.isError ? (
        <div className="form-error" role="alert">
          {query.error instanceof ApiClientError && query.error.status === 403
            ? 'Tài khoản không có quyền xem phiếu chờ của cửa hàng này.'
            : query.error instanceof ApiClientError
              ? query.error.message
              : 'Không tải được danh sách phiếu chờ.'}
          <Button onClick={() => void query.refetch()} tone="secondary">
            <RotateCcw aria-hidden="true" size={15} /> Thử lại
          </Button>
        </div>
      ) : data && data.data.length === 0 ? (
        <EmptyState
          detail={
            hasFilter
              ? 'Không có phiếu nào khớp bộ lọc. Hãy đổi hoặc xóa bộ lọc.'
              : filters.view === 'ACTIVE'
                ? 'Không có mặt hàng nào đang chờ phân bổ hoặc chờ xác nhận.'
                : 'Chưa có phiếu chờ nào được xử lý.'
          }
          title={
            filters.view === 'ACTIVE' ? 'Không có phiếu chờ đang hoạt động' : 'Chưa có lịch sử'
          }
        />
      ) : data ? (
        <>
          <ul aria-busy={query.isFetching} className="wait-documents__list">
            {data.data.map((document) => (
              <li key={document.id}>
                <WaitDocumentCard
                  document={document}
                  onOpen={openDocument}
                  opened={document.id === openId}
                  showStore={role !== 'STORE'}
                />
              </li>
            ))}
          </ul>
          {data.pagination.totalPages > 1 ? (
            <nav aria-label="Phân trang phiếu chờ" className="wait-documents__pagination">
              <Button
                disabled={filters.page <= 1 || query.isFetching}
                onClick={() => update({ page: filters.page - 1 })}
                tone="secondary"
              >
                <ChevronLeft aria-hidden="true" size={15} /> Trang trước
              </Button>
              <span>
                Trang {filters.page}/{data.pagination.totalPages}
              </span>
              <Button
                disabled={filters.page >= data.pagination.totalPages || query.isFetching}
                onClick={() => update({ page: filters.page + 1 })}
                tone="secondary"
              >
                Trang sau <ChevronRight aria-hidden="true" size={15} />
              </Button>
            </nav>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function WaitDocumentCard({
  document,
  onOpen,
  opened,
  showStore,
}: {
  readonly document: StoreWaitDocument;
  readonly onOpen: (id: string) => void;
  readonly opened: boolean;
  readonly showStore: boolean;
}) {
  const current = document.status === 'CURRENT';
  const totals = waitDocumentTotals(document);
  // The waiting part never shows a zero row; the history keeps every product of the document.
  const lines = current
    ? document.lines.filter(
        (line) => (line.remainingQuantity ?? 0) + (line.pendingQuantity ?? 0) > 0,
      )
    : document.lines;
  return (
    <article
      aria-labelledby={`wait-document-${document.id}`}
      className={opened ? 'wait-document-card wait-document-card--opened' : 'wait-document-card'}
    >
      <header className="wait-document-card__header">
        <div>
          <h3 id={`wait-document-${document.id}`}>
            Phiếu chờ {document.code}
            {showStore ? (
              <span>
                {' '}
                · <span className="store-name">{document.storeName}</span>
              </span>
            ) : null}
          </h3>
          <p>
            Tạo {formatDateTime(document.openedAt)} · chờ từ {formatDateTime(document.waitingSince)}
            {document.closedAt ? ` · xử lý ${formatDateTime(document.closedAt)}` : ''}
          </p>
        </div>
        <Badge tone={waitDocumentTone(document.status)}>{waitDocumentLabel(document)}</Badge>
      </header>
      <p className="wait-document-card__summary">
        {current
          ? `${currentDocumentDetail(document.lines)} · ${totals.products} mặt hàng · còn chờ ${totals.remaining} bao · chờ xác nhận ${totals.pending} bao`
          : `${totals.products} mặt hàng · mở ${totals.open} bao · xác nhận ${totals.confirmed} · hủy ${totals.cancelled}${
              totals.adjusted > 0 ? ` · điều chỉnh ${totals.adjusted}` : ''
            } · chuyển tiếp ${totals.carriedOut}`}
      </p>
      <div className="responsive-table wait-document-lines">
        <DataTable>
          <thead>
            <tr>
              <th scope="col" className="table-index">
                STT
              </th>
              <th data-primary-column scope="col">
                Mặt hàng
              </th>
              {current ? (
                <>
                  <th scope="col">Còn chờ phân bổ</th>
                  <th scope="col">Đã cấp chờ xác nhận</th>
                </>
              ) : (
                <>
                  <th scope="col">Mở phiếu</th>
                  <th scope="col">Đã xác nhận</th>
                  <th scope="col">Đã hủy</th>
                  <th scope="col">Chuyển tiếp</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {lines.map((line, rowIndex) => (
              <tr key={line.productId}>
                <td className="table-index" data-label="STT">
                  {rowIndex + 1}
                </td>
                <th data-primary-column data-label="Mặt hàng" scope="row">
                  {line.productName}
                </th>
                {current ? (
                  <>
                    <td data-label="Còn chờ phân bổ">{line.remainingQuantity ?? 0}</td>
                    <td data-label="Đã cấp chờ xác nhận">{line.pendingQuantity ?? 0}</td>
                  </>
                ) : (
                  <>
                    <td data-label="Mở phiếu">{lineOpenQuantity(line)}</td>
                    <td data-label="Đã xác nhận">{line.confirmedQuantity ?? 0}</td>
                    <td data-label="Đã hủy">{line.cancelledQuantity ?? 0}</td>
                    <td data-label="Chuyển tiếp">{line.carriedOutQuantity ?? 0}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      </div>
      <footer className="wait-document-card__footer">
        <span className="wait-document-card__links">
          {document.predecessor ? (
            <button
              className="link-button"
              onClick={() => onOpen(document.predecessor!.id)}
              type="button"
            >
              Từ phiếu {document.predecessor.code}
            </button>
          ) : null}
          {document.successor ? (
            <button
              className="link-button"
              onClick={() => onOpen(document.successor!.id)}
              type="button"
            >
              <ArrowRight aria-hidden="true" size={13} /> Phiếu {document.successor.code}
            </button>
          ) : null}
          <small>
            {waitDocumentEventDescription(document.closedEvent ?? document.openedEvent)}
          </small>
        </span>
        <Button
          aria-label={`Xem chi tiết phiếu chờ ${document.code}`}
          onClick={() => onOpen(document.id)}
          tone="secondary"
        >
          Xem chi tiết
        </Button>
      </footer>
    </article>
  );
}
