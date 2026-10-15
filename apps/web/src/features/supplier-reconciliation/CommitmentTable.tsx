import { DataTable } from '../../components/DataTable';
import type { SupplierCommitment, SupplierCommitmentsResponse } from '@idosi/contracts';

import { Badge } from '../../components/Badge';
import { formatDocumentTime } from '../../lib/business-time';
import { formatInteger } from '../../lib/format';
import { NOT_ORDERABLE_LABEL, ORDER_STATE_LABEL, ORDER_STATE_TONE, pageTotals } from './model';

const KIND_LABEL: Record<SupplierCommitment['kind'], string> = {
  OFFER_HOLD: 'Giữ ưu tiên (chờ phản hồi)',
  RESERVATION: 'Đã phân bổ / giữ hàng',
};

const DECISION_LABEL: Record<string, string> = {
  pending: 'Chờ cửa hàng chấp nhận',
  accepted: 'Đã chấp nhận',
  rejected: 'Đã từ chối',
  not_required: 'Không cần xác nhận',
  legacy: 'Kết quả cũ',
};

/**
 * Commitments of reconciled SKUs: what A holds for which store, from which session/result, and
 * what Reshare has recorded. `selection` turns the table into the HTKD order picker.
 */
export function CommitmentTable({
  page,
  caption,
  selection,
  showProduct = true,
}: {
  readonly page: SupplierCommitmentsResponse;
  readonly caption: string;
  readonly showProduct?: boolean;
  readonly selection?: {
    readonly quantities: ReadonlyMap<string, string>;
    readonly lineRefs: ReadonlyMap<string, string>;
    readonly onToggle: (row: SupplierCommitment, selected: boolean) => void;
    readonly onQuantity: (row: SupplierCommitment, value: string) => void;
    readonly onLineRef: (row: SupplierCommitment, value: string) => void;
    readonly disabled: boolean;
  };
}) {
  const current = pageTotals(page.data);
  const multiPage = page.pagination.totalPages > 1;
  return (
    <>
      <p className="supplier-totals" aria-live="polite">
        {caption}: {formatInteger(page.totals.quantity)} bao đang giữ, đã đặt Reshare{' '}
        {formatInteger(page.totals.orderedQuantity)}, chưa đặt{' '}
        <strong>{formatInteger(page.totals.unorderedQuantity)}</strong> bao
        {multiPage
          ? ` (trang này: ${formatInteger(current.quantity)} giữ / ${formatInteger(current.unorderedQuantity)} chưa đặt)`
          : ''}
        .{page.scoped ? ' Chỉ gồm cửa hàng của tài khoản, không phải toàn hệ thống.' : ''}
      </p>
      <div className="responsive-table supplier-table-scroll">
        <DataTable className="supplier-table">
          <thead>
            <tr>
              <th scope="col" className="table-index">
                STT
              </th>
              {selection ? <th scope="col">Chọn</th> : null}
              <th scope="col">Cửa hàng</th>
              {showProduct ? <th scope="col">Mặt hàng</th> : null}
              <th scope="col">Phiên / kết quả</th>
              <th scope="col">Loại giữ</th>
              <th scope="col">Giữ</th>
              <th scope="col">Đã đặt</th>
              <th scope="col">Chưa đặt</th>
              <th scope="col">Trạng thái Reshare</th>
              <th scope="col">Từ lúc</th>
              {selection ? <th scope="col">Số bao Reshare nhận</th> : null}
            </tr>
          </thead>
          <tbody>
            {page.data.map((row, rowIndex) => {
              const selected = selection?.quantities.has(row.id) ?? false;
              return (
                <tr key={`${row.kind}:${row.id}`} className={selected ? 'is-selected' : undefined}>
                  <td className="table-index" data-label="STT">
                    {(page.pagination.page - 1) * page.pagination.pageSize + rowIndex + 1}
                  </td>
                  {selection ? (
                    <td data-label="Chọn">
                      <input
                        aria-label={`Chọn ${row.productName} của ${row.storeName}`}
                        checked={selected}
                        disabled={selection.disabled || !row.orderable}
                        onChange={(event) => selection.onToggle(row, event.target.checked)}
                        type="checkbox"
                      />
                    </td>
                  ) : null}
                  <td data-primary-column data-label="Cửa hàng">
                    <strong>{row.storeCode}</strong>
                    <small>
                      <span className="store-name">{row.storeName}</span>
                    </small>
                    {row.htkdNames.length > 0 ? (
                      <small>HTKD: {row.htkdNames.join(', ')}</small>
                    ) : null}
                  </td>
                  {showProduct ? (
                    <td data-label="Mặt hàng">
                      <strong>{row.productName}</strong>
                    </td>
                  ) : null}
                  <td data-label="Phiên / kết quả">
                    <span>{row.orderSessionCode ?? 'Chưa ghi nhận phiên'}</span>
                    {row.businessDate ? <small>Ngày {row.businessDate}</small> : null}
                    {row.decisionStatus ? (
                      <small>{DECISION_LABEL[row.decisionStatus] ?? row.decisionStatus}</small>
                    ) : null}
                    {row.outboundRequestNumber ? (
                      <small>Phiếu xuất {row.outboundRequestNumber}</small>
                    ) : null}
                  </td>
                  <td data-label="Loại giữ">
                    {KIND_LABEL[row.kind]}
                    {row.priorityLevel ? <small>{row.priorityLevel}</small> : null}
                  </td>
                  <td className="table-number" data-label="Giữ">
                    {formatInteger(row.quantity)}
                  </td>
                  <td className="table-number" data-label="Đã đặt">
                    {formatInteger(row.orderedQuantity)}
                  </td>
                  <td className="table-number" data-label="Chưa đặt">
                    <strong>{formatInteger(row.unorderedQuantity)}</strong>
                  </td>
                  <td data-label="Trạng thái Reshare">
                    <Badge tone={ORDER_STATE_TONE[row.orderState]}>
                      {ORDER_STATE_LABEL[row.orderState]}
                    </Badge>
                    {row.notOrderableReason && row.notOrderableReason !== 'FULLY_ORDERED' ? (
                      <small>{NOT_ORDERABLE_LABEL[row.notOrderableReason]}</small>
                    ) : null}
                  </td>
                  <td data-label="Từ lúc">
                    <time dateTime={row.heldSince}>{formatDocumentTime(row.heldSince)}</time>
                    {row.deadlineAt ? (
                      <small>Hạn phản hồi {formatDocumentTime(row.deadlineAt)}</small>
                    ) : null}
                  </td>
                  {selection ? (
                    <td data-label="Số bao Reshare nhận">
                      {selected ? (
                        <div className="supplier-order-inputs">
                          <label className="supplier-order-input">
                            <input
                              aria-label={`Số bao Reshare đã nhận cho ${row.productName} của ${row.storeName}`}
                              disabled={selection.disabled}
                              inputMode="numeric"
                              max={row.unorderedQuantity}
                              min={1}
                              onChange={(event) => selection.onQuantity(row, event.target.value)}
                              type="number"
                              value={selection.quantities.get(row.id) ?? ''}
                            />
                          </label>
                          <label className="supplier-order-input">
                            <input
                              aria-label={`Dòng đơn Reshare cho ${row.productName} của ${row.storeName}`}
                              disabled={selection.disabled}
                              maxLength={100}
                              onChange={(event) => selection.onLineRef(row, event.target.value)}
                              placeholder="Dòng đơn"
                              value={selection.lineRefs.get(row.id) ?? row.sku}
                            />
                          </label>
                        </div>
                      ) : (
                        <small>—</small>
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      </div>
      {page.data.length === 0 ? (
        <p className="supplier-empty">Không có lượng giữ phù hợp.</p>
      ) : null}
    </>
  );
}
