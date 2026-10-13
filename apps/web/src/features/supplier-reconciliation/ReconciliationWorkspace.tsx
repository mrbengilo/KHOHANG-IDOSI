import type { SupplierReconciliationFilter, SupplierReconciliationRow } from '@idosi/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useState } from 'react';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { formatDocumentTime } from '../../lib/business-time';
import { formatInteger } from '../../lib/format';
import { CommitmentTable } from './CommitmentTable';
import { STATE_LABEL, STATE_TONE, positionSentence } from './model';
import { ObservationForm, type ObservationTarget } from './ObservationForm';
import {
  loadSupplierCommitments,
  loadSupplierReconciliation,
  loadSupplierSources,
} from './supplierApi';

const FILTERS: readonly { id: SupplierReconciliationFilter; label: string }[] = [
  { id: 'ALL', label: 'Tất cả' },
  { id: 'COMMITTED', label: 'Có hàng đang giữ' },
  { id: 'UNORDERED', label: 'Có phần chưa đặt Reshare' },
  { id: 'SHORTFALL', label: 'Thiếu nguồn' },
  { id: 'NEEDS_RECONCILIATION', label: 'Cần đối chiếu' },
];

/** Admin workspace: per-SKU numbers, drill-down to commitments and the observation form. */
export function ReconciliationWorkspace({
  accountId,
  onOpenSettings,
}: {
  readonly accountId: string;
  readonly onOpenSettings: () => void;
}) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [draftSearch, setDraftSearch] = useState('');
  const [filter, setFilter] = useState<SupplierReconciliationFilter>('ALL');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, ObservationTarget>>(new Map());
  const [formTargets, setFormTargets] = useState<readonly ObservationTarget[] | null>(null);
  const [notice, setNotice] = useState('');
  const sources = useQuery({
    queryKey: ['supplier-sources', accountId],
    queryFn: ({ signal }) => loadSupplierSources(signal),
    retry: false,
  });
  const selectionSources = new Set([...selected.values()].map((target) => target.sourceId));
  const summary = useQuery({
    queryKey: ['supplier-reconciliation', accountId, page, search, filter],
    queryFn: ({ signal }) => loadSupplierReconciliation({ page, search, filter }, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });
  useEffect(() => setPage(1), [search, filter]);

  const toggle = (row: SupplierReconciliationRow, checked: boolean) =>
    setSelected((current) => {
      const next = new Map(current);
      if (checked) next.set(row.productId, targetOf(row));
      else next.delete(row.productId);
      return next;
    });

  if (sources.isSuccess && sources.data.length === 0) {
    return (
      <section className="panel supplier-empty-state">
        <h2>Chưa cấu hình nguồn Reshare</h2>
        <p>
          Tạo nguồn Reshare và chọn các mặt hàng lấy từ nguồn này trước khi đối chiếu. Mặt hàng chưa
          chọn vẫn nhập kho theo phiếu nhập như cũ.
        </p>
        <Button onClick={onOpenSettings}>Mở cấu hình nguồn</Button>
      </section>
    );
  }

  return (
    <>
      {notice ? (
        <div className="supplier-notice" role="status">
          {notice}
        </div>
      ) : null}
      {formTargets && formTargets[0] ? (
        <ObservationForm
          onCancel={() => setFormTargets(null)}
          onDone={(message) => {
            setFormTargets(null);
            setSelected(new Map());
            setNotice(message);
          }}
          sourceId={formTargets[0].sourceId}
          targets={formTargets}
        />
      ) : null}
      <section className="panel supplier-summary" aria-label="Cập nhật tồn Reshare theo mặt hàng">
        <h2>Số liệu theo mặt hàng</h2>
        <p className="supplier-hint">
          Khả dụng = Reshare còn cho đặt − phần IDOSI đã giữ/cấp nhưng HTKD chưa đặt Reshare. Số
          Reshare là quan sát thủ công tại thời điểm xem, không phải số thời gian thực.
        </p>
        <form
          className="supplier-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(draftSearch.trim());
          }}
        >
          <label>
            Tìm mặt hàng
            <input
              maxLength={120}
              onChange={(event) => setDraftSearch(event.target.value)}
              type="search"
              value={draftSearch}
            />
          </label>
          <label>
            Lọc
            <select
              onChange={(event) => setFilter(event.target.value as SupplierReconciliationFilter)}
              value={filter}
            >
              {FILTERS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" tone="secondary">
            Tìm
          </Button>
          <Button
            disabled={selected.size === 0 || selectionSources.size > 1}
            onClick={() => {
              setNotice('');
              setFormTargets([...selected.values()]);
            }}
          >
            Đối chiếu {selected.size > 0 ? `${selected.size} mặt hàng` : ''}
          </Button>
        </form>
        {selectionSources.size > 1 ? (
          <p className="form-error" role="alert">
            Các mặt hàng đã chọn thuộc nhiều nguồn; mỗi lần đối chiếu chỉ cho một nguồn Reshare.
          </p>
        ) : null}
        {summary.isPending ? (
          <p role="status">Đang tải số liệu đối chiếu…</p>
        ) : summary.isError ? (
          <div role="alert" className="supplier-error">
            <p>Không tải được số liệu đối chiếu.</p>
            <Button tone="secondary" onClick={() => void summary.refetch()}>
              Thử lại
            </Button>
          </div>
        ) : (
          <>
            {summary.isFetching ? (
              <p className="supplier-refreshing" role="status">
                Đang cập nhật…
              </p>
            ) : null}
            <div className="responsive-table supplier-table-scroll">
              <table className="supplier-table supplier-summary-table">
                <thead>
                  <tr>
                    <th scope="col">Chọn</th>
                    <th scope="col">Mặt hàng</th>
                    <th scope="col">Reshare cho đặt (S)</th>
                    <th scope="col">Biến động sau</th>
                    <th scope="col">Giữ ưu tiên</th>
                    <th scope="col">Đã cấp chưa đặt</th>
                    <th scope="col">Đã đặt chờ giao</th>
                    <th scope="col">Khả dụng</th>
                    <th scope="col">Thiếu nguồn</th>
                    <th scope="col">Trạng thái</th>
                    <th scope="col">Chi tiết</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.data.data.map((row) => {
                    const open = expanded === row.productId;
                    const detailId = `supplier-detail-${row.productId}`;
                    return (
                      <Fragment key={row.productId}>
                        <tr>
                          <td data-label="Chọn">
                            <input
                              aria-label={`Chọn ${row.sku} để đối chiếu`}
                              checked={selected.has(row.productId)}
                              onChange={(event) => toggle(row, event.target.checked)}
                              type="checkbox"
                            />
                          </td>
                          <td data-label="Mặt hàng">
                            <strong>{row.productName}</strong>
                            <small>
                              {row.sku} · nguồn {row.sourceCode}
                            </small>
                          </td>
                          <td data-label="Reshare cho đặt (S)">
                            {row.baseline ? (
                              <>
                                <strong>{formatInteger(row.baseline.observedQuantity)}</strong>
                                <small>lúc {formatDocumentTime(row.baseline.observedAt)}</small>
                              </>
                            ) : (
                              'Chưa có'
                            )}
                          </td>
                          <td className="table-number" data-label="Biến động sau">
                            {formatInteger(row.position.pendingDelta)}
                            {row.position.ambiguousEventCount > 0 ? (
                              <small>{row.position.ambiguousEventCount} cần trả lời</small>
                            ) : null}
                          </td>
                          <td className="table-number" data-label="Giữ ưu tiên">
                            {formatInteger(row.position.offerHoldQuantity)}
                          </td>
                          <td className="table-number" data-label="Đã cấp chưa đặt">
                            {formatInteger(row.position.unorderedReservedQuantity)}
                          </td>
                          <td className="table-number" data-label="Đã đặt chờ giao">
                            {formatInteger(row.position.orderedReservedQuantity)}
                          </td>
                          <td className="table-number supplier-free" data-label="Khả dụng">
                            <strong>{formatInteger(row.position.freeQuantity)}</strong>
                            {row.position.projectionMismatch ? (
                              <small>
                                Sổ kho đang ghi {formatInteger(row.position.ledgerAvailable)}
                              </small>
                            ) : null}
                          </td>
                          <td
                            className={
                              row.position.shortfallQuantity > 0
                                ? 'table-number supplier-shortfall'
                                : 'table-number'
                            }
                            data-label="Thiếu nguồn"
                          >
                            {formatInteger(row.position.shortfallQuantity)}
                          </td>
                          <td data-label="Trạng thái">
                            <Badge tone={STATE_TONE[row.position.state]}>
                              {STATE_LABEL[row.position.state]}
                            </Badge>
                            {row.blockReason ? <small>{row.blockReason}</small> : null}
                          </td>
                          <td data-label="Chi tiết">
                            <div className="supplier-row-actions">
                              <Button
                                aria-controls={detailId}
                                aria-expanded={open}
                                onClick={() => setExpanded(open ? null : row.productId)}
                                tone="secondary"
                              >
                                {open ? 'Thu gọn' : 'Xem giữ hàng'}
                              </Button>
                              <Button
                                onClick={() => {
                                  setNotice('');
                                  setFormTargets([targetOf(row)]);
                                }}
                                tone="secondary"
                              >
                                Đối chiếu
                              </Button>
                            </div>
                          </td>
                        </tr>
                        {open ? (
                          <tr className="supplier-detail-row">
                            <td colSpan={11} id={detailId}>
                              <p className="supplier-hint">{positionSentence(row.position)}</p>
                              <CommitmentDetail accountId={accountId} productId={row.productId} />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {summary.data.data.length === 0 ? (
              <p className="supplier-empty">Không có mặt hàng phù hợp bộ lọc.</p>
            ) : null}
            <Pager
              page={page}
              totalPages={summary.data.pagination.totalPages}
              onPage={setPage}
              disabled={summary.isFetching}
            />
          </>
        )}
      </section>
    </>
  );
}

function targetOf(row: SupplierReconciliationRow): ObservationTarget {
  return {
    productId: row.productId,
    sourceId: row.sourceId,
    sourceCode: row.sourceCode,
    sku: row.sku,
    productName: row.productName,
    baselineQuantity: row.baseline?.observedQuantity ?? null,
  };
}

/** Holds of one SKU across every store and session still in force (no date window). */
function CommitmentDetail({
  accountId,
  productId,
}: {
  readonly accountId: string;
  readonly productId: string;
}) {
  const [page, setPage] = useState(1);
  const detail = useQuery({
    queryKey: ['supplier-commitments', accountId, 'product', productId, page],
    queryFn: ({ signal }) => loadSupplierCommitments({ page, filter: 'ALL', productId }, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });
  if (detail.isPending) return <p role="status">Đang tải hàng đang giữ…</p>;
  if (detail.isError) {
    return (
      <div role="alert" className="supplier-error">
        <p>Không tải được hàng đang giữ.</p>
        <Button tone="secondary" onClick={() => void detail.refetch()}>
          Thử lại
        </Button>
      </div>
    );
  }
  return (
    <>
      <CommitmentTable caption="Toàn bộ mặt hàng này" page={detail.data} showProduct={false} />
      <Pager
        page={page}
        totalPages={detail.data.pagination.totalPages}
        onPage={setPage}
        disabled={detail.isFetching}
      />
    </>
  );
}

export function Pager({
  page,
  totalPages,
  onPage,
  disabled,
}: {
  readonly page: number;
  readonly totalPages: number;
  readonly onPage: (page: number) => void;
  readonly disabled: boolean;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="button-row supplier-pager">
      <Button disabled={disabled || page <= 1} onClick={() => onPage(page - 1)} tone="secondary">
        Trang trước
      </Button>
      <span>
        Trang {page}/{totalPages}
      </span>
      <Button
        disabled={disabled || page >= totalPages}
        onClick={() => onPage(page + 1)}
        tone="secondary"
      >
        Trang sau
      </Button>
    </div>
  );
}
