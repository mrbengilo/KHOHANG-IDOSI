import type {
  ExactIntegerReportMetric,
  InventoryAmount,
  ReportMetricSource,
  ReportUnavailableReason,
  Session,
  Store,
} from '@idosi/contracts';
import { useQuery } from '@tanstack/react-query';
import { IdosiSalesSummary } from '../features/idosi/IdosiSalesSummary';
import {
  AlertTriangle,
  ArrowRight,
  BellRing,
  Clock3,
  Database,
  RefreshCcw,
  ShoppingBag,
} from 'lucide-react';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import {
  readReportNavigation,
  reportDrilldownPath,
  updateReportNavigation,
} from '../lib/report-navigation';
import type { AppOutletContext } from '../components/AppShell';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { StatCard } from '../components/StatCard';
import {
  DashboardApiError,
  loadDashboardBootstrap,
  loadDashboardSnapshot,
  type DashboardScope,
  type DashboardSnapshot,
} from '../features/dashboard/dashboardApi';
import '../features/dashboard/dashboard.css';
import { businessDate } from '../lib/business-time';
import { formatKg } from '../lib/format';
import type { Role, StatusTone, StoreKind } from '../lib/types';

const sourceLabels: Record<ReportMetricSource, string> = {
  NOT_AVAILABLE: 'Chưa có nguồn dữ liệu',
  STORE_OUTBOUNDS: 'Phiếu xuất cửa hàng',
  STORE_RECEIPTS: 'Phiếu nhận cửa hàng',
  STORE_RECEIPTS_AND_STORE_OUTBOUNDS: 'Phiếu nhận và phiếu xuất cửa hàng',
  WAREHOUSE_RECEIPTS: 'Phiếu nhập kho',
  WAREHOUSE_RECEIPTS_AND_STORE_OUTBOUNDS: 'Phiếu nhập kho và phiếu xuất cửa hàng',
};

const unavailableLabels: Record<ReportUnavailableReason, string> = {
  COGS_NOT_RECORDED_PER_SALE: 'Chưa ghi nhận giá vốn theo từng giao dịch bán',
  MISSING_INBOUND_WEIGHT: 'Phiếu nhập chưa có khối lượng xác nhận',
  INVOICE_COST_NOT_ALLOCATED: 'Tiền hóa đơn chưa phân bổ theo mặt hàng',
  MISSING_SALE_REVENUE: 'Nguồn bán hàng chưa có doanh thu',
  VAT_NOT_CAPTURED: 'Chưa ghi nhận đầy đủ VAT trong phạm vi báo cáo',
  ZERO_INBOUND_WEIGHT: 'Kỳ này không có khối lượng nhập để tính tỷ lệ',
};

export type DashboardViewState =
  | 'BOOTSTRAP_LOADING'
  | 'BOOTSTRAP_ERROR'
  | 'EMPTY_SCOPE'
  | 'SNAPSHOT_LOADING'
  | 'SNAPSHOT_ERROR'
  | 'READY';

interface DashboardStateInput {
  readonly bootstrapError: boolean;
  readonly bootstrapPending: boolean;
  readonly hasScope: boolean;
  readonly hasSnapshot: boolean;
  readonly snapshotError: boolean;
  readonly snapshotPending: boolean;
}

export function dashboardViewState(input: DashboardStateInput): DashboardViewState {
  if (input.bootstrapPending) return 'BOOTSTRAP_LOADING';
  if (input.bootstrapError) return 'BOOTSTRAP_ERROR';
  if (!input.hasScope) return 'EMPTY_SCOPE';
  if (input.snapshotPending) return 'SNAPSHOT_LOADING';
  if (input.snapshotError || !input.hasSnapshot) return 'SNAPSHOT_ERROR';
  return 'READY';
}

export function dashboardRetryTarget(state: DashboardViewState): 'BOOTSTRAP' | 'SNAPSHOT' | null {
  if (state === 'BOOTSTRAP_ERROR') return 'BOOTSTRAP';
  if (state === 'SNAPSHOT_ERROR') return 'SNAPSHOT';
  return null;
}

