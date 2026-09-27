import {
  InboundStatisticsQuerySchema,
  type InboundBreakdown,
  type InboundMetric,
  type InboundProductRow,
  type InboundSource,
  type InboundStatistics,
  type InboundStatisticsQuery,
} from '@idosi/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { getInboundStatistics } from '../lib/api';
import { businessDate } from '../lib/business-time';
import {
  formatInboundValue,
  inboundMetricLabel,
  inboundShare,
  inboundStatisticsKey,
} from '../features/inbound-statistics/inboundStatisticsModel';
import './inbound-statistics.css';

const sources = { ALL: 'Tất cả', WAREHOUSE: 'Kho', PARTNER: 'Đối tác khác' };
const kinds = { RETAIL: 'Bán lẻ', WHOLESALE: 'Sỉ', ALL: 'Toàn hệ thống' };

function MetricCells({ value }: { value: InboundMetric }) {
  return (
    <>
      <td>
        {formatInboundValue(value.bagQuantity)}
        {!value.bagsComplete && <small>Đã biết · thiếu dữ liệu</small>}
      </td>
      <td>
        {formatInboundValue(value.weightGrams, true)}
        {!value.weightComplete && <small>Đã biết · thiếu dữ liệu</small>}
      </td>
    </>
  );
}
function BreakdownCells({ value }: { value: InboundBreakdown }) {
  return (
    <>
      <MetricCells value={value.warehouse} />
      <MetricCells value={value.partner} />
      <MetricCells value={value.total} />
    </>
  );
}
function BreakdownHeaders() {
  return (
    <>
      {['Kho', 'Đối tác khác', 'Tổng nhập'].flatMap((label) => [
        <th key={`${label}-bags`}>
          {label}
          <br />
          bao
        </th>,
        <th key={`${label}-kg`}>
          {label}
          <br />
          kg
        </th>,
      ])}
    </>
  );
}
function Ranking({ value }: { value: InboundStatistics['ranking'] }) {
  return (
    <div className="inbound-ranking">
      {(['most', 'least'] as const).map((key) => (
        <div key={key}>
          <strong>{key === 'most' ? 'Nhập nhiều nhất' : 'Nhập ít nhất'}</strong>
          <p>
            {value[key]
              ? `${value[key].productName} — ${inboundMetricLabel(value[key].selected)}`
              : 'Không có dữ liệu'}
          </p>
          {value[key === 'most' ? 'mostTied' : 'leastTied'] && (
            <small>Đồng hạng theo số bao; ưu tiên khối lượng, sau đó mã mặt hàng.</small>
          )}
        </div>
      ))}
      {!value.complete && (
        <p role="status">
          Xếp hạng chỉ trên phần đủ dữ liệu; chưa thể khẳng định thứ hạng toàn bộ.
        </p>
      )}
    </div>
  );
}
function Pagination({
  value,
  onChange,
  label,
}: {
  value: InboundStatistics['storePagination'];
  onChange: (page: number) => void;
  label: string;
}) {
  return (
    <nav className="inbound-pagination" aria-label={`Phân trang ${label}`}>
      <span>
        {value.totalItems} dòng · Trang {value.page}/{Math.max(1, value.totalPages)}
      </span>
      <button disabled={value.page <= 1} onClick={() => onChange(value.page - 1)}>
        Trước
      </button>
      <button disabled={value.page >= value.totalPages} onClick={() => onChange(value.page + 1)}>
        Sau
      </button>
    </nav>
  );
}
function Chart({
  rows,
  source,
  weight,
}: {
  rows: InboundProductRow[];
  source: InboundSource;
  weight?: boolean;
}) {
  const key = weight ? 'weightGrams' : 'bagQuantity';
  const maximum = rows.reduce(
    (max, row) => (BigInt(row.selected[key]) > max ? BigInt(row.selected[key]) : max),
    0n,
  );
  const width = (value: string) =>
    maximum === 0n ? 0 : Number((BigInt(value) * 100_000n) / maximum) / 1000;
  const [active, setActive] = useState<string | null>(null);
  return (
    <section className="inbound-panel">
      <h2>
        {weight ? 'Khối lượng nhập theo mặt hàng' : 'Số lượng nhập theo mặt hàng'}{' '}
        <small>
          ({weight ? 'kg' : 'bao'}) · {sources[source]}
        </small>
      </h2>
      <p className="inbound-legend">
        <span className="warehouse">Kho</span>
        <span className="partner">Đối tác khác</span>
      </p>
      {rows.length === 0 && <p>Không có dữ liệu</p>}
      <div
        className="inbound-chart"
        role="list"
        aria-label={weight ? 'Biểu đồ khối lượng' : 'Biểu đồ số bao'}
      >
        {rows.map((row) => (
          <div role="listitem" key={row.productId}>
            <button
              className="inbound-bar-row"
              onMouseEnter={() => setActive(row.productId)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(row.productId)}
              onBlur={() => setActive(null)}
              onClick={() => setActive(active === row.productId ? null : row.productId)}
              aria-label={`${row.productName}: ${inboundMetricLabel(row.selected)}`}
              aria-describedby={
                active === row.productId ? `tip-${key}-${row.productId}` : undefined
              }
            >
              <span>{row.productName}</span>
              <span className="inbound-bar-track">
                {source !== 'PARTNER' && (
                  <span
                    className="warehouse"
                    style={{ width: `${width(row.amounts.warehouse[key])}%` }}
                  />
                )}
                {source !== 'WAREHOUSE' && (
                  <span
                    className="partner"
                    style={{ width: `${width(row.amounts.partner[key])}%` }}
                  />
                )}
              </span>
              <span>
                {formatInboundValue(row.selected[key], weight)}
                {!(weight ? row.selected.weightComplete : row.selected.bagsComplete) && ' *'}
              </span>
            </button>
            {active === row.productId && (
              <div className="inbound-tooltip" role="tooltip" id={`tip-${key}-${row.productId}`}>
                {source !== 'PARTNER' && (
                  <div>Kho: {inboundMetricLabel(row.amounts.warehouse)}</div>
                )}
                {source !== 'WAREHOUSE' && (
                  <div>Đối tác khác: {inboundMetricLabel(row.amounts.partner)}</div>
                )}
                <strong>Tổng nguồn đang chọn: {inboundMetricLabel(row.selected)}</strong>
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="inbound-note">
        Tối đa 10 mặt hàng và phần Khác, giữ đầy đủ tổng. Bảng bên dưới là dữ liệu thay thế có thể
        đọc bằng bàn phím.
      </p>
    </section>
  );
}

export function InboundStatisticsPage() {
  const [query, setQuery] = useState<InboundStatisticsQuery>(() =>
    InboundStatisticsQuerySchema.parse({ month: businessDate().slice(0, 7) }),
  );
  const valid = InboundStatisticsQuerySchema.safeParse(query);
  const report = useQuery({
    queryKey: inboundStatisticsKey(query),
    queryFn: () => getInboundStatistics(query),
    enabled: valid.success,
  });
  const update = (patch: Partial<InboundStatisticsQuery>) =>
    setQuery((current) => ({ ...current, storePage: 1, productPage: 1, ...patch }));
  const [storeOptions, setStoreOptions] = useState<InboundStatistics['storeOptions']>([]);
  useEffect(() => {
    if (report.data) setStoreOptions(report.data.storeOptions);
  }, [report.data]);
  const data = valid.success ? report.data : undefined;
  return (
    <div className="inbound-statistics">
      <PageHeader
        title="Thống kê nhập hàng"
        description="Tổng hợp hàng cửa hàng nhận từ kho và đối tác khác"
      />
      <section className="inbound-panel inbound-filters" aria-label="Bộ lọc thống kê">
        <label>
          Kỳ thống kê
          <select
            value={query.periodType}
            onChange={(e) =>
              update(
                e.target.value === 'DAY'
                  ? { periodType: 'DAY', date: businessDate(), month: undefined }
                  : { periodType: 'MONTH', month: businessDate().slice(0, 7), date: undefined },
              )
            }
          >
            <option value="MONTH">Theo tháng</option>
            <option value="DAY">Theo ngày</option>
          </select>
        </label>
        <label>
          {query.periodType === 'DAY' ? 'Ngày' : 'Tháng'}
          <input
            type={query.periodType === 'DAY' ? 'date' : 'month'}
            value={query.periodType === 'DAY' ? (query.date ?? '') : (query.month ?? '')}
            onChange={(e) =>
              update(
                query.periodType === 'DAY' ? { date: e.target.value } : { month: e.target.value },
              )
            }
          />
        </label>
        <label>
          Loại cửa hàng
          <select
            value={query.storeKind ?? ''}
            onChange={(e) =>
              update({
                storeKind: e.target.value ? (e.target.value as 'RETAIL' | 'WHOLESALE') : undefined,
                storeId: undefined,
              })
            }
          >
            <option value="">Toàn hệ thống</option>
            <option value="RETAIL">Bán lẻ</option>
            <option value="WHOLESALE">Sỉ</option>
          </select>
        </label>
        <label>
          Cửa hàng
          <select
            value={query.storeId ?? ''}
            onChange={(e) => update({ storeId: e.target.value || undefined })}
          >
            <option value="">Tất cả cửa hàng trong phạm vi</option>
            {storeOptions
              .filter((store) => !query.storeKind || store.kind === query.storeKind)
              .map((store) => (
                <option key={store.id} value={store.id}>
                  {store.code} · {store.name}
                </option>
              ))}
          </select>
        </label>
        <button
          onClick={() => void report.refetch()}
          disabled={!valid.success || report.isFetching}
        >
          Làm mới
        </button>
      </section>
      <section className="inbound-panel inbound-filters">
        <label>
          Chi tiết theo nguồn
          <select
            value={query.source}
            onChange={(e) => update({ source: e.target.value as InboundSource })}
          >
            {Object.entries(sources).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sắp xếp theo
          <select
            value={query.sortBy}
            onChange={(e) => update({ sortBy: e.target.value as 'bags' | 'weight' })}
          >
            <option value="bags">Số bao</option>
            <option value="weight">Khối lượng</option>
          </select>
        </label>
        <label>
          Thứ tự
          <select
            value={query.sortDirection}
            onChange={(e) => update({ sortDirection: e.target.value as 'asc' | 'desc' })}
          >
            <option value="desc">Giảm dần</option>
            <option value="asc">Tăng dần</option>
          </select>
        </label>
        <label>
          Số dòng mỗi trang
          <select
            value={query.pageSize}
            onChange={(e) => update({ pageSize: Number(e.target.value) })}
          >
            {[10, 20, 50, 100].map((size) => (
              <option key={size}>{size}</option>
            ))}
          </select>
        </label>
        <label>
          Tìm cửa hàng
          <input
            type="search"
            value={query.storeSearch}
            onChange={(e) => update({ storeSearch: e.target.value })}
            placeholder="Mã hoặc tên cửa hàng"
          />
        </label>
        <label>
          Tìm mặt hàng
          <input
            type="search"
            value={query.productSearch}
            onChange={(e) => update({ productSearch: e.target.value })}
            placeholder="Mã hoặc tên mặt hàng"
          />
        </label>
      </section>
      {!valid.success && <p role="alert">Vui lòng chọn ngày hoặc tháng hợp lệ.</p>}
      {valid.success && report.isPending && <p role="status">Đang tải thống kê…</p>}
      {report.isError && (
        <div role="alert">
          Không tải được thống kê. {report.error.message}
          <button onClick={() => void report.refetch()}>Thử lại</button>
        </div>
      )}
      {data && !report.isError && (
        <>
          <div className="inbound-heading">
            <h2>Tổng quan mọi nguồn</h2>
            <span>{data.period.label} · Asia/Ho_Chi_Minh</span>
          </div>
          {(!data.dataCompleteness.bagsComplete || !data.dataCompleteness.weightComplete) && (
            <p role="status" className="inbound-warning">
              Dữ liệu chưa đầy đủ. Các số có ghi “đã biết” chưa phải tổng đầy đủ; tỷ trọng và thứ
              hạng liên quan có thể chưa xác định.
            </p>
          )}
          <div className="inbound-overview">
            {(['total', 'warehouse', 'partner'] as const).map((key) => (
              <section key={key} className={`inbound-panel ${key}`}>
                <h3>
                  {key === 'total'
                    ? 'Tổng nhập'
                    : key === 'warehouse'
                      ? 'Nhập từ kho'
                      : 'Nhập từ đối tác khác'}
                </h3>
                <strong>{inboundMetricLabel(data.overviewAllSources[key])}</strong>
                {key !== 'total' && (
                  <p>
                    Tỷ trọng:{' '}
                    {inboundShare(
                      data.overviewAllSources[key].bagQuantity,
                      data.overviewAllSources.total.bagQuantity,
                      data.dataCompleteness.bagsComplete,
                    )}{' '}
                    bao ·{' '}
                    {inboundShare(
                      data.overviewAllSources[key].weightGrams,
                      data.overviewAllSources.total.weightGrams,
                      data.dataCompleteness.weightComplete,
                    )}{' '}
                    kg
                  </p>
                )}
              </section>
            ))}
          </div>
          <section className="inbound-panel">
            <h2>Tổng hợp theo loại cửa hàng</h2>
            <p>Trong kỳ và phạm vi đang chọn; phân loại theo loại cửa hàng hiện tại.</p>
            <div className="inbound-table-scroll" tabIndex={0} aria-label="Bảng loại cửa hàng">
              <table>
                <thead>
                  <tr>
                    <th>Loại cửa hàng</th>
                    <BreakdownHeaders />
                  </tr>
                </thead>
                <tbody>
                  {data.groupRows.map((row) => (
                    <tr key={row.kind}>
                      <th scope="row">{kinds[row.kind]}</th>
                      <BreakdownCells value={row.amounts} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="inbound-panel">
            <h2>Mặt hàng · {sources[query.source]}</h2>
            <Ranking value={data.ranking} />
          </section>
          <div className="inbound-charts">
            <Chart rows={data.charts.bags} source={query.source} />
            <Chart rows={data.charts.weight} source={query.source} weight />
          </div>
          <section className="inbound-panel">
            <h2>Theo cửa hàng</h2>

            <p>
              Tìm kiếm chỉ thu hẹp bảng. Tổng và xếp hạng giữ nguyên phạm vi; xếp hạng theo nguồn{' '}
              {sources[query.source]}.
            </p>
            <div className="inbound-table-scroll" tabIndex={0} aria-label="Bảng cửa hàng">
              <table>
                <thead>
                  <tr>
                    <th>Cửa hàng</th>
                    <th>Loại</th>
                    <BreakdownHeaders />
                    <th>Nhiều nhất</th>
                    <th>Ít nhất</th>
                    <th>Chi tiết</th>
                  </tr>
                </thead>
                <tbody>
                  {data.storeRows.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">
                        {row.code}
                        <small>{row.name}</small>
                      </th>
                      <td>{kinds[row.kind]}</td>
                      <BreakdownCells value={row.amounts} />
                      <td>
                        {row.ranking.most
                          ? `${row.ranking.most.productName} · ${inboundMetricLabel(row.ranking.most.selected)}`
                          : 'Không có dữ liệu'}
                        {row.ranking.mostTied && <small>Đồng hạng theo bao</small>}
                      </td>
                      <td>
                        {row.ranking.least
                          ? `${row.ranking.least.productName} · ${inboundMetricLabel(row.ranking.least.selected)}`
                          : 'Không có dữ liệu'}
                        {row.ranking.leastTied && <small>Đồng hạng theo bao</small>}
                        {!row.ranking.complete && <small>Xếp hạng chưa đầy đủ</small>}
                      </td>
                      <td>
                        <button
                          onClick={() =>
                            update({
                              storeId: row.id,
                              storeKind: row.kind,
                              storeSearch: '',
                              productSearch: '',
                            })
                          }
                        >
                          Xem chi tiết<span className="sr-only"> {row.name}</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={2}>Tổng toàn phạm vi</th>
                    <BreakdownCells value={data.overviewAllSources} />
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              </table>
            </div>
            {data.storeRows.length === 0 && <p>Không có dữ liệu</p>}
            <Pagination
              label="cửa hàng"
              value={data.storePagination}
              onChange={(storePage) => update({ storePage })}
            />
          </section>
          <section className="inbound-panel">
            <h2>Theo mặt hàng · {sources[query.source]}</h2>

            <p>Tìm kiếm chỉ thu hẹp bảng; tỷ trọng, biểu đồ và dòng tổng tính trên toàn phạm vi.</p>
            <div className="inbound-table-scroll" tabIndex={0} aria-label="Bảng mặt hàng">
              <table>
                <thead>
                  <tr>
                    <th>Mã / tên mặt hàng</th>
                    {query.source === 'ALL' ? (
                      <BreakdownHeaders />
                    ) : (
                      <>
                        <th>{sources[query.source]} · bao</th>
                        <th>{sources[query.source]} · kg</th>
                      </>
                    )}
                    <th>Tỷ trọng bao</th>
                    <th>Tỷ trọng kg</th>
                  </tr>
                </thead>
                <tbody>
                  {data.productRows.map((row) => (
                    <tr key={row.productId}>
                      <th scope="row">
                        {row.sku}
                        <small>{row.productName}</small>
                      </th>
                      {query.source === 'ALL' ? (
                        <BreakdownCells value={row.amounts} />
                      ) : (
                        <MetricCells value={row.selected} />
                      )}
                      <td>
                        {row.bagShareBasisPoints === null
                          ? 'Chưa xác định'
                          : `${row.bagShareBasisPoints / 100}%`}
                      </td>
                      <td>
                        {row.weightShareBasisPoints === null
                          ? 'Chưa xác định'
                          : `${row.weightShareBasisPoints / 100}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th>Tổng toàn phạm vi</th>
                    {query.source === 'ALL' ? (
                      <BreakdownCells value={data.overviewAllSources} />
                    ) : (
                      <MetricCells value={data.selectedTotal} />
                    )}
                    <td>
                      {inboundShare(
                        data.selectedTotal.bagQuantity,
                        data.selectedTotal.bagQuantity,
                        data.selectedTotal.bagsComplete,
                      )}
                    </td>
                    <td>
                      {inboundShare(
                        data.selectedTotal.weightGrams,
                        data.selectedTotal.weightGrams,
                        data.selectedTotal.weightComplete,
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {data.productRows.length === 0 && <p>Không có dữ liệu</p>}
            <Pagination
              label="mặt hàng"
              value={data.productPagination}
              onChange={(productPage) => update({ productPage })}
            />
          </section>
          <p className="inbound-note">
            Lượng thực nhận của chứng từ trong kỳ, gồm hiệu chỉnh đã có hiệu lực; không phải tồn
            hiện tại và không trừ hàng trả sau nhận. Hiệu chỉnh muộn có thể thay đổi kỳ cũ. Cập
            nhật: {new Date(data.generatedAt).toLocaleString('vi-VN', { timeZone: data.timezone })}.
          </p>
        </>
      )}
    </div>
  );
}
