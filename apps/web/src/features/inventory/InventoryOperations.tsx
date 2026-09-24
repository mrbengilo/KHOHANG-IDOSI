import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  OutboundReason,
  NewOutboundReason,
  Store,
  StoreInventoryBag,
  StoreInventoryBagStatus,
  StoreOutbound,
  StoreSortedStock,
  StoreSortingHistoryAction,
} from '@idosi/contracts';
import {
  ArrowDownToLine,
  CheckCircle2,
  PackageOpen,
  RefreshCw,
  Scale,
  ShieldCheck,
  ShoppingBag,
  XCircle,
} from 'lucide-react';
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppOutletContext } from '../../components/AppShell';
import { Badge } from '../../components/Badge';
import { BagWeightsInput } from '../../components/BagWeightsInput';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { MoneyInput } from '../../components/MoneyInput';
import { PageHeader } from '../../components/PageHeader';
import { DashboardSkeleton } from '../../components/Skeleton';
import { StatCard } from '../../components/StatCard';
import { ApiClientError, listAccessibleStores, listCatalog } from '../../lib/api';
import { useSession } from '../../lib/auth';
import { checkBagWeights } from '../../lib/bag-weights';
import { formatKg, formatKgExact, formatVnd } from '../../lib/format';
import { IdosiSalesWorkspace } from '../idosi/IdosiSalesWorkspace';
import { isOpenBagSelectionCurrent, OpenBagConfirmation } from './OpenBagConfirmation';
import {
  createStoreOutbound,
  createCharityExport,
  createStoreSorting,
  listCharityExports,
  listInventoryBags,
  listInventoryLedger,
  listStoreSortedStocks,
  listStoreSortingHistory,
  listStoreOutbounds,
  moveProductCharityToSale,
  openInventoryBag,
  reviewStoreOutbound,
} from './inventoryApi';
import './inventory-operations.css';
import { WarehouseInventory } from './WarehouseInventory';

const statusCopy: Record<
  StoreInventoryBagStatus,
  { readonly label: string; readonly tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }
> = {
  IN_TRANSIT: { label: 'Đang vận chuyển', tone: 'info' },
  AVAILABLE: { label: 'Chưa khui', tone: 'success' },
  OPEN: { label: 'Đang bán tại CH', tone: 'info' },
  EMPTY: { label: 'Đã hết', tone: 'neutral' },
  QUARANTINED: { label: 'Cách ly', tone: 'warning' },
  RETURNED: { label: 'Đã trả', tone: 'neutral' },
  LOST: { label: 'Thất lạc', tone: 'danger' },
};

const outboundStatusCopy = {
  PENDING: { label: 'Chờ duyệt', tone: 'warning' },
  APPROVED: { label: 'Đã duyệt', tone: 'success' },
  REJECTED: { label: 'Từ chối', tone: 'danger' },
} as const;

const reasonCopy: Record<OutboundReason, string> = {
  DISCOUNT_SALE: 'Sale theo ký (cũ)',
  SALE_KG: 'Sale theo ký',
  SALE_PIECE: 'Sale theo cái',
  CHARITY: 'Từ thiện',
  CANCEL: 'Hủy',
  TORN: 'Rách',
  DEFECTIVE: 'Lỗi',
  DIRTY: 'Bẩn',
  OTHER: 'Khác',
};

const sortingReasons = [
  'CHARITY',
  'SALE_KG',
  'SALE_PIECE',
  'CANCEL',
  'TORN',
  'DEFECTIVE',
  'DIRTY',
  'OTHER',
] as const;

export function outboundReasonsForMode(mode: 'SALE' | 'SORTING'): readonly OutboundReason[] {
  return mode === 'SALE' ? ['DISCOUNT_SALE', 'SALE_KG', 'SALE_PIECE'] : sortingReasons;
}

const ledgerOperationCopy = {
  RECEIVE: 'Nhập kho',
  CONSUME: 'Xuất kho',
  ADJUST: 'Điều chỉnh',
  QUARANTINE: 'Cách ly',
  RELEASE: 'Gỡ cách ly',
} as const;

const sortingHistoryCopy: Record<
  StoreSortingHistoryAction,
  { readonly label: string; readonly tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }
> = {
  SORT_SALE: { label: 'Lọc vào Sale', tone: 'info' },
  SORT_CHARITY: { label: 'Lọc vào Từ thiện', tone: 'warning' },
  SORT_CANCEL: { label: 'Hủy', tone: 'danger' },
  CHARITY_TO_SALE: { label: 'Từ thiện → Sale', tone: 'success' },
  CHARITY_EXPORT: { label: 'Xuất từ thiện', tone: 'neutral' },
};

const SORTING_HISTORY_PAGE_SIZE = 20;

const vietnamDateTimeParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Sorting history reads day-first in Vietnam time regardless of the device time zone. */
export function formatSortingTime(isoDateTime: string): string {
  const parts = new Map(
    vietnamDateTimeParts
      .formatToParts(new Date(isoDateTime))
      .map((part) => [part.type, part.value] as const),
  );
  return `${parts.get('day')}/${parts.get('month')}/${parts.get('year')} ${parts.get('hour')}:${parts.get('minute')}:${parts.get('second')}`;
}

const kilogramsPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/;

function errorMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : 'Dữ liệu máy chủ không hợp lệ.';
}

export function kilogramsToGrams(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0').slice(0, 3) || '0');
}

export function gramsToKilograms(grams: bigint): string {
  const sign = grams < 0n ? '-' : '';
  const absolute = grams < 0n ? -grams : grams;
  return `${sign}${absolute / 1000n}.${String(absolute % 1000n).padStart(3, '0')}`;
}

export { formatKg } from '../../lib/format';

export function isOutboundWeightAllowed(value: string, remainingWeightKg: string): boolean {
  if (!kilogramsPattern.test(value)) return false;
  const grams = kilogramsToGrams(value);
  return grams > 0n && grams <= kilogramsToGrams(remainingWeightKg);
}

function uuid(): string {
  return crypto.randomUUID();
}

function storeName(stores: readonly Store[], storeId: string): string {
  const store = stores.find((candidate) => candidate.id === storeId);
  return store ? `${store.code} · ${store.name}` : storeId;
}

