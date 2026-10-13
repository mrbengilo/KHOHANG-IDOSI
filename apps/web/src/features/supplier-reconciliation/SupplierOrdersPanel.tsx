import type { SupplierBatch, SupplierCommitment, SupplierEvent } from '@idosi/contracts';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';

import { Button } from '../../components/Button';
import { ApiClientError, listAccessibleStores, listCatalog } from '../../lib/api';
import { formatDocumentTime } from '../../lib/business-time';
import { formatInteger } from '../../lib/format';
import { retainIdempotencyForExactRetry, type RetryAttempt } from '../../lib/idempotency-retry';
import { CommitmentTable } from './CommitmentTable';
import { buildOrderLines, fromBusinessLocalInput, parseBags, toBusinessLocalInput } from './model';
import { Pager } from './ReconciliationWorkspace';
import {
  SUPPLIER_QUERY_ROOTS,
  cancelSupplierOrder,
  loadSupplierCommitments,
  loadSupplierOrders,
  recordSupplierOrder,
} from './supplierApi';

function errorText(error: unknown): string {
  if (error instanceof ApiClientError && error.code !== 'NETWORK_ERROR' && error.status < 500) {
    return error.message;
  }
  return 'Không gửi được yêu cầu. Kiểm tra mạng rồi bấm lại: cùng thao tác sẽ không bị ghi hai lần.';
}

/**
 * HTKD (assigned stores) and Admin record what Reshare actually accepted, after ordering there.
 * Recording an order never changes availability and never confirms a receipt.
 */