export function resolveDashboardScope(
  session: Session,
  stores: readonly Store[],
  requestedScope: string,
): DashboardScope | null {
  const principal = session.principal;
  if (principal.role === 'ADMIN') {
    if (requestedScope === 'ALL' || requestedScope === '') return { kind: 'ALL' };
    return stores.some((store) => store.id === requestedScope)
      ? { kind: 'STORE', storeId: requestedScope }
      : { kind: 'ALL' };
  }

  if (principal.role === 'STORE') {
    return principal.storeId === null ? null : { kind: 'STORE', storeId: principal.storeId };
  }

  const assignedStores = stores.filter((store) => principal.assignedStoreIds.includes(store.id));
  const requested = assignedStores.find((store) => store.id === requestedScope);
  const store = requested ?? assignedStores[0];
  return store ? { kind: 'STORE', storeId: store.id } : null;
}

export function dashboardRouteForAction(
  action: 'PRIMARY' | 'WAITING',
  role: Role,
  storeKind: StoreKind | null,
): string {
  if (action === 'WAITING') return role === 'STORE' ? '/requests' : '/allocations';
  if (role === 'STORE') return storeKind === 'WHOLESALE' ? '/requests' : '/receive';
  return '/reports';
}

export function formatExactVnd(value: string): string {
  return new Intl.NumberFormat('vi-VN', {
    currency: 'VND',
    maximumFractionDigits: 0,
    style: 'currency',
  }).format(BigInt(value));
}

export function formatExactGrams(value: string): string {
  const grams = BigInt(value);
  const kilograms = grams / 1_000n;
  const remainder = grams % 1_000n;
  const whole = new Intl.NumberFormat('vi-VN').format(kilograms);
  if (remainder === 0n) return `${whole} kg`;
  return `${whole},${remainder.toString().padStart(3, '0').replace(/0+$/, '')} kg`;
}

function formatAmount(amount: InventoryAmount): string {
  if (amount.kind === 'UNIT')
    return `${new Intl.NumberFormat('vi-VN').format(amount.quantity)} bao`;
  return formatKg(amount.value);
}

function currentBusinessMonth(): string {
  return businessDate().slice(0, 7);
}

function parseMonth(yearMonth: string): { month: number; year: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null;
  return { month, year };
}

function metricValue(
  metric: ExactIntegerReportMetric,
  formatter: (value: string) => string,
): string {
  return metric.value === null ? 'Chưa có dữ liệu' : formatter(metric.value);
}

function metricDetail(metric: ExactIntegerReportMetric): string {
  if (metric.value !== null) return `Nguồn: ${sourceLabels[metric.source]}`;
  return metric.unavailableReason === null
    ? 'Backend chưa cung cấp nguồn cho chỉ số này'
    : unavailableLabels[metric.unavailableReason];
}

function errorMessage(error: unknown): string {
  if (error instanceof DashboardApiError) {
    return error.requestId ? `${error.message} • Mã yêu cầu ${error.requestId}` : error.message;
  }
  return 'Dữ liệu backend không đúng hợp đồng hoặc kết nối đã bị gián đoạn.';
}

interface StoreHealthRow {
  readonly activeOffers: number;
  readonly activeOrders: number;
  readonly activeWaitTickets: number;
  readonly pendingReceipts: number;
  readonly riskReceipts: number;
  readonly status: 'STABLE' | 'WATCH' | 'RISK';
  readonly store: Store;
}

