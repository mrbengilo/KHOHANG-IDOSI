import type {
  BasisPointsReportMetric,
  ExactIntegerReportMetric,
  MonthlyOperationalReport,
  MonthlyOperationalReportQuery,
  ReportMetricSource,
  ReportUnavailableReason,
} from '@idosi/contracts';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowDownToLine, Database, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { readReportNavigation, updateReportNavigation } from '../lib/report-navigation';
import type { AppOutletContext } from '../components/AppShell';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { StatCard } from '../components/StatCard';
import {
  ApiClientError,
  getMonthlyOperationalReport,
  listAccessibleStores,
  mockModeEnabled,
} from '../lib/api';
import { useSession } from '../lib/auth';
import { businessDate } from '../lib/business-time';
import type { Role } from '../lib/types';

const unavailableReasonLabels: Record<ReportUnavailableReason, string> = {
  COGS_NOT_RECORDED_PER_SALE: 'Chưa ghi nhận giá vốn theo từng giao dịch bán',
  MISSING_INBOUND_WEIGHT: 'Phiếu nhập chưa có khối lượng xác nhận',
  INVOICE_COST_NOT_ALLOCATED: 'Tiền hóa đơn chưa phân bổ theo mặt hàng',
  MISSING_SALE_REVENUE: 'Nguồn bán hàng chưa có doanh thu',
  VAT_NOT_CAPTURED: 'Chưa ghi nhận đầy đủ VAT trong phạm vi báo cáo',
  ZERO_INBOUND_WEIGHT: 'Kỳ này không có khối lượng nhập để tính tỷ lệ',
};

const sourceLabels: Record<ReportMetricSource, string> = {
  NOT_AVAILABLE: 'Chưa có nguồn dữ liệu',
  STORE_OUTBOUNDS: 'Phiếu xuất cửa hàng',
  STORE_RECEIPTS: 'Phiếu nhận tại cửa hàng',
  STORE_RECEIPTS_AND_STORE_OUTBOUNDS: 'Phiếu nhận và phiếu xuất cửa hàng',
  WAREHOUSE_RECEIPTS: 'Phiếu nhập kho',
  WAREHOUSE_RECEIPTS_AND_STORE_OUTBOUNDS: 'Phiếu nhập kho và phiếu xuất cửa hàng',
};

const demoStoreId = '20000000-0000-4000-8000-000000000001';
const demoProductId = '40000000-0000-4000-8000-000000000001';

function currentBusinessMonth(): string {
  return businessDate().slice(0, 7);
}

export function reportQueryForSelection(
  role: Role,
  yearMonth: string,
  scopeSelection: string,
): MonthlyOperationalReportQuery | null {
  const match = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null;

  if (role === 'ADMIN' && scopeSelection === 'ALL') {
    return { month, scopeKind: 'ALL', year };
  }
  if ((role === 'ADMIN' || role === 'HTKD') && scopeSelection && scopeSelection !== 'ALL') {
    return { month, scopeId: scopeSelection, scopeKind: 'STORE', year };
  }
  return null;
}

function exactVnd(value: string): string {
  return new Intl.NumberFormat('vi-VN', {
    currency: 'VND',
    maximumFractionDigits: 0,
    style: 'currency',
  }).format(BigInt(value));
}

function exactGramsAsKilograms(value: string): string {
  const grams = BigInt(value);
  const wholeKilograms = grams / 1_000n;
  const remainder = grams % 1_000n;
  const whole = new Intl.NumberFormat('vi-VN').format(wholeKilograms);
  if (remainder === 0n) return `${whole} kg`;
  const decimals = remainder.toString().padStart(3, '0').replace(/0+$/, '');
  return `${whole},${decimals} kg`;
}

function basisPointsAsPercent(value: number): string {
  return `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(value / 100)}%`;
}

function metricDetail(metric: ExactIntegerReportMetric | BasisPointsReportMetric): string {
  return metric.value === null
    ? unavailableReasonLabels[metric.unavailableReason!]
    : `Nguồn: ${sourceLabels[metric.source]}`;
}

