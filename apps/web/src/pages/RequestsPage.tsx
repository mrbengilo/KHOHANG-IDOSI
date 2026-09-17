import { Clock3, Plus, RotateCcw, Send, Trash2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { AppOutletContext } from '../components/AppShell';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { WaitlistPanel } from '../components/WaitlistPanel';
import {
  ApiClientError,
  listAccessibleStores,
  listCatalog,
  listOpenOrderSessions,
  listStoreOrderRequests,
  mockModeEnabled,
  submitStoreOrderRequest,
} from '../lib/api';
import { useSession } from '../lib/auth';
import { productConversions } from '../lib/data';

interface RequestDraft {
  product: string;
  bags: number;
  note: string;
}

const initialRequests: RequestDraft[] = [
  { product: 'Đồ nam', bags: 3, note: 'Ưu tiên kiện loại A' },
];

export function RequestsPage() {
  const { role, storeKind } = useOutletContext<AppOutletContext>();
  const [requests, setRequests] = useState(initialRequests);
  const [product, setProduct] = useState('Đồ nam');
  const [bags, setBags] = useState(1);
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const remaining = Math.max(0, 2 - requests.length);
  const isWholesale = role === 'STORE' && storeKind === 'WHOLESALE';

  const grouped = useMemo(
    () =>
      requests.reduce<Record<string, number>>((result, request) => {
        result[request.product] = (result[request.product] ?? 0) + request.bags;
        return result;
      }, {}),
    [requests],
  );

  if (!mockModeEnabled) {
    return <ProductionRequestsPage role={role} storeKind={storeKind} />;
  }

  const add = () => {
    if (remaining === 0) return;
    setRequests((current) => [...current, { product, bags: Math.max(1, bags), note }]);
    setNote('');
  };

  return (
    <>
      <PageHeader
        description={`${isWholesale ? 'Khách sỉ' : 'Gò Vấp'} • gửi trước 08:00 xét cùng ngày; từ 08:00 chuyển phiên sau`}
        title={isWholesale ? 'Đặt hàng khách sỉ' : 'Đặt hàng & kết quả'}
      />

      <section className="quota-card">
        <div>
          <strong>{requests.length} / 2 phiếu</strong>
          <span>Còn {remaining} yêu cầu mới trong phiên tuần 37</span>
        </div>
        <progress max="2" value={requests.length} />
        <Badge tone={remaining > 0 ? 'info' : 'warning'}>
          {remaining > 0 ? 'Còn lượt' : 'Đã đủ giới hạn'}
        </Badge>
      </section>

      {isWholesale ? (
        <section className="permission-card">
          <strong>Quyền hạn khách sỉ</strong>
          <span>Đặt hàng • xem phân bổ • phiếu chờ</span>
          <small>Không nhận / khui / bán / tồn / điều chuyển</small>
        </section>
      ) : null}

      <div className="request-layout">
        <section className="panel request-form-panel">
          <div className="section-heading section-heading--compact">
            <div>
              <h2>Tạo yêu cầu</h2>
              <p>Mỗi yêu cầu có nhiều mặt hàng; tổng tối đa 2 phiếu hoạt động.</p>
            </div>
          </div>
          <div className="form-grid">
            <label>
              Mặt hàng
              <select onChange={(event) => setProduct(event.target.value)} value={product}>
                {productConversions.map((item) => (
                  <option key={item.id} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Số bao
              <input
                max="999"
                min="1"
                onChange={(event) => setBags(event.target.valueAsNumber || 1)}
                type="number"
                value={bags}
              />
            </label>
            <label className="form-grid__wide">
              Ghi chú
              <textarea
                onChange={(event) => setNote(event.target.value)}
                placeholder="Nhu cầu hoặc ưu tiên vận hành"
                rows={3}
                value={note}
              />
            </label>
          </div>
          <Button disabled={remaining === 0} onClick={add}>
            <Plus aria-hidden="true" size={16} /> Thêm yêu cầu
          </Button>
        </section>

        <section className="panel request-summary">
          <div className="section-heading section-heading--compact">
            <div>
              <h2>Yêu cầu đang soạn</h2>
              <p>Hệ thống chưa kiểm tồn và chưa giữ hàng lúc gửi.</p>
            </div>
          </div>
          {requests.map((request, index) => (
            <article className="request-line" key={`${request.product}-${index + 1}`}>
              <div>
                <strong>
                  Phiếu {index + 1} • {request.product}
                </strong>
                <span>
                  {request.bags} bao • {request.note || 'Không có ghi chú'}
                </span>
              </div>
              <button
                aria-label={`Xóa ${request.product}`}
                onClick={() =>
                  setRequests((current) =>
                    current.filter((_, currentIndex) => currentIndex !== index),
                  )
                }
                type="button"
              >
                <Trash2 size={17} />
              </button>
            </article>
          ))}
          <div className="grouped-demand">
            <strong>Nhu cầu được gộp khi phân bổ</strong>
            {Object.entries(grouped).map(([name, quantity]) => (
              <span key={name}>
                {name}
                <b>{quantity} bao</b>
              </span>
            ))}
          </div>
          <Button disabled={requests.length === 0 || submitted} onClick={() => setSubmitted(true)}>
            <Send aria-hidden="true" size={16} />{' '}
            {submitted ? 'Đã gửi yêu cầu' : 'Gửi yêu cầu đặt hàng'}
          </Button>
        </section>
      </div>

      <section className="panel history-list">
        <div className="section-heading section-heading--compact">
          <div>
            <h2>Phiếu chờ phân bổ</h2>
            <p>Mỗi cửa hàng + mặt hàng chỉ có một phiếu chờ đang hoạt động.</p>
          </div>
        </div>
        <article>
          <div>
            <strong>YC-GV-260912-032</strong>
            <span>
              <Clock3 size={14} /> Đồ nam 3 bao • Áo nữ 2 bao
            </span>
          </div>
          <Badge tone="warning">Chờ phân bổ</Badge>
          <button className="link-button" type="button">
            Xem lịch sử
          </button>
        </article>
      </section>
    </>
  );
}

interface ProductionDraftLine {
  readonly productId: string;
  readonly quantity: number;
}

interface RequestNotice {
  readonly kind: 'error' | 'success';
  readonly message: string;
}

function ProductionRequestsPage({ role, storeKind }: AppOutletContext) {
  const sessionQuery = useSession();
  const storesQuery = useQuery({
    queryFn: listAccessibleStores,
    queryKey: ['stores', 'accessible'],
    retry: false,
  });
  const catalogQuery = useQuery({ queryFn: listCatalog, queryKey: ['catalog'], retry: false });
  const sessionsQuery = useQuery({
    queryFn: listOpenOrderSessions,
    queryKey: ['order-sessions', 'open'],
    retry: false,
  });
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [draftLines, setDraftLines] = useState<ProductionDraftLine[]>([]);
  const [notice, setNotice] = useState<RequestNotice | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const idempotencyKey = useRef<string | null>(null);

  const stores = storesQuery.data ?? [];
  const catalogProducts = catalogQuery.data ?? [];
  const activeProducts = catalogProducts.filter((product) => product.status === 'ACTIVE');
  const sessions = sessionsQuery.data ?? [];
  const activeSession = sessions.find((session) => session.id === selectedSessionId) ?? sessions[0];
  const principalStoreId = sessionQuery.data?.principal.storeId ?? '';
  const effectiveStoreId =
    role === 'STORE' ? principalStoreId : selectedStoreId || stores[0]?.id || '';
  const selectedStore = stores.find((store) => store.id === effectiveStoreId);
  const requestsQuery = useQuery({
    enabled: Boolean(effectiveStoreId && activeSession),
    queryFn: () => {
      if (!effectiveStoreId || !activeSession) throw new Error('Missing order scope');
      return listStoreOrderRequests(effectiveStoreId, activeSession.id);
    },
    queryKey: ['order-requests', effectiveStoreId, activeSession?.id],
    retry: false,
  });
  const submittedRequests = requestsQuery.data ?? [];
  const usedSlots = submittedRequests.filter((request) => request.status !== 'CANCELLED').length;
  const remainingSlots = Math.max(0, 2 - usedSlots);
  const productNameById = useMemo(
    () => new Map(catalogProducts.map((product) => [product.id, product.name])),
    [catalogProducts],
  );
  const isWholesale = role === 'STORE' && storeKind === 'WHOLESALE';

  const resetMutationKey = () => {
    idempotencyKey.current = null;
    setNotice(null);
  };

  const addLine = () => {
    const productId = selectedProductId || activeProducts[0]?.id;
    if (!productId || !Number.isSafeInteger(quantity) || quantity <= 0) return;
    setDraftLines((current) => {
      const existing = current.find((line) => line.productId === productId);
      if (existing) {
        return current.map((line) =>
          line.productId === productId ? { ...line, quantity: line.quantity + quantity } : line,
        );
      }
      return [...current, { productId, quantity }];
    });
    setQuantity(1);
    resetMutationKey();
  };

  const submit = async () => {
    if (!activeSession || !effectiveStoreId || draftLines.length === 0 || remainingSlots === 0) {
      return;
    }
    setSubmitting(true);
    setNotice(null);
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      await submitStoreOrderRequest(
        {
          businessSessionId: activeSession.id,
          items: draftLines.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
          })),
          storeId: effectiveStoreId,
        },
        idempotencyKey.current,
      );
      setDraftLines([]);
      idempotencyKey.current = null;
      setNotice({
        kind: 'success',
        message: 'Đã gửi yêu cầu. Kho chỉ giữ hàng sau khi chạy phân bổ.',
      });
      await requestsQuery.refetch();
    } catch (cause) {
      setNotice({
        kind: 'error',
        message:
          cause instanceof ApiClientError
            ? cause.message
            : 'Không thể gửi yêu cầu vì phản hồi máy chủ không hợp lệ.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const initialLoading =
    sessionQuery.isPending ||
    storesQuery.isPending ||
    catalogQuery.isPending ||
    sessionsQuery.isPending;
  const loading =
    initialLoading || (Boolean(effectiveStoreId && activeSession) && requestsQuery.isPending);
  const loadError =
    sessionQuery.error ??
    storesQuery.error ??
    catalogQuery.error ??
    sessionsQuery.error ??
    requestsQuery.error;
  const formDisabled = loading || Boolean(loadError) || submitting;

  const retryLoading = () => {
    void sessionQuery.refetch();
    void storesQuery.refetch();
    void catalogQuery.refetch();
    void sessionsQuery.refetch();
    if (effectiveStoreId && activeSession) void requestsQuery.refetch();
  };

  return (
    <>
      <PageHeader
        description={
          activeSession
            ? `${selectedStore?.name ?? 'Phạm vi cửa hàng'} • nhận yêu cầu đến ${new Date(activeSession.requestClosesAt).toLocaleString('vi-VN')}`
            : 'Chưa có phiên đặt hàng đang mở'
        }
        title={isWholesale ? 'Đặt hàng khách sỉ' : 'Đặt hàng & kết quả'}
      />

      {loadError ? (
        <section className="panel form-error" role="alert">
          <p>Không thể tải đầy đủ dữ liệu đặt hàng. Biểu mẫu đã được khóa để tránh gửi sai.</p>
          <Button onClick={retryLoading} tone="secondary">
            <RotateCcw aria-hidden="true" size={16} /> Thử tải lại
          </Button>
        </section>
      ) : null}
      {loading ? <section className="panel">Đang tải dữ liệu đặt hàng…</section> : null}

      {!initialLoading && role !== 'STORE' ? (
        <section className="panel form-grid">
          <label>
            Cửa hàng
            <select
              disabled={formDisabled}
              onChange={(event) => {
                setSelectedStoreId(event.target.value);
                setDraftLines([]);
                resetMutationKey();
              }}
              value={effectiveStoreId}
            >
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.code} • {store.name}
                </option>
              ))}
            </select>
          </label>
          {sessions.length > 1 ? (
            <label>
              Phiên đặt hàng
              <select
                disabled={formDisabled}
                onChange={(event) => {
                  setSelectedSessionId(event.target.value);
                  setDraftLines([]);
                  resetMutationKey();
                }}
                value={activeSession?.id ?? ''}
              >
                {sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.businessDate} · đóng{' '}
                    {new Date(session.requestClosesAt).toLocaleString('vi-VN')}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </section>
      ) : null}

      {!initialLoading && role === 'STORE' && sessions.length > 1 ? (
        <section className="panel">
          <label>
            Phiên đặt hàng
            <select
              disabled={formDisabled}
              onChange={(event) => {
                setSelectedSessionId(event.target.value);
                setDraftLines([]);
                resetMutationKey();
              }}
              value={activeSession?.id ?? ''}
            >
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.businessDate} · đóng{' '}
                  {new Date(session.requestClosesAt).toLocaleString('vi-VN')}
                </option>
              ))}
            </select>
          </label>
        </section>
      ) : null}

      <section className="quota-card">
        <div>
          <strong>{usedSlots} / 2 phiếu</strong>
          <span>Còn {remainingSlots} yêu cầu mới trong phiên hiện tại</span>
        </div>
        <progress max="2" value={usedSlots} />
        <Badge tone={remainingSlots > 0 ? 'info' : 'warning'}>
          {remainingSlots > 0 ? 'Còn lượt' : 'Đã đủ giới hạn'}
        </Badge>
      </section>

      {isWholesale ? (
        <section className="permission-card">
          <strong>Quyền hạn khách sỉ</strong>
          <span>Đặt hàng • xem phân bổ • phiếu chờ</span>
          <small>Không nhận / khui / bán / tồn / điều chuyển</small>
        </section>
      ) : null}

      <div className="request-layout">
        <section className="panel request-form-panel">
          <div className="section-heading section-heading--compact">
            <div>
              <h2>Tạo yêu cầu</h2>
              <p>Một phiếu có thể gồm nhiều mặt hàng; tối đa hai phiếu trong mỗi phiên.</p>
            </div>
          </div>
          <div className="form-grid">
            <label>
              Mặt hàng
              <select
                disabled={formDisabled || !activeSession || remainingSlots === 0}
                onChange={(event) => {
                  setSelectedProductId(event.target.value);
                  resetMutationKey();
                }}
                value={selectedProductId || activeProducts[0]?.id || ''}
              >
                {activeProducts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Số bao
              <input
                disabled={formDisabled || !activeSession || remainingSlots === 0}
                max="100000"
                min="1"
                onChange={(event) => {
                  setQuantity(event.target.valueAsNumber || 1);
                  resetMutationKey();
                }}
                type="number"
                value={quantity}
              />
            </label>
          </div>
          <Button
            disabled={
              formDisabled || !activeSession || remainingSlots === 0 || activeProducts.length === 0
            }
            onClick={addLine}
          >
            <Plus aria-hidden="true" size={16} /> Thêm mặt hàng
          </Button>
        </section>

        <section className="panel request-summary">
          <div className="section-heading section-heading--compact">
            <div>
              <h2>Phiếu đang soạn</h2>
              <p>Hệ thống chưa kiểm tồn và chưa giữ hàng lúc gửi.</p>
            </div>
          </div>
          {draftLines.length === 0 ? <p>Chưa có mặt hàng.</p> : null}
          {draftLines.map((line) => (
            <article className="request-line" key={line.productId}>
              <div>
                <strong>{productNameById.get(line.productId) ?? line.productId}</strong>
                <span>{line.quantity} bao</span>
              </div>
              <button
                aria-label={`Xóa ${productNameById.get(line.productId) ?? 'mặt hàng'}`}
                onClick={() => {
                  setDraftLines((current) =>
                    current.filter((candidate) => candidate.productId !== line.productId),
                  );
                  resetMutationKey();
                }}
                type="button"
              >
                <Trash2 size={17} />
              </button>
            </article>
          ))}
          {notice ? (
            <div
              className={notice.kind === 'error' ? 'form-error' : 'inline-notice'}
              role={notice.kind === 'error' ? 'alert' : 'status'}
            >
              {notice.message}
            </div>
          ) : null}
          <Button
            busy={submitting}
            disabled={
              formDisabled ||
              !activeSession ||
              !effectiveStoreId ||
              draftLines.length === 0 ||
              remainingSlots === 0
            }
            onClick={() => void submit()}
          >
            <Send aria-hidden="true" size={16} /> Gửi yêu cầu đặt hàng
          </Button>
        </section>
      </div>

      <section className="panel history-list">
        <div className="section-heading section-heading--compact">
          <div>
            <h2>Yêu cầu trong phiên</h2>
            <p>Dữ liệu trực tiếp từ máy chủ; ưu tiên do hệ thống phân bổ gán.</p>
          </div>
        </div>
        {submittedRequests.length === 0 ? <p>Chưa có yêu cầu đã gửi.</p> : null}
        {submittedRequests.map((request) => (
          <article key={request.id}>
            <div>
              <strong>Phiếu {request.requestSequence}</strong>
              <span>
                <Clock3 size={14} />{' '}
                {request.lines
                  .map((line) => {
                    const quantity =
                      line.requested.kind === 'UNIT'
                        ? `${line.requested.quantity} bao`
                        : `${line.requested.value} kg`;
                    return `${productNameById.get(line.productId) ?? line.productId}: ${quantity}`;
                  })
                  .join(' • ')}
              </span>
            </div>
            <Badge tone={request.status === 'CANCELLED' ? 'neutral' : 'warning'}>
              {request.status === 'CANCELLED'
                ? 'Đã hủy'
                : request.status === 'MERGED'
                  ? 'Đã gộp'
                  : 'Đã gửi'}
            </Badge>
          </article>
        ))}
      </section>

      {role === 'STORE' && effectiveStoreId ? (
        <WaitlistPanel
          productNameById={productNameById}
          role={role}
          scopeStoreId={effectiveStoreId}
        />
      ) : null}
    </>
  );
}
