import type { Receipt, Store, StoreOrderRequest } from '@idosi/contracts';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Button } from '../../components/Button';
import { StatCard } from '../../components/StatCard';
import { businessDate } from '../../lib/business-time';
import { listAccessibleOrderRequests, listCatalog, listStoreReceipts } from '../../lib/api';
import type { DashboardScope } from './dashboardApi';

interface ProductTotal {
  readonly productId: string;
  readonly ordered: number;
  readonly received: number;
}

export function wholesaleTotals(
  stores: readonly Store[],
  orders: readonly StoreOrderRequest[],
  receipts: readonly Receipt[],
  period: string,
): Map<string, ProductTotal[]> {
  const totals = new Map<string, Map<string, { ordered: number; received: number }>>(
    stores.map((store) => [store.id, new Map()]),
  );
  for (const order of orders) {
    if (
      order.status === 'CANCELLED' ||
      businessDate(new Date(order.submittedAt)).slice(0, 7) !== period
    )
      continue;
    const products = totals.get(order.storeId);
    if (!products) continue;
    for (const line of order.lines) {
      if (line.requested.kind !== 'UNIT') continue;
      const current = products.get(line.productId) ?? { ordered: 0, received: 0 };
      current.ordered += line.requested.quantity;
      products.set(line.productId, current);
    }
  }
  for (const receipt of receipts) {
    if (
      !['PENDING_HTKD', 'FINALIZED'].includes(receipt.status) ||
      businessDate(new Date(receipt.createdAt)).slice(0, 7) !== period
    )
      continue;
    const products = totals.get(receipt.storeId);
    if (!products) continue;
    for (const line of receipt.lines) {
      const current = products.get(line.productId) ?? { ordered: 0, received: 0 };
      current.received += line.receivedUnits;
      products.set(line.productId, current);
    }
    for (const item of receipt.unexpectedItems ?? []) {
      const current = products.get(item.productId) ?? { ordered: 0, received: 0 };
      current.received += item.quantity;
      products.set(item.productId, current);
    }
  }
  return new Map(
    [...totals].map(([storeId, products]) => [
      storeId,
      [...products].map(([productId, amount]) => ({ productId, ...amount })),
    ]),
  );
}