function exactMetricValue(
  metric: ExactIntegerReportMetric,
  formatter: (value: string) => string,
): string {
  return metric.value === null ? 'Chưa có dữ liệu' : formatter(metric.value);
}

function basisPointMetricValue(metric: BasisPointsReportMetric): string {
  return metric.value === null ? 'Chưa có dữ liệu' : basisPointsAsPercent(metric.value);
}

function csvCell(value: string | number): string {
  const rawValue = String(value);
  const safeValue = /^[\t\r ]*[=+\-@]/u.test(rawValue) ? `'${rawValue}` : rawValue;
  return `"${safeValue.replace(/"/g, '""')}"`;
}

export function buildMonthlyReportCsv(report: MonthlyOperationalReport): string {
  const scope =
    report.scope.kind === 'ALL'
      ? 'ALL'
      : report.scope.kind === 'STORE'
        ? `STORE:${report.scope.storeId}`
        : `GROUP:${report.scope.groupId}`;
  const rows: Array<Array<string | number>> = [
    ['Báo cáo vận hành tháng'],
    ['Từ ngày', report.period.startBusinessDate],
    ['Đến trước ngày', report.period.endBusinessDateExclusive],
    ['Phạm vi', scope],
    ['Nguồn dữ liệu', report.dataOrigin],
    ['Tạo lúc', report.generatedAt],
    [],
    ['Chỉ số', 'Giá trị', 'Đơn vị', 'Nguồn', 'Lý do chưa có'],
  ];

  const addMetric = (
    label: string,
    metric: ExactIntegerReportMetric | BasisPointsReportMetric,
    unit: string,
  ) => {
    rows.push([label, metric.value ?? '', unit, metric.source, metric.unavailableReason ?? '']);
  };

  addMetric('Khối lượng nhập', report.totals.inboundWeightGrams, 'gram');
  addMetric('Khối lượng bán', report.totals.soldWeightGrams, 'gram');
  addMetric('Doanh thu', report.totals.revenueVnd, 'VND');
  addMetric('Tiền hàng nhập', report.totals.inboundGoodsCostVnd, 'VND');
  addMetric('Phí vận chuyển', report.totals.transportationFeeVnd, 'VND');
  addMetric('Phí bốc xếp', report.totals.handlingFeeVnd, 'VND');
  addMetric('Chi phí nhập khác', report.totals.otherInboundCostVnd, 'VND');
  addMetric('Tổng giá vốn nhập', report.totals.landedInboundCostVnd, 'VND');
  addMetric('VAT đầu vào', report.totals.vatCostVnd, 'VND');
  addMetric('Giá nhập bình quân/kg', report.ratios.averageInboundCostPerKgVnd, 'VND/kg');
  addMetric('Doanh thu/kg nhập', report.ratios.revenuePerInboundKgVnd, 'VND/kg');
  addMetric('Giá vốn/kg bán', report.ratios.effectiveCostPerSoldKgVnd, 'VND/kg');
  addMetric('Biên lợi nhuận gộp', report.ratios.grossMarginBasisPoints, 'basis-point');
  rows.push(
    [],
    [
      'Sản phẩm',
      'SKU',
      'Khối lượng nhập (gram)',
      'Lý do thiếu khối lượng nhập',
      'Tiền hàng nhập (VND)',
      'Lý do thiếu tiền hàng nhập',
      'Khối lượng bán (gram)',
      'Lý do thiếu khối lượng bán',
      'Doanh thu (VND)',
      'Lý do thiếu doanh thu',
    ],
    ...report.products.map((product) => [
      product.productName,
      product.sku,
      product.inboundWeightGrams.value ?? '',
      product.inboundWeightGrams.unavailableReason ?? '',
      product.inboundGoodsCostVnd.value ?? '',
      product.inboundGoodsCostVnd.unavailableReason ?? '',
      product.soldWeightGrams.value ?? '',
      product.soldWeightGrams.unavailableReason ?? '',
      product.revenueVnd.value ?? '',
      product.revenueVnd.unavailableReason ?? '',
    ]),
  );
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function downloadCsv(report: MonthlyOperationalReport): void {
  const csv = buildMonthlyReportCsv(report);
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const scope = report.scope.kind === 'ALL' ? 'tat-ca' : report.scope.kind.toLocaleLowerCase('vi');
  anchor.href = href;
  anchor.download = `bao-cao-${report.period.startBusinessDate.slice(0, 7)}-${scope}.csv`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 0);
}

