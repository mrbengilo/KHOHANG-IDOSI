import { useState } from 'react';
import { useOutletContext, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PriorityOrder,
  PriorityOrderInput,
  PriorityAvailability,
  PrioritySource,
} from '@idosi/contracts';
import type { AppOutletContext } from '../components/AppShell';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { UnavailableFeature } from '../components/UnavailableFeature';
import { useSession } from '../lib/auth';
import { ApiClientError, mockModeEnabled } from '../lib/api';
import { useBeforeUnloadWhile } from '../lib/draft-guard';
import { priorityApi } from '../features/priority-orders/api';
import './priority-orders.css';

export function PriorityOrdersPage() {
  const { role } = useOutletContext<AppOutletContext>();
  const session = useSession();
  const accountId = session.data?.principal.accountId ?? 'demo';
  if (mockModeEnabled) return <UnavailableFeature title="Đơn ưu tiên khẩn cấp" />;
  return (
    <PriorityWorkspace
      key={accountId}
      accountId={accountId}
      manager={role === 'ADMIN' || role === 'HTKD'}
    />
  );
}

function PriorityWorkspace({ accountId, manager }: { accountId: string; manager: boolean }) {
  const [creating, setCreating] = useState(false);
  const [page, setPage] = useState(1);
  const [filterStore, setFilterStore] = useState('');
  const stores = useQuery({
    queryKey: ['priority-context', accountId, '', 1],
    queryFn: () => priorityApi.context(''),
    enabled: manager,
  });
  const query = useQuery({
    queryKey: ['priority-orders', accountId, page, filterStore],
    queryFn: () => priorityApi.list(page, filterStore),
  });
  return (
    <div className="priority-workspace">
      <PageHeader
        title="Đơn ưu tiên khẩn cấp"
        description="Xử lý ngay hàng đã cấp đang giữ, kèm mặt hàng đặt thêm theo tồn khả dụng."
      />
      {manager && (
        <Button onClick={() => setCreating(true)} disabled={creating}>
          Tạo đơn ưu tiên khẩn cấp
        </Button>
      )}
      {creating && (
        <PriorityForm
          accountId={accountId}
          onDone={() => {
            setCreating(false);
            setPage(1);
            setFilterStore('');
          }}
        />
      )}
      <h2>Đơn đã duyệt</h2>
      {manager && (
        <label>
          Lọc cửa hàng
          <select
            aria-label="Lọc cửa hàng"
            value={filterStore}
            onChange={(e) => {
              setFilterStore(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Tất cả cửa hàng</option>
            {stores.data?.stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {query.isPending && <p role="status">Đang tải đơn…</p>}
      {query.isError && (
        <p role="alert">
          {query.error.message} <Button onClick={() => void query.refetch()}>Tải lại</Button>
        </p>
      )}
      {query.data?.data.length === 0 && <p>Chưa có đơn ưu tiên khẩn cấp.</p>}
      {query.data?.data.map((order) => (
        <PriorityCard key={order.id} order={order} manager={manager} />
      ))}
      {query.data && query.data.pagination.totalPages > 1 && (
        <nav aria-label="Phân trang đơn ưu tiên">
          <Button disabled={page === 1} onClick={() => setPage(page - 1)}>
            Trang trước
          </Button>
          <span>
            Trang {page} / {query.data.pagination.totalPages}
          </span>
          <Button
            disabled={page >= query.data.pagination.totalPages}
            onClick={() => setPage(page + 1)}
          >
            Trang sau
          </Button>
        </nav>
      )}
    </div>
  );
}

export function stockHint(stock: PriorityAvailability | undefined, quantity: number): string {
  if (!stock) return 'Đang kiểm tra tồn khả dụng…';
  if (stock.blockingReason) return stock.blockingReason;
  if (quantity > stock.maxAdditionalBags)
    return `Kho chỉ còn ${stock.maxAdditionalBags} bao khả dụng, chỉ được đặt tối đa ${stock.maxAdditionalBags} bao.`;
  if (!Number.isInteger(quantity) || quantity < 1) return 'Số bao phải là số nguyên lớn hơn 0.';
  return `Được đặt thêm tối đa: ${stock.maxAdditionalBags} bao`;
}

function PriorityForm({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const cache = useQueryClient();
  const [storeId, setStoreId] = useState('');
  const [selected, setSelected] = useState<PrioritySource[]>([]);
  const [sourcePage, setSourcePage] = useState(1);
  const [additional, setAdditional] = useState<{ productId: string; quantity: number }[]>([]);
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [intent, setIntent] = useState<{ key: string; input: PriorityOrderInput } | null>(null);
  useBeforeUnloadWhile(!!intent || selected.length > 0 || additional.length > 0);
  const context = useQuery({
    queryKey: ['priority-context', accountId, storeId, sourcePage],
    queryFn: () => priorityApi.context(storeId, sourcePage),
    staleTime: 0,
  });
  const stock = useQuery({
    queryKey: ['priority-stock', accountId, storeId, productId],
    queryFn: () => priorityApi.availability(storeId, productId),
    enabled: !!storeId && !!productId,
    refetchInterval: 15000,
    staleTime: 0,
  });
  const lineStocks = useQuery({
    queryKey: ['priority-line-stock', accountId, storeId, additional.map((l) => l.productId)],
    queryFn: () =>
      Promise.all(additional.map((l) => priorityApi.availability(storeId, l.productId))),
    enabled: additional.length > 0,
    refetchInterval: 15000,
    staleTime: 0,
  });
  const held = selected;
  const heldTotal = held.reduce((n, s) => n + s.quantity, 0);
  const total = heldTotal + additional.reduce((n, l) => n + l.quantity, 0);
  const validStock =
    stock.data &&
    !stock.isFetching &&
    !stock.isError &&
    Number.isInteger(quantity) &&
    quantity > 0 &&
    quantity <= stock.data.maxAdditionalBags;
  const validLines =
    additional.length > 0 &&
    !lineStocks.isFetching &&
    !lineStocks.isError &&
    lineStocks.data?.length === additional.length &&
    additional.every(
      (l) =>
        l.quantity <=
        (lineStocks.data?.find((s) => s.productId === l.productId)?.maxAdditionalBags ?? 0),
    );
  const invalid =
    busy ||
    !storeId ||
    held.length === 0 ||
    held.length > 100 ||
    !validLines ||
    context.isFetching ||
    context.isError ||
    total > 10000;
  async function submit() {
    const pending = intent ?? {
      key: crypto.randomUUID(),
      input: {
        storeId,
        sources: held.map((s) => ({ id: s.id, revision: s.revision })),
        additionalLines: additional,
        notes,
      },
    };
    setIntent(pending);
    setBusy(true);
    setError('');
    try {
      await priorityApi.submit(pending.input, pending.key);
      await cache.invalidateQueries();
      setIntent(null);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không gửi được đơn.');
      // Network/5xx/invalid success are unknown outcomes. Keep the exact intent for replay.
      if (e instanceof ApiClientError && e.status >= 400 && e.status < 500) {
        setIntent(null);
        if (e.code === 'CONFLICT') setSelected([]);
        await Promise.all([context.refetch(), stock.refetch(), lineStocks.refetch()]);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="priority-card" aria-label="Soạn đơn ưu tiên khẩn cấp">
      <h2>Tạo đơn ưu tiên khẩn cấp</h2>
      <fieldset disabled={busy || !!intent}>
        <label>
          Cửa hàng
          <select
            aria-label="Cửa hàng"
            value={storeId}
            onChange={(e) => {
              setStoreId(e.target.value);
              setSelected([]);
              setSourcePage(1);
              setAdditional([]);
              setProductId('');
              setError('');
            }}
          >
            <option value="">Chọn cửa hàng</option>
            {context.data?.stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {context.isPending && <p role="status">Đang tải cửa hàng và nguồn hàng…</p>}
        {context.isError && (
          <p role="alert">
            {context.error.message}{' '}
            <Button onClick={() => void context.refetch()}>Tải lại nguồn</Button>
          </p>
        )}
        {storeId && context.data && !context.isFetching && (
          <>
            <h3>Phiếu chờ đang hoạt động</h3>
            <p>Chỉ tham khảo — không đưa vào đơn ưu tiên này.</p>
            <p>
              {context.data.waitDocuments.map((d) => d.code).join(', ') ||
                'Không có phiếu chờ đang hoạt động.'}
            </p>
            <h3>Đã cấp chờ giao</h3>
            {!context.data.sources.length && (
              <p>Không có nguồn hàng đủ điều kiện đang giữ chờ giao.</p>
            )}
            {context.data.sources.map((s) => (
              <label className="priority-source" key={s.id}>
                <input
                  type="checkbox"
                  checked={selected.some((row) => row.id === s.id)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, s]
                        : selected.filter((row) => row.id !== s.id),
                    )
                  }
                />
                <span>
                  {s.name}: {s.quantity} bao{' '}
                  <small>
                    {s.reshareCode ? `Đã xuất · ${s.reshareCode}` : 'Đã giữ · sẽ xuất khi gửi'}
                  </small>
                </span>
              </label>
            ))}
            <nav aria-label="Phân trang nguồn">
              <Button
                tone="secondary"
                disabled={sourcePage === 1}
                onClick={() => setSourcePage(sourcePage - 1)}
              >
                Nguồn trước
              </Button>
              <span>Trang {sourcePage}</span>
              <Button
                tone="secondary"
                disabled={!context.data.sourcesHaveMore}
                onClick={() => setSourcePage(sourcePage + 1)}
              >
                Nguồn sau
              </Button>
            </nav>
            <h3>Đặt thêm mặt hàng</h3>
            <div className="priority-add">
              <label>
                Mặt hàng
                <select
                  aria-label="Mặt hàng"
                  value={productId}
                  onChange={(e) => {
                    setProductId(e.target.value);
                    setQuantity(1);
                  }}
                >
                  <option value="">Chọn mặt hàng</option>
                  {context.data.products
                    .filter((p) => !additional.some((l) => l.productId === p.productId))
                    .map((p) => (
                      <option value={p.productId} key={p.productId}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Số bao
                <input
                  type="number"
                  min="1"
                  max={stock.data?.maxAdditionalBags}
                  step="1"
                  value={quantity}
                  disabled={
                    !productId ||
                    stock.isPending ||
                    stock.isError ||
                    stock.data?.maxAdditionalBags === 0
                  }
                  onChange={(e) => setQuantity(Number(e.target.value))}
                />
              </label>
              <Button
                disabled={!validStock || !productId || additional.length >= 100}
                onClick={() => {
                  setAdditional([...additional, { productId, quantity }]);
                  setProductId('');
                  setQuantity(1);
                }}
              >
                Thêm mặt hàng
              </Button>
            </div>
            {productId && (
              <div aria-live="polite">
                {stock.isError ? (
                  <p role="alert">
                    Chưa kiểm tra được tồn khả dụng, vui lòng thử lại.{' '}
                    <Button onClick={() => void stock.refetch()}>Kiểm tra lại tồn</Button>
                  </p>
                ) : stock.isFetching ? (
                  <p>Đang kiểm tra tồn khả dụng…</p>
                ) : (
                  <>
                    <p>Tồn khả dụng: {stock.data?.availableBags ?? '…'} bao</p>
                    <p>{stockHint(stock.data, quantity)}</p>
                  </>
                )}
              </div>
            )}
            <h3>Nội dung đơn</h3>
            {held.length > 100 && <p role="alert">Mỗi đơn chọn tối đa 100 nguồn hàng.</p>}
            {held.map((s) => (
              <p key={s.id}>
                {s.name} — đã cấp đang giữ: {s.quantity} bao
              </p>
            ))}
            {additional.map((l) => {
              const live = lineStocks.data?.find((s) => s.productId === l.productId);
              return (
                <div className="priority-added" key={l.productId}>
                  <p>
                    {context.data.products.find((p) => p.productId === l.productId)?.name} — đặt
                    thêm: {l.quantity} bao
                    <br />
                    <small>
                      {lineStocks.isError
                        ? 'Chưa kiểm tra được tồn khả dụng, vui lòng thử lại'
                        : stockHint(live, l.quantity)}
                    </small>
                  </p>
                  <Button
                    tone="secondary"
                    onClick={() =>
                      setAdditional(additional.filter((row) => row.productId !== l.productId))
                    }
                  >
                    Bỏ mặt hàng
                  </Button>
                </div>
              );
            })}
            <p className="priority-total">
              Tổng đơn: {total} bao ({heldTotal} đã cấp + {total - heldTotal} đặt thêm)
            </p>
            <label>
              Ghi chú
              <textarea maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </>
        )}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {intent && !busy && (
        <p>
          Chưa xác định kết quả. Thử lại sẽ dùng nguyên nội dung và mã yêu cầu cũ để tránh tạo
          trùng.
        </p>
      )}
      <div className="priority-actions">
        <Button busy={busy} disabled={intent ? busy : invalid} onClick={() => void submit()}>
          {intent ? 'Kiểm tra và thử lại đơn cũ' : 'Gửi đơn ưu tiên khẩn cấp'}
        </Button>
        <Button tone="secondary" disabled={busy || !!intent} onClick={onDone}>
          Đóng
        </Button>
      </div>
      <p>
        Gửi thành công: duyệt ngay, ghi xuất kho, lập đơn Reshare và đưa toàn bộ hàng vào chuyến
        giao.
      </p>
    </section>
  );
}

export function priorityDeliveryLabel(status: string) {
  if (status === 'received') return 'Đã nhận hàng';
  if (status === 'partially_received') return 'Đã nhận thiếu';
  return 'Đã xuất kho · chờ cửa hàng nhận';
}

function PriorityCard({ order, manager }: { order: PriorityOrder; manager: boolean }) {
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{
    key: string;
    status: 'ORDERED' | 'NOT_ORDERED';
    expectedVersion: number;
  } | null>(null);
  async function update() {
    const intent = pending ?? {
      key: crypto.randomUUID(),
      status: order.reshareStatus === 'ORDERED' ? ('NOT_ORDERED' as const) : ('ORDERED' as const),
      expectedVersion: order.version,
    };
    setPending(intent);
    setBusy(true);
    setError('');
    try {
      await priorityApi.status(
        order.id,
        { status: intent.status, expectedVersion: intent.expectedVersion },
        intent.key,
      );
      setPending(null);
      await cache.invalidateQueries({ queryKey: ['priority-orders'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không cập nhật được trạng thái');
      if (e instanceof ApiClientError && e.status >= 400 && e.status < 500) {
        setPending(null);
        await cache.invalidateQueries({ queryKey: ['priority-orders'] });
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="priority-card" id={order.id}>
      <span className="priority-tag">Đơn ưu tiên khẩn cấp</span>
      <h3>
        {order.code} · {order.storeName}
      </h3>
      <p>
        Đã duyệt bởi {order.actorName} · {new Date(order.approvedAt).toLocaleString('vi-VN')}
      </p>
      <p>
        {priorityDeliveryLabel(order.status)} · Tổng {order.totalQuantity} bao
      </p>
      <ul>
        {order.lines.map((l) => (
          <li key={l.productId}>
            {l.name}: {l.held} đã cấp + {l.additional} đặt thêm = <strong>{l.total} bao</strong>
          </li>
        ))}
      </ul>
      <p>
        RE lập ngay: <strong>{order.reshareCode}</strong> · {order.reshareQuantity} bao ·{' '}
        {order.reshareStatus === 'ORDERED' ? 'Đã đặt Reshare' : 'Chưa đặt Reshare'}
      </p>
      <p>Chứng từ nguồn: {[...new Set(order.sources.map((s) => s.reshareCode))].join(', ')}</p>
      {order.notes && <p>Ghi chú: {order.notes}</p>}
      {manager && (
        <Button busy={busy} tone="secondary" onClick={() => void update()}>
          {pending
            ? 'Thử lại cập nhật trạng thái'
            : order.reshareStatus === 'ORDERED'
              ? 'Đánh dấu chưa đặt Reshare'
              : 'Đánh dấu đã đặt Reshare'}
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      <p>
        <Link to="/receive">Mở nhận hàng</Link> ·{' '}
        <Link to="/supplier-reconciliation?tab=orders">Đơn & tồn Reshare</Link>
      </p>
      <details>
        <summary>Lịch sử đơn</summary>
        <ul>
          {order.history.map((h, i) => (
            <li key={i}>
              {h.action === 'EMERGENCY_PRIORITY_ORDER_APPROVED'
                ? 'Duyệt đơn khẩn cấp và lập RE'
                : 'Cập nhật trạng thái Reshare'}{' '}
              · {h.actorName} · {new Date(h.createdAt).toLocaleString('vi-VN')}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}
