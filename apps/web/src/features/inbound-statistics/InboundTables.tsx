import type {
  InboundBreakdown,
  InboundMetric,
  InboundSource,
  InboundStatistics,
} from '@idosi/contracts';
import { formatInboundValue, inboundShare } from './inboundStatisticsModel';

/** Table pieces shared by the page-wide report and the inline store detail. */
export const inboundSourceLabels: Record<InboundSource, string> = {
  ALL: 'Tất cả',
  WAREHOUSE: 'Kho',
  PARTNER: 'Đối tác khác',
};

export function MetricCells({ value }: { value: InboundMetric }) {
  return (
    <>
      <td className="table-number">
        {formatInboundValue(value.bagQuantity)}
        {!value.bagsComplete && <small>Đã biết · thiếu dữ liệu</small>}
      </td>
      <td className="table-number">
        {formatInboundValue(value.weightGrams, true)}
        {!value.weightComplete && <small>Đã biết · thiếu dữ liệu</small>}
      </td>
    </>
  );
}
export function BreakdownCells({ value }: { value: InboundBreakdown }) {
  return (
    <>
      <MetricCells value={value.warehouse} />
      <MetricCells value={value.partner} />
      <MetricCells value={value.total} />
    </>
  );
}
export function BreakdownHeaders() {
  return (
    <>
      {['Kho', 'Đối tác khác', 'Tổng nhập'].flatMap((label) => [
        <th className="table-number" key={`${label}-bags`}>
          {label}
          <br />
          bao
        </th>,
        <th className="table-number" key={`${label}-kg`}>
          {label}
          <br />
          kg
        </th>,
      ])}
    </>
  );
}
export function InboundPagination({
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
function basisPoints(value: number | null) {
  return value === null ? 'Chưa xác định' : `${value / 100}%`;
}
/** Product rows of one response; shares and the footer always come from that same response. */
export function InboundProductTable({
  data,
  label,
  totalLabel,
}: {
  data: InboundStatistics;
  label: string;
  totalLabel: string;
}) {
  const source = data.selectedSource;
  return (
    <div className="inbound-table-scroll" tabIndex={0} aria-label={label}>
      <table className="table-density">
        <thead>
          <tr>
            <th>Mã / tên mặt hàng</th>
            {source === 'ALL' ? (
              <BreakdownHeaders />
            ) : (
              <>
                <th>{inboundSourceLabels[source]} · bao</th>
                <th>{inboundSourceLabels[source]} · kg</th>
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
              {source === 'ALL' ? (
                <BreakdownCells value={row.amounts} />
              ) : (
                <MetricCells value={row.selected} />
              )}
              <td>{basisPoints(row.bagShareBasisPoints)}</td>
              <td>{basisPoints(row.weightShareBasisPoints)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th>{totalLabel}</th>
            {source === 'ALL' ? (
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
  );
}
