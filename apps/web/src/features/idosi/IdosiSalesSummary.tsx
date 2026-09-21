import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { StatCard } from '../../components/StatCard';
import { formatKg, formatInteger } from '../../lib/format';
import { listIdosiStatistics, idosiStatisticsErrorMessage } from './idosiStatisticsApi';
import { summarizeIdosiSales } from './sales-summary';
import './idosi-statistics.css';

export function IdosiSalesSummary({
  period,
  storeId,
  filters,
}: {
  readonly period: string;
  readonly storeId?: string;
  readonly filters?: {
    readonly stores: readonly { id: string; name: string }[];
    readonly allowAll: boolean;
    readonly onPeriodChange: (value: string) => void;
    readonly onStoreChange: (value: string) => void;
  };
}) {
  const query = useQuery({
    queryKey: ['idosi-sales-summary', period, storeId ?? 'ALL'],
    queryFn: () => listIdosiStatistics(period, storeId),
    retry: false,
  });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const summary = summarizeIdosiSales(query.data ?? []);
  const rows = summary.productTotals.filter((item) =>
    `${item.productName} ${item.productCode ?? ''}`
      .toLocaleLowerCase('vi-VN')
      .includes(search.toLocaleLowerCase('vi-VN')),
  );
  const pages = Math.max(1, Math.ceil(rows.length / 15));
  const currentPage = Math.min(page, pages);
  const hasData = summary.snapshots.length > 0;
  const partial = summary.missingStores > 0;
  const money = (value: bigint) => `${value.toLocaleString('vi-VN')} ₫`;
  return (
    <section className="panel idosi-sales-summary" aria-labelledby="idosi-sales-heading">
      <div className="section-heading section-heading--compact">
        <div>
          <h2 id="idosi-sales-heading">Doanh thu & hàng đã bán · IDOSI</h2>
          <p>Kỳ {period} · dữ liệu từ idosi.io.vn, độc lập với phiếu xuất kho nội bộ.</p>
        </div>
        <Button busy={query.isFetching} tone="secondary" onClick={() => void query.refetch()}>
          <RefreshCw size={16} aria-hidden="true" /> Cập nhật hiển thị
        </Button>
      </div>
      {query.isPending ? (
        <p role="status">Đang tải dữ liệu bán hàng…</p>
      ) : query.error ? (
        <p role="alert">{idosiStatisticsErrorMessage(query.error)}</p>
      ) : (
        <>
          <div className="idosi-sales-coverage">
            <Badge
              tone={partial || summary.staleStores ? 'warning' : hasData ? 'success' : 'neutral'}
            >
              {summary.snapshots.length}/{query.data?.length ?? 0} cửa hàng có dữ liệu
            </Badge>
            <span>
              {partial ? 'Tổng dưới đây chỉ gồm cửa hàng đã đồng bộ. ' : ''}
              {summary.staleStores
                ? `${summary.staleStores} cửa hàng có lần đồng bộ gần nhất thất bại. `
                : ''}
              Khách sỉ không thuộc nguồn bán lẻ IDOSI.
            </span>
          </div>
          <div className="stats-grid stats-grid--small">
            <StatCard
              label={partial ? 'Doanh thu đã đồng bộ' : 'Doanh thu IDOSI'}
              value={hasData ? money(summary.revenueVnd) : 'Chưa có dữ liệu'}
              tone="success"
              detail="Đơn hoạt động; không cộng thêm doanh thu phiếu kho"
            />
            <StatCard
              label="Số cái đã bán"
              value={hasData ? `${formatInteger(summary.pieces)} cái` : 'Chưa có dữ liệu'}
              tone="info"
              detail="Chỉ cộng dòng đơn vị cái, không cộng số kg vào số cái"
            />
            <StatCard
              label={summary.incompleteWeight ? 'Kg bán đã biết' : 'Tổng kg đã bán'}
              value={hasData ? formatKg(summary.knownKg) : 'Chưa có dữ liệu'}
              tone={summary.incompleteWeight ? 'warning' : 'success'}
              detail={
                summary.incompleteWeight
                  ? 'Chưa đủ hệ số; không phải tổng đầy đủ'
                  : 'Gồm kg thực tế và kg quy đổi từ cái'
              }
            />
            <StatCard
              label="Thực tế / quy đổi"
              value={
                hasData
                  ? `${formatKg(summary.actualKg)} / ${formatKg(summary.estimatedKg)}`
                  : 'Chưa có dữ liệu'
              }
              detail={
                summary.unclassifiedOrders
                  ? `${formatInteger(summary.unclassifiedOrders)} đơn chưa phân loại mặt hàng`
                  : 'Phân biệt kg cân thực tế và kg ước tính theo hệ số'
              }
            />
          </div>
          <details className="idosi-sales-sources">
            <summary>Thời điểm đồng bộ từng cửa hàng</summary>
            <ul>
              {summary.snapshots.map((snapshot) => (
                <li key={snapshot.storeId}>
                  {snapshot.payload.store.name} ·{' '}
                  {new Date(snapshot.lastSyncedAt).toLocaleString('vi-VN', {
                    timeZone: 'Asia/Ho_Chi_Minh',
                  })}
                </li>
              ))}
            </ul>
          </details>
          <div className="section-heading section-heading--compact">
            <h3>Số lượng và khối lượng bán từng mặt hàng</h3>
            {filters ? (
              <>
                <label>
                  Tháng thống kê bán hàng
                  <input
                    type="month"
                    min="2000-01"
                    max="2100-12"
                    value={period}
                    onChange={(event) => filters.onPeriodChange(event.target.value)}
                  />
                </label>
                <label>
                  Cửa hàng thống kê bán hàng
                  <select
                    value={storeId ?? 'ALL'}
                    onChange={(event) => filters.onStoreChange(event.target.value)}
                  >
                    {filters.allowAll ? <option value="ALL">Toàn hệ thống</option> : null}
                    {filters.stores.map((store) => (
                      <option key={store.id} value={store.id}>
                        {store.name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
            <label>
              Tìm mặt hàng
              <input
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
              />
            </label>
          </div>
          {rows.length ? (
            <>
              <div className="responsive-table">
                <table>
                  <thead>
                    <tr>
                      <th>Mặt hàng</th>
                      <th>Số lượng bán</th>
                      <th>Khối lượng bán</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice((currentPage - 1) * 15, currentPage * 15).map((item) => (
                      <tr key={item.productId}>
                        <td data-label="Mặt hàng">
                          <strong>{item.productName}</strong>
                          <small>{item.productCode ?? item.productId}</small>
                        </td>
                        <td data-label="Số lượng bán">{formatInteger(item.pieces)} cái</td>
                        <td data-label="Khối lượng bán">
                          {formatKg(item.knownKg)}
                          {!item.isComplete ? (
                            <small>Chỉ phần đã biết · dữ liệu khối lượng chưa đầy đủ</small>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="idosi-sales-pagination">
                <Button
                  tone="secondary"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  Trước
                </Button>
                <span>
                  Trang {currentPage}/{pages} · {rows.length} dòng
                </span>
                <Button
                  tone="secondary"
                  disabled={currentPage >= pages}
                  onClick={() => setPage(currentPage + 1)}
                >
                  Sau
                </Button>
              </div>
            </>
          ) : (
            <p>
              {hasData
                ? 'Không có mặt hàng phù hợp trong kỳ này.'
                : 'Chưa có snapshot cho kỳ và phạm vi đã chọn. Chọn cửa hàng tại Bán & đồng bộ để đồng bộ kỳ lịch sử.'}
            </p>
          )}
        </>
      )}
    </section>
  );
}
