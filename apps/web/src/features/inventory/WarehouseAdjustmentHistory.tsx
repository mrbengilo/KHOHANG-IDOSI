import type { WarehouseStockAdjustment } from '@idosi/contracts';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { listCatalog } from '../../lib/api';
import { formatInteger } from '../../lib/format';
import { loadWarehouseAdjustments } from './inventoryApi';
import { KEYS, withParams, type InventoryNavigation } from './inventoryNavigation';
import { warehouseAdjustmentReasonLabel } from './WarehouseAdjustmentDialog';

const timestamp = new Intl.DateTimeFormat('vi-VN', {
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
  month: '2-digit',
  second: '2-digit',
  timeZone: 'Asia/Ho_Chi_Minh',
  year: 'numeric',
});

export function formatAdjustmentTime(value: string): string {
  return timestamp.format(new Date(value));
}

export function signedBags(adjustment: Pick<WarehouseStockAdjustment, 'delta'>): string {
  return `${adjustment.delta > 0 ? '+' : '−'}${formatInteger(Math.abs(adjustment.delta))} bao`;
}

/**
 * Immutable adjustment documents, newest first, paged and filtered by the server. A wrong
 * adjustment is corrected by a new opposite one; nothing here edits or deletes a row.
 */
export function WarehouseAdjustmentHistory({
  filters,
}: {
  readonly filters: InventoryNavigation['warehouse']['adjustments'];
}) {
  const [, setParams] = useSearchParams();
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: listCatalog, retry: false });
  const query = {
    ...(filters.productId ? { productId: filters.productId } : {}),
    ...(filters.direction === 'ALL' ? {} : { direction: filters.direction }),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
  };
  const history = useQuery({
    queryKey: ['warehouse-adjustments', filters.page, query],
    queryFn: ({ signal }) => loadWarehouseAdjustments(filters.page, query, signal),
    placeholderData: (previous) => previous,
    retry: false,
  });
  // Any filter change starts again at the first page.
  const setFilter = (key: string, value: string) =>
    setParams(
      (current) => withParams(current, { [key]: value, [KEYS.warehouseAdjustmentPage]: 1 }),
      { replace: true },
    );
  const setPage = (page: number) =>
    setParams((current) => withParams(current, { [KEYS.warehouseAdjustmentPage]: page }));
  const products = (catalog.data ?? []).toSorted((left, right) =>
    left.name.localeCompare(right.name, 'vi'),
  );
  const data = history.data;

  return (
    <section className="panel warehouse-stock-panel" aria-label="Lịch sử điều chỉnh tồn kho tổng">
      <h2>Lịch sử điều chỉnh tồn kho tổng</h2>
      <p>
        Mỗi điều chỉnh là một chứng từ bất biến kèm bút toán sổ kho. Muốn sửa sai, tạo điều chỉnh
        ngược chiều mới; phiếu cũ được giữ nguyên để đối soát.
      </p>
      <div className="filter-card warehouse-adjustment-filters" aria-label="Bộ lọc điều chỉnh">
        <label>
          Mặt hàng
          <select
            onChange={(event) => setFilter(KEYS.warehouseAdjustmentProduct, event.target.value)}
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
          Hướng
          <select
            onChange={(event) => setFilter(KEYS.warehouseAdjustmentDirection, event.target.value)}
            value={filters.direction}
          >
            <option value="ALL">Tăng và giảm</option>
            <option value="INCREASE">Chỉ tăng tồn</option>
            <option value="DECREASE">Chỉ giảm tồn</option>
          </select>
        </label>
        <label>
          Từ ngày
          <input
            onChange={(event) => setFilter(KEYS.warehouseAdjustmentFrom, event.target.value)}
            type="date"
            value={filters.from}
          />
        </label>
        <label>
          Đến ngày
          <input
            onChange={(event) => setFilter(KEYS.warehouseAdjustmentTo, event.target.value)}
            type="date"
            value={filters.to}
          />
        </label>
      </div>
      {history.isPending ? (
        <p role="status">Đang tải lịch sử điều chỉnh…</p>
      ) : history.isError && !data ? (
        <div className="form-error" role="alert">
          <span>Không tải được lịch sử điều chỉnh. Kiểm tra kết nối rồi thử lại.</span>
          <Button onClick={() => void history.refetch()} tone="secondary">
            Thử lại
          </Button>
        </div>
      ) : data ? (
        <>
          {history.isError ? (
            <p role="alert">Không cập nhật được dữ liệu mới nhất; đang hiển thị lần tải trước.</p>
          ) : null}
          {history.isFetching ? <p role="status">Đang cập nhật…</p> : null}
          <div className="responsive-table">
            <table className="table-density warehouse-adjustment-table">
              <thead>
                <tr>
                  <th>Phiếu / thời gian</th>
                  <th>Mặt hàng</th>
                  <th>Thay đổi</th>
                  <th>Đang có tại kho</th>
                  <th>Đang giữ</th>
                  <th>Lý do</th>
                  <th>Người thực hiện</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((adjustment) => (
                  <tr key={adjustment.id}>
                    <td data-label="Phiếu / thời gian">
                      <strong>{adjustment.code}</strong>
                      <small>{formatAdjustmentTime(adjustment.createdAt)}</small>
                    </td>
                    <td data-label="Mặt hàng">
                      <strong>{adjustment.productName}</strong>
                      <small>{adjustment.sku}</small>
                    </td>
                    <td data-label="Thay đổi">
                      <Badge tone={adjustment.delta > 0 ? 'success' : 'danger'}>
                        {signedBags(adjustment)}
                      </Badge>
                    </td>
                    <td data-label="Đang có tại kho">
                      {formatInteger(adjustment.before.onHand)} →{' '}
                      {formatInteger(adjustment.after.onHand)} bao
                      <small>
                        Khả dụng {formatInteger(adjustment.before.available)} →{' '}
                        {formatInteger(adjustment.after.available)}
                      </small>
                    </td>
                    <td data-label="Đang giữ">{formatInteger(adjustment.after.reserved)} bao</td>
                    <td data-label="Lý do">
                      <strong>{warehouseAdjustmentReasonLabel[adjustment.reasonCode]}</strong>
                      <small>{adjustment.reason}</small>
                      {adjustment.compensatesAdjustmentId ? <small>Phiếu bù sai sót</small> : null}
                    </td>
                    <td data-label="Người thực hiện">{adjustment.createdBy.displayName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.data.length === 0 ? <p>Chưa có điều chỉnh tồn phù hợp bộ lọc.</p> : null}
          <div className="inventory-actions">
            <Button
              disabled={filters.page <= 1 || history.isFetching}
              onClick={() => setPage(filters.page - 1)}
              tone="secondary"
            >
              Trang trước
            </Button>
            <span>
              Trang {filters.page}/{Math.max(1, data.pagination.totalPages)} ·{' '}
              {formatInteger(data.pagination.totalItems)} phiếu
            </span>
            <Button
              disabled={filters.page >= data.pagination.totalPages || history.isFetching}
              onClick={() => setPage(filters.page + 1)}
              tone="secondary"
            >
              Trang sau
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