function demoReport(yearMonth: string, role: Role): MonthlyOperationalReport {
  const [year = '2026', month = '09'] = yearMonth.split('-');
  const nextMonth = Number(month) === 12 ? '01' : String(Number(month) + 1).padStart(2, '0');
  const nextYear = Number(month) === 12 ? String(Number(year) + 1) : year;
  const available = (value: string, source: ReportMetricSource): ExactIntegerReportMetric => ({
    source,
    unavailableReason: null,
    value,
  });
  const unavailable = (reason: ReportUnavailableReason): ExactIntegerReportMetric => ({
    source: 'NOT_AVAILABLE',
    unavailableReason: reason,
    value: null,
  });
  return {
    counts: {
      allocationBatchesCompleted: 12,
      approvedDiscountSales: 8,
      inboundReceipts: 18,
      outboundOrdersReceived: 34,
      waitTicketsQueued: 5,
    },
    dataOrigin: 'LOCAL_TRANSACTIONAL_DATA',
    generatedAt: `${yearMonth}-17T03:20:00.000Z`,
    period: {
      endBusinessDateExclusive: `${nextYear}-${nextMonth}-01`,
      endExclusive: `${nextYear}-${nextMonth}-01T00:00:00.000Z`,
      start: `${yearMonth}-01T00:00:00.000Z`,
      startBusinessDate: `${yearMonth}-01`,
      timeZone: 'Asia/Ho_Chi_Minh',
    },
    products: [
      {
        inboundGoodsCostVnd: available('418000000', 'WAREHOUSE_RECEIPTS'),
        inboundWeightGrams: available('18200000', 'WAREHOUSE_RECEIPTS'),
        productId: demoProductId,
        productName: 'Đầm',
        revenueVnd: available('726000000', 'STORE_OUTBOUNDS'),
        sku: 'DAM-001',
        soldWeightGrams: available('9300000', 'STORE_OUTBOUNDS'),
      },
    ],
    ratios: {
      averageInboundCostPerKgVnd: available('22967', 'WAREHOUSE_RECEIPTS'),
      effectiveCostPerSoldKgVnd: unavailable('COGS_NOT_RECORDED_PER_SALE'),
      grossMarginBasisPoints: {
        source: 'NOT_AVAILABLE',
        unavailableReason: 'COGS_NOT_RECORDED_PER_SALE',
        value: null,
      },
      revenuePerInboundKgVnd: available('157480', 'WAREHOUSE_RECEIPTS_AND_STORE_OUTBOUNDS'),
    },
    scope: role === 'ADMIN' ? { kind: 'ALL' } : { kind: 'STORE', storeId: demoStoreId },
    totals: {
      handlingFeeVnd: available('12000000', 'WAREHOUSE_RECEIPTS'),
      inboundGoodsCostVnd: available('1340000000', 'WAREHOUSE_RECEIPTS'),
      inboundWeightGrams: available('58420000', 'WAREHOUSE_RECEIPTS'),
      landedInboundCostVnd: available('1382000000', 'WAREHOUSE_RECEIPTS'),
      otherInboundCostVnd: available('8000000', 'WAREHOUSE_RECEIPTS'),
      revenueVnd: available('2860000000', 'STORE_OUTBOUNDS'),
      soldWeightGrams: available('18540000', 'STORE_OUTBOUNDS'),
      transportationFeeVnd: available('22000000', 'WAREHOUSE_RECEIPTS'),
      vatCostVnd: unavailable('VAT_NOT_CAPTURED'),
    },
  };
}