export function SupplierOrdersPanel({
  accountId,
  readOnly = false,
}: {
  readonly accountId: string;
  readonly readOnly?: boolean;
}) {
  const client = useQueryClient();
  const [page, setPage] = useState(1);
  const [quantities, setQuantities] = useState<Map<string, string>>(new Map());
  const [lineRefs, setLineRefs] = useState<Map<string, string>>(new Map());
  const [externalRef, setExternalRef] = useState('');
  const [occurredAt, setOccurredAt] = useState(() => toBusinessLocalInput(new Date()));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const attempt = useRef<RetryAttempt | null>(null);
  const [productId, setProductId] = useState('');
  const [storeId, setStoreId] = useState('');
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: listCatalog, retry: false });
  const stores = useQuery({
    queryKey: ['stores', 'accessible'],
    queryFn: listAccessibleStores,
    retry: false,
  });
  const filter = readOnly ? 'ALL' : 'ORDERABLE';
  const commitments = useQuery({
    queryKey: ['supplier-commitments', accountId, filter, page, productId, storeId],
    queryFn: ({ signal }) =>
      loadSupplierCommitments(
        {
          page,
          filter,
          ...(productId ? { productId } : {}),
          ...(storeId ? { storeId } : {}),
        },
        signal,
      ),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const rows = commitments.data?.data ?? [];

  const update = (setter: typeof setQuantities, row: SupplierCommitment, value: string | null) =>
    setter((current) => {
      const next = new Map(current);
      if (value === null) next.delete(row.id);
      else next.set(row.id, value);
      return next;
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const { lines, error: lineError } = buildOrderLines(rows, quantities, lineRefs);
    const iso = fromBusinessLocalInput(occurredAt);
    if (lineError) return setError(lineError);
    if (!externalRef.trim()) return setError('Nhập mã đơn Reshare đã nhận.');
    if (!iso) return setError('Nhập thời điểm Reshare nhận đơn (giờ Việt Nam).');
    const payload = {
      externalRef: externalRef.trim(),
      occurredAt: iso,
      lines,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    attempt.current = retainIdempotencyForExactRetry(attempt.current, JSON.stringify(payload));
    setBusy(true);
    setError(null);
    try {
      const batch = await recordSupplierOrder(payload, attempt.current.key);
      attempt.current = null;
      setQuantities(new Map());
      setLineRefs(new Map());
      setExternalRef('');
      setNote('');
      setNotice(
        `Đã ghi nhận đơn Reshare ${batch.externalRef}: ${batch.events
          .map((item) => `${item.sku} ${formatInteger(item.quantity)} bao`)
          .join(', ')}. Khả dụng không đổi; hàng vẫn giữ tới khi cửa hàng nhận.`,
      );
      await Promise.all(
        SUPPLIER_QUERY_ROOTS.map((root) => client.invalidateQueries({ queryKey: [root] })),
      );
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {notice ? (
        <div className="supplier-notice" role="status">
          {notice}
        </div>
      ) : null}
      <section
        className="panel supplier-orders"
        aria-label={readOnly ? 'Trạng thái đặt Reshare' : 'Hàng chờ đặt Reshare'}
      >
        <h2>{readOnly ? 'Hàng đang giữ cho cửa hàng' : 'Chờ đặt Reshare'}</h2>
        <p className="supplier-hint">
          {readOnly
            ? 'Trạng thái đặt Reshare của hàng đã phân bổ cho cửa hàng. Cửa hàng chỉ xem; xác nhận nhận hàng vẫn theo phiếu nhận hàng.'
            : 'Đặt hàng tại Reshare trước, sau khi Reshare nhận đơn mới ghi nhận ở đây với đúng số bao Reshare đã nhận. Chỉ hiện kết quả phân bổ đã được cửa hàng chấp nhận.'}
        </p>
        <div className="supplier-filters">
          <label>
            Mặt hàng
            <select
              onChange={(event) => {
                setProductId(event.target.value);
                setQuantities(new Map());
                setPage(1);
              }}
              value={productId}
            >
              <option value="">Tất cả mặt hàng</option>
              {(catalog.data ?? []).map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
          </label>
          {(stores.data?.length ?? 0) > 1 ? (
            <label>
              Cửa hàng
              <select
                onChange={(event) => {
                  setStoreId(event.target.value);
                  setQuantities(new Map());
                  setPage(1);
                }}
                value={storeId}
              >
                <option value="">Tất cả cửa hàng trong phạm vi</option>
                {(stores.data ?? []).map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.code} — {store.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        {commitments.isPending ? (
          <p role="status">Đang tải hàng chờ đặt…</p>
        ) : commitments.isError ? (
          <div role="alert" className="supplier-error">
            <p>Không tải được hàng chờ đặt Reshare.</p>
            <Button tone="secondary" onClick={() => void commitments.refetch()}>
              Thử lại
            </Button>
          </div>
        ) : (
          <form noValidate onSubmit={(event) => void submit(event)}>
            <CommitmentTable
              caption={readOnly ? 'Hàng đang giữ' : 'Có thể đặt'}
              page={commitments.data}
              {...(readOnly
                ? {}
                : {
                    selection: {
                      quantities,
                      lineRefs,
                      disabled: busy,
                      onToggle: (row, checked) => {
                        update(setQuantities, row, checked ? String(row.unorderedQuantity) : null);
                        setError(null);
                      },
                      onQuantity: (row, value) => update(setQuantities, row, value),
                      onLineRef: (row, value) => update(setLineRefs, row, value),
                    },
                  })}
            />
            <Pager
              page={page}
              totalPages={commitments.data.pagination.totalPages}
              onPage={(next) => {
                setQuantities(new Map());
                setPage(next);
              }}
              disabled={commitments.isFetching || busy}
            />
            {!readOnly ? (
              <fieldset className="supplier-order-form" disabled={busy}>
                <legend>Đơn Reshare đã nhận</legend>
                <label>
                  Mã đơn Reshare
                  <input
                    maxLength={100}
                    onChange={(event) => setExternalRef(event.target.value)}
                    required
                    value={externalRef}
                  />
                </label>
                <label>
                  Reshare nhận đơn lúc (giờ Việt Nam)
                  <input
                    onChange={(event) => setOccurredAt(event.target.value)}
                    required
                    step={1}
                    type="datetime-local"
                    value={occurredAt}
                  />
                </label>
                <label>
                  Ghi chú
                  <input
                    maxLength={500}
                    onChange={(event) => setNote(event.target.value)}
                    value={note}
                  />
                </label>
                <Button busy={busy} disabled={quantities.size === 0} type="submit" tone="success">
                  Ghi nhận đơn Reshare
                </Button>
              </fieldset>
            ) : null}
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        )}
      </section>
      <SupplierOrderHistory accountId={accountId} readOnly={readOnly} />
    </>
  );
}

function SupplierOrderHistory({
  accountId,
  readOnly,
}: {
  readonly accountId: string;
  readonly readOnly: boolean;
}) {
  const [page, setPage] = useState(1);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const orders = useQuery({
    queryKey: ['supplier-orders', accountId, page],
    queryFn: ({ signal }) => loadSupplierOrders({ page }, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });
  return (
    <section className="panel supplier-orders" aria-label="Lịch sử đơn Reshare">
      <h2>Lịch sử đơn Reshare</h2>
      {orders.isPending ? (
        <p role="status">Đang tải lịch sử đơn Reshare…</p>
      ) : orders.isError ? (
        <div role="alert" className="supplier-error">
          <p>Không tải được lịch sử đơn Reshare.</p>
          <Button tone="secondary" onClick={() => void orders.refetch()}>
            Thử lại
          </Button>
        </div>
      ) : orders.data.data.length === 0 ? (
        <p className="supplier-empty">Chưa ghi nhận đơn Reshare nào.</p>
      ) : (
        <>
          <ul className="supplier-batches">
            {orders.data.data.map((batch) => (
              <BatchItem
                batch={batch}
                cancelling={cancelling}
                key={batch.id}
                onCancel={setCancelling}
                readOnly={readOnly}
              />
            ))}
          </ul>
          <Pager
            page={page}
            totalPages={orders.data.pagination.totalPages}
            onPage={setPage}
            disabled={orders.isFetching}
          />
        </>
      )}
    </section>
  );
}

const BATCH_LABEL: Record<SupplierBatch['kind'], string> = {
  ORDER: 'Đơn Reshare',
  ORDER_CANCEL: 'Reshare hủy đơn',
  SOURCE_RETURN: 'Reshare hoàn lượng đặt được',
};

function BatchItem({
  batch,
  cancelling,
  onCancel,
  readOnly,
}: {
  readonly batch: SupplierBatch;
  readonly cancelling: string | null;
  readonly onCancel: (eventId: string | null) => void;
  readonly readOnly: boolean;
}) {
  return (
    <li className="supplier-batch">
      <header>
        <strong>
          {BATCH_LABEL[batch.kind]} {batch.externalRef}
        </strong>
        <small>
          Reshare ghi nhận {formatDocumentTime(batch.occurredAt)} · nhập{' '}
          {formatDocumentTime(batch.recordedAt)} · {batch.createdBy.displayName}
        </small>
        {batch.note ? <small>{batch.note}</small> : null}
      </header>
      <ul>
        {batch.events.map((event) => (
          <li key={event.id}>
            <span>
              {event.productName} ({event.sku}) · dòng {event.externalLineRef}:{' '}
              <strong>{formatInteger(event.quantity)} bao</strong>
            </span>
            {!readOnly && event.kind === 'ORDER' ? (
              cancelling === event.id ? (
                <CancelForm event={event} onClose={() => onCancel(null)} />
              ) : (
                <Button aria-expanded={false} onClick={() => onCancel(event.id)} tone="secondary">
                  Ghi nhận Reshare hủy
                </Button>
              )
            ) : null}
          </li>
        ))}
      </ul>
    </li>
  );
}

function CancelForm({
  event,
  onClose,
}: {
  readonly event: SupplierEvent;
  readonly onClose: () => void;
}) {
  const client = useQueryClient();
  const [quantity, setQuantity] = useState('');
  const [cancelRef, setCancelRef] = useState('');
  const [occurredAt, setOccurredAt] = useState(() => toBusinessLocalInput(new Date()));
  const [returned, setReturned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<RetryAttempt | null>(null);
  const submit = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    if (busy) return;
    const bags = parseBags(quantity, event.quantity);
    const iso = fromBusinessLocalInput(occurredAt);
    if (bags === null || bags < 1) return setError(`Nhập từ 1 đến ${event.quantity} bao.`);
    if (!cancelRef.trim()) return setError('Nhập mã hủy của Reshare.');
    if (!iso) return setError('Nhập thời điểm Reshare hủy.');
    const payload = {
      quantity: bags,
      cancelRef: cancelRef.trim(),
      occurredAt: iso,
      sourceReturned: returned,
    };
    attempt.current = retainIdempotencyForExactRetry(attempt.current, JSON.stringify(payload));
    setBusy(true);
    setError(null);
    try {
      await cancelSupplierOrder(event.id, payload, attempt.current.key);
      await Promise.all(
        SUPPLIER_QUERY_ROOTS.map((root) => client.invalidateQueries({ queryKey: [root] })),
      );
      onClose();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="supplier-cancel-form"
      noValidate
      onSubmit={(formEvent) => void submit(formEvent)}
    >
      <fieldset disabled={busy}>
        <legend>Reshare hủy dòng {event.externalLineRef}</legend>
        <label>
          Số bao hủy
          <input
            inputMode="numeric"
            min={1}
            max={event.quantity}
            onChange={(e) => setQuantity(e.target.value)}
            type="number"
            value={quantity}
          />
        </label>
        <label>
          Mã hủy Reshare
          <input maxLength={100} onChange={(e) => setCancelRef(e.target.value)} value={cancelRef} />
        </label>
        <label>
          Hủy lúc (giờ Việt Nam)
          <input
            onChange={(e) => setOccurredAt(e.target.value)}
            step={1}
            type="datetime-local"
            value={occurredAt}
          />
        </label>
        <label className="supplier-attest">
          <input
            checked={returned}
            onChange={(e) => setReturned(e.target.checked)}
            type="checkbox"
          />
          Reshare đã xác nhận các bao này đặt lại được
        </label>
        <p className="supplier-hint">
          Hàng vẫn phải giao cho cửa hàng sẽ trở lại “chưa đặt”. Nếu Reshare chưa hoàn lượng đặt
          được, khả dụng giảm tương ứng.
        </p>
        <div className="button-row">
          <Button busy={busy} type="submit" tone="danger">
            Lưu hủy đơn
          </Button>
          <Button onClick={onClose} tone="secondary">
            Đóng
          </Button>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </fieldset>
    </form>
  );
}
