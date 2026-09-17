import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Store, StoreTransfer, StoreTransferStatus } from '@idosi/contracts';
import {
  ArrowRight,
  CheckCircle2,
  CircleCheck,
  RefreshCw,
  Send,
  ShieldCheck,
  Truck,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import type { AppOutletContext } from '../../components/AppShell';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { DashboardSkeleton } from '../../components/Skeleton';
import { ApiClientError, listAccessibleStores, listCatalog } from '../../lib/api';
import { useSession } from '../../lib/auth';
import { formatVnd } from '../../lib/format';
import { listInventoryBags } from '../inventory/inventoryApi';
import {
  cancelStoreTransfer,
  createStoreTransfer,
  dispatchStoreTransfer,
  listStoreTransferDestinations,
  listStoreTransfers,
  receiveStoreTransfer,
} from './transferApi';
import './transfer-operations.css';

const kilogramsPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/;

const transferStatusCopy: Record<
  StoreTransferStatus,
  { readonly label: string; readonly tone: 'neutral' | 'info' | 'success' | 'danger' }
> = {
  DRAFT: { label: 'Phiếu nháp', tone: 'neutral' },
  IN_TRANSIT: { label: 'Đang vận chuyển', tone: 'info' },
  RECEIVED: { label: 'Đã nhận', tone: 'success' },
  CANCELLED: { label: 'Đã hủy', tone: 'danger' },
};

type TransferAction = 'DISPATCH' | 'RECEIVE' | 'CANCEL';

interface Notice {
  readonly tone: 'success' | 'error';
  readonly text: string;
}

interface ActionInput {
  readonly action: TransferAction;
  readonly transfer: StoreTransfer;
  readonly sourceBagVersion?: number;
  readonly reason?: string;
}

function exactGrams(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0').slice(0, 3) || '0');
}

export function isTransferWeightAllowed(value: string, remainingWeightKg: string): boolean {
  if (!kilogramsPattern.test(value)) return false;
  const grams = exactGrams(value);
  return grams > 0n && grams <= exactGrams(remainingWeightKg);
}

export function transferActionsForStore(
  transfer: StoreTransfer,
  principalStoreId: string,
): readonly TransferAction[] {
  if (transfer.status === 'DRAFT' && transfer.sourceStoreId === principalStoreId) {
    return ['DISPATCH', 'CANCEL'];
  }
  if (transfer.status === 'IN_TRANSIT' && transfer.destinationStoreId === principalStoreId) {
    return ['RECEIVE'];
  }
  return [];
}

function formatKg(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  return `${new Intl.NumberFormat('vi-VN').format(BigInt(whole))},${fraction.padEnd(3, '0').slice(0, 3)} kg`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : 'Dữ liệu máy chủ không hợp lệ.';
}

function storeLabel(stores: readonly Store[], storeId: string): string {
  const store = stores.find((candidate) => candidate.id === storeId);
  return store ? `${store.code} · ${store.name}` : storeId;
}

function transferTimeline(status: StoreTransferStatus) {
  return (
    <div aria-label={`Trạng thái: ${transferStatusCopy[status].label}`} className="transfer-flow">
      <span className="transfer-flow__step transfer-flow__step--done">
        <CircleCheck aria-hidden="true" size={17} /> Tạo phiếu
      </span>
      <ArrowRight aria-hidden="true" size={16} />
      <span
        className={
          status === 'IN_TRANSIT' || status === 'RECEIVED'
            ? 'transfer-flow__step transfer-flow__step--done'
            : 'transfer-flow__step'
        }
      >
        <Truck aria-hidden="true" size={17} /> Vận chuyển
      </span>
      <ArrowRight aria-hidden="true" size={16} />
      <span
        className={
          status === 'RECEIVED'
            ? 'transfer-flow__step transfer-flow__step--done'
            : 'transfer-flow__step'
        }
      >
        <CheckCircle2 aria-hidden="true" size={17} /> Xác nhận đích
      </span>
    </div>
  );
}

interface TransferCardProps {
  readonly busyAction: TransferAction | null;
  readonly cancelReason: string;
  readonly principalStoreId: string;
  readonly productName: string;
  readonly sourceBagVersion: number | undefined;
  readonly sourceName: string;
  readonly destinationName: string;
  readonly transfer: StoreTransfer;
  readonly onAction: (input: ActionInput) => void;
  readonly onCancelReasonChange: (reason: string) => void;
}

function TransferCard({
  busyAction,
  cancelReason,
  destinationName,
  onAction,
  onCancelReasonChange,
  principalStoreId,
  productName,
  sourceBagVersion,
  sourceName,
  transfer,
}: TransferCardProps) {
  const actions = transferActionsForStore(transfer, principalStoreId);
  const canCancel = actions.includes('CANCEL') && cancelReason.trim().length >= 3;

  return (
    <article className="transfer-card">
      <header>
        <div>
          <strong>{transfer.transferNumber}</strong>
          <span>{formatDateTime(transfer.createdAt)}</span>
        </div>
        <Badge tone={transferStatusCopy[transfer.status].tone}>
          {transferStatusCopy[transfer.status].label}
        </Badge>
      </header>
      {transfer.status === 'CANCELLED' ? null : transferTimeline(transfer.status)}
      <dl>
        <div>
          <dt>Nguồn</dt>
          <dd>{sourceName}</dd>
        </div>
        <div>
          <dt>Đích</dt>
          <dd>{destinationName}</dd>
        </div>
        <div>
          <dt>Mặt hàng</dt>
          <dd>{productName}</dd>
        </div>
        <div>
          <dt>Khối lượng</dt>
          <dd>{formatKg(transfer.weightKg)}</dd>
        </div>
        <div>
          <dt>Giá vốn chuyển</dt>
          <dd>{transfer.costVnd === null ? 'Chốt khi xuất' : formatVnd(transfer.costVnd)}</dd>
        </div>
        <div>
          <dt>Phiên bản</dt>
          <dd>v{transfer.version}</dd>
        </div>
      </dl>
      {transfer.note ? <p className="transfer-card__note">{transfer.note}</p> : null}
      {transfer.cancellationReason ? (
        <p className="transfer-card__reason">Lý do hủy: {transfer.cancellationReason}</p>
      ) : null}
      {actions.length > 0 ? (
        <div className="transfer-card__actions">
          {actions.includes('DISPATCH') ? (
            <Button
              busy={busyAction === 'DISPATCH'}
              disabled={sourceBagVersion === undefined || busyAction !== null}
              onClick={() => {
                if (sourceBagVersion !== undefined) {
                  onAction({ action: 'DISPATCH', sourceBagVersion, transfer });
                }
              }}
            >
              <Send aria-hidden="true" size={16} /> Xuất khỏi cửa hàng nguồn
            </Button>
          ) : null}
          {actions.includes('RECEIVE') ? (
            <Button
              busy={busyAction === 'RECEIVE'}
              disabled={busyAction !== null}
              onClick={() => onAction({ action: 'RECEIVE', transfer })}
              tone="success"
            >
              <CircleCheck aria-hidden="true" size={16} /> Xác nhận đã nhận đủ
            </Button>
          ) : null}
          {actions.includes('CANCEL') ? (
            <>
              <label>
                Lý do hủy phiếu
                <input
                  maxLength={500}
                  onChange={(event) => onCancelReasonChange(event.target.value)}
                  placeholder="Tối thiểu 3 ký tự"
                  value={cancelReason}
                />
              </label>
              <Button
                busy={busyAction === 'CANCEL'}
                disabled={!canCancel || busyAction !== null}
                onClick={() =>
                  onAction({ action: 'CANCEL', reason: cancelReason.trim(), transfer })
                }
                tone="danger"
              >
                <XCircle aria-hidden="true" size={16} /> Hủy phiếu nháp
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function ProductionTransfersPage({ role }: AppOutletContext) {
  const queryClient = useQueryClient();
  const sessionQuery = useSession();
  const storesQuery = useQuery({
    queryFn: listAccessibleStores,
    queryKey: ['stores', 'accessible'],
    retry: false,
  });
  const catalogQuery = useQuery({ queryFn: listCatalog, queryKey: ['catalog'], retry: false });
  const destinationsQuery = useQuery({
    enabled: role === 'STORE',
    queryFn: listStoreTransferDestinations,
    queryKey: ['store-transfer-destinations'],
    retry: false,
  });
  const principalStoreId = sessionQuery.data?.principal.storeId ?? '';
  const bagsQuery = useQuery({
    enabled: role === 'STORE' && Boolean(principalStoreId),
    queryFn: () => listInventoryBags({ storeId: principalStoreId }),
    queryKey: ['store-inventory-bags', principalStoreId, 'transfer'],
    retry: false,
  });
  const [status, setStatus] = useState<StoreTransferStatus | 'ALL'>('ALL');
  const transfersQuery = useQuery({
    queryFn: () => listStoreTransfers(status === 'ALL' ? {} : { status }),
    queryKey: ['store-transfers', status],
    retry: false,
  });
  const [selectedBagId, setSelectedBagId] = useState('');
  const [destinationStoreId, setDestinationStoreId] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [note, setNote] = useState('');
  const [cancelReasons, setCancelReasons] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);

  const bags = bagsQuery.data ?? [];
  const eligibleBags = bags.filter(
    (bag) =>
      (bag.status === 'AVAILABLE' || bag.status === 'OPEN') &&
      exactGrams(bag.remainingWeightKg) > 0n,
  );
  const effectiveBagId = eligibleBags.some((bag) => bag.id === selectedBagId)
    ? selectedBagId
    : (eligibleBags[0]?.id ?? '');
  const selectedBag = eligibleBags.find((bag) => bag.id === effectiveBagId);
  const destinations = destinationsQuery.data ?? [];
  const effectiveDestinationId = destinations.some((store) => store.id === destinationStoreId)
    ? destinationStoreId
    : (destinations[0]?.id ?? '');
  const allVisibleStores = useMemo(() => {
    const byId = new Map<string, Store>();
    for (const store of [...(storesQuery.data ?? []), ...destinations]) byId.set(store.id, store);
    return [...byId.values()];
  }, [destinations, storesQuery.data]);
  const productNames = useMemo(
    () => new Map((catalogQuery.data ?? []).map((product) => [product.id, product.name])),
    [catalogQuery.data],
  );
  const bagVersions = useMemo(() => new Map(bags.map((bag) => [bag.id, bag.version])), [bags]);
  const canCreate =
    role === 'STORE' &&
    Boolean(principalStoreId) &&
    Boolean(selectedBag) &&
    Boolean(effectiveDestinationId) &&
    isTransferWeightAllowed(weightKg, selectedBag?.remainingWeightKg ?? '0');

  const refresh = async () => {
    await Promise.all([
      sessionQuery.refetch(),
      transfersQuery.refetch(),
      storesQuery.refetch(),
      catalogQuery.refetch(),
      ...(role === 'STORE' ? [destinationsQuery.refetch(), bagsQuery.refetch()] : []),
    ]);
  };

  const invalidateTransferData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['store-transfers'] }),
      queryClient.invalidateQueries({ queryKey: ['store-inventory-bags'] }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedBag || !principalStoreId || !effectiveDestinationId) {
        throw new ApiClientError('Thiếu dữ liệu nguồn hoặc cửa hàng đích.', 400);
      }
      return createStoreTransfer(
        {
          sourceStoreId: principalStoreId,
          destinationStoreId: effectiveDestinationId,
          sourceInventoryBagId: selectedBag.id,
          weightKg,
          expectedSourceBagVersion: selectedBag.version,
          note: note.trim() || null,
        },
        crypto.randomUUID(),
      );
    },
    onError: (error) => setNotice({ tone: 'error', text: errorMessage(error) }),
    onSuccess: async (transfer) => {
      setNotice({ tone: 'success', text: `Đã tạo phiếu ${transfer.transferNumber}.` });
      setWeightKg('');
      setNote('');
      await invalidateTransferData();
    },
  });

  const actionMutation = useMutation({
    mutationFn: async ({ action, reason, sourceBagVersion, transfer }: ActionInput) => {
      if (action === 'DISPATCH') {
        if (sourceBagVersion === undefined) {
          throw new ApiClientError('Không tìm thấy phiên bản hiện tại của bao nguồn.', 409);
        }
        return dispatchStoreTransfer(
          transfer.id,
          { expectedVersion: transfer.version, expectedSourceBagVersion: sourceBagVersion },
          crypto.randomUUID(),
        );
      }
      if (action === 'RECEIVE') {
        return receiveStoreTransfer(
          transfer.id,
          { expectedVersion: transfer.version },
          crypto.randomUUID(),
        );
      }
      return cancelStoreTransfer(
        transfer.id,
        { expectedVersion: transfer.version, reason: reason ?? '' },
        crypto.randomUUID(),
      );
    },
    onError: (error) => setNotice({ tone: 'error', text: errorMessage(error) }),
    onSuccess: async (transfer) => {
      setNotice({
        tone: 'success',
        text:
          transfer.status === 'IN_TRANSIT'
            ? `Đã xuất phiếu ${transfer.transferNumber}.`
            : transfer.status === 'RECEIVED'
              ? `Đã xác nhận nhận phiếu ${transfer.transferNumber}.`
              : `Đã hủy phiếu ${transfer.transferNumber}.`,
      });
      setCancelReasons((current) => {
        const next = { ...current };
        delete next[transfer.id];
        return next;
      });
      await invalidateTransferData();
    },
  });

  const loadError =
    sessionQuery.error ??
    storesQuery.error ??
    catalogQuery.error ??
    transfersQuery.error ??
    (role === 'STORE' ? (destinationsQuery.error ?? bagsQuery.error) : null);
  const initialPending =
    sessionQuery.isPending ||
    storesQuery.isPending ||
    catalogQuery.isPending ||
    transfersQuery.isPending ||
    (role === 'STORE' && (destinationsQuery.isPending || bagsQuery.isPending));

  return (
    <>
      <PageHeader
        actions={
          <Button busy={transfersQuery.isFetching} onClick={() => void refresh()} tone="secondary">
            <RefreshCw aria-hidden="true" size={16} /> Làm mới
          </Button>
        }
        description="Nguồn chỉ trừ khi xuất; đích chỉ cộng sau khi tài khoản cửa hàng đích xác nhận"
        title="Điều chuyển cửa hàng"
      />
      {notice ? (
        <div
          className={`operation-notice operation-notice--${notice.tone}`}
          role={notice.tone === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </div>
      ) : null}
      {loadError ? (
        <section className="panel source-error" role="alert">
          <strong>Không thể tải dữ liệu điều chuyển</strong>
          <p>{errorMessage(loadError)}</p>
          <Button onClick={() => void refresh()} tone="secondary">
            Thử lại
          </Button>
        </section>
      ) : initialPending ? (
        <DashboardSkeleton />
      ) : (
        <>
          {role === 'STORE' ? (
            <section className="panel transfer-create">
              <div className="section-heading section-heading--compact">
                <div>
                  <h2>Tạo phiếu chuyển</h2>
                  <p>Phiếu nháp chưa trừ tồn. Giá vốn được cố định tại thời điểm xuất.</p>
                </div>
                <ShieldCheck aria-hidden="true" size={24} />
              </div>
              <div className="transfer-create__grid">
                <label>
                  Bao nguồn
                  <select
                    disabled={eligibleBags.length === 0}
                    onChange={(event) => setSelectedBagId(event.target.value)}
                    value={effectiveBagId}
                  >
                    {eligibleBags.length === 0 ? (
                      <option value="">Không có bao khả dụng</option>
                    ) : null}
                    {eligibleBags.map((bag) => (
                      <option key={bag.id} value={bag.id}>
                        {bag.bagCode} · {productNames.get(bag.productId) ?? bag.productId} ·{' '}
                        {formatKg(bag.remainingWeightKg)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Cửa hàng đích
                  <select
                    disabled={destinations.length === 0}
                    onChange={(event) => setDestinationStoreId(event.target.value)}
                    value={effectiveDestinationId}
                  >
                    {destinations.length === 0 ? (
                      <option value="">Không có cửa hàng đích</option>
                    ) : null}
                    {destinations.map((store) => (
                      <option key={store.id} value={store.id}>
                        {store.code} · {store.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Số kg chuyển
                  <input
                    inputMode="decimal"
                    onChange={(event) => setWeightKg(event.target.value)}
                    placeholder="Ví dụ: 5.250"
                    value={weightKg}
                  />
                  <small>
                    {selectedBag
                      ? `Tối đa ${formatKg(selectedBag.remainingWeightKg)}`
                      : 'Chọn bao nguồn trước'}
                  </small>
                </label>
                <label className="transfer-create__note">
                  Ghi chú
                  <input
                    maxLength={500}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Mục đích điều chuyển (không bắt buộc)"
                    value={note}
                  />
                </label>
              </div>
              <Button
                busy={createMutation.isPending}
                disabled={!canCreate || actionMutation.isPending}
                onClick={() => {
                  setNotice(null);
                  createMutation.mutate();
                }}
              >
                <Send aria-hidden="true" size={16} /> Tạo phiếu nháp
              </Button>
            </section>
          ) : (
            <section className="panel transfer-oversight">
              <ShieldCheck aria-hidden="true" size={24} />
              <div>
                <strong>Chế độ giám sát</strong>
                <p>Admin và HTKD xem theo phạm vi; chỉ hai cửa hàng liên quan được thao tác.</p>
              </div>
            </section>
          )}
          <section className="panel transfer-list">
            <div className="section-heading section-heading--compact">
              <div>
                <h2>Lịch sử điều chuyển</h2>
                <p>{transfersQuery.data?.length ?? 0} phiếu trong phạm vi hiện tại.</p>
              </div>
              <label className="transfer-filter">
                Trạng thái
                <select
                  onChange={(event) => setStatus(event.target.value as StoreTransferStatus | 'ALL')}
                  value={status}
                >
                  <option value="ALL">Tất cả</option>
                  {Object.entries(transferStatusCopy).map(([value, copy]) => (
                    <option key={value} value={value}>
                      {copy.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {(transfersQuery.data ?? []).length === 0 ? (
              <EmptyState
                detail="Tạo phiếu từ cửa hàng nguồn hoặc chọn trạng thái khác."
                title="Chưa có phiếu điều chuyển"
              />
            ) : (
              <div className="transfer-card-grid">
                {(transfersQuery.data ?? []).map((transfer) => {
                  const busy =
                    actionMutation.isPending &&
                    actionMutation.variables?.transfer.id === transfer.id;
                  return (
                    <TransferCard
                      busyAction={busy ? actionMutation.variables.action : null}
                      cancelReason={cancelReasons[transfer.id] ?? ''}
                      destinationName={storeLabel(allVisibleStores, transfer.destinationStoreId)}
                      key={transfer.id}
                      onAction={(input) => {
                        setNotice(null);
                        actionMutation.mutate(input);
                      }}
                      onCancelReasonChange={(reason) =>
                        setCancelReasons((current) => ({ ...current, [transfer.id]: reason }))
                      }
                      principalStoreId={principalStoreId}
                      productName={productNames.get(transfer.productId) ?? transfer.productId}
                      sourceBagVersion={bagVersions.get(transfer.sourceInventoryBagId)}
                      sourceName={storeLabel(allVisibleStores, transfer.sourceStoreId)}
                      transfer={transfer}
                    />
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