export function ReportsPage() {
  const { role } = useOutletContext<AppOutletContext>();
  const sessionQuery = useSession();
  const [search, setSearch] = useSearchParams();
  const [defaultPeriod] = useState(currentBusinessMonth);
  const { period: yearMonth, scope: scopeSelection } = readReportNavigation(
    search,
    defaultPeriod,
    role === 'ADMIN',
  );
  const setYearMonth = (value: string) =>
    setSearch((previous) => updateReportNavigation(previous, 'period', value), { replace: true });
  const setScopeSelection = (value: string) =>
    setSearch((previous) => updateReportNavigation(previous, 'scope', value), { replace: true });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const storesQuery = useQuery({
    enabled: !mockModeEnabled,
    queryFn: listAccessibleStores,
    queryKey: ['stores', 'accessible'],
    retry: false,
  });
  const stores = (storesQuery.data ?? []).filter((store) => store.status === 'ACTIVE');
  const effectiveScopeSelection =
    role === 'ADMIN'
      ? scopeSelection || 'ALL'
      : scopeSelection && scopeSelection !== 'ALL'
        ? scopeSelection
        : (stores[0]?.id ?? '');
  const reportInput = reportQueryForSelection(role, yearMonth, effectiveScopeSelection);
  const reportQuery = useQuery({
    enabled: !mockModeEnabled && Boolean(sessionQuery.data) && reportInput !== null,
    queryFn: () => {
      if (!reportInput) throw new Error('Missing report scope');
      return getMonthlyOperationalReport(reportInput);
    },
    queryKey: ['reports', 'monthly-operational', reportInput],
    retry: false,
  });
  const preview = useMemo(
    () => (reportQueryForSelection('ADMIN', yearMonth, 'ALL') ? demoReport(yearMonth, role) : null),
    [role, yearMonth],
  );
  const report = mockModeEnabled ? preview : reportQuery.data;
  const loading =
    !mockModeEnabled &&
    (sessionQuery.isPending ||
      storesQuery.isPending ||
      (reportInput !== null && reportQuery.isPending));
  const loadError = sessionQuery.error ?? storesQuery.error ?? reportQuery.error;
  const noAssignedStores =
    !mockModeEnabled && role === 'HTKD' && !storesQuery.isPending && stores.length === 0;

  const handleExport = async () => {
    if (!report || exporting) return;
    setExportError('');
    setExporting(true);
    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      downloadCsv(report);
    } catch {
      setExportError('Không thể tạo tệp CSV trên thiết bị này. Vui lòng thử lại.');
    } finally {
      setExporting(false);
    }
  };

  const retry = () => {
    if (storesQuery.isError) void storesQuery.refetch();
    if (sessionQuery.isError) void sessionQuery.refetch();
    if (reportInput) void reportQuery.refetch();
  };

  return (
    <>
      <PageHeader
        actions={
          <>
            {!mockModeEnabled ? (
              <Button
                busy={reportQuery.isFetching}
                disabled={reportInput === null || Boolean(loadError)}
                onClick={() => void reportQuery.refetch()}
                tone="secondary"
              >
                <RefreshCw aria-hidden="true" size={16} /> Tải lại
              </Button>
            ) : null}
            <Button
              busy={exporting}
              disabled={!report || loading || Boolean(loadError)}
              onClick={() => void handleExport()}
            >
              <ArrowDownToLine aria-hidden="true" size={16} /> Xuất CSV
            </Button>
          </>
        }
        description="Số liệu từ giao dịch đã ghi nhận; chỉ số thiếu nguồn được nêu rõ, không tự thay bằng 0"
        title="Báo cáo hiệu quả"
      />

      <section aria-label="Bộ lọc báo cáo" className="panel report-controls">
        <label>
          Kỳ báo cáo
          <input
            max="2100-12"
            min="2000-01"
            onChange={(event) => setYearMonth(event.target.value)}
            type="month"
            value={yearMonth}
          />
        </label>
        <label>
          Phạm vi
          <select
            aria-label="Phạm vi báo cáo"
            disabled={mockModeEnabled || storesQuery.isPending || noAssignedStores}
            onChange={(event) => setScopeSelection(event.target.value)}
            value={
              mockModeEnabled ? (role === 'ADMIN' ? 'ALL' : demoStoreId) : effectiveScopeSelection
            }
          >
            {role === 'ADMIN' ? <option value="ALL">Toàn hệ thống</option> : null}
            {mockModeEnabled && role === 'HTKD' ? (
              <option value={demoStoreId}>Gò Vấp</option>
            ) : null}
            {stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.code} • {store.name}
              </option>
            ))}
          </select>
        </label>
        <div className="report-controls__source">
          <Database aria-hidden="true" size={18} />
          <div>
            <strong>
              {mockModeEnabled ? 'Bản xem trước có kiểm soát' : 'Dữ liệu giao dịch nội bộ'}
            </strong>
            <span>
              {role === 'ADMIN'
                ? 'Admin được xem toàn hệ thống hoặc từng cửa hàng.'
                : 'HTKD chỉ xem các cửa hàng được phân công.'}
            </span>
          </div>
        </div>
      </section>

      {exportError ? (
        <section className="panel report-message report-message--error" role="alert">
          <AlertTriangle aria-hidden="true" size={20} />
          <span>{exportError}</span>
        </section>
      ) : null}
      {loadError ? (
        <section className="panel report-message report-message--error" role="alert">
          <AlertTriangle aria-hidden="true" size={20} />
          <div>
            <strong>Không thể tải báo cáo</strong>
            <span>
              {loadError instanceof ApiClientError
                ? loadError.message
                : 'Máy chủ trả về dữ liệu không hợp lệ hoặc kết nối bị gián đoạn.'}
            </span>
          </div>
          <Button onClick={retry} tone="secondary">
            Thử lại
          </Button>
        </section>
      ) : null}
      {noAssignedStores ? (
        <section className="panel report-message" role="status">
          <AlertTriangle aria-hidden="true" size={20} />
          <div>
            <strong>Chưa có cửa hàng được phân công</strong>
            <span>Liên hệ Admin để cấp phạm vi trước khi xem báo cáo.</span>
          </div>
        </section>
      ) : null}
      {loading ? (
        <section aria-live="polite" className="panel report-message" role="status">
          <span aria-hidden="true" className="button__spinner" />
          <strong>Đang tổng hợp dữ liệu báo cáo…</strong>
        </section>
      ) : null}

      {report && !loadError ? <ReportContent report={report} /> : null}
    </>
  );
}