function downloadInventoryCsv(
  bags: readonly StoreInventoryBag[],
  sortedStocks: readonly StoreSortedStock[],
  productNames: ReadonlyMap<string, string>,
  stores: readonly Store[],
): void {
  const quote = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const rows = [
    [
      'Cửa hàng',
      'Mã bao',
      'Mặt hàng',
      'Trạng thái',
      'Khối lượng đầu',
      'Khối lượng còn',
      'Sale còn',
      'Từ thiện còn',
      'Phiên bản',
    ],
    ...bags.map((bag) => [
      storeName(stores, bag.storeId),
      bag.bagCode,
      productNames.get(bag.productId) ?? bag.productId,
      statusCopy[bag.status].label,
      bag.originalWeightKg,
      bag.remainingWeightKg,
      sortedStocks.find((stock) => stock.inventoryLotId === bag.id)?.saleWeightKg ?? '0.000',
      sortedStocks.find((stock) => stock.inventoryLotId === bag.id)?.charityWeightKg ?? '0.000',
      bag.version,
    ]),
  ];
  const blob = new Blob([`\uFEFF${rows.map((row) => row.map(quote).join(',')).join('\n')}`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `doi-soat-ton-kho-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function useInventorySources(role: AppOutletContext['role']) {
  const sessionQuery = useSession();
  const storesQuery = useQuery({
    queryFn: listAccessibleStores,
    queryKey: ['stores', 'accessible'],
    retry: false,
  });
  const catalogQuery = useQuery({ queryFn: listCatalog, queryKey: ['catalog'], retry: false });
  const principalStoreId = sessionQuery.data?.principal.storeId ?? '';
  const stores = storesQuery.data ?? [];
  const defaultStoreId = role === 'STORE' ? principalStoreId : (stores[0]?.id ?? '');
  return { catalogQuery, defaultStoreId, principalStoreId, sessionQuery, stores, storesQuery };
}

export function ProductionInventoryPage({ role }: AppOutletContext) {
  const [scope, setScope] = useState<'WAREHOUSE' | 'STORE'>('WAREHOUSE');
  if (role !== 'ADMIN') return <StoreInventoryPage role={role} storeKind={null} />;
  const navigation = (
    <div className="inventory-actions inventory-scope-tabs" aria-label="Phạm vi tồn kho">
      <Button
        tone={scope === 'WAREHOUSE' ? 'primary' : 'secondary'}
        aria-pressed={scope === 'WAREHOUSE'}
        onClick={() => setScope('WAREHOUSE')}
      >
        Kho tổng
      </Button>
      <Button
        tone={scope === 'STORE' ? 'primary' : 'secondary'}
        aria-pressed={scope === 'STORE'}
        onClick={() => setScope('STORE')}
      >
        Kho cửa hàng
      </Button>
    </div>
  );
  return (
    <>
      {scope === 'WAREHOUSE' ? (
        <WarehouseInventory navigation={navigation} />
      ) : (
        <StoreInventoryPage role={role} storeKind={null} navigation={navigation} />
      )}
    </>
  );
}

function StoreInventoryPage({
  role,
  navigation,
}: AppOutletContext & { readonly navigation?: ReactNode }) {
  const { catalogQuery, defaultStoreId, sessionQuery, stores, storesQuery } =
    useInventorySources(role);
  const [storeId, setStoreId] = useState('');
  const [status, setStatus] = useState<StoreInventoryBagStatus | 'ALL'>('ALL');
  const [query, setQuery] = useState('');
  const [selectedBagId, setSelectedBagId] = useState('');
  const effectiveStoreId = role === 'STORE' ? defaultStoreId : storeId;
  const bagsQuery = useQuery({
    enabled: role !== 'STORE' || Boolean(effectiveStoreId),
    queryFn: () =>
      listInventoryBags({
        ...(effectiveStoreId ? { storeId: effectiveStoreId } : {}),
        ...(status === 'ALL' ? {} : { status }),
        ...(query.trim() ? { bagCode: query.trim() } : {}),
      }),
    queryKey: ['store-inventory-bags', effectiveStoreId, status, query.trim()],
    retry: false,
  });
  const sortedQuery = useQuery({
    enabled: role !== 'STORE' || Boolean(effectiveStoreId),
    queryFn: () => listStoreSortedStocks(effectiveStoreId || undefined),
    queryKey: ['store-sorted-stocks', effectiveStoreId],
    retry: false,
  });
  const bags = bagsQuery.data ?? [];
  const effectiveBagId = bags.some((bag) => bag.id === selectedBagId)
    ? selectedBagId
    : (bags[0]?.id ?? '');
  const ledgerQuery = useQuery({
    enabled: Boolean(effectiveBagId),
    queryFn: () => listInventoryLedger(effectiveBagId),
    queryKey: ['store-inventory-ledger', effectiveBagId],
    retry: false,
  });
  const productNames = useMemo(
    () => new Map((catalogQuery.data ?? []).map((product) => [product.id, product.name])),
    [catalogQuery.data],
  );
  const totalGrams = bags.reduce((sum, bag) => sum + kilogramsToGrams(bag.remainingWeightKg), 0n);
  const visibleBagIds = new Set(bags.map((bag) => bag.id));
  const visibleSortedStocks = (sortedQuery.data ?? []).filter((stock) =>
    visibleBagIds.has(stock.inventoryLotId),
  );
  const sortedSaleGrams = visibleSortedStocks.reduce(
    (sum, stock) => sum + kilogramsToGrams(stock.saleWeightKg),
    0n,
  );
  const sortedCharityGrams = visibleSortedStocks.reduce(
    (sum, stock) => sum + kilogramsToGrams(stock.charityWeightKg),
    0n,
  );
  const availableGrams = bags
    .filter((bag) => bag.status === 'AVAILABLE')
    .reduce((sum, bag) => sum + kilogramsToGrams(bag.remainingWeightKg), 0n);
  const openedGrams = bags
    .filter((bag) => bag.status === 'OPEN')
    .reduce((sum, bag) => sum + kilogramsToGrams(bag.remainingWeightKg), 0n);
  const loadError =
    sessionQuery.error ??
    storesQuery.error ??
    catalogQuery.error ??
    bagsQuery.error ??
    sortedQuery.error;

  const retry = async () => {
    await Promise.all([
      sessionQuery.refetch(),
      storesQuery.refetch(),
      catalogQuery.refetch(),
      bagsQuery.refetch(),
      sortedQuery.refetch(),
      ...(effectiveBagId ? [ledgerQuery.refetch()] : []),
    ]);
  };

  return (
    <>
      <PageHeader
        actions={
          <div className="inventory-actions">
            <Button
              disabled={bags.length === 0}
              onClick={() => downloadInventoryCsv(bags, visibleSortedStocks, productNames, stores)}
              tone="secondary"
            >
              <ArrowDownToLine aria-hidden="true" size={16} /> Xuất đối soát
            </Button>
            <Button
              busy={
                sessionQuery.isFetching ||
                storesQuery.isFetching ||
                catalogQuery.isFetching ||
                bagsQuery.isFetching ||
                sortedQuery.isFetching ||
                ledgerQuery.isFetching
              }
              onClick={() => void retry()}
              tone="secondary"
            >
              <RefreshCw aria-hidden="true" size={16} /> Làm mới
            </Button>
          </div>
        }
        description="Số dư lấy trực tiếp từ sổ phát sinh bất biến; mọi thay đổi đều có phiên bản và người thao tác"
        title="Tồn kho & lịch sử"
      />

      {navigation}

      {loadError ? (
        <section className="panel source-error" role="alert">
          <strong>Không thể tải tồn kho</strong>
          <p>{errorMessage(loadError)}</p>
          <Button
            busy={
              sessionQuery.isFetching ||
              storesQuery.isFetching ||
              catalogQuery.isFetching ||
              bagsQuery.isFetching ||
              sortedQuery.isFetching ||
              ledgerQuery.isFetching
            }
            onClick={() => void retry()}
            tone="secondary"
          >
            Thử lại
          </Button>
        </section>
      ) : bagsQuery.isPending ||
        sortedQuery.isPending ||
        catalogQuery.isPending ||
        storesQuery.isPending ? (
        <DashboardSkeleton />
      ) : (
        <>
          <div className="stats-grid stats-grid--small">
            <StatCard
              detail={`${bags.filter((bag) => bag.status === 'AVAILABLE').length} Mã bao`}
              label="Hàng chưa khui"
              tone="info"
              value={formatKg(gramsToKilograms(availableGrams))}
            />
            <StatCard
              detail={`${bags.filter((bag) => bag.status === 'OPEN').length} Mã bao`}
              label="Đang bán tại CH"
              value={formatKg(gramsToKilograms(openedGrams))}
            />
            <StatCard
              detail="Từ nguồn API tồn kho"
              label="Tổng còn lại"
              tone="success"
              value={formatKg(gramsToKilograms(totalGrams + sortedSaleGrams + sortedCharityGrams))}
            />
            <StatCard
              detail="Đã lọc, chưa bán hết"
              label="Sale còn"
              tone="info"
              value={formatKg(gramsToKilograms(sortedSaleGrams))}
            />
            <StatCard
              detail="Đã lọc, chưa xuất hết"
              label="Từ thiện còn"
              tone="warning"
              value={formatKg(gramsToKilograms(sortedCharityGrams))}
            />
            <StatCard
              detail="Không cho sửa/xóa giao dịch"
              label="Nguồn đối soát"
              tone="success"
              value="Sổ cái"
            />
          </div>
          <section className="panel inventory-panel">
            <div className="inventory-toolbar">
              {role !== 'STORE' ? (
                <label>
                  Cửa hàng
                  <select onChange={(event) => setStoreId(event.target.value)} value={storeId}>
                    <option value="">Tất cả cửa hàng được phân quyền</option>
                    {stores.map((store) => (
                      <option key={store.id} value={store.id}>
                        {store.code} · {store.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                Trạng thái
                <select
                  onChange={(event) =>
                    setStatus(event.target.value as StoreInventoryBagStatus | 'ALL')
                  }
                  value={status}
                >
                  <option value="ALL">Tất cả</option>
                  {Object.entries(statusCopy).map(([value, copy]) => (
                    <option key={value} value={value}>
                      {copy.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Tìm Mã bao
                <input
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Nhập Mã bao"
                  value={query}
                />
              </label>
            </div>
            {bags.length === 0 ? (
              <EmptyState
                detail="Không có Mã bao phù hợp với phạm vi và bộ lọc hiện tại."
                title="Chưa có tồn kho"
              />
            ) : (
              <div className="inventory-master-detail">
                <div className="responsive-table">
                  <table>
                    <thead>
                      <tr>
                        <th>Mã bao</th>
                        <th>Mặt hàng</th>
                        <th>Cửa hàng</th>
                        <th>Trạng thái</th>
                        <th>Còn lại</th>
                        <th>Thao tác</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bags.map((bag) => (
                        <tr key={bag.id}>
                          <td data-label="Mã bao">
                            <strong>{bag.bagCode}</strong>
                            <small>v{bag.version}</small>
                          </td>
                          <td data-label="Mặt hàng">
                            {productNames.get(bag.productId) ?? bag.productId}
                          </td>
                          <td data-label="Cửa hàng">{storeName(stores, bag.storeId)}</td>
                          <td data-label="Trạng thái">
                            <Badge tone={statusCopy[bag.status].tone}>
                              {statusCopy[bag.status].label}
                            </Badge>
                          </td>
                          <td data-label="Còn lại">{formatKg(bag.remainingWeightKg)}</td>
                          <td>
                            <button
                              className="link-button"
                              onClick={() => setSelectedBagId(bag.id)}
                              type="button"
                            >
                              Xem sổ
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <aside className="inventory-ledger" aria-live="polite">
                  <h2>Sổ phát sinh Mã bao</h2>
                  {!effectiveBagId ? (
                    <p>Chọn một Mã bao để xem lịch sử.</p>
                  ) : ledgerQuery.isPending ? (
                    <p>Đang tải sổ phát sinh…</p>
                  ) : ledgerQuery.isError ? (
                    <div role="alert">
                      <p>{errorMessage(ledgerQuery.error)}</p>
                      <Button
                        busy={ledgerQuery.isFetching}
                        onClick={() => void ledgerQuery.refetch()}
                        tone="secondary"
                      >
                        Thử lại
                      </Button>
                    </div>
                  ) : (ledgerQuery.data ?? []).length === 0 ? (
                    <p>Chưa có phát sinh cho Mã bao này.</p>
                  ) : (
                    <ol>
                      {(ledgerQuery.data ?? []).map((entry) => (
                        <li key={entry.id}>
                          <span>
                            <strong>{ledgerOperationCopy[entry.operation]}</strong>
                            <time>{new Date(entry.createdAt).toLocaleString('vi-VN')}</time>
                          </span>
                          <b>
                            {formatKg(entry.beforeWeightKg)} → {formatKg(entry.afterWeightKg)}
                          </b>
                          <small>{entry.reason}</small>
                        </li>
                      ))}
                    </ol>
                  )}
                </aside>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

export function ProductionOpenBagPage({ role }: AppOutletContext) {
  const queryClient = useQueryClient();
  const { catalogQuery, defaultStoreId, stores, storesQuery } = useInventorySources(role);
  const [storeId, setStoreId] = useState('');
  const [productId, setProductId] = useState('');
  const [notice, setNotice] = useState('');
  const [mutationError, setMutationError] = useState('');
  const [selectedBag, setSelectedBag] = useState<StoreInventoryBag | null>(null);
  const operationKeys = useRef(new Map<string, string>());
  const effectiveStoreId = role === 'STORE' ? defaultStoreId : storeId;
  const bagsQuery = useQuery({
    enabled: role !== 'STORE' || Boolean(effectiveStoreId),
    queryFn: () =>
      listInventoryBags({
        ...(effectiveStoreId ? { storeId: effectiveStoreId } : {}),
        status: 'AVAILABLE',
      }),
    queryKey: ['store-inventory-bags', effectiveStoreId, 'AVAILABLE'],
    retry: false,
  });
  const availableBags = bagsQuery.data ?? [];
  const products = (catalogQuery.data ?? []).filter((product) =>
    availableBags.some((bag) => bag.productId === product.id),
  );
  const productBags = availableBags
    .filter((bag) => bag.productId === productId)
    .sort((left, right) => left.bagCode.localeCompare(right.bagCode));
  const currentBag = availableBags.find((bag) => bag.id === selectedBag?.id);
  const selectedProduct = products.find((product) => product.id === productId);
  const mutation = useMutation({
    mutationFn: async (bag: StoreInventoryBag) => {
      const signature = `${bag.id}:${bag.version}`;
      const key = operationKeys.current.get(signature) ?? uuid();
      operationKeys.current.set(signature, key);
      return openInventoryBag(bag.id, { expectedVersion: bag.version }, key);
    },
    onError: (error) => setMutationError(errorMessage(error)),
    onSuccess: async (bag, submittedBag) => {
      operationKeys.current.delete(`${submittedBag.id}:${submittedBag.version}`);
      setSelectedBag(null);
      setMutationError('');
      if (productBags.length === 1) setProductId('');
      await queryClient.invalidateQueries({ queryKey: ['store-inventory-bags'] });
      setNotice(`Đã khui ${bag.bagCode}. Tồn chưa khui giảm 1 bao; tồn đang bán tăng 1 bao.`);
    },
  });

  const loadError = storesQuery.error ?? catalogQuery.error ?? bagsQuery.error;
  return (
    <>
      <PageHeader
        actions={
          <Button
            busy={bagsQuery.isFetching}
            onClick={() => void bagsQuery.refetch()}
            tone="secondary"
          >
            <RefreshCw aria-hidden="true" size={16} /> Làm mới
          </Button>
        }
        description="Chọn mặt hàng và bao khả dụng để khui; tổng khối lượng tồn kho không đổi"
        title="Khui kiện"
      />
      {role !== 'STORE' ? (
        <section className="panel scope-notice">
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>Chế độ giám sát</strong>
            <p>
              Admin/HTKD có thể xem bao chưa khui; chỉ tài khoản cửa hàng sở hữu mới được xác nhận
              khui.
            </p>
          </div>
        </section>
      ) : null}
      {notice ? (
        <div className="operation-notice operation-notice--success" role="status">
          {notice}
        </div>
      ) : null}
      {mutationError ? (
        <div className="operation-notice operation-notice--error" role="alert">
          {mutationError}
        </div>
      ) : null}
      {role !== 'STORE' ? (
        <label className="panel inventory-scope-select">
          Cửa hàng
          <select
            onChange={(event) => {
              setStoreId(event.target.value);
              setProductId('');
              setSelectedBag(null);
            }}
            value={storeId}
          >
            <option value="">Tất cả cửa hàng được phân quyền</option>
            {stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.code} · {store.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {loadError ? (
        <section className="panel source-error" role="alert">
          <strong>Không thể tải bao khả dụng</strong>
          <p>{errorMessage(loadError)}</p>
          <Button
            busy={bagsQuery.isFetching}
            onClick={() => void bagsQuery.refetch()}
            tone="secondary"
          >
            Thử lại
          </Button>
        </section>
      ) : bagsQuery.isPending || catalogQuery.isPending ? (
        <DashboardSkeleton />
      ) : availableBags.length === 0 ? (
        <section className="panel">
          <EmptyState
            detail="Chưa có bao khả dụng trong phạm vi hiện tại."
            title="Không có bao chờ khui"
          />
        </section>
      ) : (
        <section className="panel open-bag-form">
          <div className="section-heading section-heading--compact">
            <div>
              <h2>Chọn bao để khui</h2>
              <p>{availableBags.length} bao chưa khui trong phạm vi đang xem</p>
            </div>
            <PackageOpen aria-hidden="true" />
          </div>
          <div className="open-bag-fields">
            <label>
              Mặt hàng
              <select
                disabled={mutation.isPending}
                onChange={(event) => {
                  setProductId(event.target.value);
                  setSelectedBag(null);
                  setMutationError('');
                }}
                value={selectedProduct ? productId : ''}
              >
                <option value="">Chọn mặt hàng</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Bao khả dụng
              <select
                disabled={!selectedProduct || mutation.isPending}
                onChange={(event) => {
                  setSelectedBag(productBags.find((bag) => bag.id === event.target.value) ?? null);
                  setMutationError('');
                }}
                value={
                  selectedBag && productBags.some((bag) => bag.id === selectedBag.id)
                    ? selectedBag.id
                    : ''
                }
              >
                <option value="">Chọn bao</option>
                {productBags.map((bag) => (
                  <option key={bag.id} value={bag.id}>
                    {bag.bagCode} · {formatKg(bag.remainingWeightKg)}
                    {role === 'STORE' ? '' : ` · ${storeName(stores, bag.storeId)}`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {selectedProduct ? (
            <p className="open-bag-availability">
              {selectedProduct.name}: {productBags.length} bao chưa khui ·{' '}
              {formatKg(
                gramsToKilograms(
                  productBags.reduce(
                    (sum, bag) => sum + kilogramsToGrams(bag.remainingWeightKg),
                    0n,
                  ),
                ),
              )}
            </p>
          ) : null}
          {role === 'STORE' &&
          selectedBag &&
          selectedProduct &&
          selectedBag.productId === productId ? (
            <OpenBagConfirmation
              bag={selectedBag}
              busy={mutation.isPending}
              canConfirm={
                !bagsQuery.isFetching &&
                isOpenBagSelectionCurrent(selectedBag, currentBag, defaultStoreId)
              }
              onCancel={() => setSelectedBag(null)}
              onConfirm={() => {
                if (
                  !mutation.isPending &&
                  !bagsQuery.isFetching &&
                  isOpenBagSelectionCurrent(selectedBag, currentBag, defaultStoreId)
                ) {
                  mutation.mutate(selectedBag);
                }
              }}
            />
          ) : null}
        </section>
      )}
    </>
  );
}

interface OutboundPageProps extends AppOutletContext {
  readonly mode: 'SALE' | 'SORTING';
}

export function LegacyOutboundPage({ mode, role }: OutboundPageProps) {
  const queryClient = useQueryClient();
  const { catalogQuery, defaultStoreId, stores, storesQuery } = useInventorySources(role);
  const [storeId, setStoreId] = useState('');
  const [bagId, setBagId] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [revenueVnd, setRevenueVnd] = useState('');
  const [pieceCount, setPieceCount] = useState('');
  const [reason, setReason] = useState<NewOutboundReason>(mode === 'SALE' ? 'SALE_KG' : 'CHARITY');
  const isSale = mode === 'SALE' || reason === 'SALE_KG' || reason === 'SALE_PIECE';
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [operationError, setOperationError] = useState('');
  const operationKeys = useRef(new Map<string, string>());
  const effectiveStoreId = role === 'STORE' ? defaultStoreId : storeId;
  const bagsQuery = useQuery({
    enabled: role !== 'STORE' || Boolean(effectiveStoreId),
    queryFn: async () => {
      const filters = effectiveStoreId ? { storeId: effectiveStoreId } : {};
      const pages = await Promise.all([
        listInventoryBags({ ...filters, status: 'AVAILABLE' }),
        listInventoryBags({ ...filters, status: 'OPEN' }),
      ]);
      return pages.flat();
    },
    queryKey: ['store-inventory-bags', effectiveStoreId, 'outbound-source'],
    retry: false,
  });
  const outboundsQuery = useQuery({
    queryFn: async () => {
      const filters = effectiveStoreId ? { storeId: effectiveStoreId } : {};
      const pages = await Promise.all(
        outboundReasonsForMode(mode).map((outboundReason) =>
          listStoreOutbounds({ ...filters, reason: outboundReason }),
        ),
      );
      return pages.flat().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    queryKey: ['store-outbounds', effectiveStoreId, mode],
    retry: false,
  });
  const eligibleBags = bagsQuery.data ?? [];
  const displayedOutbounds = outboundsQuery.data ?? [];
  const effectiveBagId = eligibleBags.some((bag) => bag.id === bagId)
    ? bagId
    : (eligibleBags[0]?.id ?? '');
  const selectedBag = eligibleBags.find((bag) => bag.id === effectiveBagId);
  const productNames = useMemo(
    () => new Map((catalogQuery.data ?? []).map((product) => [product.id, product.name])),
    [catalogQuery.data],
  );

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedBag || !effectiveStoreId) throw new Error('Chưa chọn Mã bao hợp lệ.');
      const signature = [
        selectedBag.id,
        selectedBag.version,
        weightKg,
        reason,
        revenueVnd,
        pieceCount,
      ].join(':');
      const key = operationKeys.current.get(signature) ?? uuid();
      operationKeys.current.set(signature, key);
      const revenue = isSale ? Number(revenueVnd) : null;
      const result = await createStoreOutbound(
        {
          storeId: effectiveStoreId,
          inventoryLotId: selectedBag.id,
          expectedInventoryVersion: selectedBag.version,
          weightKg,
          reason: mode === 'SALE' ? 'SALE_KG' : reason,
          revenueVnd: revenue,
          pieceCount: reason === 'SALE_PIECE' ? Number(pieceCount) : null,
        },
        key,
      );
      operationKeys.current.delete(signature);
      return result;
    },
    onError: (error) => setOperationError(errorMessage(error)),
    onSuccess: async () => {
      setOperationError('');
      setNotice('Đã tạo phiếu và gửi HTKD/Admin duyệt. Tồn chỉ giảm sau khi phiếu được duyệt.');
      setWeightKg('');
      setRevenueVnd('');
      setPieceCount('');
      await queryClient.invalidateQueries({ queryKey: ['store-outbounds'] });
    },
  });
  const reviewMutation = useMutation({
    mutationFn: async ({
      decision,
      outbound,
    }: {
      decision: 'APPROVE' | 'REJECT';
      outbound: StoreOutbound;
    }) => {
      const note = (reviewNotes[outbound.id] ?? '').trim();
      const signature = `${outbound.id}:${outbound.version}:${decision}:${note}`;
      const key = operationKeys.current.get(signature) ?? uuid();
      operationKeys.current.set(signature, key);
      const result = await reviewStoreOutbound(
        outbound.id,
        { decision, expectedVersion: outbound.version, note: note || null },
        key,
      );
      operationKeys.current.delete(signature);
      return result;
    },
    onError: (error) => setOperationError(errorMessage(error)),
    onSuccess: async (outbound) => {
      setOperationError('');
      setNotice(
        outbound.status === 'APPROVED'
          ? 'Đã duyệt phiếu; tồn kho và sổ phát sinh đã cập nhật nguyên tử.'
          : 'Đã từ chối phiếu và lưu lý do.',
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['store-outbounds'] }),
        queryClient.invalidateQueries({ queryKey: ['store-inventory-bags'] }),
        queryClient.invalidateQueries({ queryKey: ['store-inventory-ledger'] }),
      ]);
    },
  });

  const parsedRevenue = Number(revenueVnd);
  const formInvalid =
    !selectedBag ||
    !isOutboundWeightAllowed(weightKg, selectedBag.remainingWeightKg) ||
    (isSale &&
      (!/^\d+$/.test(revenueVnd) || !Number.isSafeInteger(parsedRevenue) || parsedRevenue < 0)) ||
    (mode === 'SORTING' &&
      reason === 'SALE_PIECE' &&
      (!/^[1-9]\d*$/.test(pieceCount) ||
        !Number.isSafeInteger(Number(pieceCount)) ||
        Number(pieceCount) > 2_147_483_647));
  const loadError =
    storesQuery.error ?? catalogQuery.error ?? bagsQuery.error ?? outboundsQuery.error;
  const pending = displayedOutbounds.filter((outbound) => outbound.status === 'PENDING').length;
  const approved = displayedOutbounds.filter((outbound) => outbound.status === 'APPROVED').length;
  const reasonLabel = mode === 'SORTING' ? 'Loại hàng' : 'Lý do';

  return (
    <>
      <PageHeader
        actions={
          <Button
            busy={bagsQuery.isFetching || outboundsQuery.isFetching}
            onClick={() => void Promise.all([bagsQuery.refetch(), outboundsQuery.refetch()])}
            tone="secondary"
          >
            <RefreshCw aria-hidden="true" size={16} /> Làm mới
          </Button>
        }
        description={
          mode === 'SALE'
            ? 'Ghi doanh thu theo Mã bao; chỉ trừ kho khi người có quyền duyệt phiếu'
            : 'Lập chứng từ từ thiện, sale theo ký/cái hoặc hủy; không reset tồn'
        }
        title={mode === 'SALE' ? 'Bán & đồng bộ' : 'Lọc & xử lý'}
      />
      {mode === 'SALE' ? (
        <IdosiSalesWorkspace role={role} principalStoreId={defaultStoreId} stores={stores} />
      ) : null}
      {notice ? (
        <div className="operation-notice operation-notice--success" role="status">
          {notice}
        </div>
      ) : null}
      {operationError ? (
        <div className="operation-notice operation-notice--error" role="alert">
          {operationError}
        </div>
      ) : null}
      {loadError ? (
        <section className="panel source-error" role="alert">
          <strong>Không thể tải dữ liệu vận hành</strong>
          <p>{errorMessage(loadError)}</p>
          <Button
            busy={bagsQuery.isFetching || outboundsQuery.isFetching}
            onClick={() => void Promise.all([bagsQuery.refetch(), outboundsQuery.refetch()])}
            tone="secondary"
          >
            Thử lại
          </Button>
        </section>
      ) : bagsQuery.isPending || outboundsQuery.isPending || catalogQuery.isPending ? (
        <DashboardSkeleton />
      ) : (
        <>
          <div className="stats-grid stats-grid--small">
            <StatCard
              detail="Chưa tác động tồn"
              label="Phiếu chờ duyệt"
              tone="warning"
              value={String(pending)}
            />
            <StatCard
              detail="Đã ghi sổ phát sinh"
              label="Phiếu đã duyệt"
              tone="success"
              value={String(approved)}
            />
            <StatCard
              detail="AVAILABLE hoặc OPEN"
              label="Mã bao khả dụng"
              tone="info"
              value={String(eligibleBags.length)}
            />
          </div>
          {role === 'STORE' ? (
            <section className="panel outbound-create">
              <div className="section-heading section-heading--compact">
                <div>
                  <h2>{mode === 'SALE' ? 'Tạo phiếu bán giảm giá' : 'Tạo phiếu xử lý'}</h2>
                  <p>Mỗi lần gửi có khóa idempotency; bấm lại không tạo trùng.</p>
                </div>
                {mode === 'SALE' ? (
                  <ShoppingBag aria-hidden="true" />
                ) : (
                  <Scale aria-hidden="true" />
                )}
              </div>
              <div className="outbound-form-grid">
                <label>
                  <span className="field-label">Mã bao</span>
                  <select
                    required
                    onChange={(event) => setBagId(event.target.value)}
                    value={effectiveBagId}
                  >
                    <option value="">Chọn Mã bao</option>
                    {eligibleBags.map((bag) => (
                      <option key={bag.id} value={bag.id}>
                        {bag.bagCode} · {productNames.get(bag.productId) ?? bag.productId} · còn{' '}
                        {formatKg(bag.remainingWeightKg)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="field-label">Khối lượng (kg)</span>
                  <input
                    required
                    inputMode="decimal"
                    min="0.001"
                    onChange={(event) => setWeightKg(event.target.value)}
                    placeholder="0.000"
                    step="0.001"
                    type="number"
                    value={weightKg}
                  />
                  <small>
                    {selectedBag
                      ? `Tối đa ${formatKg(selectedBag.remainingWeightKg)} · v${selectedBag.version}`
                      : 'Chưa có Mã bao khả dụng'}
                  </small>
                </label>
                {mode === 'SORTING' ? (
                  <label>
                    <span className="field-label">Lý do</span>
                    <select
                      required
                      onChange={(event) => {
                        setReason(
                          event.target.value === 'SALE'
                            ? 'SALE_KG'
                            : (event.target.value as NewOutboundReason),
                        );
                        setPieceCount('');
                        setRevenueVnd('');
                      }}
                      value={reason === 'SALE_KG' || reason === 'SALE_PIECE' ? 'SALE' : reason}
                    >
                      <option value="CHARITY">Từ thiện</option>
                      <option value="SALE">Sale</option>
                      <option value="CANCEL">Hủy</option>
                    </select>
                  </label>
                ) : null}
                {isSale ? (
                  <label>
                    <span className="field-label">Doanh thu (VND)</span>
                    <MoneyInput required onValueChange={setRevenueVnd} value={revenueVnd} />
                  </label>
                ) : null}
                {mode === 'SORTING' && isSale ? (
                  <label>
                    <span className="field-label">{reasonLabel}</span>
                    <select
                      onChange={(event) => {
                        setReason(event.target.value as 'SALE_KG' | 'SALE_PIECE');
                        setPieceCount('');
                      }}
                      value={reason}
                    >
                      <option value="SALE_KG">Sale theo ký</option>
                      <option value="SALE_PIECE">Sale theo cái</option>
                    </select>
                  </label>
                ) : null}
                {mode === 'SORTING' && reason === 'SALE_PIECE' ? (
                  <label>
                    <span className="field-label">Số cái</span>
                    <input
                      required
                      inputMode="numeric"
                      min="1"
                      max="2147483647"
                      onChange={(event) => setPieceCount(event.target.value)}
                      step="1"
                      type="number"
                      value={pieceCount}
                    />
                  </label>
                ) : null}
              </div>
              <Button
                busy={createMutation.isPending}
                disabled={formInvalid}
                onClick={() => createMutation.mutate()}
              >
                Gửi phiếu chờ duyệt
              </Button>
            </section>
          ) : (
            <section className="panel oversight-banner">
              <ShieldCheck aria-hidden="true" />
              <div>
                <strong>Chế độ duyệt</strong>
                <p>
                  Kiểm tra Mã bao, khối lượng và {reasonLabel.toLowerCase()} trước khi duyệt. Duyệt
                  sẽ trừ tồn và ghi sổ trong cùng giao dịch.
                </p>
              </div>
              <label>
                Cửa hàng
                <select onChange={(event) => setStoreId(event.target.value)} value={storeId}>
                  <option value="">Tất cả cửa hàng được phân quyền</option>
                  {stores.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.code} · {store.name}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          )}
          <section className="panel table-panel">
            <div className="section-heading section-heading--compact">
              <div>
                <h2>Chứng từ nguồn</h2>
                <p>
                  Dữ liệu lấy từ `/store-outbounds`; không có dữ liệu minh họa trong production.
                </p>
              </div>
            </div>
            {displayedOutbounds.length === 0 ? (
              <EmptyState
                detail="Chưa có phiếu phù hợp trong phạm vi hiện tại."
                title="Chưa có chứng từ"
              />
            ) : (
              <div className="responsive-table">
                <table>
                  <thead>
                    <tr>
                      <th>Thời gian</th>
                      <th>Mã bao</th>
                      <th>{reasonLabel}</th>
                      <th>Khối lượng</th>
                      <th>Số cái</th>
                      <th>Doanh thu</th>
                      <th>Trạng thái</th>
                      <th>Thao tác</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedOutbounds.map((outbound) => {
                      const bag = (bagsQuery.data ?? []).find(
                        (candidate) => candidate.id === outbound.inventoryLotId,
                      );
                      const reviewNote = reviewNotes[outbound.id] ?? '';
                      const canReview = role !== 'STORE' && outbound.status === 'PENDING';
                      return (
                        <tr key={outbound.id}>
                          <td data-label="Thời gian">
                            {outbound.code ? <strong>{outbound.code} · </strong> : null}
                            {new Date(outbound.createdAt).toLocaleString('vi-VN')}
                          </td>
                          <td data-label="Mã bao">
                            <strong>{bag?.bagCode ?? outbound.inventoryLotId}</strong>
                            <small>{storeName(stores, outbound.storeId)}</small>
                          </td>
                          <td data-label={reasonLabel}>{reasonCopy[outbound.reason]}</td>
                          <td data-label="Khối lượng">{formatKg(outbound.weightKg)}</td>
                          <td data-label="Số cái">{outbound.pieceCount ?? '—'}</td>
                          <td data-label="Doanh thu">
                            {outbound.revenueVnd === null ? '—' : formatVnd(outbound.revenueVnd)}
                          </td>
                          <td data-label="Trạng thái">
                            <Badge tone={outboundStatusCopy[outbound.status].tone}>
                              {outboundStatusCopy[outbound.status].label}
                            </Badge>
                            {outbound.reviewNote ? <small>{outbound.reviewNote}</small> : null}
                          </td>
                          <td data-label="Thao tác">
                            {canReview ? (
                              <div className="review-actions">
                                <input
                                  aria-label={`Ghi chú duyệt ${outbound.id}`}
                                  onChange={(event) =>
                                    setReviewNotes((current) => ({
                                      ...current,
                                      [outbound.id]: event.target.value,
                                    }))
                                  }
                                  placeholder="Ghi chú / lý do từ chối"
                                  value={reviewNote}
                                />
                                <Button
                                  busy={
                                    reviewMutation.isPending &&
                                    reviewMutation.variables?.outbound.id === outbound.id &&
                                    reviewMutation.variables.decision === 'APPROVE'
                                  }
                                  disabled={reviewMutation.isPending}
                                  onClick={() =>
                                    reviewMutation.mutate({ decision: 'APPROVE', outbound })
                                  }
                                  tone="success"
                                >
                                  <CheckCircle2 aria-hidden="true" size={16} /> Duyệt
                                </Button>
                                <Button
                                  busy={
                                    reviewMutation.isPending &&
                                    reviewMutation.variables?.outbound.id === outbound.id &&
                                    reviewMutation.variables.decision === 'REJECT'
                                  }
                                  disabled={
                                    reviewMutation.isPending || reviewNote.trim().length < 3
                                  }
                                  onClick={() =>
                                    reviewMutation.mutate({ decision: 'REJECT', outbound })
                                  }
                                  tone="danger"
                                >
                                  <XCircle aria-hidden="true" size={16} /> Từ chối
                                </Button>
                              </div>
                            ) : (
                              <span>—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

export function ProductionOutboundPage(props: OutboundPageProps) {
  return <SortedStockWorkspace {...props} />;
}

function SortedStockWorkspace({ mode, role }: OutboundPageProps) {
  const queryClient = useQueryClient();
  const { catalogQuery, defaultStoreId, stores, storesQuery } = useInventorySources(role);
  const [storeId, setStoreId] = useState('');
  const [bagId, setBagId] = useState('');
  const [reason, setReason] = useState<'CHARITY' | 'SALE' | 'CANCEL'>('CHARITY');
  const [weightKg, setWeightKg] = useState('');
  const [notice, setNotice] = useState('');
  const [operationError, setOperationError] = useState('');
  const operationKeys = useRef(new Map<string, string>());
  const effectiveStoreId = role === 'STORE' ? defaultStoreId : storeId;
  const sortedQuery = useQuery({
    queryKey: ['store-sorted-stocks', effectiveStoreId],
    queryFn: () => listStoreSortedStocks(effectiveStoreId || undefined),
    enabled: role !== 'STORE' || Boolean(effectiveStoreId),
    retry: false,
  });
  const bagsQuery = useQuery({
    queryKey: ['store-inventory-bags', effectiveStoreId, 'sorting-source'],
    queryFn: async () => {
      const filters = effectiveStoreId ? { storeId: effectiveStoreId } : {};
      const pages = await Promise.all([
        listInventoryBags({ ...filters, status: 'AVAILABLE' }),
        listInventoryBags({ ...filters, status: 'OPEN' }),
      ]);
      return pages.flat();
    },
    enabled: mode === 'SORTING' && (role !== 'STORE' || Boolean(effectiveStoreId)),
    retry: false,
  });
  const productNames = useMemo(
    () => new Map((catalogQuery.data ?? []).map((product) => [product.id, product.name])),
    [catalogQuery.data],
  );
  const stocks = sortedQuery.data ?? [];
  const eligibleBags = bagsQuery.data ?? [];
  const effectiveBagId = eligibleBags.some((bag) => bag.id === bagId)
    ? bagId
    : (eligibleBags[0]?.id ?? '');
  const selectedBag = eligibleBags.find((bag) => bag.id === effectiveBagId);
  const saleGrams = stocks.reduce((sum, stock) => sum + kilogramsToGrams(stock.saleWeightKg), 0n);
  const charityGrams = stocks.reduce(
    (sum, stock) => sum + kilogramsToGrams(stock.charityWeightKg),
    0n,
  );
  const byProduct = new Map<
    string,
    { storeId: string; productId: string; saleGrams: bigint; charityGrams: bigint }
  >();
  for (const stock of stocks) {
    const key = `${stock.storeId}:${stock.productId}`;
    const current = byProduct.get(key);
    byProduct.set(key, {
      storeId: stock.storeId,
      productId: stock.productId,
      saleGrams: (current?.saleGrams ?? 0n) + kilogramsToGrams(stock.saleWeightKg),
      charityGrams: (current?.charityGrams ?? 0n) + kilogramsToGrams(stock.charityWeightKg),
    });
  }
  const saleByProduct = [...byProduct.values()].filter((item) => item.saleGrams > 0n);
  const charityByProduct = [...byProduct.values()].filter((item) => item.charityGrams > 0n);
  const charityExportsQuery = useQuery({
    queryKey: ['store-charity-exports', effectiveStoreId],
    queryFn: () => listCharityExports(effectiveStoreId || undefined),
    enabled: mode === 'SORTING' && (role !== 'STORE' || Boolean(effectiveStoreId)),
    retry: false,
  });
  const refreshStock = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['store-sorted-stocks'] }),
      queryClient.invalidateQueries({ queryKey: ['store-inventory-bags'] }),
      queryClient.invalidateQueries({ queryKey: ['store-inventory-ledger'] }),
      queryClient.invalidateQueries({ queryKey: ['store-charity-exports'] }),
      queryClient.invalidateQueries({ queryKey: ['store-sorting-history'] }),
    ]);
  };
  const sortingMutation = useMutation({
    mutationFn: async () => {
      if (!selectedBag || !effectiveStoreId) throw new Error('Chưa chọn Mã bao hợp lệ.');
      const signature = `${selectedBag.id}:${selectedBag.version}:${reason}:${weightKg}`;
      const key = operationKeys.current.get(signature) ?? uuid();
      operationKeys.current.set(signature, key);
      const result = await createStoreSorting(
        {
          storeId: effectiveStoreId,
          inventoryLotId: selectedBag.id,
          expectedInventoryVersion: selectedBag.version,
          reason,
          weightKg,
        },
        key,
      );
      operationKeys.current.delete(signature);
      return result;
    },
    onError: (error) => setOperationError(errorMessage(error)),
    onSuccess: async () => {
      setOperationError('');
      setNotice(
        reason === 'CANCEL'
          ? 'Đã xác nhận hủy và ghi sổ.'
          : `Đã cộng ${weightKg} kg vào mục ${reason === 'SALE' ? 'Sale' : 'Từ thiện'}.`,
      );
      setWeightKg('');
      await refreshStock();
    },
  });
  const charityMutation = useMutation({
    mutationFn: async (
      variables:
        | { action: 'SALE'; storeId: string; productId: string; kilograms: string }
        | { action: 'CHARITY'; storeId: string; productId: string; bagWeightsKg: string[] },
    ) => {
      const signature = JSON.stringify(variables);
      const key = operationKeys.current.get(signature) ?? uuid();
      operationKeys.current.set(signature, key);
      if (variables.action === 'SALE') {
        await moveProductCharityToSale(
          {
            storeId: variables.storeId,
            productId: variables.productId,
            weightKg: variables.kilograms,
          },
          key,
        );
        operationKeys.current.delete(signature);
        return null;
      }
      const created = await createCharityExport(
        {
          storeId: variables.storeId,
          productId: variables.productId,
          bagWeightsKg: variables.bagWeightsKg,
          note: null,
        },
        key,
      );
      operationKeys.current.delete(signature);
      return created;
    },
    onError: (error) => setOperationError(errorMessage(error)),
    onSuccess: async (created, variables) => {
      setOperationError('');
      setNotice(
        variables.action === 'SALE'
          ? `Đã chuyển ${variables.kilograms} kg ${productNames.get(variables.productId) ?? ''} từ Từ thiện về Sale.`
          : `Đã xuất từ thiện ${created?.bagQuantity ?? 0} bao (${formatKgExact(created?.weightKg ?? '0')}) theo phiếu ${created?.exportNumber ?? ''}.`,
      );
      await refreshStock();
    },
  });
  const loadError =
    sortedQuery.error ??
    catalogQuery.error ??
    storesQuery.error ??
    (mode === 'SORTING' ? (bagsQuery.error ?? charityExportsQuery.error) : null);

  return (
    <>
      <PageHeader
        title={mode === 'SALE' ? 'Bán & đồng bộ' : 'Lọc & xử lý'}
        description={
          mode === 'SALE'
            ? 'Số dư Sale theo mặt hàng tự cập nhật từ dữ liệu bán trên IDOSI'
            : 'Lưu kg đã lọc vào Sale hoặc Từ thiện; kg bán giá thường trên IDOSI tự trừ vào Mã bao'
        }
        actions={
          <Button
            tone="secondary"
            busy={sortedQuery.isFetching || bagsQuery.isFetching}
            onClick={() =>
              void Promise.all([
                sortedQuery.refetch(),
                ...(mode === 'SORTING' ? [bagsQuery.refetch()] : []),
              ])
            }
          >
            <RefreshCw aria-hidden="true" size={16} /> Làm mới
          </Button>
        }
      />
      {mode === 'SALE' ? (
        <IdosiSalesWorkspace role={role} principalStoreId={defaultStoreId} stores={stores} />
      ) : null}
      {notice ? (
        <div className="operation-notice operation-notice--success" role="status">
          {notice}
        </div>
      ) : null}
      {operationError ? (
        <div className="operation-notice operation-notice--error" role="alert">
          {operationError}
        </div>
      ) : null}
      {loadError ? (
        <section className="panel source-error" role="alert">
          <strong>Không thể tải số dư đã lọc</strong>
          <p>{errorMessage(loadError)}</p>
        </section>
      ) : sortedQuery.isPending ||
        catalogQuery.isPending ||
        (mode === 'SORTING' && bagsQuery.isPending) ? (
        <DashboardSkeleton />
      ) : (
        <>
          {role !== 'STORE' ? (
            <section className="panel inventory-toolbar">
              <label>
                Cửa hàng
                <select value={storeId} onChange={(event) => setStoreId(event.target.value)}>
                  <option value="">Tất cả cửa hàng được phân quyền</option>
                  {stores.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.code} · {store.name}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          ) : null}
          <div className="stats-grid stats-grid--small">
            <StatCard
              label="Sale còn"
              value={formatKgExact(gramsToKilograms(saleGrams))}
              detail="Tự trừ theo IDOSI"
              tone="info"
            />
            <StatCard
              label="Từ thiện còn"
              value={formatKg(gramsToKilograms(charityGrams))}
              detail="Chờ chuyển Sale hoặc xuất"
              tone="warning"
            />
            {mode === 'SORTING' ? (
              <StatCard
                label="Số bao có thể lọc"
                value={String(eligibleBags.length)}
                detail="Phần kg chưa phân loại"
                tone="success"
              />
            ) : null}
          </div>
          {mode === 'SORTING' && role === 'STORE' ? (
            <section className="panel outbound-create">
              <div className="section-heading section-heading--compact">
                <div>
                  <h2>Lưu khối lượng đã lọc</h2>
                  <p>
                    Nhập tổng kg đưa vào Sale hoặc Từ thiện; số bán theo ký/cái được đối soát từ
                    IDOSI.
                  </p>
                </div>
                <Scale aria-hidden="true" />
              </div>
              <div className="outbound-form-grid">
                <label>
                  <span className="field-label">Mã bao</span>
                  <select value={effectiveBagId} onChange={(event) => setBagId(event.target.value)}>
                    <option value="">Chọn Mã bao</option>
                    {eligibleBags.map((bag) => (
                      <option key={bag.id} value={bag.id}>
                        {bag.bagCode} · {productNames.get(bag.productId) ?? bag.productId} · còn{' '}
                        {formatKg(bag.remainingWeightKg)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="field-label">Loại hàng</span>
                  <select
                    value={reason}
                    onChange={(event) => setReason(event.target.value as typeof reason)}
                  >
                    <option value="CHARITY">Từ thiện</option>
                    <option value="SALE">Sale</option>
                    <option value="CANCEL">Hủy</option>
                  </select>
                </label>
                <label>
                  <span className="field-label-row">
                    <span className="field-label">Khối lượng đã lọc (kg)</span>
                    <small>
                      {selectedBag
                        ? `Tối đa ${formatKg(selectedBag.remainingWeightKg)}`
                        : 'Chưa có Mã bao khả dụng'}
                    </small>
                  </span>
                  <input
                    type="number"
                    min="0.001"
                    step="0.001"
                    inputMode="decimal"
                    placeholder="0.000"
                    value={weightKg}
                    onChange={(event) => setWeightKg(event.target.value)}
                  />
                </label>
              </div>
              <Button
                className="outbound-create__submit"
                busy={sortingMutation.isPending}
                disabled={
                  !selectedBag || !isOutboundWeightAllowed(weightKg, selectedBag.remainingWeightKg)
                }
                onClick={() => sortingMutation.mutate()}
              >
                {reason === 'CANCEL' ? 'Xác nhận hủy' : 'Lưu khối lượng đã lọc'}
              </Button>
            </section>
          ) : null}
          <section className="panel table-panel">
            <div className="section-heading section-heading--compact">
              <div>
                <h2>Hàng Sale còn lại</h2>
                <p>Kg đã lọc trừ kg bán trên IDOSI, theo từng cửa hàng và mặt hàng.</p>
              </div>
            </div>
            {saleByProduct.length === 0 ? (
              <EmptyState
                title="Chưa có hàng Sale"
                detail="Lưu khối lượng Sale sau lọc để bắt đầu đối soát."
              />
            ) : (
              <div className="responsive-table">
                <table>
                  <thead>
                    <tr>
                      <th>Cửa hàng</th>
                      <th>Mặt hàng</th>
                      <th>Sale còn</th>
                    </tr>
                  </thead>
                  <tbody>
                    {saleByProduct.map((item) => (
                      <tr key={`${item.storeId}:${item.productId}`}>
                        <td data-label="Cửa hàng">{storeName(stores, item.storeId)}</td>
                        <td data-label="Mặt hàng">
                          {productNames.get(item.productId) ?? item.productId}
                        </td>
                        <td data-label="Sale còn">
                          <strong>{formatKgExact(gramsToKilograms(item.saleGrams))}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          {mode === 'SORTING' ? (
            <>
              <section className="panel table-panel">
                <div className="section-heading section-heading--compact">
                  <div>
                    <h2>Hàng Từ thiện</h2>
                    <p>
                      Theo từng mặt hàng: quay lại Sale theo kg, hoặc xuất từ thiện theo số bao và
                      kg từng bao.
                    </p>
                  </div>
                </div>
                {charityByProduct.length === 0 ? (
                  <EmptyState
                    title="Chưa có hàng Từ thiện"
                    detail="Lưu khối lượng Từ thiện sau lọc để quay lại Sale hoặc xuất đi."
                  />
                ) : (
                  <div className="sorted-charity-grid">
                    {charityByProduct.map((item) => (
                      <CharityProductCard
                        key={`${item.storeId}:${item.productId}:${item.charityGrams}`}
                        productName={productNames.get(item.productId) ?? item.productId}
                        storeName={storeName(stores, item.storeId)}
                        charityWeightKg={gramsToKilograms(item.charityGrams)}
                        editable={role === 'STORE'}
                        busy={charityMutation.isPending}
                        onMoveToSale={(kilograms) =>
                          charityMutation.mutate({
                            action: 'SALE',
                            storeId: item.storeId,
                            productId: item.productId,
                            kilograms,
                          })
                        }
                        onExport={(bagWeightsKg) =>
                          charityMutation.mutate({
                            action: 'CHARITY',
                            storeId: item.storeId,
                            productId: item.productId,
                            bagWeightsKg,
                          })
                        }
                      />
                    ))}
                  </div>
                )}
              </section>
              <section className="panel table-panel">
                <div className="section-heading section-heading--compact">
                  <div>
                    <h2>Phiếu xuất từ thiện</h2>
                    <p>{charityExportsQuery.data?.length ?? 0} phiếu gần nhất.</p>
                  </div>
                </div>
                {(charityExportsQuery.data ?? []).length === 0 ? (
                  <EmptyState
                    title="Chưa có phiếu xuất từ thiện"
                    detail="Mỗi lần xuất ghi số bao và kg từng bao."
                  />
                ) : (
                  <div className="sorted-charity-grid">
                    {(charityExportsQuery.data ?? []).map((row) => (
                      <article className="sorted-charity-card" key={row.id}>
                        <div>
                          <h3>{row.exportNumber}</h3>
                          <small>
                            {storeName(stores, row.storeId)} ·{' '}
                            {new Date(row.createdAt).toLocaleString('vi-VN')}
                          </small>
                        </div>
                        <strong>
                          {productNames.get(row.productId) ?? row.productId} · {row.bagQuantity} bao
                          · {formatKgExact(row.weightKg)}
                        </strong>
                        <ul className="sorted-charity-bags" aria-label="Khối lượng từng bao">
                          {row.bagWeightsKg.map((weight, index) => (
                            <li key={index}>
                              Bao {index + 1} · {productNames.get(row.productId) ?? row.productId} ·{' '}
                              {formatKgExact(weight)}
                            </li>
                          ))}
                        </ul>
                      </article>
                    ))}
                  </div>
                )}
              </section>
              <SortingHistoryPanel
                key={effectiveStoreId || 'all-stores'}
                storeId={effectiveStoreId}
                stores={stores}
                productNames={productNames}
                showStore={role !== 'STORE'}
              />
            </>
          ) : null}
        </>
      )}
    </>
  );
}

function SortingHistoryPanel({
  storeId,
  stores,
  productNames,
  showStore,
}: {
  readonly storeId: string;
  readonly stores: readonly Store[];
  readonly productNames: ReadonlyMap<string, string>;
  readonly showStore: boolean;
}) {
  const [date, setDate] = useState('');
  const [page, setPage] = useState(1);
  const headingId = useId();
  const historyQuery = useQuery({
    queryKey: ['store-sorting-history', storeId, date, page],
    queryFn: () =>
      listStoreSortingHistory({
        ...(storeId ? { storeId } : {}),
        ...(date ? { date } : {}),
        page,
        pageSize: SORTING_HISTORY_PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const rows = historyQuery.data?.data ?? [];
  const meta = historyQuery.data?.pagination;
  const lastPage = Math.max(1, meta?.totalPages ?? 1);
  return (
    <section className="panel table-panel sorting-history" aria-labelledby={headingId}>
      <div className="section-heading section-heading--compact sorting-history__heading">
        <div>
          <h2 id={headingId}>Lịch sử lọc</h2>
          <p>
            Ngày giờ, Mã bao, mặt hàng và số kg của từng lần lọc, chuyển Sale hoặc xuất từ thiện.
          </p>
        </div>
        <div className="sorting-history__filters">
          <label>
            <span className="field-label">Ngày</span>
            <input
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
                setPage(1);
              }}
            />
          </label>
          {date ? (
            <Button
              tone="secondary"
              onClick={() => {
                setDate('');
                setPage(1);
              }}
            >
              Tất cả ngày
            </Button>
          ) : null}
        </div>
      </div>
      {historyQuery.isError ? (
        <div
          className="operation-notice operation-notice--error sorting-history__error"
          role="alert"
        >
          <span>Không thể tải lịch sử lọc: {errorMessage(historyQuery.error)}</span>
          <Button tone="secondary" onClick={() => void historyQuery.refetch()}>
            Thử lại
          </Button>
        </div>
      ) : historyQuery.isPending ? (
        <p className="sorting-history__status" role="status">
          Đang tải lịch sử lọc…
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="Chưa có lịch sử lọc"
          detail={
            date
              ? 'Không có lần lọc hoặc xử lý nào trong ngày đã chọn.'
              : 'Mỗi lần lưu khối lượng đã lọc sẽ được ghi lại tại đây.'
          }
        />
      ) : (
        <>
          <div className="responsive-table" aria-busy={historyQuery.isFetching}>
            <table>
              <thead>
                <tr>
                  <th>Thời gian</th>
                  {showStore ? <th>Cửa hàng</th> : null}
                  <th>Mã bao</th>
                  <th>Mặt hàng</th>
                  <th>Xử lý</th>
                  <th>Khối lượng</th>
                  <th>Người thực hiện</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Thời gian">
                      <time dateTime={row.occurredAt}>{formatSortingTime(row.occurredAt)}</time>
                    </td>
                    {showStore ? (
                      <td data-label="Cửa hàng">{storeName(stores, row.storeId)}</td>
                    ) : null}
                    <td data-label="Mã bao">{row.bagCode ?? '—'}</td>
                    <td data-label="Mặt hàng">
                      {productNames.get(row.productId) ?? row.productId}
                    </td>
                    <td data-label="Xử lý">
                      <Badge tone={sortingHistoryCopy[row.action].tone}>
                        {sortingHistoryCopy[row.action].label}
                      </Badge>
                    </td>
                    <td data-label="Khối lượng">
                      <strong>{formatKgExact(row.weightKg)}</strong>
                    </td>
                    <td data-label="Người thực hiện">{row.actorDisplayName ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {lastPage > 1 ? (
            <nav className="sorting-history__pagination" aria-label="Phân trang lịch sử lọc">
              <Button
                tone="secondary"
                disabled={page <= 1 || historyQuery.isFetching}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Trang trước
              </Button>
              <span>
                Trang {page}/{lastPage} · {meta?.totalItems ?? 0} lần
              </span>
              <Button
                tone="secondary"
                disabled={page >= lastPage || historyQuery.isFetching}
                onClick={() => setPage((current) => current + 1)}
              >
                Trang sau
              </Button>
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
}

function CharityProductCard({
  productName,
  storeName: sourceStoreName,
  charityWeightKg,
  editable,
  busy,
  onMoveToSale,
  onExport,
}: {
  readonly productName: string;
  readonly storeName: string;
  readonly charityWeightKg: string;
  readonly editable: boolean;
  readonly busy: boolean;
  readonly onMoveToSale: (kilograms: string) => void;
  readonly onExport: (bagWeightsKg: string[]) => void;
}) {
  const [saleKg, setSaleKg] = useState('');
  const [bagCount, setBagCount] = useState('');
  const [bagWeights, setBagWeights] = useState<string[]>([]);
  const [confirmExport, setConfirmExport] = useState(false);
  const saleAllowed = isOutboundWeightAllowed(saleKg, charityWeightKg);
  const bagCheck = checkBagWeights(bagCount, bagWeights, charityWeightKg);
  const idPrefix = useId();
  return (
    <article className="sorted-charity-card">
      <div>
        <h3>{productName}</h3>
        <small>{sourceStoreName}</small>
      </div>
      <strong>{formatKgExact(charityWeightKg)} còn lại</strong>
      {editable ? (
        <>
          <fieldset className="sorted-charity-action">
            <legend>Quay lại Sale</legend>
            <label>
              Khối lượng (kg)
              <input
                type="number"
                min="0.001"
                step="0.001"
                inputMode="decimal"
                placeholder="0.000"
                value={saleKg}
                onChange={(event) => setSaleKg(event.target.value)}
              />
            </label>
            <Button
              tone="secondary"
              disabled={!saleAllowed || busy}
              onClick={() => onMoveToSale(gramsToKilograms(kilogramsToGrams(saleKg)))}
            >
              Chuyển về Sale
            </Button>
          </fieldset>
          <fieldset className="sorted-charity-action">
            <legend>Xuất từ thiện</legend>
            <BagWeightsInput
              idPrefix={idPrefix}
              productName={productName}
              availableKg={charityWeightKg}
              count={bagCount}
              weights={bagWeights}
              check={bagCheck}
              onChange={(count, weights) => {
                setBagCount(count);
                setBagWeights(weights);
                setConfirmExport(false);
              }}
            />
            {!confirmExport ? (
              <Button disabled={!bagCheck.valid || busy} onClick={() => setConfirmExport(true)}>
                Xuất từ thiện
              </Button>
            ) : (
              <div
                className="sorted-charity-confirm"
                role="group"
                aria-label="Xác nhận xuất từ thiện"
              >
                <p>
                  Xác nhận xuất {bagCheck.bagWeightsKg.length} bao {productName} (
                  {formatKgExact(bagCheck.totalKg)}) đi từ thiện?
                </p>
                <Button
                  disabled={busy || !bagCheck.valid}
                  onClick={() => onExport(bagCheck.bagWeightsKg)}
                >
                  Xác nhận xuất
                </Button>
                <Button tone="secondary" onClick={() => setConfirmExport(false)}>
                  Quay lại
                </Button>
              </div>
            )}
          </fieldset>
        </>
      ) : null}
    </article>
  );
}
