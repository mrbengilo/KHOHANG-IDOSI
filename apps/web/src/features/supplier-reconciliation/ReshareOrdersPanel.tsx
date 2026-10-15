import type {
  ReshareOrderHistoryRow,
  ReshareOrderHistoryStatus,
  UpdateReshareOrderStatusRequest,
} from '@idosi/contracts';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '../../components/Button';
import { ApiClientError, listCatalog, listOrderSessions } from '../../lib/api';
import { businessDate } from '../../lib/business-time';
import { formatInteger } from '../../lib/format';
import { Pager } from './ReconciliationWorkspace';
import { RESHARE_STATUS_LABEL, ReshareOrderHistoryTable } from './ReshareOrderHistoryTable';
import { ReshareStatusHistoryDialog } from './ReshareStatusHistory';
import {
  loadReshareOrders,
  loadReshareStores,
  updateReshareOrderStatus,
  type ReshareOrderFilters,
} from './supplierApi';
import type { Role } from '../../lib/types';
import { retainIdempotencyForExactRetry, type RetryAttempt } from '../../lib/idempotency-retry';

const STATUSES: readonly ReshareOrderHistoryStatus[] = ['ORDERED', 'NOT_ORDERED', 'CANCELLED'];

/** Start of a Vietnam business day as an ISO instant (independent of the browser zone). */
export function businessDayStart(date: string): string {
  return new Date(`${date}T00:00:00+07:00`).toISOString();
}

/** Exclusive end of an inclusive Vietnam business day. */
export function businessDayEnd(date: string): string {
  return new Date(new Date(`${date}T00:00:00+07:00`).getTime() + 86_400_000).toISOString();
}

function errorText(error: unknown): string {
  if (error instanceof ApiClientError && error.status === 403) {
    return 'Tài khoản không có quyền xem đơn của cửa hàng này.';
  }
  return 'Không tải được lịch sử đơn đặt Reshare. Kiểm tra mạng rồi thử lại.';
}

/**
 * "Đơn đặt Reshare": every role sees the RE orders of its own Reshare scope (Admin and HTKD: all
 * stores). Filters, sorting and paging are done by the server; the store list comes from the
 * Reshare-only store projection, so no other module's store scope is widened.
 */
