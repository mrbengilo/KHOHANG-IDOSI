import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ReceiptAdjustmentListItem } from '@idosi/contracts';
import { ClipboardList, Eye, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { EmptyState } from '../../../components/EmptyState';
import { DashboardSkeleton } from '../../../components/Skeleton';
import { ApiClientError, listAccessibleStores, listCatalog } from '../../../lib/api';
import { DraftScope } from '../../../lib/draft-guard';
import {
  ADJUSTMENT_PAGE_SIZE,
  KEYS,
  readInventoryNavigation,
  withAdjustmentFilters,
  withParams,
  withStoreScope,
  type AdjustmentFilters,
} from '../../inventory/inventoryNavigation';
import {
  adjustmentSyncOptions,
  getReceiptAdjustment,
  listReceiptAdjustmentsPage,
} from './adjustmentApi';
import {
  accountLabel,
  ADJUSTMENT_STATUSES,
  adjustmentStatusCopy,
  listMoneyCopy,
  storeLabel,
} from './adjustmentModel';
import { AdjustmentDetailPanel } from './ReceiptAdjustments';
import { SyncNotice } from './SyncNotice';
import './receipt-adjustments.css';

const dateTime = new Intl.DateTimeFormat('vi-VN', {
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  month: '2-digit',
  timeZone: 'Asia/Ho_Chi_Minh',
  year: 'numeric',
});

function when(value: string | null): string {
  return value === null ? '—' : dateTime.format(new Date(value));
}

/** The words above the list that say exactly which slice of documents is on screen. */
export function describeAdjustmentFilters(
  filters: AdjustmentFilters,
  storeName: string | null,
): string {
  const parts = [
    filters.status === 'ALL' ? 'Tất cả trạng thái' : adjustmentStatusCopy[filters.status].label,
    storeName ?? 'Mọi cửa hàng',
  ];
  if (filters.q) parts.push(`mã chứa “${filters.q}”`);
  if (filters.from || filters.to) {
    const field = filters.dateField === 'DECIDED' ? 'Ngày xử lý' : 'Ngày báo';
    parts.push(`${field} ${filters.from || '…'} → ${filters.to || '…'}`);
  }
  return parts.join(' · ');
}

function itemStore(item: ReceiptAdjustmentListItem): string {
  return storeLabel({ storeId: item.storeId, code: item.storeCode, name: item.storeName });
}

/**
 * Admin's view of every store's discrepancy documents: one server page at a time, filters in
 * the URL, the chosen document opened below with its history. Pending admin decisions are the
 * default slice; "Tất cả" and "Đã xử lý" open the full history.
 */
export function AdminAdjustmentWorkspace() {
  const [params, setParams] = useSearchParams();
  const filters = readInventoryNavigation(params).adjustments;
  const [draftSearch, setDraftSearch] = useState(filters.q);
  const [draftFrom, setDraftFrom] = useState(filters.from);
  const [draftTo, setDraftTo] = useState(filters.to);
  const [formError, setFormError] = useState('');
  const [detailDirty, setDetailDirty] = useState(false);
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);
  const detailRef = useRef<HTMLElement>(null);

  // Back/Forward or a shared link changes the URL under the form: show what is applied.
  useEffect(() => {
    setDraftSearch(filters.q);
    setDraftFrom(filters.from);
    setDraftTo(filters.to);
  }, [filters.q, filters.from, filters.to]);

  const storesQuery = useQuery({
    queryFn: listAccessibleStores,
    queryKey: ['stores', 'accessible'],
    retry: false,
  });
  const catalogQuery = useQuery({ queryFn: listCatalog, queryKey: ['catalog'], retry: false });
  const listQuery = useQuery({
    placeholderData: keepPreviousData,
    queryFn: () =>
      listReceiptAdjustmentsPage({
        page: filters.page,
        pageSize: ADJUSTMENT_PAGE_SIZE,
        ...(filters.status === 'ALL' ? {} : { status: filters.status }),
        ...(filters.storeId ? { storeId: filters.storeId } : {}),
        ...(filters.q ? { q: filters.q } : {}),
        ...(filters.from || filters.to
          ? {
              dateField: filters.dateField,
              ...(filters.from ? { from: filters.from } : {}),
              ...(filters.to ? { to: filters.to } : {}),
            }
          : {}),
      }),
    queryKey: [
      'receipt-adjustments',
      'admin',
      filters.status,
      filters.storeId,
      filters.q,
      filters.dateField,
      filters.from,
      filters.to,
      filters.page,
    ],
    retry: false,
    ...adjustmentSyncOptions,
  });
  // The same cache entry the detail uses, so this costs no extra request; it tells a document
  // opened from a link (not on the current page) which receipt and store it belongs to.
  const openQuery = useQuery({
    enabled: filters.openId !== '',
    queryFn: () => getReceiptAdjustment(filters.openId),
    queryKey: ['receipt-adjustment', filters.openId],
    retry: false,
    ...adjustmentSyncOptions,
  });
  const page = listQuery.data;
  const totalPages = page?.pagination.totalPages ?? 0;

  // A page emptied by processing or filtering moves back to the last page that has rows.
  useEffect(() => {
    if (!page || listQuery.isPlaceholderData) return;
    if (page.data.length === 0 && filters.page > 1) {
      setParams(
        (current) => withParams(current, { [KEYS.adjustmentPage]: Math.max(1, totalPages) }),
        {
          replace: true,
        },
      );
    }
  }, [filters.page, listQuery.isPlaceholderData, page, setParams, totalPages]);

  useEffect(() => {
    if (filters.openId) detailRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [filters.openId]);

  const stores = storesQuery.data ?? [];
  const storeById = useMemo(() => new Map(stores.map((store) => [store.id, store])), [stores]);
  const productNameById = useMemo(
    () => new Map((catalogQuery.data ?? []).map((product) => [product.id, product.name])),
    [catalogQuery.data],
  );
  const activeProducts = useMemo(
    () =>
      (catalogQuery.data ?? [])
        .filter((product) => product.status === 'ACTIVE')
        .map((product) => ({ id: product.id, name: product.name })),
    [catalogQuery.data],
  );
  const selectedStore = filters.storeId ? storeById.get(filters.storeId) : undefined;
  const opened = openQuery.data;

  const update = (next: URLSearchParams, push = false) => setParams(next, { replace: !push });
  const openDocument = (id: string | null) => {
    if (detailDirty && id !== filters.openId) {
      setPendingOpen(id ?? '');
      return;
    }
    setPendingOpen(null);
    update(withParams(params, { [KEYS.adjustmentOpen]: id }), true);
  };
  const applyTextFilters = () => {
    if (draftFrom && draftTo && draftFrom > draftTo) {
      setFormError('Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.');
      return;
    }
    setFormError('');
    update(withAdjustmentFilters(params, { q: draftSearch, from: draftFrom, to: draftTo }));
  };

  return (
    <div className="adjustment-workspace">
      <section className="panel adjustment-workspace__filters" aria-label="Lọc phiếu sai lệch">
        <form
          className="adjustment-filter-grid"
          onSubmit={(event) => {
            event.preventDefault();
            applyTextFilters();
          }}
        >
          <label>
            Trạng thái
            <select
              onChange={(event) =>
                update(
                  withAdjustmentFilters(params, {
                    status: event.target.value as AdjustmentFilters['status'],
                  }),
                )
              }
              value={filters.status}
            >
              <option value="ALL">Tất cả trạng thái</option>
              {ADJUSTMENT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status === 'APPLIED'
                    ? `${adjustmentStatusCopy[status].label} (lịch sử)`
                    : adjustmentStatusCopy[status].label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Cửa hàng
            <select
              disabled={storesQuery.isPending}
              onChange={(event) =>
                update(
                  withStoreScope(
                    params,
                    KEYS.adjustmentStore,
                    event.target.value,
                    opened?.storeId ?? null,
                  ),
                )
              }
              value={filters.storeId}
            >
              <option value="">Mọi cửa hàng</option>
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.code} · {store.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Mã PSL hoặc mã phiếu nhận
            <input
              maxLength={40}
              onChange={(event) => setDraftSearch(event.target.value)}
              placeholder="VD: PSL-000012"
              type="search"
              value={draftSearch}
            />
          </label>
          <label>
            Lọc theo mốc
            <select
              onChange={(event) =>
                update(
                  withAdjustmentFilters(params, {
                    dateField: event.target.value as AdjustmentFilters['dateField'],
                  }),
                )
              }
              value={filters.dateField}
            >
              <option value="REPORTED">Ngày cửa hàng báo</option>
              <option value="DECIDED">Ngày xử lý (duyệt/từ chối/hủy)</option>
            </select>
          </label>
          <label>
            Từ ngày
            <input
              onChange={(event) => setDraftFrom(event.target.value)}
              type="date"
              value={draftFrom}
            />
          </label>
          <label>
            Đến ngày
            <input
              onChange={(event) => setDraftTo(event.target.value)}
              type="date"
              value={draftTo}
            />
          </label>
          <div className="adjustment-filter-grid__actions">
            <Button type="submit">Lọc</Button>
            <Button
              onClick={() => {
                setDraftSearch('');
                setDraftFrom('');
                setDraftTo('');
                setFormError('');
                update(
                  withAdjustmentFilters(params, {
                    status: 'PENDING_ADMIN',
                    storeId: '',
                    q: '',
                    dateField: 'REPORTED',
                    from: '',
                    to: '',
                  }),
                );
              }}
              tone="secondary"
            >
              Mặc định
            </Button>
          </div>
        </form>
        {formError ? (
          <div className="form-error" role="alert">
            {formError}
          </div>
        ) : null}
        <p className="adjustment-workspace__scope" aria-live="polite">
          <ClipboardList aria-hidden="true" size={16} />
          <span>
            Đang xem:{' '}
            {describeAdjustmentFilters(
              filters,
              selectedStore ? `${selectedStore.code} · ${selectedStore.name}` : null,
            )}
            {page ? ` · ${page.pagination.totalItems} hồ sơ` : ''}
          </span>
        </p>
      </section>

      <section className="panel adjustment-workspace__list" aria-label="Danh sách phiếu sai lệch">
        {listQuery.isPending ? (
          <DashboardSkeleton />
        ) : !page ? (
          <div className="receipt-error" role="alert">
            <span>
              {listQuery.error instanceof ApiClientError && listQuery.error.status === 403
                ? 'Tài khoản không có quyền xem phiếu sai lệch.'
                : 'Không tải được danh sách phiếu sai lệch.'}
            </span>
            <button onClick={() => void listQuery.refetch()} type="button">
              Thử lại
            </button>
          </div>
        ) : (
          <>
            <SyncNotice query={listQuery} />
            {page.data.length === 0 ? (
              <EmptyState
                detail={
                  filters.status === 'PENDING_ADMIN'
                    ? 'Không có hồ sơ nào HTKD đã xác minh đang chờ Admin duyệt trong phạm vi lọc.'
                    : 'Không có hồ sơ phù hợp với bộ lọc hiện tại.'
                }
                title="Không có phiếu sai lệch"
              />
            ) : (
              <div className="responsive-table adjustment-workspace__table">
                <table>
                  <thead>
                    <tr>
                      <th>Hồ sơ</th>
                      <th>Cửa hàng</th>
                      <th>Cửa hàng báo</th>
                      <th>Xác minh, gửi Admin</th>
                      <th>Nội dung</th>
                      <th>Tiền hàng</th>
                      <th>Trạng thái / xử lý</th>
                      <th>
                        <span className="sr-only">Thao tác</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.data.map((item) => {
                      const copy = adjustmentStatusCopy[item.status];
                      const money = listMoneyCopy(item);
                      const selected = item.id === filters.openId;
                      return (
                        <tr
                          aria-current={selected ? 'true' : undefined}
                          className={selected ? 'selected' : undefined}
                          key={item.id}
                        >
                          <td data-label="Hồ sơ">
                            <span className="adjustment-cell">
                              <strong>{item.code}</strong>
                              <small>Phiếu nhận {item.receiptNumber}</small>
                            </span>
                          </td>
                          <td data-label="Cửa hàng">{itemStore(item)}</td>
                          <td data-label="Cửa hàng báo">
                            <span className="adjustment-cell">
                              {accountLabel(item.reportedBy)}
                              <small>{when(item.reportedAt)}</small>
                            </span>
                          </td>
                          <td data-label="Xác minh, gửi Admin">
                            {item.verifiedBy ? (
                              <span className="adjustment-cell">
                                {accountLabel(item.verifiedBy)}
                                <small>{when(item.verifiedAt)}</small>
                              </span>
                            ) : (
                              'Chưa xác minh'
                            )}
                          </td>
                          <td data-label="Nội dung">
                            <span className="adjustment-cell">
                              <span className="adjustment-reason">{item.reason}</span>
                              <small>
                                {item.lineCount} bao
                                {item.shortageQuantity > 0
                                  ? ` · chờ bù ${item.shortageQuantity}`
                                  : ''}
                              </small>
                            </span>
                          </td>
                          <td data-label="Tiền hàng">
                            <span className="adjustment-cell">
                              {money.value ?? '—'}
                              <small>{money.label}</small>
                            </span>
                          </td>
                          <td data-label="Trạng thái / xử lý">
                            <span className="adjustment-cell">
                              <Badge tone={copy.tone}>{copy.label}</Badge>
                              {item.decidedBy ? (
                                <small>
                                  {accountLabel(item.decidedBy)} · {when(item.decidedAt)}
                                </small>
                              ) : null}
                              {item.decisionNote ? <small>{item.decisionNote}</small> : null}
                            </span>
                          </td>
                          <td data-label="Thao tác">
                            <Button
                              aria-label={`Xem chi tiết ${item.code}`}
                              onClick={() => openDocument(selected ? null : item.id)}
                              tone={selected ? 'primary' : 'secondary'}
                            >
                              <Eye aria-hidden="true" size={15} /> {selected ? 'Đang xem' : 'Xem'}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {totalPages > 1 ? (
              <div className="adjustment-pager">
                <Button
                  disabled={filters.page <= 1}
                  onClick={() =>
                    update(withParams(params, { [KEYS.adjustmentPage]: filters.page - 1 }), true)
                  }
                  tone="secondary"
                >
                  Trang trước
                </Button>
                <span>
                  Trang {filters.page}/{totalPages}
                </span>
                <Button
                  disabled={filters.page >= totalPages}
                  onClick={() =>
                    update(withParams(params, { [KEYS.adjustmentPage]: filters.page + 1 }), true)
                  }
                  tone="secondary"
                >
                  Trang sau
                </Button>
              </div>
            ) : null}
          </>
        )}
      </section>

      {pendingOpen !== null ? (
        <div
          className="receipt-review-note adjustment-outdated"
          role="alertdialog"
          aria-label="Bản nháp chưa gửi"
        >
          <span>
            <strong>Hồ sơ đang mở có nội dung chưa gửi.</strong>
            Chuyển hồ sơ sẽ bỏ bản nháp này.
          </span>
          <Button onClick={() => setPendingOpen(null)} tone="secondary">
            Ở lại
          </Button>
          <Button
            onClick={() => {
              const target = pendingOpen;
              setPendingOpen(null);
              setDetailDirty(false);
              update(withParams(params, { [KEYS.adjustmentOpen]: target || null }), true);
            }}
            tone="danger"
          >
            Bỏ nháp và chuyển
          </Button>
        </div>
      ) : null}

      {filters.openId ? (
        <section
          aria-label="Chi tiết hồ sơ sai lệch"
          className="panel adjustment-workspace__detail"
          ref={detailRef}
        >
          <div className="adjustment-workspace__detail-head">
            <strong>
              {opened
                ? `${opened.code} · ${storeLabel({ storeId: opened.storeId, code: storeById.get(opened.storeId)?.code ?? null, name: storeById.get(opened.storeId)?.name ?? null })}`
                : 'Hồ sơ sai lệch'}
            </strong>
            <Button
              aria-label="Đóng chi tiết hồ sơ"
              onClick={() => openDocument(null)}
              tone="secondary"
            >
              <X aria-hidden="true" size={15} /> Đóng
            </Button>
          </div>
          {openQuery.isPending ? (
            <DashboardSkeleton />
          ) : !opened ? (
            <div className="receipt-error" role="alert">
              <span>
                {openQuery.error instanceof ApiClientError && openQuery.error.status === 404
                  ? 'Không tìm thấy hồ sơ sai lệch này.'
                  : openQuery.error instanceof ApiClientError && openQuery.error.status === 403
                    ? 'Tài khoản không có quyền xem hồ sơ này.'
                    : 'Không tải được hồ sơ sai lệch.'}
              </span>
              <button onClick={() => void openQuery.refetch()} type="button">
                Thử lại
              </button>
            </div>
          ) : (
            <DraftScope onDirtyChange={setDetailDirty}>
              <AdjustmentDetailPanel
                adjustmentId={opened.id}
                key={opened.id}
                productNameById={productNameById}
                products={activeProducts}
                receiptId={opened.receiptId}
                role="ADMIN"
              />
            </DraftScope>
          )}
        </section>
      ) : null}
    </div>
  );
}
