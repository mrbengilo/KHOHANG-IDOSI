import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { StatCard } from '../../components/StatCard';
import { formatKg, formatInteger } from '../../lib/format';
import {
  listIdosiStatistics,
  idosiStatisticsErrorMessage,
  syncIdosiSalesSummary,
} from './idosiStatisticsApi';
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
  const queryClient = useQueryClient();
  const sync = useMutation({
    mutationFn: (scope: { period: string; storeId?: string }) =>
      syncIdosiSalesSummary(scope.period, scope.storeId),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['idosi-sales-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['idosi-statistics'] }),
      ]);
    },
  });
  const query = useQuery({
    queryKey: ['idosi-sales-summary', period, storeId ?? 'ALL'],
    queryFn: () => listIdosiStatistics(period, storeId),
    retry: false,
    refetchInterval: sync.isPending ? false : 30_000,
  });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const summary = summarizeIdosiSales(query.data ?? []);
  const sourceTimes = summary.snapshots.map((snapshot) => snapshot.payload.generatedAt).sort();
  const formatTime = (value: string) =>
    new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const syncMatchesScope = sync.variables?.period === period && sync.variables?.storeId === storeId;
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
        <Button
          busy={sync.isPending}
          disabled={query.isPending || !!query.error || !query.data?.length}
          tone="secondary"
          onClick={() => sync.mutate({ period, ...(storeId ? { storeId } : {}) })}
        >
          <RefreshCw size={16} aria-hidden="true" /> Đồng bộ từ IDOSI
        </Button>
      </div>
      {sourceTimes.length > 0 ? (
        <p>
          Dữ liệu nguồn lúc {formatTime(sourceTimes[0]!)}
          {sourceTimes.at(-1) !== sourceTimes[0] ? ` – ${formatTime(sourceTimes.at(-1)!)}` : ''}.
          Đơn sau mốc này vào lần đồng bộ kế tiếp.
        </p>
      ) : null}
      {sync.isPending ? <p role="status">Đang lấy dữ liệu mới từ IDOSI…</p> : null}
      {syncMatchesScope && sync.error ? (
        <p role="alert">{idosiStatisticsErrorMessage(sync.error)}</p>
      ) : null}
      {syncMatchesScope && sync.isSuccess ? (
        <div role={sync.data.failures.length ? 'alert' : 'status'}>
          <p>
            Đã đồng bộ {sync.data.succeeded}/{sync.data.total} cửa hàng từ IDOSI.
          </p>
          {sync.data.failures.length ? (
            <>
              <p>Cửa hàng lỗi vẫn giữ số liệu của lần đồng bộ thành công trước đó:</p>
              <ul>
                {sync.data.failures.map((failure) => (
                  <li key={failure}>{failure}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
      {query.isPending ? (
        <p role="status">Đang tải dữ liệu bán hàng…</p>
      ) : query.error ? (
        <p role="alert">{idosiStatisticsErrorMessage(query.error)}</p>
      ) : (
        <>
          <div className="idosi-sales-coverage">
            <Badge
              tone={
                partial || summary.staleStores || summary.resyncStores
                  ? 'warning'
                  : hasData
                    ? 'success'
                    : 'neutral'
              }
            >
              {summary.snapshots.length}/{query.data?.length ?? 0} cửa hàng có dữ liệu
            </Badge>
            <span>
              {partial ? 'Tổng dưới đây chỉ gồm cửa hàng đã đồng bộ. ' : ''}
              {summary.staleStores
                ? `${summary.staleStores} cửa hàng có lần đồng bộ gần nhất thất bại. `
                : ''}
              {summary.resyncStores
                ? `${summary.resyncStores} cửa hàng có snapshot cũ cần đồng bộ lại. `
                : ''}
              Khách sỉ không thuộc nguồn bán lẻ IDOSI.
            </span>
          </div>
          {summary.ambiguousProducts > 0 ? (
            <p className="idosi-sales-warning" role="alert">
              <strong>
                {formatInteger(summary.ambiguousProducts)} mã mặt hàng IDOSI xuất hiện dưới nhiều
                tên khác nhau.
              </strong>{' '}
              Số liệu của những mặt hàng đó có thể bị tách hoặc gộp nhầm. Hãy đồng bộ lại sau khi
              IDOSI gửi kèm định danh chuẩn cho các cửa hàng này.
            </p>
          ) : null}
          {summary.reconciliationMismatches > 0 ? (
            <p className="idosi-sales-warning" role="alert">
              {formatInteger(summary.reconciliationMismatches)} cửa hàng có tổng doanh thu lệch ba
              loại bán. Cần đối soát với IDOSI; số nguồn không được tự sửa.
            </p>
          ) : null}
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
              label={summary.incompleteWeight ? 'Khối lượng bán đã biết' : 'Tổng khối lượng đã bán'}
              value={hasData ? formatKg(summary.knownKg) : 'Chưa có dữ liệu'}
              tone={summary.incompleteWeight ? 'warning' : 'success'}
              detail={
                summary.incompleteWeight
                  ? 'Còn đơn thiếu chi tiết hoặc hệ số; chưa tính đủ kg'
                  : 'Tổng khối lượng bán tính được từ dữ liệu đơn'
              }
            />
            <StatCard
              label="Khối lượng quy đổi"
              value={hasData ? formatKg(summary.estimatedKg) : 'Chưa có dữ liệu'}
              detail={
                summary.unclassifiedOrders
                  ? `${formatInteger(summary.unclassifiedOrders)} đơn chưa phân loại mặt hàng`
                  : 'Khối lượng quy đổi từ số cái theo hệ số của mặt hàng'
              }
            />
          </div>
          <div className="section-heading section-heading--compact">
            <h3>Doanh thu theo loại bán</h3>
          </div>
          <div className="stats-grid stats-grid--small">
            <StatCard
              label="Bán thường"
              value={hasData ? money(summary.normalRevenueVnd) : 'Chưa có dữ liệu'}
              detail="Chỉ phần đã phân loại NORMAL"
            />
            <StatCard
              label="Sale theo cái"
              value={hasData ? money(summary.salePieceRevenueVnd) : 'Chưa có dữ liệu'}
              detail="Tiền sale theo số cái"
              tone="info"
            />
            <StatCard
              label="Sale theo ký"
              value={hasData ? money(summary.saleKgRevenueVnd) : 'Chưa có dữ liệu'}
              detail="Tiền sale theo kg thực bán"
              tone="info"
            />
            <StatCard
              label="Chưa phân loại"
              value={hasData ? money(summary.unclassifiedRevenueVnd) : 'Chưa có dữ liệu'}
              detail={
                summary.revenueUnclassifiedOrders
                  ? `${formatInteger(summary.revenueUnclassifiedOrders)} đơn cần đối soát`
                  : 'Không có đơn thiếu dấu phân loại'
              }
              tone={summary.revenueUnclassifiedOrders ? 'warning' : 'success'}
            />
          </div>
          <div className="section-heading section-heading--compact">
            <h3>Số lượng và khối lượng sale</h3>
          </div>
          <div className="stats-grid stats-grid--small">
            <StatCard
              label="Sale theo cái · số lượng"
              value={
                hasData ? `${formatInteger(summary.salePieceQuantity)} cái` : 'Chưa có dữ liệu'
              }
              detail="Không cộng kg vào số cái"
            />
            <StatCard
              label="Sale theo cái · khối lượng"
              value={hasData ? formatKg(summary.salePieceEstimatedKg) : 'Chưa có dữ liệu'}
              detail={
                summary.salePieceWeightComplete
                  ? 'Kg quy đổi ước tính theo mặt hàng'
                  : 'Chỉ phần đã biết · còn thiếu hệ số'
              }
              tone={summary.salePieceWeightComplete ? 'info' : 'warning'}
            />
            <StatCard
              label="Sale theo ký · khối lượng"
              value={hasData ? formatKg(summary.saleKgActualKg) : 'Chưa có dữ liệu'}
              detail="Kg thực bán, không quy đổi lần nữa"
              tone="info"
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
                      <th>Sale theo cái</th>
                      <th>Sale theo ký</th>
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
                        <td data-label="Sale theo cái">
                          {formatInteger(item.salePiecePieces)} cái · {formatKg(item.salePieceKg)}{' '}
                          ước tính{!item.salePieceComplete ? <small>Chỉ phần đã biết</small> : null}
                        </td>
                        <td data-label="Sale theo ký">
                          {formatKg(item.saleKg)} thực bán
                          {!item.saleKgComplete ? <small>Chỉ phần đã biết</small> : null}
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
