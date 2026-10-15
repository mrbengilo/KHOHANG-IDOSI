import { DataTable } from '../../components/DataTable';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '../../components/Button';
import { formatDocumentTime } from '../../lib/business-time';
import { formatInteger } from '../../lib/format';
import { Pager } from './ReconciliationWorkspace';
import { loadSupplierHistory } from './supplierApi';

/** Immutable record of every confirmed observation: S, before/after and who confirmed it. */
export function ObservationHistory({ accountId }: { readonly accountId: string }) {
  const [page, setPage] = useState(1);
  const history = useQuery({
    queryKey: ['supplier-history', accountId, page],
    queryFn: ({ signal }) => loadSupplierHistory({ page }, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });
  return (
    <section className="panel supplier-history" aria-label="Lịch sử đối chiếu tồn Reshare">
      <h2>Lịch sử đối chiếu</h2>
      {history.isPending ? (
        <p role="status">Đang tải lịch sử đối chiếu…</p>
      ) : history.isError ? (
        <div role="alert" className="supplier-error">
          <p>Không tải được lịch sử đối chiếu.</p>
          <Button tone="secondary" onClick={() => void history.refetch()}>
            Thử lại
          </Button>
        </div>
      ) : history.data.data.length === 0 ? (
        <p className="supplier-empty">Chưa có lần đối chiếu nào.</p>
      ) : (
        <>
          <div className="responsive-table supplier-table-scroll table-cards-narrow">
            <DataTable className="supplier-table">
              <thead>
                <tr>
                  <th scope="col" className="table-index">
                    STT
                  </th>
                  <th data-primary-column scope="col">
                    Mặt hàng
                  </th>
                  <th scope="col">Xem tồn lúc</th>
                  <th scope="col">Reshare cho đặt</th>
                  <th scope="col">Chưa đặt (U)</th>
                  <th scope="col">Khả dụng sau</th>
                  <th scope="col">Thiếu nguồn</th>
                  <th scope="col">Tồn sổ kho trước → sau</th>
                  <th scope="col">Người xác nhận</th>
                </tr>
              </thead>
              <tbody>
                {history.data.data.map((row, rowIndex) => (
                  <tr key={row.lineId}>
                    <td className="table-index" data-label="STT">
                      {(history.data.pagination.page - 1) * history.data.pagination.pageSize +
                        rowIndex +
                        1}
                    </td>
                    <td data-primary-column data-label="Mặt hàng">
                      <strong>{row.productName}</strong>
                    </td>
                    <td data-label="Xem tồn lúc">
                      <time dateTime={row.observedAt}>{formatDocumentTime(row.observedAt)}</time>
                      <small>Lưu {formatDocumentTime(row.recordedAt)}</small>
                    </td>
                    <td className="table-number" data-label="Reshare cho đặt">
                      {formatInteger(row.observedQuantity)}
                      {row.coveredEventCount > 0 ? (
                        <small>gồm {row.coveredEventCount} biến động đã ghi</small>
                      ) : null}
                    </td>
                    <td className="table-number" data-label="Chưa đặt (U)">
                      {formatInteger(row.unorderedCommitmentQuantity)}
                      {row.attestedUnlinkedQuantity > 0 ? (
                        <small>{row.attestedUnlinkedQuantity} xác nhận chưa đặt khi bật</small>
                      ) : null}
                    </td>
                    <td className="table-number" data-label="Khả dụng sau">
                      <strong>{formatInteger(row.freeQuantity)}</strong>
                    </td>
                    <td className="table-number" data-label="Thiếu nguồn">
                      {formatInteger(row.shortfallQuantity)}
                    </td>
                    <td className="table-number" data-label="Tồn sổ kho trước → sau">
                      {formatInteger(row.onHandBefore)} → {formatInteger(row.onHandAfter)}
                      <small>đang giữ {formatInteger(row.reservedBefore)}</small>
                    </td>
                    <td data-label="Người xác nhận">
                      {row.createdByDisplayName}
                      {row.evidenceRef ? <small>Chứng từ: {row.evidenceRef}</small> : null}
                      {row.note ? <small>{row.note}</small> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
          <Pager
            page={page}
            totalPages={history.data.pagination.totalPages}
            onPage={setPage}
            disabled={history.isFetching}
          />
        </>
      )}
    </section>
  );
}