export function ReshareOrdersPanel({
  accountId: account,
  role,
  initialCode = '',
  canEdit = false,
}: {
  readonly accountId: string;
  readonly role: Role;
  readonly initialCode?: string;
  readonly canEdit?: boolean;
}) {
  // Every cached Reshare read is keyed by role and account (a role change must not reuse it).
  const accountId = `${role}:${account}`;
  const [historyRow, setHistoryRow] = useState<ReshareOrderHistoryRow | null>(null);
  const client = useQueryClient();
  const [busyDecisionId, setBusyDecisionId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeStore, setNoticeStore] = useState('');
  const busy = useRef(false);
  const attempt = useRef<RetryAttempt | null>(null);
  const [page, setPage] = useState(1);
  const [sessionId, setSessionId] = useState('');
  const [storeId, setStoreId] = useState('');
  const [productId, setProductId] = useState('');
  const [status, setStatus] = useState<ReshareOrderHistoryStatus | ''>('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [code, setCode] = useState(initialCode);
  const [codeDraft, setCodeDraft] = useState(initialCode);
  const recentFrom = (() => {
    const today = new Date(`${businessDate()}T00:00:00+07:00`);
    return businessDate(new Date(today.getTime() - 60 * 86_400_000));
  })();
  const sessions = useQuery({
    queryKey: ['order-sessions', 'reshare-filter', recentFrom],
    queryFn: () => listOrderSessions(recentFrom),
    retry: false,
  });
  const stores = useQuery({
    queryKey: ['reshare-stores', accountId],
    queryFn: ({ signal }) => loadReshareStores(signal),
    retry: false,
  });
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: listCatalog, retry: false });
  const rangeInvalid = fromDate !== '' && toDate !== '' && fromDate > toDate;
  const filters: ReshareOrderFilters = {
    page,
    ...(sessionId ? { sessionId } : {}),
    ...(storeId ? { storeId } : {}),
    ...(productId ? { productId } : {}),
    ...(status ? { status } : {}),
    ...(fromDate && !rangeInvalid ? { from: businessDayStart(fromDate) } : {}),
    ...(toDate && !rangeInvalid ? { to: businessDayEnd(toDate) } : {}),
    ...(code ? { code } : {}),
  };
  const orders = useQuery({
    queryKey: ['reshare-orders', accountId, filters],
    queryFn: ({ signal }) => loadReshareOrders(filters, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const reset =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      setPage(1);
    };
  const data = orders.data;
  const filtered = Boolean(
    sessionId || storeId || productId || status || fromDate || toDate || code,
  );
  const changeStatus = async (row: ReshareOrderHistoryRow) => {
    if (!canEdit || busy.current || !row.statusControl || row.status === 'CANCELLED') return;
    const input: UpdateReshareOrderStatusRequest = {
      status: row.status === 'ORDERED' ? 'NOT_ORDERED' : 'ORDERED',
      expectedStatus: row.status,
      expectedVersion: row.statusControl.version,
    };
    attempt.current = retainIdempotencyForExactRetry(
      attempt.current,
      JSON.stringify({ decisionId: row.decisionId, ...input }),
    );
    busy.current = true;
    setBusyDecisionId(row.decisionId);
    setMutationError('');
    setNotice('');
    try {
      const saved = await updateReshareOrderStatus(row.decisionId, input, attempt.current.key);
      attempt.current = null;
      setNoticeStore(row.storeName);
      setNotice(
        saved.version === input.expectedVersion
          ? `${row.sessionCode}: trạng thái đã là “${RESHARE_STATUS_LABEL[saved.status]}”, không có thay đổi.`
          : `${row.sessionCode}: đã lưu “${RESHARE_STATUS_LABEL[saved.status]}” và ghi vào lịch sử thay đổi.`,
      );
      await Promise.all([
        client.invalidateQueries({ queryKey: ['reshare-orders'] }),
        client.invalidateQueries({ queryKey: ['reshare-status-history'] }),
      ]);
    } catch (error) {
      setMutationError(
        error instanceof ApiClientError && error.status < 500 && error.code !== 'NETWORK_ERROR'
          ? error.message
          : 'Không xác nhận được kết quả lưu. Kiểm tra mạng rồi bấm lại; thao tác sẽ không ghi trùng.',
      );
      if (error instanceof ApiClientError && error.code === 'VERSION_CONFLICT') {
        attempt.current = null;
        await client.invalidateQueries({ queryKey: ['reshare-orders'] });
      }
    } finally {
      busy.current = false;
      setBusyDecisionId(null);
    }
  };

  return (
    <section
      className="panel supplier-orders reshare-orders"
      aria-labelledby="reshare-orders-title"
    >
      <h2 id="reshare-orders-title">Lịch sử đặt hàng theo phân bổ</h2>
      <p className="supplier-hint">
        Mỗi kết quả phân bổ được chấp nhận tạo một đơn mã RE và xuất hàng khỏi kho tổng IDOSI. Dùng
        mã đơn và số bao dưới đây để đặt hàng trên Reshare. Admin và HTKD cập nhật xác nhận đã đặt
        hoặc chưa đặt; mỗi lần đổi được lưu vào “Lịch sử thay đổi” cùng người thực hiện và không làm
        thay đổi số lượng kho.
      </p>
      <form
        className="supplier-filters reshare-orders__filters"
        onSubmit={(event) => {
          event.preventDefault();
          setCode(codeDraft.trim().toUpperCase());
          setPage(1);
        }}
      >
        <label>
          Phiên phân bổ
          <select onChange={(event) => reset(setSessionId)(event.target.value)} value={sessionId}>
            <option value="">Tất cả phiên</option>
            {(sessions.data ?? []).map((session) => (
              <option key={session.id} value={session.id}>
                {session.code} · {session.businessDate}
              </option>
            ))}
          </select>
        </label>
        {(stores.data?.data.length ?? 0) > 1 ? (
          <label>
            Cửa hàng
            <select
              className="store-name"
              onChange={(event) => reset(setStoreId)(event.target.value)}
              value={storeId}
            >
              <option value="">
                {stores.data?.scoped ? 'Tất cả cửa hàng trong phạm vi' : 'Tất cả cửa hàng'}
              </option>
              {(stores.data?.data ?? []).map((store) => (
                <option className="store-name" key={store.id} value={store.id}>
                  {store.name}
                  {store.isActive ? '' : ' (ngừng hoạt động)'}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          Mặt hàng
          <select onChange={(event) => reset(setProductId)(event.target.value)} value={productId}>
            <option value="">Tất cả mặt hàng</option>
            {(catalog.data ?? []).map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Trạng thái
          <select
            onChange={(event) =>
              reset(setStatus)(event.target.value as ReshareOrderHistoryStatus | '')
            }
            value={status}
          >
            <option value="">Tất cả trạng thái</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {RESHARE_STATUS_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Từ ngày
          <input
            onChange={(event) => reset(setFromDate)(event.target.value)}
            type="date"
            value={fromDate}
          />
        </label>
        <label>
          Đến ngày
          <input
            onChange={(event) => reset(setToDate)(event.target.value)}
            type="date"
            value={toDate}
          />
        </label>
        <label>
          Mã đơn RE
          <span className="reshare-orders__search">
            <input
              autoComplete="off"
              inputMode="text"
              maxLength={20}
              onChange={(event) => setCodeDraft(event.target.value)}
              placeholder="RE-000001"
              value={codeDraft}
            />
            <Button tone="secondary" type="submit">
              Tìm
            </Button>
          </span>
        </label>
      </form>
      {rangeInvalid ? (
        <p className="form-error" role="alert">
          “Từ ngày” phải trước hoặc bằng “Đến ngày”.
        </p>
      ) : null}
      {notice ? (
        <p className="supplier-notice" role="status">
          <span className="store-name">{noticeStore}</span>
          {' · '}
          {notice}
        </p>
      ) : null}
      {mutationError ? (
        <p className="form-error" role="alert">
          {mutationError}
        </p>
      ) : null}
      {orders.isPending ? (
        <p role="status">Đang tải lịch sử đơn đặt Reshare…</p>
      ) : orders.isError && !data ? (
        <div role="alert" className="supplier-error">
          <p>{errorText(orders.error)}</p>
          <Button tone="secondary" onClick={() => void orders.refetch()}>
            Thử lại
          </Button>
        </div>
      ) : data ? (
        <>
          {orders.isError ? (
            <div role="alert" className="supplier-error">
              <p>Không làm mới được; đang hiển thị dữ liệu đã tải trước đó.</p>
              <Button tone="secondary" onClick={() => void orders.refetch()}>
                Thử lại
              </Button>
            </div>
          ) : null}
          <p className="supplier-totals" aria-live="polite">
            {formatInteger(data.pagination.totalItems)} kết quả phân bổ
            {data.scoped ? ' trong phạm vi tài khoản' : ' toàn hệ thống'}.
            {orders.isFetching ? ' Đang cập nhật…' : ''}
          </p>
          {data.data.length === 0 ? (
            <div className="supplier-empty reshare-orders__empty">
              <p>
                {filtered
                  ? 'Không có đơn nào khớp bộ lọc. Thử bỏ bớt điều kiện lọc.'
                  : 'Chưa có kết quả phân bổ nào cần đặt Reshare. Đơn RE được tạo khi cửa hàng hoặc HTKD chấp nhận kết quả phân bổ.'}
              </p>
              <Link className="button button--secondary" to="/allocations">
                Mở kết quả phân bổ
              </Link>
            </div>
          ) : (
            <ReshareOrderHistoryTable
              offset={(data.pagination.page - 1) * data.pagination.pageSize}
              caption="Lịch sử đặt hàng theo phân bổ"
              rows={data.data}
              {...(canEdit
                ? { onChangeStatus: (row: ReshareOrderHistoryRow) => void changeStatus(row) }
                : {})}
              onShowHistory={setHistoryRow}
              busyDecisionId={busyDecisionId}
              disabled={orders.isFetching || orders.isError}
            />
          )}
          <Pager
            disabled={orders.isFetching}
            onPage={setPage}
            page={page}
            totalPages={data.pagination.totalPages}
          />
        </>
      ) : null}
      {historyRow ? (
        <ReshareStatusHistoryDialog
          accountId={accountId}
          onClose={() => setHistoryRow(null)}
          row={historyRow}
        />
      ) : null}
    </section>
  );
}