export function WholesaleOverview({
  accountId,
  period,
  scope,
  stores,
}: {
  readonly accountId: string;
  readonly period: string;
  readonly scope: DashboardScope;
  readonly stores: readonly Store[];
}) {
  const wholesaleStores = useMemo(
    () => stores.filter((store) => store.kind === 'WHOLESALE'),
    [stores],
  );
  const query = useQuery({
    queryFn: async () => {
      const [orders, receipts, products] = await Promise.all([
        listAccessibleOrderRequests(),
        listStoreReceipts(),
        listCatalog(),
      ]);
      return { orders, receipts, products };
    },
    queryKey: ['wholesale-overview', accountId],
    retry: false,
  });
  if (query.isPending)
    return (
      <section className="panel" role="status">
        Đang tải thống kê cửa hàng sỉ…
      </section>
    );
  if (query.isError)
    return (
      <section className="panel form-error" role="alert">
        <p>Không thể tải thống kê đặt và nhận hàng.</p>
        <Button onClick={() => void query.refetch()} tone="secondary">
          Thử lại
        </Button>
      </section>
    );

  const selectedStores =
    scope.kind === 'ALL'
      ? wholesaleStores
      : wholesaleStores.filter((store) => store.id === scope.storeId);
  const byStore = wholesaleTotals(selectedStores, query.data.orders, query.data.receipts, period);
  const productNames = new Map(query.data.products.map((product) => [product.id, product.name]));
  const byProduct = new Map<string, { ordered: number; received: number }>();
  for (const rows of byStore.values())
    for (const row of rows) {
      const current = byProduct.get(row.productId) ?? { ordered: 0, received: 0 };
      current.ordered += row.ordered;
      current.received += row.received;
      byProduct.set(row.productId, current);
    }
  const ranked = [...byProduct]
    .filter(([, amount]) => amount.ordered > 0)
    .toSorted(
      (left, right) =>
        right[1].ordered - left[1].ordered ||
        (productNames.get(left[0]) ?? left[0]).localeCompare(
          productNames.get(right[0]) ?? right[0],
          'vi',
        ),
    );
  const mostOrdered = ranked[0];
  const leastOrdered = ranked.at(-1);
  const orderedTotal = [...byProduct.values()].reduce((sum, row) => sum + row.ordered, 0);
  const receivedTotal = [...byProduct.values()].reduce((sum, row) => sum + row.received, 0);

  return (
    <div className="wholesale-overview">
      <div className="stats-grid">
        <StatCard
          label="Tổng đặt hàng"
          value={`${orderedTotal} bao`}
          detail={`${selectedStores.length} cửa hàng sỉ trong kỳ`}
        />
        <StatCard
          label="Tổng thực nhận"
          value={`${receivedTotal} bao`}
          detail="Phiếu đã gửi HTKD hoặc đã chốt"
          tone="success"
        />
        <StatCard
          label="Đặt nhiều nhất"
          value={mostOrdered ? (productNames.get(mostOrdered[0]) ?? mostOrdered[0]) : 'Chưa có'}
          detail={mostOrdered ? `${mostOrdered[1].ordered} bao` : 'Chưa có phiếu đặt'}
          tone="info"
        />
        <StatCard
          label="Đặt ít nhất"
          value={leastOrdered ? (productNames.get(leastOrdered[0]) ?? leastOrdered[0]) : 'Chưa có'}
          detail={leastOrdered ? `${leastOrdered[1].ordered} bao` : 'Chưa có phiếu đặt'}
        />
      </div>
      <section className="panel table-panel">
        <div className="section-heading section-heading--compact">
          <div>
            <h2>Đặt hàng và thực nhận theo mặt hàng</h2>
            <p>
              Đơn chưa hủy theo ngày gửi; thực nhận theo ngày tạo phiếu, gồm hàng nhận dư đã khai.
              Phiếu nháp và phiếu bị trả chưa được tính.
            </p>
          </div>
        </div>
        {byProduct.size === 0 ? (
          <p>Chưa có số liệu trong kỳ đã chọn.</p>
        ) : (
          <div className="responsive-table">
            <table>
              <thead>
                <tr>
                  <th>Mặt hàng</th>
                  <th>Đặt hàng</th>
                  <th>Thực nhận</th>
                </tr>
              </thead>
              <tbody>
                {[...byProduct]
                  .toSorted((a, b) =>
                    (productNames.get(a[0]) ?? a[0]).localeCompare(
                      productNames.get(b[0]) ?? b[0],
                      'vi',
                    ),
                  )
                  .map(([id, total]) => (
                    <tr key={id}>
                      <td data-label="Mặt hàng">{productNames.get(id) ?? id}</td>
                      <td data-label="Đặt hàng">{total.ordered} bao</td>
                      <td data-label="Thực nhận">{total.received} bao</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel table-panel">
        <div className="section-heading section-heading--compact">
          <div>
            <h2>Theo từng cửa hàng sỉ</h2>
            <p>Số bao theo từng mặt hàng.</p>
          </div>
        </div>
        {selectedStores.length === 0 ? (
          <p>Chưa có cửa hàng sỉ được phân quyền.</p>
        ) : (
          <div className="responsive-table">
            <table>
              <thead>
                <tr>
                  <th>Cửa hàng</th>
                  <th>Mặt hàng</th>
                  <th>Đặt hàng</th>
                  <th>Thực nhận</th>
                </tr>
              </thead>
              <tbody>
                {selectedStores.flatMap((store) => {
                  const rows = byStore.get(store.id) ?? [];
                  return rows.length
                    ? rows.map((row) => (
                        <tr key={`${store.id}:${row.productId}`}>
                          <td data-label="Cửa hàng">{store.name}</td>
                          <td data-label="Mặt hàng">
                            {productNames.get(row.productId) ?? row.productId}
                          </td>
                          <td data-label="Đặt hàng">{row.ordered} bao</td>
                          <td data-label="Thực nhận">{row.received} bao</td>
                        </tr>
                      ))
                    : [
                        <tr key={store.id}>
                          <td data-label="Cửa hàng">{store.name}</td>
                          <td colSpan={3}>Chưa có số liệu trong kỳ</td>
                        </tr>,
                      ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
