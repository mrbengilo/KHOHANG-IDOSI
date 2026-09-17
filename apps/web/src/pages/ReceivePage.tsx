import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DeclareStoreReceiptRequest,
  FinalizeReceiptRequest,
  Receipt,
  ReceiptStatus,
  ReturnReceiptForCorrectionRequest,
  StoreReceiptSource,
  SubmitStoreReceiptRequest,
} from '@idosi/contracts';
import {
  AlertTriangle,
  CheckCircle2,
  CircleCheck,
  ClipboardCheck,
  FileCheck2,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  Send,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { AppOutletContext } from '../components/AppShell';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { DashboardSkeleton } from '../components/Skeleton';
import { StatCard } from '../components/StatCard';
import { listStoreReceiptSources } from '../features/receipts/receiptSourceApi';
import '../features/receipts/receipt-source.css';
import {
  ApiClientError,
  declareStoreReceipt,
  finalizeStoreReceipt,
  getStoreReceipt,
  listAccessibleStores,
  listCatalog,
  listStoreReceipts,
  mockModeEnabled,
  returnStoreReceiptForCorrection,
  submitStoreReceipt,
} from '../lib/api';
import { useSession } from '../lib/auth';
import { formatVnd } from '../lib/format';

const receiptStatusCopy: Record<
  ReceiptStatus,
  { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' }
> = {
  DRAFT: { label: 'Đang khai', tone: 'neutral' },
  PENDING_HTKD: { label: 'Chờ HTKD duyệt', tone: 'warning' },
  RETURNED: { label: 'Cần cửa hàng sửa', tone: 'info' },
  FINALIZED: { label: 'Đã nhập kho', tone: 'success' },
};

type ReceiptOperation =
  | { kind: 'DECLARE'; input: DeclareStoreReceiptRequest; idempotencyKey: string }
  | {
      kind: 'SUBMIT';
      receiptId: string;
      input: SubmitStoreReceiptRequest;
      idempotencyKey: string;
    }
  | {
      kind: 'RETURN';
      receiptId: string;
      input: ReturnReceiptForCorrectionRequest;
      idempotencyKey: string;
    }
  | {
      kind: 'FINALIZE';
      receiptId: string;
      input: FinalizeReceiptRequest;
      idempotencyKey: string;
    };

type OperationWithoutKey = ReceiptOperation extends infer Operation
  ? Operation extends { idempotencyKey: string }
    ? Omit<Operation, 'idempotencyKey'>
    : never
  : never;

const operationNotice: Record<ReceiptOperation['kind'], string> = {
  DECLARE: 'Đã tạo phiếu nháp. Cửa hàng có thể kiểm tra lại trước khi gửi.',
  SUBMIT: 'Đã gửi số thực nhận cho HTKD duyệt.',
  RETURN: 'Đã trả phiếu về cửa hàng và lưu lý do vào lịch sử.',
  FINALIZE: 'Đã chốt giá, khối lượng và nhập hàng vào tồn kho.',
};

type ReceiptOperationKind = ReceiptOperation['kind'];

export async function confirmReceiptDeclaration(
  input: DeclareStoreReceiptRequest,
  onDeclare: (request: DeclareStoreReceiptRequest) => Promise<boolean>,
  onConfirmed: () => void,
): Promise<boolean> {
  const created = await onDeclare(input);
  if (!created) return false;
  onConfirmed();
  return true;
}

export function ReceivePage() {
  const context = useOutletContext<AppOutletContext>();
  return mockModeEnabled ? <MockReceivePage /> : <ProductionReceivePage {...context} />;
}

function ProductionReceivePage({ role }: AppOutletContext) {
  const queryClient = useQueryClient();
  const sessionQuery = useSession();
  const [statusFilter, setStatusFilter] = useState<ReceiptStatus | 'ALL'>('ALL');
  const [storeFilter, setStoreFilter] = useState('');
  const [selectedReceiptId, setSelectedReceiptId] = useState('');
  const [notice, setNotice] = useState('');
  const operationKeys = useRef(new Map<string, string>());
  const operationInFlight = useRef(false);
  const principalStoreId = sessionQuery.data?.principal.storeId ?? '';

  const storesQuery = useQuery({
    queryFn: listAccessibleStores,
    queryKey: ['stores', 'accessible'],
    retry: false,
  });
  const catalogQuery = useQuery({ queryFn: listCatalog, queryKey: ['catalog'], retry: false });
  const receiptSourcesQuery = useQuery({
    enabled: role === 'STORE' && Boolean(principalStoreId),
    queryFn: () => listStoreReceiptSources({ storeId: principalStoreId }),
    queryKey: ['store-receipt-sources', principalStoreId],
    retry: false,
  });
  const receiptsQuery = useQuery({
    queryFn: () =>
      listStoreReceipts({
        ...(statusFilter === 'ALL' ? {} : { status: statusFilter }),
        ...(role !== 'STORE' && storeFilter ? { storeId: storeFilter } : {}),
      }),
    queryKey: ['store-receipts', role, storeFilter, statusFilter],
    retry: false,
  });

  const receipts = receiptsQuery.data ?? [];
  const effectiveReceiptId = receipts.some((receipt) => receipt.id === selectedReceiptId)
    ? selectedReceiptId
    : (receipts[0]?.id ?? '');
  const detailQuery = useQuery({
    enabled: Boolean(effectiveReceiptId),
    queryFn: () => getStoreReceipt(effectiveReceiptId),
    queryKey: ['store-receipt', effectiveReceiptId],
    retry: false,
  });
  const selectedReceipt = detailQuery.data ?? null;
  const stores = storesQuery.data ?? [];
  const productNameById = useMemo(
    () => new Map((catalogQuery.data ?? []).map((product) => [product.id, product.name])),
    [catalogQuery.data],
  );
  const storeNameById = useMemo(
    () => new Map(stores.map((store) => [store.id, store.name])),
    [stores],
  );

  const mutation = useMutation({
    mutationFn: async (operation: ReceiptOperation) => {
      switch (operation.kind) {
        case 'DECLARE':
          return declareStoreReceipt(operation.input, operation.idempotencyKey);
        case 'SUBMIT':
          return submitStoreReceipt(operation.receiptId, operation.input, operation.idempotencyKey);
        case 'RETURN':
          return returnStoreReceiptForCorrection(
            operation.receiptId,
            operation.input,
            operation.idempotencyKey,
          );
        case 'FINALIZE':
          return finalizeStoreReceipt(
            operation.receiptId,
            operation.input,
            operation.idempotencyKey,
          );
      }
    },
    onSuccess: async (receipt, operation) => {
      setNotice(operationNotice[operation.kind]);
      setSelectedReceiptId(receipt.id);
      queryClient.setQueryData(['store-receipt', receipt.id], receipt);
      if (operation.kind === 'DECLARE') {
        queryClient.setQueryData<StoreReceiptSource[]>(
          ['store-receipt-sources', principalStoreId],
          (sources = []) => removeDeclaredReceiptSource(sources, operation.input.outboundRequestId),
        );
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['store-receipts'] }),
        ...(operation.kind === 'DECLARE'
          ? [queryClient.invalidateQueries({ queryKey: ['store-receipt-sources'] })]
          : []),
      ]);
    },
  });

  const runOperation = async (operation: OperationWithoutKey): Promise<boolean> => {
    if (operationInFlight.current) return false;
    operationInFlight.current = true;
    setNotice('');
    mutation.reset();
    const fingerprint = JSON.stringify(operation);
    const idempotencyKey = operationKeys.current.get(fingerprint) ?? crypto.randomUUID();
    operationKeys.current.set(fingerprint, idempotencyKey);
    try {
      await mutation.mutateAsync({ ...operation, idempotencyKey } as ReceiptOperation);
      operationKeys.current.delete(fingerprint);
      return true;
    } catch {
      // The mutation owns the visible error state; retain the key for an exact retry.
      return false;
    } finally {
      operationInFlight.current = false;
    }
  };

  const pendingOperation = mutation.isPending ? (mutation.variables?.kind ?? null) : null;

  const receiptCounts = useMemo(
    () => ({
      draft: receipts.filter((receipt) => ['DRAFT', 'RETURNED'].includes(receipt.status)).length,
      finalized: receipts.filter((receipt) => receipt.status === 'FINALIZED').length,
      pending: receipts.filter((receipt) => receipt.status === 'PENDING_HTKD').length,
      receivedUnits: receipts.reduce(
        (total, receipt) =>
          total + receipt.lines.reduce((lineTotal, line) => lineTotal + line.receivedUnits, 0),
        0,
      ),
    }),
    [receipts],
  );

  const loadError =
    sessionQuery.error ??
    storesQuery.error ??
    catalogQuery.error ??
    receiptsQuery.error ??
    detailQuery.error;

  return (
    <>
      <PageHeader
        description={
          role === 'STORE'
            ? 'Cửa hàng khai số thực nhận; tồn kho chỉ tăng sau khi HTKD duyệt.'
            : 'Đối chiếu khai nhận, cân từng Mã bao và chốt chi phí trước khi nhập kho.'
        }
        title={role === 'STORE' ? 'Xác nhận nhận hàng' : 'Duyệt phiếu nhận hàng'}
      />

      <div className="stats-grid stats-grid--small">
        <StatCard
          detail="Nháp hoặc cần sửa"
          label="Cửa hàng xử lý"
          value={String(receiptCounts.draft)}
        />
        <StatCard
          detail="Không tự cộng tồn"
          label="Chờ HTKD"
          tone="warning"
          value={String(receiptCounts.pending)}
        />
        <StatCard
          detail="Đã có giá và Mã bao"
          label="Đã nhập kho"
          tone="success"
          value={String(receiptCounts.finalized)}
        />
        <StatCard
          detail="Trong danh sách đang lọc"
          label="Tổng thực nhận"
          tone="info"
          value={`${receiptCounts.receivedUnits} bao`}
        />
      </div>

      {role === 'STORE' && principalStoreId ? (
        <CreateReceiptForm
          busy={pendingOperation === 'DECLARE'}
          disabled={mutation.isPending}
          onDeclare={(input) => runOperation({ kind: 'DECLARE', input })}
          onRefresh={() => receiptSourcesQuery.refetch()}
          productNameById={productNameById}
          sources={receiptSourcesQuery.data ?? []}
          sourcesError={receiptSourcesQuery.error}
          sourcesFetching={receiptSourcesQuery.isFetching}
          sourcesPending={receiptSourcesQuery.isPending}
          storeId={principalStoreId}
        />
      ) : null}

      <section className="filter-card receipt-filters" aria-label="Bộ lọc phiếu nhận hàng">
        {role !== 'STORE' ? (
          <label>
            Cửa hàng
            <select
              disabled={mutation.isPending}
              onChange={(event) => setStoreFilter(event.target.value)}
              value={storeFilter}
            >
              <option value="">Tất cả phạm vi được giao</option>
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
            disabled={mutation.isPending}
            onChange={(event) => setStatusFilter(event.target.value as ReceiptStatus | 'ALL')}
            value={statusFilter}
          >
            <option value="ALL">Tất cả trạng thái</option>
            {Object.entries(receiptStatusCopy).map(([status, copy]) => (
              <option key={status} value={status}>
                {copy.label}
              </option>
            ))}
          </select>
        </label>
        <div className="filter-card__summary">
          <strong>{receipts.length}</strong>
          <span>phiếu trong phạm vi</span>
        </div>
      </section>

      {notice ? (
        <div className="receipt-notice" role="status">
          <CheckCircle2 aria-hidden="true" size={18} />
          <span>{notice}</span>
        </div>
      ) : null}
      {mutation.error ? <ErrorNotice error={mutation.error} /> : null}
      {loadError ? (
        <ErrorNotice
          error={loadError}
          onRetry={() => {
            void sessionQuery.refetch();
            void storesQuery.refetch();
            void catalogQuery.refetch();
            void receiptsQuery.refetch();
            if (effectiveReceiptId) void detailQuery.refetch();
          }}
        />
      ) : null}

      {receiptsQuery.isPending ? (
        <DashboardSkeleton />
      ) : receipts.length === 0 ? (
        <section className="panel">
          <EmptyState
            detail="Thay đổi bộ lọc hoặc tạo phiếu từ một lệnh xuất đã giao."
            title="Chưa có phiếu nhận hàng"
          />
        </section>
      ) : (
        <div className="receipt-workspace">
          <section className="panel receipt-list" aria-label="Danh sách phiếu nhận hàng">
            <div className="section-heading section-heading--compact">
              <div>
                <h2>Phiếu nhận</h2>
                <p>Chọn phiếu để xem dữ liệu mới nhất từ máy chủ.</p>
              </div>
            </div>
            {receipts.map((receipt) => {
              const copy = receiptStatusCopy[receipt.status];
              const total = receipt.lines.reduce((sum, line) => sum + line.receivedUnits, 0);
              return (
                <button
                  aria-pressed={receipt.id === effectiveReceiptId}
                  className={
                    receipt.id === effectiveReceiptId ? 'receipt-card selected' : 'receipt-card'
                  }
                  disabled={mutation.isPending}
                  key={receipt.id}
                  onClick={() => setSelectedReceiptId(receipt.id)}
                  type="button"
                >
                  <span>
                    <strong>{receipt.receiptNumber}</strong>
                    <small>{storeNameById.get(receipt.storeId) ?? receipt.storeId}</small>
                  </span>
                  <Badge tone={copy.tone}>{copy.label}</Badge>
                  <span className="receipt-card__meta">
                    {total} bao · cập nhật {formatDateTime(receipt.updatedAt)}
                  </span>
                </button>
              );
            })}
          </section>

          <section className="panel receipt-detail">
            {detailQuery.isError ? (
              <EmptyState
                detail="Dữ liệu danh sách không được dùng thay cho bản chi tiết khi máy chủ chưa xác minh."
                title="Chưa tải được chi tiết phiếu"
              />
            ) : detailQuery.isPending || !selectedReceipt ? (
              <DashboardSkeleton />
            ) : (
              <ReceiptDetail
                key={`${selectedReceipt.id}:${selectedReceipt.version}`}
                onFinalize={(input) =>
                  runOperation({
                    kind: 'FINALIZE',
                    receiptId: selectedReceipt.id,
                    input,
                  })
                }
                onReturn={(input) =>
                  runOperation({ kind: 'RETURN', receiptId: selectedReceipt.id, input })
                }
                onSubmit={(input) =>
                  runOperation({ kind: 'SUBMIT', receiptId: selectedReceipt.id, input })
                }
                productNameById={productNameById}
                pendingOperation={pendingOperation}
                receipt={selectedReceipt}
                role={role}
                storeName={storeNameById.get(selectedReceipt.storeId) ?? selectedReceipt.storeId}
              />
            )}
          </section>
        </div>
      )}
    </>
  );
}

interface DraftLine {
  readonly productId: string;
  readonly approvedUnits: number;
  readonly receivedUnits: number;
}

export function receiptSourceDraftLines(source: StoreReceiptSource): DraftLine[] {
  return source.lines.map((line) => ({
    productId: line.productId,
    approvedUnits: line.approvedUnits,
    receivedUnits: line.dispatchedUnits,
  }));
}

export function removeDeclaredReceiptSource(
  sources: readonly StoreReceiptSource[],
  outboundRequestId: string,
): StoreReceiptSource[] {
  return sources.filter((source) => source.id !== outboundRequestId);
}

function CreateReceiptForm({
  busy,
  disabled,
  onDeclare,
  onRefresh,
  productNameById,
  sources,
  sourcesError,
  sourcesFetching,
  sourcesPending,
  storeId,
}: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onDeclare: (input: DeclareStoreReceiptRequest) => Promise<boolean>;
  readonly onRefresh: () => Promise<unknown>;
  readonly productNameById: ReadonlyMap<string, string>;
  readonly sources: readonly StoreReceiptSource[];
  readonly sourcesError: unknown;
  readonly sourcesFetching: boolean;
  readonly sourcesPending: boolean;
  readonly storeId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [discrepancyNote, setDiscrepancyNote] = useState('');
  const [formError, setFormError] = useState('');
  const selectedSource = sources.find((source) => source.id === selectedSourceId) ?? null;

  useEffect(() => {
    if (!selectedSourceId || selectedSource) return;
    setSelectedSourceId('');
    setLines([]);
    setDiscrepancyNote('');
  }, [selectedSource, selectedSourceId]);

  const chooseSource = (source: StoreReceiptSource) => {
    setSelectedSourceId(source.id);
    setLines(receiptSourceDraftLines(source));
    setDiscrepancyNote('');
    setFormError('');
  };

  const updateReceivedUnits = (productId: string, receivedUnits: number) => {
    setLines((current) =>
      current.map((line) => (line.productId === productId ? { ...line, receivedUnits } : line)),
    );
  };

  const submit = async () => {
    const normalizedLines = lines.map((line) => ({
      approvedUnits: line.approvedUnits,
      productId: line.productId,
      receivedUnits: line.receivedUnits,
    }));
    const hasShortage = normalizedLines.some((line) => line.receivedUnits < line.approvedUnits);
    if (!selectedSource || normalizedLines.length === 0) {
      setFormError('Chọn một lệnh xuất đang chờ nhận trước khi tạo phiếu.');
      return;
    }
    if (
      normalizedLines.some(
        (line) =>
          !Number.isSafeInteger(line.approvedUnits) ||
          line.approvedUnits <= 0 ||
          !Number.isSafeInteger(line.receivedUnits) ||
          line.receivedUnits < 0 ||
          line.receivedUnits > line.approvedUnits,
      )
    ) {
      setFormError('Số thực nhận phải là số nguyên từ 0 đến số đã duyệt.');
      return;
    }
    if (hasShortage && discrepancyNote.trim().length < 3) {
      setFormError('Phiếu nhận thiếu cần ghi rõ nguyên nhân hoặc bằng chứng.');
      return;
    }
    setFormError('');
    const input: DeclareStoreReceiptRequest = {
      discrepancyNote: discrepancyNote.trim() || null,
      lines: normalizedLines,
      outboundRequestId: selectedSource.id,
      storeId,
    };
    await confirmReceiptDeclaration(input, onDeclare, () => {
      setSelectedSourceId('');
      setLines([]);
      setDiscrepancyNote('');
      setExpanded(false);
    });
  };

  return (
    <section className="panel receipt-create">
      <div className="section-heading section-heading--compact">
        <div>
          <h2>Khai phiếu nhận từ lệnh xuất</h2>
          <p>Chọn lệnh đã giao từ máy chủ; mặt hàng và số duyệt không thể tự nhập hoặc sửa.</p>
        </div>
        <div className="receipt-source-actions">
          <span className="receipt-source-count">{sources.length} lệnh chờ nhận</span>
          <Button
            aria-label="Làm mới lệnh xuất chờ nhận"
            className={sourcesFetching ? 'receipt-source-refreshing' : undefined}
            disabled={disabled || sourcesFetching}
            onClick={() => void onRefresh()}
            tone="secondary"
          >
            <RefreshCw aria-hidden="true" size={15} /> Làm mới
          </Button>
          <Button
            disabled={disabled}
            onClick={() => setExpanded((current) => !current)}
            tone="secondary"
          >
            <ClipboardCheck aria-hidden="true" size={16} /> {expanded ? 'Đóng' : 'Tạo phiếu'}
          </Button>
        </div>
      </div>
      {expanded ? (
        <div className="receipt-create__body">
          {sourcesPending ? (
            <div className="receipt-source-state" role="status">
              <span>
                <span aria-hidden="true" className="button__spinner" />
                Đang tải lệnh xuất đã giao từ máy chủ…
              </span>
            </div>
          ) : sourcesError && sources.length === 0 ? (
            <ErrorNotice error={sourcesError} onRetry={() => void onRefresh()} />
          ) : sources.length === 0 ? (
            <div className="receipt-source-state">
              <span>
                <PackageCheck aria-hidden="true" size={22} />
                <strong>Không có lệnh xuất nào đang chờ nhận</strong>
                Khi kho đánh dấu đã giao, lệnh hợp lệ sẽ xuất hiện tại đây.
              </span>
            </div>
          ) : (
            <>
              {sourcesError ? (
                <ErrorNotice error={sourcesError} onRetry={() => void onRefresh()} />
              ) : null}
              <div className="receipt-source-grid" aria-label="Lệnh xuất đang chờ nhận">
                {sources.map((source) => (
                  <button
                    aria-pressed={selectedSourceId === source.id}
                    className={
                      selectedSourceId === source.id
                        ? 'receipt-source-card selected'
                        : 'receipt-source-card'
                    }
                    disabled={disabled}
                    key={source.id}
                    onClick={() => chooseSource(source)}
                    type="button"
                  >
                    <span className="receipt-source-card__heading">
                      <strong>{source.requestNumber}</strong>
                      <span>{source.lines.length} mặt hàng</span>
                    </span>
                    <span className="receipt-source-card__meta">
                      <span>Đã giao {formatDateTime(source.dispatchedAt)}</span>
                      <span>Mã: {source.id}</span>
                    </span>
                    <span className="receipt-source-card__lines">
                      {source.lines.map((line) => (
                        <span className="receipt-source-card__line" key={line.productId}>
                          <span>{productNameById.get(line.productId) ?? line.productId}</span>
                          <strong>
                            Duyệt {line.approvedUnits} · giao {line.dispatchedUnits}
                          </strong>
                        </span>
                      ))}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {selectedSource ? (
            <>
              <div className="receipt-source-selection" role="status">
                <CircleCheck aria-hidden="true" size={18} />
                <span>
                  <strong>Đã chọn {selectedSource.requestNumber}</strong>
                  <small>Chỉ chỉnh số thực nhận; số duyệt lấy trực tiếp từ lệnh xuất.</small>
                </span>
              </div>
              <div className="receipt-line-editor">
                {lines.map((line, index) => (
                  <div className="receipt-line-editor__row" key={line.productId}>
                    <label>
                      Mặt hàng {index + 1}
                      <input
                        disabled
                        value={productNameById.get(line.productId) ?? line.productId}
                      />
                    </label>
                    <label>
                      Đã duyệt
                      <input disabled type="number" value={line.approvedUnits} />
                    </label>
                    <label>
                      Thực nhận
                      <input
                        disabled={disabled}
                        max={line.approvedUnits}
                        min="0"
                        onChange={(event) =>
                          updateReceivedUnits(
                            line.productId,
                            Number.isNaN(event.target.valueAsNumber)
                              ? 0
                              : event.target.valueAsNumber,
                          )
                        }
                        type="number"
                        value={line.receivedUnits}
                      />
                    </label>
                  </div>
                ))}
              </div>
              <label>
                Ghi chú / bằng chứng chênh lệch
                <textarea
                  disabled={disabled}
                  onChange={(event) => setDiscrepancyNote(event.target.value)}
                  placeholder="Bắt buộc khi nhận thiếu; ghi rõ chênh lệch giao nhận"
                  rows={3}
                  value={discrepancyNote}
                />
              </label>
              {formError ? (
                <div className="form-error" role="alert">
                  {formError}
                </div>
              ) : null}
              <div className="receipt-actions">
                <Button
                  busy={busy}
                  disabled={disabled || !selectedSource}
                  onClick={() => void submit()}
                >
                  <ClipboardCheck aria-hidden="true" size={16} /> Lưu phiếu nháp
                </Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ReceiptDetail({
  onFinalize,
  onReturn,
  onSubmit,
  productNameById,
  pendingOperation,
  receipt,
  role,
  storeName,
}: {
  readonly onFinalize: (input: FinalizeReceiptRequest) => Promise<boolean>;
  readonly onReturn: (input: ReturnReceiptForCorrectionRequest) => Promise<boolean>;
  readonly onSubmit: (input: SubmitStoreReceiptRequest) => Promise<boolean>;
  readonly productNameById: ReadonlyMap<string, string>;
  readonly pendingOperation: ReceiptOperationKind | null;
  readonly receipt: Receipt;
  readonly role: AppOutletContext['role'];
  readonly storeName: string;
}) {
  const copy = receiptStatusCopy[receipt.status];
  return (
    <>
      <div className="receipt-detail__header">
        <div>
          <span>{storeName}</span>
          <h2>{receipt.receiptNumber}</h2>
          <small>Lệnh xuất {receipt.outboundRequestId}</small>
        </div>
        <Badge tone={copy.tone}>{copy.label}</Badge>
      </div>
      {receipt.reviewNote ? (
        <div className="receipt-review-note">
          <RotateCcw aria-hidden="true" size={17} />
          <span>
            <strong>Lý do trả phiếu</strong>
            {receipt.reviewNote}
          </span>
        </div>
      ) : null}
      {role === 'STORE' ? (
        <StoreReceiptForm
          pendingOperation={pendingOperation}
          onSubmit={onSubmit}
          productNameById={productNameById}
          receipt={receipt}
        />
      ) : (
        <ReviewerReceiptForm
          onFinalize={onFinalize}
          onReturn={onReturn}
          productNameById={productNameById}
          pendingOperation={pendingOperation}
          receipt={receipt}
        />
      )}
    </>
  );
}

function StoreReceiptForm({
  onSubmit,
  pendingOperation,
  productNameById,
  receipt,
}: {
  readonly onSubmit: (input: SubmitStoreReceiptRequest) => Promise<boolean>;
  readonly pendingOperation: ReceiptOperationKind | null;
  readonly productNameById: ReadonlyMap<string, string>;
  readonly receipt: Receipt;
}) {
  const [lines, setLines] = useState(() =>
    receipt.lines.map((line) => ({
      approvedUnits: line.approvedUnits,
      productId: line.productId,
      receivedUnits: line.receivedUnits,
    })),
  );
  const [note, setNote] = useState(receipt.discrepancyNote ?? '');
  const [formError, setFormError] = useState('');
  const editable = receipt.status === 'DRAFT' || receipt.status === 'RETURNED';
  const submitting = pendingOperation === 'SUBMIT';
  const mutationPending = pendingOperation !== null;

  const submit = async () => {
    const hasShortage = lines.some((line) => line.receivedUnits < line.approvedUnits);
    if (
      lines.some(
        (line) =>
          !Number.isSafeInteger(line.receivedUnits) ||
          line.receivedUnits < 0 ||
          line.receivedUnits > line.approvedUnits,
      )
    ) {
      setFormError('Số thực nhận phải từ 0 đến số đã duyệt.');
      return;
    }
    if (hasShortage && note.trim().length < 3) {
      setFormError('Phiếu nhận thiếu cần ghi rõ nguyên nhân hoặc bằng chứng.');
      return;
    }
    setFormError('');
    await onSubmit({
      discrepancyNote: note.trim() || null,
      expectedVersion: receipt.version,
      lines,
    });
  };

  return (
    <div className="receipt-form-stack">
      <div className="receipt-policy">
        <PackageCheck aria-hidden="true" size={20} />
        <span>
          <strong>Số thực nhận do cửa hàng chịu trách nhiệm</strong>
          HTKD có thể trả phiếu nhưng không thể âm thầm thay đổi số đã khai.
        </span>
      </div>
      <div className="responsive-table receipt-lines-table">
        <table>
          <thead>
            <tr>
              <th>Mặt hàng</th>
              <th>Đã duyệt</th>
              <th>Thực nhận</th>
              <th>Chênh lệch</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.productId}>
                <td data-label="Mặt hàng">
                  <strong>{productNameById.get(line.productId) ?? line.productId}</strong>
                </td>
                <td data-label="Đã duyệt">{line.approvedUnits} bao</td>
                <td data-label="Thực nhận">
                  {editable ? (
                    <input
                      aria-label={`Số thực nhận ${productNameById.get(line.productId) ?? line.productId}`}
                      disabled={mutationPending}
                      max={line.approvedUnits}
                      min="0"
                      onChange={(event) =>
                        setLines((current) =>
                          current.map((candidate) =>
                            candidate.productId === line.productId
                              ? {
                                  ...candidate,
                                  receivedUnits: Number.isNaN(event.target.valueAsNumber)
                                    ? 0
                                    : event.target.valueAsNumber,
                                }
                              : candidate,
                          ),
                        )
                      }
                      type="number"
                      value={line.receivedUnits}
                    />
                  ) : (
                    `${line.receivedUnits} bao`
                  )}
                </td>
                <td data-label="Chênh lệch">
                  <Badge tone={line.receivedUnits === line.approvedUnits ? 'success' : 'warning'}>
                    {line.receivedUnits === line.approvedUnits
                      ? 'Nhận đủ'
                      : `Thiếu ${line.approvedUnits - line.receivedUnits}`}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <label>
        Ghi chú / bằng chứng
        <textarea
          disabled={!editable || mutationPending}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Mô tả chênh lệch hoặc tình trạng niêm phong"
          rows={3}
          value={note}
        />
      </label>
      {formError ? (
        <div className="form-error" role="alert">
          {formError}
        </div>
      ) : null}
      {editable ? (
        <div className="receipt-actions">
          <Button
            busy={submitting}
            disabled={mutationPending && !submitting}
            onClick={() => void submit()}
          >
            <Send aria-hidden="true" size={16} /> Gửi HTKD duyệt
          </Button>
        </div>
      ) : receipt.status === 'PENDING_HTKD' ? (
        <div className="receipt-waiting">
          <FileCheck2 aria-hidden="true" size={18} /> HTKD đang đối chiếu giá và khối lượng.
        </div>
      ) : (
        <FinalizedSummary receipt={receipt} />
      )}
    </div>
  );
}

function ReviewerReceiptForm({
  onFinalize,
  onReturn,
  pendingOperation,
  productNameById,
  receipt,
}: {
  readonly onFinalize: (input: FinalizeReceiptRequest) => Promise<boolean>;
  readonly onReturn: (input: ReturnReceiptForCorrectionRequest) => Promise<boolean>;
  readonly pendingOperation: ReceiptOperationKind | null;
  readonly productNameById: ReadonlyMap<string, string>;
  readonly receipt: Receipt;
}) {
  const [weights, setWeights] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      receipt.lines.map((line) => [
        line.productId,
        line.bagWeightsKg.length === line.receivedUnits
          ? [...line.bagWeightsKg]
          : Array.from({ length: line.receivedUnits }, () => ''),
      ]),
    ),
  );
  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      receipt.lines.map((line) => [line.productId, line.pricePerKgVnd?.toString() ?? '']),
    ),
  );
  const [freight, setFreight] = useState(receipt.freightVnd.toString());
  const [handling, setHandling] = useState(receipt.handlingVnd.toString());
  const [returnReason, setReturnReason] = useState('');
  const [formError, setFormError] = useState('');
  const reviewable = receipt.status === 'PENDING_HTKD';
  const finalizing = pendingOperation === 'FINALIZE';
  const returning = pendingOperation === 'RETURN';
  const mutationPending = pendingOperation !== null;

  const finalize = async () => {
    const invalidWeight = receipt.lines.some((line) =>
      (weights[line.productId] ?? []).some((weight) => !isPositiveKilograms(weight)),
    );
    const invalidPrice = receipt.lines.some(
      (line) => line.receivedUnits > 0 && !isMoney(prices[line.productId] ?? ''),
    );
    if (invalidWeight) {
      setFormError('Mỗi bao cần một khối lượng lớn hơn 0, tối đa 3 chữ số thập phân.');
      return;
    }
    if (invalidPrice || !isMoney(freight) || !isMoney(handling)) {
      setFormError('Giá và chi phí phải là số nguyên VND không âm.');
      return;
    }
    setFormError('');
    await onFinalize({
      expectedVersion: receipt.version,
      freightVnd: Number(freight),
      handlingVnd: Number(handling),
      lines: receipt.lines.map((line) => ({
        approvedUnits: line.approvedUnits,
        bagWeightsKg: weights[line.productId] ?? [],
        pricePerKgVnd: line.receivedUnits > 0 ? Number(prices[line.productId]) : null,
        productId: line.productId,
        receivedUnits: line.receivedUnits,
      })),
    });
  };

  const sendBack = async () => {
    if (returnReason.trim().length < 3) {
      setFormError('Nhập lý do trả phiếu tối thiểu 3 ký tự.');
      return;
    }
    setFormError('');
    await onReturn({ expectedVersion: receipt.version, reason: returnReason.trim() });
  };

  if (!reviewable) {
    return (
      <div className="receipt-form-stack">
        <ReadonlyReceiptLines productNameById={productNameById} receipt={receipt} />
        {receipt.status === 'FINALIZED' ? (
          <FinalizedSummary receipt={receipt} />
        ) : (
          <div className="receipt-waiting">
            <AlertTriangle aria-hidden="true" size={18} /> Phiếu đang chờ cửa hàng hoàn thiện và gửi
            duyệt.
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="receipt-form-stack">
      <div className="receipt-policy">
        <ClipboardCheck aria-hidden="true" size={20} />
        <span>
          <strong>Đối chiếu, không sửa khai nhận</strong>
          Nếu số bao chưa đúng, trả phiếu về cửa hàng kèm lý do.
        </span>
      </div>
      {receipt.lines.map((line) => (
        <article className="receipt-review-line" key={line.productId}>
          <div className="receipt-review-line__title">
            <span>
              <strong>{productNameById.get(line.productId) ?? line.productId}</strong>
              <small>
                Duyệt {line.approvedUnits} bao · cửa hàng khai {line.receivedUnits} bao
              </small>
            </span>
            <Badge tone={line.approvedUnits === line.receivedUnits ? 'success' : 'warning'}>
              {line.approvedUnits === line.receivedUnits ? 'Đủ' : 'Thiếu'}
            </Badge>
          </div>
          <div className="receipt-review-line__fields">
            <label>
              Giá nhập / kg (VND)
              <input
                disabled={mutationPending || line.receivedUnits === 0}
                inputMode="numeric"
                min="0"
                onChange={(event) =>
                  setPrices((current) => ({ ...current, [line.productId]: event.target.value }))
                }
                placeholder="0"
                type="number"
                value={prices[line.productId] ?? ''}
              />
            </label>
            {(weights[line.productId] ?? []).map((weight, index) => (
              <label key={`${line.productId}:bag:${index + 1}`}>
                Mã bao {index + 1} · kg
                <input
                  disabled={mutationPending}
                  inputMode="decimal"
                  min="0.001"
                  onChange={(event) =>
                    setWeights((current) => ({
                      ...current,
                      [line.productId]: (current[line.productId] ?? []).map(
                        (candidate, currentIndex) =>
                          currentIndex === index ? event.target.value : candidate,
                      ),
                    }))
                  }
                  placeholder="Ví dụ 92.500"
                  step="0.001"
                  value={weight}
                />
              </label>
            ))}
          </div>
        </article>
      ))}
      <div className="receipt-fees">
        <label>
          Phí vận chuyển (VND)
          <input
            disabled={mutationPending}
            inputMode="numeric"
            min="0"
            onChange={(event) => setFreight(event.target.value)}
            type="number"
            value={freight}
          />
        </label>
        <label>
          Phí bốc xếp (VND)
          <input
            disabled={mutationPending}
            inputMode="numeric"
            min="0"
            onChange={(event) => setHandling(event.target.value)}
            type="number"
            value={handling}
          />
        </label>
      </div>
      <label>
        Lý do trả phiếu
        <textarea
          disabled={mutationPending}
          onChange={(event) => setReturnReason(event.target.value)}
          placeholder="Chỉ nhập khi cần cửa hàng sửa số liệu hoặc bổ sung bằng chứng"
          rows={3}
          value={returnReason}
        />
      </label>
      {formError ? (
        <div className="form-error" role="alert">
          {formError}
        </div>
      ) : null}
      <div className="receipt-actions receipt-actions--review">
        <Button
          busy={returning}
          disabled={mutationPending && !returning}
          onClick={() => void sendBack()}
          tone="secondary"
        >
          <RotateCcw aria-hidden="true" size={16} /> Trả cửa hàng sửa
        </Button>
        <Button
          busy={finalizing}
          disabled={mutationPending && !finalizing}
          onClick={() => void finalize()}
          tone="success"
        >
          <CircleCheck aria-hidden="true" size={16} /> Chốt giá & nhập kho
        </Button>
      </div>
    </div>
  );
}

function ReadonlyReceiptLines({
  productNameById,
  receipt,
}: {
  readonly productNameById: ReadonlyMap<string, string>;
  readonly receipt: Receipt;
}) {
  return (
    <div className="responsive-table receipt-lines-table">
      <table>
        <thead>
          <tr>
            <th>Mặt hàng</th>
            <th>Duyệt / nhận</th>
            <th>Mã bao</th>
            <th>Giá / kg</th>
          </tr>
        </thead>
        <tbody>
          {receipt.lines.map((line) => (
            <tr key={line.productId}>
              <td data-label="Mặt hàng">
                <strong>{productNameById.get(line.productId) ?? line.productId}</strong>
              </td>
              <td data-label="Duyệt / nhận">
                {line.approvedUnits} / {line.receivedUnits} bao
              </td>
              <td data-label="Mã bao">
                {line.bagWeightsKg.length > 0 ? line.bagWeightsKg.join(' · ') + ' kg' : 'Chưa cân'}
              </td>
              <td data-label="Giá / kg">
                {line.pricePerKgVnd === null ? 'Chưa chốt' : formatVnd(line.pricePerKgVnd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FinalizedSummary({ receipt }: { readonly receipt: Receipt }) {
  return (
    <div className="document-summary receipt-finalized-summary">
      <span>Phí vận chuyển</span>
      <strong>{formatVnd(receipt.freightVnd)}</strong>
      <span>Phí bốc xếp</span>
      <strong>{formatVnd(receipt.handlingVnd)}</strong>
      <span>Tổng giá vốn</span>
      <strong>{receipt.totalCostVnd === null ? 'Chưa có' : formatVnd(receipt.totalCostVnd)}</strong>
    </div>
  );
}

function ErrorNotice({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry?: () => void;
}) {
  const message =
    error instanceof ApiClientError || error instanceof Error
      ? error.message
      : 'Không thể tải dữ liệu nhận hàng.';
  return (
    <div className="receipt-error" role="alert">
      <AlertTriangle aria-hidden="true" size={18} />
      <span>{message}</span>
      {onRetry ? (
        <button onClick={onRetry} type="button">
          Thử lại
        </button>
      ) : null}
    </div>
  );
}

function isMoney(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0;
}

function isPositiveKilograms(value: string): boolean {
  return /^(?:0\.\d{1,3}|[1-9]\d*(?:\.\d{1,3})?)$/.test(value) && Number(value) > 0;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
  }).format(new Date(value));
}

function MockReceivePage() {
  const [mode, setMode] = useState<'EXACT' | 'SHORT' | 'WRONG'>('EXACT');
  const [actual, setActual] = useState(5);
  const [done, setDone] = useState(false);

  return (
    <>
      <PageHeader
        description="Phiếu PB-GV-260912-032 • 5 bao Đồ nam • cửa hàng Gò Vấp"
        title="Xác nhận nhận hàng"
      />
      <div className="stats-grid stats-grid--small">
        <StatCard detail="Theo phiếu phân bổ" label="Số dự kiến" tone="info" value="5 bao" />
        <StatCard detail="Mã bao 014–018" label="Khối lượng dự kiến" value="474 kg" />
        <StatCard
          detail="Chỉ cộng tồn sau xác nhận"
          label="Trạng thái"
          tone="warning"
          value="Chờ nhận"
        />
        <StatCard detail="HTKD Nguyễn An" label="Người phụ trách" value="09:05" />
      </div>
      <section className="panel receive-grid">
        <div>
          <h2>Khai thực nhận</h2>
          <p>Cửa hàng khai đúng thực tế. HTKD không thể âm thầm thay đổi số đã khai.</p>
          <div className="choice-grid">
            {(['EXACT', 'SHORT', 'WRONG'] as const).map((value) => (
              <label className={mode === value ? 'selected' : ''} key={value}>
                <input
                  checked={mode === value}
                  name="receive-mode"
                  onChange={() => setMode(value)}
                  type="radio"
                />
                <strong>
                  {value === 'EXACT'
                    ? 'Nhận đủ'
                    : value === 'SHORT'
                      ? 'Nhận thiếu'
                      : 'Sai mặt hàng / hư hỏng'}
                </strong>
                <span>
                  {value === 'EXACT'
                    ? 'Đúng 5 bao theo phiếu'
                    : value === 'SHORT'
                      ? 'Tạo/cập nhật phiếu chờ ưu tiên'
                      : 'Đưa phần sai vào khu cách ly'}
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="receive-form">
          <label>
            Số bao thực nhận
            <input
              max="5"
              min="0"
              onChange={(event) => setActual(event.target.valueAsNumber || 0)}
              type="number"
              value={actual}
            />
          </label>
          <label>
            Ghi chú / bằng chứng
            <textarea placeholder="Mô tả chênh lệch, tình trạng niêm phong…" rows={4} />
          </label>
          <div className="document-summary">
            <span>Được cộng tồn</span>
            <strong>{mode === 'WRONG' ? 0 : actual} bao</strong>
            <span>Khu cách ly / chờ xử lý</span>
            <strong>{mode === 'EXACT' ? 0 : Math.max(0, 5 - actual)} bao</strong>
          </div>
          <Button disabled={done} onClick={() => setDone(true)}>
            {done ? <CircleCheck size={17} /> : <FileCheck2 size={17} />}{' '}
            {done ? 'Đã ghi nhận thực nhận' : 'Xác nhận thực nhận'}
          </Button>
        </div>
      </section>
    </>
  );
}