export function buildStoreHealthRows(
  stores: readonly Store[],
  snapshot: DashboardSnapshot,
): StoreHealthRow[] {
  return stores.map((store) => {
    const receipts = snapshot.receipts.filter(
      (receipt) => receipt.storeId === store.id && receipt.status !== 'FINALIZED',
    );
    const activeWaitTickets = snapshot.waitTickets.filter(
      (ticket) =>
        ticket.storeId === store.id &&
        ['WAITING', 'OFFERED', 'PARTIALLY_FULFILLED'].includes(ticket.status),
    ).length;
    const activeOffers = snapshot.priorityOffers.filter(
      (offer) => offer.storeId === store.id && offer.status === 'PENDING',
    ).length;
    const activeOrders = snapshot.orderRequests.filter(
      (request) => request.storeId === store.id && request.status !== 'CANCELLED',
    ).length;
    const riskReceipts = receipts.filter((receipt) => receipt.status === 'RETURNED').length;
    const workload = receipts.length + activeWaitTickets + activeOffers;
    return {
      activeOffers,
      activeOrders,
      activeWaitTickets,
      pendingReceipts: receipts.length,
      riskReceipts,
      status: riskReceipts > 0 || workload >= 8 ? 'RISK' : workload > 0 ? 'WATCH' : 'STABLE',
      store,
    };
  });
}

interface ActivityItem {
  readonly detail: string;
  readonly id: string;
  readonly occurredAt: string;
  readonly title: string;
  readonly tone: StatusTone;
}

