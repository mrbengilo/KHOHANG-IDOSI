import type { HeldAllocation } from '@idosi/contracts';
import { useQuery } from '@tanstack/react-query';
import { Clock3 } from 'lucide-react';

import { Badge } from '../../components/Badge';
import { listHeldAllocations } from '../../lib/api';

export interface HeldAllocationRow {
  readonly key: string;
  readonly storeName: string;
  readonly productName: string;
  readonly heldUnits: number;
  readonly heldSince: string;
}

/** Oldest hold first: the longest wait is the one people should notice. */
export function heldAllocationRows(
  rows: readonly HeldAllocation[],
  storeNameById: ReadonlyMap<string, string>,
  productNameById: ReadonlyMap<string, string>,
): HeldAllocationRow[] {
  return [...rows]
    .sort(
      (left, right) =>
        left.heldSince.localeCompare(right.heldSince) ||
        left.storeId.localeCompare(right.storeId) ||
        left.productId.localeCompare(right.productId),
    )
    .map((row) => ({
      key: `${row.storeId}:${row.productId}`,
      storeName: storeNameById.get(row.storeId) ?? row.storeId,
      productName: productNameById.get(row.productId) ?? row.productId,
      heldUnits: row.heldUnits,
      heldSince: row.heldSince,
    }));
}

export function HeldAllocationsPanel({
  storeId,
  audience,
  storeNameById,
  productNameById,
}: {
  /** Restricts to one store; omit to show every store the account may see. */
  readonly storeId?: string;
  readonly audience: 'STORE' | 'OPERATIONS';
  readonly storeNameById: ReadonlyMap<string, string>;
  readonly productNameById: ReadonlyMap<string, string>;
}) {
  const heldQuery = useQuery({
    queryFn: () => listHeldAllocations(storeId),
    queryKey: ['held-allocations', storeId ?? 'all'],
    retry: false,
  });
  if (heldQuery.isPending) return null;
  if (heldQuery.isError) {
    return (
      <section className="panel held-allocations" aria-label="Hàng ưu tiên đang giữ chờ giao chung">
        <p role="alert">
          Không tải được danh sách hàng đang giữ chờ giao chung. Hãy tải lại trang để thử lại.
        </p>
      </section>
    );
  }
  if (heldQuery.data.length === 0) return null;
  const rows = heldAllocationRows(heldQuery.data, storeNameById, productNameById);
  const totalUnits = rows.reduce((total, row) => total + row.heldUnits, 0);

  return (
    <section className="panel held-allocations" aria-label="Hàng ưu tiên đang giữ chờ giao chung">
      <div className="section-heading section-heading--compact">
        <div>
          <h2>
            <Clock3 aria-hidden="true" size={18} /> Hàng ưu tiên đang giữ chờ giao chung
          </h2>
          <p>
            {audience === 'STORE'
              ? 'Hàng này đã được phân bổ và đang giữ riêng cho cửa hàng tại kho tổng. Theo quy tắc giao chung, hàng sẽ được xuất cùng đơn đặt hàng thường kế tiếp của cửa hàng và khi đó hiện ở mục chờ nhận bên dưới.'
              : 'Đã phân bổ và giữ tại kho tổng, chưa có phiếu xuất. Theo quy tắc giao chung, hàng tự được xuất cùng đơn đặt hàng thường kế tiếp của cửa hàng.'}
          </p>
        </div>
        <Badge tone="warning">{totalUnits} bao đang giữ</Badge>
      </div>
      <div className="responsive-table">
        <table>
          <thead>
            <tr>
              {audience === 'OPERATIONS' ? <th>Cửa hàng</th> : null}
              <th>Mặt hàng</th>
              <th>Số bao đang giữ</th>
              <th>Giữ từ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                {audience === 'OPERATIONS' ? <td data-label="Cửa hàng">{row.storeName}</td> : null}
                <td data-label="Mặt hàng">{row.productName}</td>
                <td data-label="Số bao đang giữ">{row.heldUnits} bao</td>
                <td data-label="Giữ từ">
                  {new Date(row.heldSince).toLocaleString('vi-VN', {
                    timeZone: 'Asia/Ho_Chi_Minh',
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
