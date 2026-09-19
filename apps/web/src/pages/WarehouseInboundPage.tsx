import {
  CreateInboundReceiptRequestSchema,
  type CreateInboundReceiptRequest,
} from '@idosi/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { AdminAccess } from '../features/admin/AdminAccess';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { ProductBagPicker } from '../components/ProductBagPicker';
import { createWarehouseInbound, listCatalog, listWarehouseInbounds } from '../lib/api';

interface DraftProduct {
  productId: string;
  quantity: number;
  bags: { bagCode: string; weightKg: string }[];
}

function newBag() {
  return { bagCode: `B-${crypto.randomUUID()}`, weightKg: '' };
}

export function WarehouseInboundPage() {
  return (
    <AdminAccess>
      <WarehouseInboundContent />
    </AdminAccess>
  );
}

function WarehouseInboundContent() {
  const client = useQueryClient();
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: listCatalog, retry: false });
  const [page, setPage] = useState(1);
  const history = useQuery({
    queryKey: ['warehouse-inbounds', page],
    queryFn: () => listWarehouseInbounds(page),
    retry: false,
  });
  const [draft, setDraft] = useState<DraftProduct[]>([]);
  const [referenceCode, setReferenceCode] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; message: string } | null>(null);
  const operation = useRef<{ key: string; input: CreateInboundReceiptRequest } | null>(null);
  const products = (catalog.data ?? []).filter((product) => product.status === 'ACTIVE');
  const changed = () => {
    operation.current = null;
    setNotice(null);
  };
  const total = draft.reduce((sum, item) => sum + item.quantity, 0);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (
      draft.some(
        (item) =>
          !Number.isSafeInteger(item.quantity) ||
          item.quantity < 1 ||
          item.quantity !== item.bags.length ||
          !products.some((product) => product.id === item.productId),
      )
    ) {
      setNotice({ error: true, message: 'Kiểm tra số bao và mặt hàng đang hoạt động đã chọn.' });
      return;
    }
    const parsed = CreateInboundReceiptRequestSchema.safeParse(
      operation.current?.input ?? {
        referenceCode,
        supplierName,
        receivedAt: new Date().toISOString(),
        bags: draft.flatMap((item) =>
          item.bags.map((bag) => ({ ...bag, productId: item.productId })),
        ),
      },
    );
    if (!parsed.success) {
      setNotice({
        error: true,
        message:
          'Nhập mã phiếu, nhà cung cấp và khối lượng kg dương (tối đa 3 số thập phân) cho từng bao; một phiếu từ 1 đến 2000 bao.',
      });
      return;
    }
    operation.current ??= { key: crypto.randomUUID(), input: parsed.data };
    setBusy(true);
    setNotice(null);
    try {
      const receipt = await createWarehouseInbound(operation.current.input, operation.current.key);
      setDraft([]);
      setReferenceCode('');
      setSupplierName('');
      operation.current = null;
      setNotice({ error: false, message: `Đã nhập phiếu ${receipt.referenceCode} vào kho tổng.` });
      setPage(1);
      void client.invalidateQueries({ queryKey: ['warehouse-inbounds'] });
      void client.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (error) {
      setNotice({
        error: true,
        message: error instanceof Error ? error.message : 'Không thể nhập kho. Vui lòng thử lại.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Nhập kho tổng"
        description="Admin tiếp nhận hàng từ nhà cung cấp vào kho tổng. Chọn mặt hàng và nhập số bao thực nhận."
      />
      {catalog.isError ? (
        <div role="alert">
          Không tải được danh mục.{' '}
          <Button onClick={() => void catalog.refetch()}>Thử lại danh mục</Button>
        </div>
      ) : null}
      {catalog.isPending ? <p role="status">Đang tải mặt hàng…</p> : null}
      <form className="panel" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy} className="product-bag-picker">
          <div className="form-grid">
            <label>
              Mã phiếu nhập
              <input
                required
                maxLength={100}
                value={referenceCode}
                onChange={(event) => {
                  setReferenceCode(event.target.value);
                  changed();
                }}
              />
            </label>
            <label>
              Nhà cung cấp
              <input
                required
                maxLength={200}
                value={supplierName}
                onChange={(event) => {
                  setSupplierName(event.target.value);
                  changed();
                }}
              />
            </label>
          </div>
          <ProductBagPicker
            products={products}
            disabled={busy || catalog.isPending || catalog.isError}
            quantities={Object.fromEntries(draft.map((item) => [item.productId, item.quantity]))}
            onSelect={(productId, selected) => {
              setDraft((current) =>
                selected
                  ? [...current, { productId, quantity: 1, bags: [newBag()] }]
                  : current.filter((item) => item.productId !== productId),
              );
              changed();
            }}
            onQuantityChange={(productId, quantity) => {
              setDraft((current) =>
                current.map((item) => {
                  if (item.productId !== productId) return item;
                  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2000)
                    return { ...item, quantity };
                  return {
                    ...item,
                    quantity,
                    bags: Array.from(
                      { length: quantity },
                      (_, index) => item.bags[index] ?? newBag(),
                    ),
                  };
                }),
              );
              changed();
            }}
            renderDetails={(productId) =>
              draft
                .find((item) => item.productId === productId)
                ?.bags.map((bag, index) => (
                  <label key={bag.bagCode}>
                    Khối lượng bao {index + 1} (kg) —{' '}
                    {products.find((product) => product.id === productId)?.name}
                    <input
                      required
                      inputMode="decimal"
                      placeholder="Ví dụ: 80.500"
                      value={bag.weightKg}
                      onChange={(event) => {
                        setDraft((current) =>
                          current.map((item) =>
                            item.productId === productId
                              ? {
                                  ...item,
                                  bags: item.bags.map((candidate, bagIndex) =>
                                    bagIndex === index
                                      ? {
                                          ...candidate,
                                          weightKg: event.target.value.replace(',', '.'),
                                        }
                                      : candidate,
                                  ),
                                }
                              : item,
                          ),
                        );
                        changed();
                      }}
                    />
                    <small>Mã bao: {bag.bagCode}</small>
                  </label>
                ))
            }
          />
          <p aria-live="polite">
            Đã chọn {draft.length} mặt hàng · {Number.isFinite(total) ? total : 0} bao
          </p>
          {notice ? (
            <p
              role={notice.error ? 'alert' : 'status'}
              className={notice.error ? 'form-error' : 'inline-notice'}
            >
              {notice.message}
            </p>
          ) : null}
          <Button
            type="submit"
            busy={busy}
            disabled={catalog.isPending || catalog.isError || draft.length === 0 || total > 2000}
          >
            Xác nhận nhập kho tổng
          </Button>
        </fieldset>
      </form>
      <section className="panel">
        <h2>Phiếu nhập kho tổng</h2>
        <Button tone="secondary" onClick={() => void history.refetch()} busy={history.isFetching}>
          Làm mới phiếu nhập
        </Button>
        {history.isError ? (
          <p role="alert">Không tải được phiếu nhập. Nhấn làm mới để thử lại.</p>
        ) : null}
        {history.isPending ? <p role="status">Đang tải phiếu nhập…</p> : null}
        {history.data?.data.length === 0 ? <p>Chưa có phiếu nhập.</p> : null}
        {history.data?.data.map((receipt) => (
          <article className="request-line" key={receipt.id}>
            <div>
              <strong>
                {receipt.referenceCode} · {receipt.supplierName}
              </strong>
              <span>
                {receipt.bags.length} bao ·{' '}
                {receipt.status === 'COST_CONFIRMED'
                  ? 'Đã xác nhận chi phí'
                  : receipt.status === 'CANCELLED'
                    ? 'Đã hủy'
                    : 'Đã nhập, chờ xác nhận chi phí'}
              </span>
            </div>
          </article>
        ))}
        <div className="button-row">
          <Button
            tone="secondary"
            disabled={page <= 1 || history.isFetching}
            onClick={() => setPage((value) => value - 1)}
          >
            Trang trước
          </Button>
          <span>Trang {page}</span>
          <Button
            tone="secondary"
            disabled={
              !history.data || page >= history.data.pagination.totalPages || history.isFetching
            }
            onClick={() => setPage((value) => value + 1)}
          >
            Trang sau
          </Button>
        </div>
      </section>
    </>
  );
}
