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

/** `label` names the source column pair; mobile cards show it as `label · bao` / `label · kg`. */
export function MetricCells({ value, label }: { value: InboundMetric; label: string }) {
  return (
    <>
      <td className="table-number" data-label={`${label} · bao`}>
        {formatInboundValue(value.bagQuantity)}
        {!value.bagsComplete && <small>Đã biết · thiếu dữ liệu</small>}
      </td>
      <td className="table-number" data-label={`${label} · kg`}>
        {formatInboundValue(value.weightGrams, true)}
        {!value.weightComplete && <small>Đã biết · thiếu dữ liệu</small>}
      </td>
    </>
  );
}
export function BreakdownCells({ value }: { value: InboundBreakdown }) {
  return (
    <>
      <MetricCells value={value.warehouse} label="Kho" />
      <MetricCells value={value.partner} label="Đối tác khác" />
      <MetricCells value={value.total} label="Tổng nhập" />
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
                <MetricCells value={row.selected} label={inboundSourceLabels[source]} />
              )}
              <td data-label="Tỷ trọng bao">{basisPoints(row.bagShareBasisPoints)}</td>
              <td data-label="Tỷ trọng kg">{basisPoints(row.weightShareBasisPoints)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th>{totalLabel}</th>
            {source === 'ALL' ? (
              <BreakdownCells value={data.overviewAllSources} />
            ) : (
              <MetricCells value={data.selectedTotal} label={inboundSourceLabels[source]} />
            )}
            <td data-label="Tỷ trọng bao">
              {inboundShare(
                data.selectedTotal.bagQuantity,
                data.selectedTotal.bagQuantity,
                data.selectedTotal.bagsComplete,
              )}
            </td>
            <td data-label="Tỷ trọng kg">
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