function recentActivity(snapshot: DashboardSnapshot, stores: readonly Store[]): ActivityItem[] {
  const storeName = (storeId: string) =>
    stores.find((store) => store.id === storeId)?.name ?? `Cửa hàng ${storeId.slice(0, 8)}`;
  const items: ActivityItem[] = [
    ...snapshot.receipts.map((receipt): ActivityItem => ({
      detail: `${storeName(receipt.storeId)} • ${receipt.lines.length} mặt hàng • ${receipt.status}`,
      id: `receipt-${receipt.id}`,
      occurredAt: receipt.updatedAt,
      title: `Phiếu nhận ${receipt.receiptNumber}`,
      tone:
        receipt.status === 'FINALIZED'
          ? 'success'
          : receipt.status === 'RETURNED'
            ? 'danger'
            : 'warning',
    })),
    ...snapshot.waitTickets.map((ticket): ActivityItem => ({
      detail: `${storeName(ticket.storeId)} • còn ${formatAmount(ticket.remaining)} • ${ticket.priority}`,
      id: `wait-${ticket.id}`,
      occurredAt: ticket.updatedAt,
      title: `Phiếu chờ ${ticket.id.slice(0, 8)}`,
      tone: ticket.status === 'FULFILLED' ? 'success' : 'warning',
    })),
    ...snapshot.priorityOffers.map((offer): ActivityItem => ({
      detail: `${storeName(offer.storeId)} • ${formatAmount(offer.offered)} • hết hạn ${new Date(offer.expiresAt).toLocaleString('vi-VN')}`,
      id: `offer-${offer.id}`,
      occurredAt: offer.offeredAt,
      title: `Đề nghị ưu tiên ${offer.status}`,
      tone:
        offer.status === 'PENDING'
          ? 'priority'
          : offer.status === 'ACCEPTED'
            ? 'success'
            : 'neutral',
    })),
    ...snapshot.orderRequests.map((request): ActivityItem => ({
      detail: `${storeName(request.storeId)} • ${request.lines.length} mặt hàng • ${request.status}`,
      id: `order-${request.id}`,
      occurredAt: request.submittedAt,
      title: `Yêu cầu đặt hàng lần ${request.requestSequence}`,
      tone: request.status === 'CANCELLED' ? 'danger' : 'info',
    })),
  ];
  return items
    .toSorted((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .slice(0, 8);
}

export function DashboardPage() {
  const { role: shellRole, storeKind: shellStoreKind } = useOutletContext<AppOutletContext>();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const { period: yearMonth, scope: requestedScope } = readReportNavigation(
    search,
    currentBusinessMonth(),
    shellRole === 'ADMIN',
  );
  const setYearMonth = (value: string) =>
    setSearch((previous) => updateReportNavigation(previous, 'period', value), { replace: true });
  const setRequestedScope = (value: string) =>
    setSearch((previous) => updateReportNavigation(previous, 'scope', value), { replace: true });
  const bootstrapQuery = useQuery({
    queryFn: loadDashboardBootstrap,
    queryKey: ['dashboard', 'bootstrap'],
    retry: false,
    staleTime: 30_000,
  });
  const bootstrap = bootstrapQuery.data;
  const scope = bootstrap
    ? resolveDashboardScope(bootstrap.session, bootstrap.stores, requestedScope)
    : null;
  const parsedMonth = parseMonth(yearMonth);
  const scopeKey = scope?.kind === 'ALL' ? 'ALL' : scope?.storeId;
  const snapshotQuery = useQuery({
    enabled: scope !== null && parsedMonth !== null,
    queryFn: () => {
      if (!scope || !parsedMonth) throw new Error('Dashboard scope is incomplete');
      return loadDashboardSnapshot({ ...parsedMonth, scope });
    },
    queryKey: ['dashboard', 'snapshot', yearMonth, scopeKey],
    retry: false,
  });
  const viewState = dashboardViewState({
    bootstrapError: bootstrapQuery.isError,
    bootstrapPending: bootstrapQuery.isPending,
    hasScope: scope !== null && parsedMonth !== null,
    hasSnapshot: snapshotQuery.data !== undefined,
    snapshotError: snapshotQuery.isError,
    snapshotPending: snapshotQuery.isPending,
  });
  const sessionRole = bootstrap?.session.principal.role ?? shellRole;
  const selectedStore =
    scope?.kind === 'STORE'
      ? bootstrap?.stores.find((store) => store.id === scope.storeId)
      : undefined;
  const effectiveStoreKind =
    selectedStore?.kind ?? (sessionRole === 'STORE' ? shellStoreKind : null);
  const roleMismatch = bootstrap !== undefined && bootstrap.session.principal.role !== shellRole;
  const busy = bootstrapQuery.isFetching || snapshotQuery.isFetching;

  const refresh = async () => {
    const bootstrapResult = await bootstrapQuery.refetch();
    if (!bootstrapResult.isError && scope !== null && parsedMonth !== null) {
      await snapshotQuery.refetch();
    }
  };

  const retry = () => {
    const target = dashboardRetryTarget(viewState);
    if (target === 'BOOTSTRAP') void bootstrapQuery.refetch();
    if (target === 'SNAPSHOT') void snapshotQuery.refetch();
  };

  const primaryTarget = dashboardRouteForAction('PRIMARY', sessionRole, effectiveStoreKind);
  const scopedPrimaryTarget =
    primaryTarget === '/reports' && scopeKey
      ? reportDrilldownPath(yearMonth, scopeKey)
      : primaryTarget;
  const primaryLabel =
    sessionRole === 'STORE'
      ? effectiveStoreKind === 'WHOLESALE'
        ? 'Đặt hàng'
        : 'Nhận hàng'
      : 'Xem báo cáo';
  const title =
    sessionRole === 'STORE'
      ? effectiveStoreKind === 'WHOLESALE'
        ? 'Tổng quan khách sỉ'
        : 'Tổng quan cửa hàng'
      : 'Tổng quan điều hành';

  return (
    <div className="dashboard-page">
      <PageHeader
        actions={
          <>
            <Button
              aria-label="Tải lại dữ liệu dashboard từ backend"
              busy={busy}
              onClick={() => void refresh()}
              tone="secondary"
            >
              <RefreshCcw aria-hidden="true" size={16} /> Tải lại
            </Button>
            {bootstrap ? (
              <Button onClick={() => navigate(scopedPrimaryTarget)}>
                {primaryLabel} <ArrowRight aria-hidden="true" size={16} />
              </Button>
            ) : null}
          </>
        }
        description="Số liệu trực tiếp từ giao dịch được phân quyền; dữ liệu thiếu nguồn không tự thay bằng số demo"
        title={title}
      />

      {roleMismatch ? (
        <DashboardMessage
          detail="Quyền trên giao diện khác phiên đăng nhập. Hệ thống đã chặn hiển thị để tránh lộ dữ liệu; hãy đăng nhập lại."
          title="Phiên đăng nhập không đồng nhất"
          tone="error"
        />
      ) : null}

      {!roleMismatch && bootstrap ? (
        <DashboardFilters
          onScopeChange={setRequestedScope}
          onYearMonthChange={setYearMonth}
          requestedScope={requestedScope}
          scope={scope}
          session={bootstrap.session}
          stores={bootstrap.stores}
          yearMonth={yearMonth}
        />
      ) : null}

      {!roleMismatch && viewState === 'BOOTSTRAP_LOADING' ? (
        <DashboardMessage
          detail="Đang xác minh phiên và phạm vi cửa hàng qua /auth/session và /stores."
          loading
          title="Đang tải phạm vi dashboard…"
        />
      ) : null}

      {!roleMismatch && viewState === 'BOOTSTRAP_ERROR' ? (
        <DashboardMessage
          action={<Button onClick={retry}>Thử lại</Button>}
          detail={errorMessage(bootstrapQuery.error)}
          title="Không thể xác minh nguồn dữ liệu"
          tone="error"
        />
      ) : null}

      {!roleMismatch && viewState === 'EMPTY_SCOPE' ? (
        <DashboardMessage
          detail={
            parsedMonth === null
              ? 'Hãy chọn một tháng hợp lệ từ 2000 đến 2100.'
              : 'Tài khoản chưa có cửa hàng được phân công. Liên hệ Admin để cấp phạm vi.'
          }
          title="Chưa thể tạo dashboard"
          tone="warning"
        />
      ) : null}

      {!roleMismatch && viewState === 'SNAPSHOT_LOADING' ? (
        <DashboardMessage
          detail="Đang tổng hợp báo cáo, phiếu nhận, phiếu chờ, offer và yêu cầu đặt hàng."
          loading
          title="Đang tải số liệu nghiệp vụ…"
        />
      ) : null}

      {!roleMismatch && viewState === 'SNAPSHOT_ERROR' ? (
        <DashboardMessage
          action={<Button onClick={retry}>Thử lại</Button>}
          detail={errorMessage(snapshotQuery.error)}
          title="Không thể tải dashboard"
          tone="error"
        />
      ) : null}

      {!roleMismatch && viewState === 'READY' && bootstrap && snapshotQuery.data ? (
        <>
          {effectiveStoreKind !== 'WHOLESALE' ? (
            <IdosiSalesSummary
              key={`${yearMonth}:${scopeKey}`}
              period={yearMonth}
              {...(scope?.kind === 'STORE' ? { storeId: scope.storeId } : {})}
            />
          ) : null}
          <DashboardContent
            onNavigate={(target) => navigate(target)}
            role={sessionRole}
            scope={scope as DashboardScope}
            snapshot={snapshotQuery.data}
            storeKind={effectiveStoreKind}
            stores={bootstrap.stores}
          />
        </>
      ) : null}
    </div>
  );
}

function DashboardFilters({
  onScopeChange,
  onYearMonthChange,
  requestedScope,
  scope,
  session,
  stores,
  yearMonth,
}: {
  readonly onScopeChange: (value: string) => void;
  readonly onYearMonthChange: (value: string) => void;
  readonly requestedScope: string;
  readonly scope: DashboardScope | null;
  readonly session: Session;
  readonly stores: readonly Store[];
  readonly yearMonth: string;
}) {
  const role = session.principal.role;
  const scopeValue = scope?.kind === 'ALL' ? 'ALL' : (scope?.storeId ?? requestedScope);
  return (
    <section aria-label="Bộ lọc dashboard" className="filter-card dashboard-filters">
      <label>
        Kỳ báo cáo
        <input
          aria-label="Kỳ báo cáo dashboard"
          max="2100-12"
          min="2000-01"
          onChange={(event) => onYearMonthChange(event.target.value)}
          type="month"
          value={yearMonth}
        />
      </label>
      {role !== 'STORE' ? (
        <label>
          Phạm vi cửa hàng
          <select
            aria-label="Phạm vi cửa hàng dashboard"
            onChange={(event) => onScopeChange(event.target.value)}
            value={scopeValue}
          >
            {role === 'ADMIN' ? <option value="ALL">Toàn hệ thống</option> : null}
            {stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.code} • {store.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="filter-card__summary dashboard-filters__source">
        <Badge tone="success">Backend trực tiếp</Badge>
        <Database aria-hidden="true" size={16} />
        <span>
          {scope?.kind === 'ALL'
            ? `${stores.length} cửa hàng được trả về theo quyền Admin`
            : 'Phạm vi được khóa theo session và quyền truy cập backend'}
        </span>
      </div>
    </section>
  );
}

function DashboardMessage({
  action,
  detail,
  loading = false,
  title,
  tone = 'neutral',
}: {
  readonly action?: React.ReactNode;
  readonly detail: string;
  readonly loading?: boolean;
  readonly title: string;
  readonly tone?: 'error' | 'neutral' | 'warning';
}) {
  return (
    <section
      aria-live="polite"
      className={`panel dashboard-message dashboard-message--${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {loading ? (
        <span aria-hidden="true" className="button__spinner" />
      ) : (
        <AlertTriangle aria-hidden="true" size={20} />
      )}
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      {action}
    </section>
  );
}

function DashboardContent({
  onNavigate,
  role,
  scope,
  snapshot,
  storeKind,
  stores,
}: {
  readonly onNavigate: (target: string) => void;
  readonly role: Role;
  readonly scope: DashboardScope;
  readonly snapshot: DashboardSnapshot;
  readonly storeKind: StoreKind | null;
  readonly stores: readonly Store[];
}) {
  const isWholesale = scope.kind === 'STORE' && storeKind === 'WHOLESALE';
  const scopedStores =
    scope.kind === 'ALL' ? stores : stores.filter((store) => store.id === scope.storeId);
  const openSessions = snapshot.orderSessions.filter((session) => session.status === 'OPEN');
  const activeOrders = snapshot.orderRequests.filter((request) => request.status !== 'CANCELLED');
  const activeWaitTickets = snapshot.waitTickets.filter((ticket) =>
    ['WAITING', 'OFFERED', 'PARTIALLY_FULFILLED'].includes(ticket.status),
  );
  const pendingOffers = snapshot.priorityOffers.filter((offer) => offer.status === 'PENDING');
  const pendingReceipts = snapshot.receipts.filter((receipt) => receipt.status !== 'FINALIZED');
  const activity = recentActivity(snapshot, stores);
  const healthRows = buildStoreHealthRows(scopedStores, snapshot);

  return (
    <>
      <section className="dashboard-source-strip" aria-label="Nguồn và thời điểm dashboard">
        <div>
          <Database aria-hidden="true" size={17} />
          <span>Báo cáo giao dịch nội bộ</span>
        </div>
        <Badge tone="success">{snapshot.report.dataOrigin}</Badge>
        <small>Tổng hợp lúc {new Date(snapshot.report.generatedAt).toLocaleString('vi-VN')}</small>
      </section>

      {isWholesale ? (
        <section className="permission-card dashboard-permission">
          <ShoppingBag aria-hidden="true" size={20} />
          <div>
            <strong>Phạm vi khách sỉ</strong>
            <span>Đặt hàng, theo dõi phân bổ, phiếu chờ và offer ưu tiên.</span>
            <small>Nghiệp vụ nhận, khui, bán lẻ và điều chuyển không áp dụng.</small>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="dashboard-kpi-title">
        <div className="section-heading">
          <div>
            <h2 id="dashboard-kpi-title">Chỉ số theo nguồn đã ghi nhận</h2>
            <p>Chỉ số tài chính theo kỳ đã chọn; công việc chờ theo trạng thái hiện tại.</p>
          </div>
          <Badge tone="info">Theo phạm vi được phân quyền</Badge>
        </div>
        <div className="stats-grid">
          {isWholesale ? (
            <>
              <StatCard
                detail="Nguồn: /order-sessions"
                label="Phiên đang mở"
                tone="info"
                value={String(openSessions.length)}
              />
              <StatCard
                detail="Yêu cầu chưa hủy trong phạm vi cửa hàng"
                label="Yêu cầu đặt hàng"
                value={String(activeOrders.length)}
              />
              <StatCard
                detail="WAITING, OFFERED hoặc PARTIALLY_FULFILLED"
                label="Phiếu đang chờ"
                tone="warning"
                value={String(activeWaitTickets.length)}
              />
              <StatCard
                detail="Offer PENDING cần phản hồi"
                label="Ưu tiên cần xử lý"
                tone={pendingOffers.length > 0 ? 'priority' : 'success'}
                value={String(pendingOffers.length)}
              />
            </>
          ) : (
            <>
              <StatCard
                detail={metricDetail(snapshot.report.totals.revenueVnd)}
                label="Doanh thu"
                tone="success"
                value={metricValue(snapshot.report.totals.revenueVnd, formatExactVnd)}
              />
              <StatCard
                detail={metricDetail(snapshot.report.totals.inboundWeightGrams)}
                label="Khối lượng nhập"
                tone="info"
                value={metricValue(snapshot.report.totals.inboundWeightGrams, formatExactGrams)}
              />
              <StatCard
                detail="Nguồn: /store-receipts • chưa FINALIZED"
                label="Phiếu nhận cần xử lý"
                tone={pendingReceipts.length > 0 ? 'warning' : 'success'}
                value={String(pendingReceipts.length)}
              />
              <StatCard
                detail="Nguồn: /wait-tickets và /priority-offers"
                label="Việc chờ / offer"
                tone={activeWaitTickets.length + pendingOffers.length > 0 ? 'warning' : 'success'}
                value={`${activeWaitTickets.length} / ${pendingOffers.length}`}
              />
            </>
          )}
        </div>
      </section>

      <section className="split-grid dashboard-operations" aria-label="Công việc vận hành">
        <article className="panel alerts-panel">
          <div className="section-heading section-heading--compact">
            <div>
              <h2>Công việc cần xử lý</h2>
              <p>Đếm từ trạng thái backend trong phạm vi hiện tại.</p>
            </div>
            <Badge
              tone={pendingReceipts.length + activeWaitTickets.length > 0 ? 'warning' : 'success'}
            >
              {pendingReceipts.length + activeWaitTickets.length + pendingOffers.length} việc
            </Badge>
          </div>
          <DashboardWorkRow
            detail={`${pendingReceipts.length} phiếu chưa FINALIZED`}
            label="Phiếu nhận hàng"
            tone={pendingReceipts.length > 0 ? 'warning' : 'success'}
            value={String(pendingReceipts.length)}
          />
          <DashboardWorkRow
            detail={`${activeWaitTickets.length} phiếu còn số lượng chờ`}
            label="Danh sách chờ"
            tone={activeWaitTickets.length > 0 ? 'warning' : 'success'}
            value={String(activeWaitTickets.length)}
          />
          <DashboardWorkRow
            detail={`${pendingOffers.length} offer đang PENDING`}
            label="Ưu tiên phản hồi"
            tone={pendingOffers.length > 0 ? 'priority' : 'success'}
            value={String(pendingOffers.length)}
          />
          <DashboardWorkRow
            detail={`${openSessions.length} phiên nhận yêu cầu`}
            label="Phiên đặt hàng mở"
            tone={openSessions.length > 0 ? 'info' : 'neutral'}
            value={String(openSessions.length)}
          />
          <Button
            aria-label={
              role === 'STORE'
                ? 'Mở trang yêu cầu và danh sách chờ'
                : 'Mở trang phân bổ và danh sách chờ'
            }
            onClick={() => onNavigate(dashboardRouteForAction('WAITING', role, storeKind))}
            tone="secondary"
          >
            Xem việc chờ <ArrowRight aria-hidden="true" size={16} />
          </Button>
        </article>

        <article className="panel dashboard-activity">
          <div className="section-heading section-heading--compact">
            <div>
              <h2>Hoạt động gần nhất</h2>
              <p>Phiếu nhận, chờ, offer và yêu cầu đặt hàng.</p>
            </div>
          </div>
          {activity.length === 0 ? (
            <div className="empty-state">
              <strong>Chưa có giao dịch trong phạm vi</strong>
              <p>Backend đã trả về danh sách rỗng; dashboard không tạo hoạt động giả.</p>
            </div>
          ) : (
            activity.map((item) => (
              <div className="alert-row" key={item.id}>
                <BellRing aria-hidden="true" size={17} />
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.detail}</span>
                </div>
                <Badge tone={item.tone}>
                  {new Date(item.occurredAt).toLocaleDateString('vi-VN')}
                </Badge>
              </div>
            ))
          )}
        </article>
      </section>

      <section className="panel table-panel" aria-labelledby="store-health-title">
        <div className="section-heading section-heading--compact">
          <div>
            <h2 id="store-health-title">Sức khỏe cửa hàng</h2>
            <p>Đánh giá từ phiếu nhận bị trả, việc chờ và offer; không suy diễn tồn kho.</p>
          </div>
          <Badge tone="info">{healthRows.length} cửa hàng</Badge>
        </div>
        {healthRows.length === 0 ? (
          <div className="empty-state">
            <strong>Không có cửa hàng trong phạm vi</strong>
            <p>Danh sách /stores không trả về cửa hàng phù hợp với session.</p>
          </div>
        ) : (
          <div className="responsive-table">
            <table>
              <thead>
                <tr>
                  <th>Cửa hàng</th>
                  <th>Loại</th>
                  <th>Phiếu nhận chờ</th>
                  <th>Phiếu chờ</th>
                  <th>Offer chờ</th>
                  <th>Đơn đang theo dõi</th>
                  <th>Sức khỏe</th>
                </tr>
              </thead>
              <tbody>
                {healthRows.map((row) => (
                  <tr key={row.store.id}>
                    <td data-label="Cửa hàng">
                      <strong>{row.store.name}</strong>
                      <small>{row.store.code}</small>
                    </td>
                    <td data-label="Loại">
                      <Badge tone={row.store.kind === 'RETAIL' ? 'info' : 'neutral'}>
                        {row.store.kind === 'RETAIL' ? 'Bán lẻ' : 'Khách sỉ'}
                      </Badge>
                    </td>
                    <td data-label="Phiếu nhận chờ">
                      {row.store.kind === 'WHOLESALE' ? 'Không áp dụng' : row.pendingReceipts}
                    </td>
                    <td data-label="Phiếu chờ">{row.activeWaitTickets}</td>
                    <td data-label="Offer chờ">{row.activeOffers}</td>
                    <td data-label="Đơn đang theo dõi">{row.activeOrders}</td>
                    <td data-label="Sức khỏe">
                      <Badge
                        tone={
                          row.status === 'STABLE'
                            ? 'success'
                            : row.status === 'WATCH'
                              ? 'warning'
                              : 'danger'
                        }
                      >
                        {row.status === 'STABLE'
                          ? 'Ổn định'
                          : row.status === 'WATCH'
                            ? 'Cần xem'
                            : `Rủi ro • ${row.riskReceipts} phiếu bị trả`}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="dashboard-data-note">
        <Clock3 aria-hidden="true" size={17} />
        <span>
          Công việc chờ phản ánh trạng thái hiện tại, không phải số dư lịch sử của kỳ đã chọn. Chỉ
          số tháng dùng nguồn tổng hợp /reports/monthly và giữ nguyên số nguyên từ backend.
        </span>
      </section>
    </>
  );
}

function DashboardWorkRow({
  detail,
  label,
  tone,
  value,
}: {
  readonly detail: string;
  readonly label: string;
  readonly tone: StatusTone;
  readonly value: string;
}) {
  return (
    <div className="alert-row">
      <BellRing aria-hidden="true" size={17} />
      <div>
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <Badge tone={tone}>{value}</Badge>
    </div>
  );
}