function MetricCell({
  formatter,
  metric,
}: {
  readonly formatter: (value: string) => string;
  readonly metric: ExactIntegerReportMetric;
}) {
  return (
    <span
      className={
        metric.value === null ? 'report-metric report-metric--unavailable' : 'report-metric'
      }
    >
      <strong>{exactMetricValue(metric, formatter)}</strong>
      <small>{metricDetail(metric)}</small>
    </span>
  );
}

function ReportContent({ report }: { readonly report: MonthlyOperationalReport }) {
  return (
    <>
      <section className="report-period-note">
        <div>
          <strong>
            {report.period.startBusinessDate} → {report.period.endBusinessDateExclusive}
          </strong>
          <span>Múi giờ nghiệp vụ: Asia/Ho_Chi_Minh</span>
        </div>
        <Badge tone="success">Nguồn giao dịch nội bộ</Badge>
        <small>Tạo lúc {new Date(report.generatedAt).toLocaleString('vi-VN')}</small>
      </section>

      <div className="stats-grid report-stats">
        <StatCard
          detail={metricDetail(report.totals.revenueVnd)}
          label="Doanh thu"
          tone="success"
          value={exactMetricValue(report.totals.revenueVnd, exactVnd)}
        />
        <StatCard
          detail={metricDetail(report.totals.landedInboundCostVnd)}
          label="Giá vốn nhập"
          value={exactMetricValue(report.totals.landedInboundCostVnd, exactVnd)}
        />
        <StatCard
          detail={metricDetail(report.totals.inboundWeightGrams)}
          label="Khối lượng nhập"
          tone="info"
          value={exactMetricValue(report.totals.inboundWeightGrams, exactGramsAsKilograms)}
        />
        <StatCard
          detail={metricDetail(report.ratios.grossMarginBasisPoints)}
          label="Biên lợi nhuận gộp"
          tone={report.ratios.grossMarginBasisPoints.value === null ? 'warning' : 'success'}
          value={basisPointMetricValue(report.ratios.grossMarginBasisPoints)}
        />
      </div>

      <div className="report-detail-grid">
        <section className="panel report-counts">
          <div className="section-heading section-heading--compact">
            <div>
              <h2>Khối lượng nghiệp vụ</h2>
              <p>Đếm trực tiếp theo trạng thái giao dịch trong kỳ.</p>
            </div>
          </div>
          <dl>
            <div>
              <dt>Phiếu nhập</dt>
              <dd>{report.counts.inboundReceipts}</dd>
            </div>
            <div>
              <dt>Đơn xuất đã nhận</dt>
              <dd>{report.counts.outboundOrdersReceived}</dd>
            </div>
            <div>
              <dt>Đợt phân bổ hoàn tất</dt>
              <dd>{report.counts.allocationBatchesCompleted}</dd>
            </div>
            <div>
              <dt>Phiếu chờ</dt>
              <dd>{report.counts.waitTicketsQueued}</dd>
            </div>
            <div>
              <dt>Sale giảm giá đã duyệt</dt>
              <dd>{report.counts.approvedDiscountSales}</dd>
            </div>
          </dl>
        </section>

        <section className="panel report-ratios">
          <div className="section-heading section-heading--compact">
            <div>
              <h2>Chi phí & hiệu suất</h2>
              <p>Mỗi chỉ số hiển thị nguồn hoặc lý do chưa thể tính.</p>
            </div>
          </div>
          <MetricRow
            label="Giá nhập bình quân / kg"
            metric={report.ratios.averageInboundCostPerKgVnd}
          />
          <MetricRow label="Doanh thu / kg nhập" metric={report.ratios.revenuePerInboundKgVnd} />
          <MetricRow
            label="Giá vốn hiệu lực / kg bán"
            metric={report.ratios.effectiveCostPerSoldKgVnd}
          />
          <MetricRow label="VAT đầu vào" metric={report.totals.vatCostVnd} />
        </section>
      </div>

      <section className="panel table-panel report-products">
        <div className="section-heading section-heading--compact">
          <div>
            <h2>Theo mặt hàng</h2>
            <p>Số liệu nguồn được giữ ở độ chính xác nguyên; tệp CSV xuất giá trị gốc.</p>
          </div>
        </div>
        {report.products.length === 0 ? (
          <div className="empty-state">
            <strong>Chưa có phát sinh theo mặt hàng</strong>
            <p>Kỳ và phạm vi đã chọn không có giao dịch phù hợp.</p>
          </div>
        ) : (
          <div className="responsive-table">
            <table>
              <thead>
                <tr>
                  <th>Mặt hàng</th>
                  <th>Nhập</th>
                  <th>Tiền hàng nhập</th>
                  <th>Đã bán</th>
                  <th>Doanh thu</th>
                </tr>
              </thead>
              <tbody>
                {report.products.map((product) => (
                  <tr key={product.productId}>
                    <td data-label="Mặt hàng">
                      <strong>{product.productName}</strong>
                      <small>{product.sku}</small>
                    </td>
                    <td data-label="Nhập">
                      <MetricCell
                        formatter={exactGramsAsKilograms}
                        metric={product.inboundWeightGrams}
                      />
                    </td>
                    <td data-label="Tiền hàng nhập">
                      <MetricCell formatter={exactVnd} metric={product.inboundGoodsCostVnd} />
                    </td>
                    <td data-label="Đã bán">
                      <MetricCell
                        formatter={exactGramsAsKilograms}
                        metric={product.soldWeightGrams}
                      />
                    </td>
                    <td data-label="Doanh thu">
                      <MetricCell formatter={exactVnd} metric={product.revenueVnd} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function MetricRow({
  label,
  metric,
}: {
  readonly label: string;
  readonly metric: ExactIntegerReportMetric;
}) {
  return (
    <div className="report-ratio-row">
      <span>{label}</span>
      <MetricCell formatter={exactVnd} metric={metric} />
    </div>
  );
}
