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
import { formatVnd } from '../lib/format';
import { groupInboundProducts } from './InboundReceiptDetails';
import { formatDocumentTime } from '../lib/business-time';
import '../styles/document-history.css';
import './warehouse-inbound.css';

interface DraftProduct {
  productId: string;
  quantity: number;
  bags: { bagCode: string; weightKg: null }[];
}

function newBag() {
  return { bagCode: `B-${crypto.randomUUID()}`, weightKg: null };
}

export function WarehouseInboundPage() {
  return (
    <AdminAccess roles={['ADMIN', 'HTKD']}>
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
        supplierName,
        receivedAt: new Date().toISOString(),
        bags: draft.flatMap((item) =>
          item.bags.map((bag) => ({
            ...bag,
            weightKg: null,
            productId: item.productId,
          })),
        ),
      },
    );
    if (!parsed.success) {
      setNotice({
        error: true,
        message:
          'Nhập nhà cung cấp và chọn từ 1 đến 2000 bao. HTKD nhập khối lượng sau khi cửa hàng gửi kết quả thực nhận.',
      });
      return;
    }
    operation.current ??= { key: crypto.randomUUID(), input: parsed.data };
    setBusy(true);
    setNotice(null);
    try {
      const receipt = await createWarehouseInbound(operation.current.input, operation.current.key);
      setDraft([]);
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
        description="Tiếp nhận hàng từ nhà cung cấp vào kho tổng. Chọn mặt hàng và nhập số bao thực nhận."
      />
      {catalog.isError ? (
        <div role="alert">
          Không tải được danh mục.{' '}
          <Button onClick={() => void catalog.refetch()}>Thử lại danh mục</Button>
        </div>
      ) : null}
      {catalog.isPending ? <p role="status">Đang tải mặt hàng…</p> : null}
      <form
        className="panel warehouse-inbound-form"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <fieldset disabled={busy} className="product-bag-picker">
          <div className="form-grid">
            <label>
              Mã phiếu nhập
              <input readOnly value="Tự tạo khi lưu · PN00001-dd/MM/yyyy" />
            </label>
            <label>
              <span>
                Nhà cung cấp{' '}
                <span className="inbound-required" aria-hidden="true">
                  *
                </span>
              </span>
              <input
                required
                aria-label="Nhà cung cấp"
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
            required
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
            className="warehouse-inbound-form__submit"
            type="submit"
            busy={busy}
            disabled={catalog.isPending || catalog.isError || draft.length === 0 || total > 2000}
          >
            Xác nhận nhập kho tổng
          </Button>
        </fieldset>
      </form>
      <section className="panel inbound-history">
        <h2>Phiếu nhập kho tổng</h2>
        <Button tone="secondary" onClick={() => void history.refetch()} busy={history.isFetching}>
          Làm mới phiếu nhập
        </Button>
        {history.isError ? (
          <p role="alert">Không tải được phiếu nhập. Nhấn làm mới để thử lại.</p>
        ) : null}
        {history.isPending ? <p role="status">Đang tải phiếu nhập…</p> : null}
        {history.data?.data.length === 0 ? <p>Chưa có phiếu nhập.</p> : null}
        <p>
          Chi phí nhận hàng do HTKD chốt tại Nhận hàng / Chi phí sau khi cửa hàng gửi kết quả thực
          nhận. Tên người nhập là tên tài khoản hiện tại.
        </p>
        <div
          className="document-history"
          role="region"
          aria-label="Lịch sử nhập kho tổng"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                {[
                  'Thời gian',
                  'Mã phiếu',
                  'Nhà cung cấp',
                  'Mặt hàng',
                  'Số lượng (bao)',
                  'Tổng số lượng (bao)',
                  'Người thực hiện',
                ].map((label) => (
                  <th scope="col" key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            {history.data?.data.map((receipt) => {
              const lines = groupInboundProducts(receipt.bags, catalog.data ?? []);
              return (
                <tbody key={receipt.id}>
                  {lines.map((line, index) => (
                    <tr key={line.productId}>
                      {index === 0 ? (
                        <>
                          <td rowSpan={lines.length}>
                            <time dateTime={receipt.receivedAt}>
                              {formatDocumentTime(receipt.receivedAt)}
                            </time>
                          </td>
                          <td rowSpan={lines.length}>
                            <details>
                              <summary>{receipt.referenceCode || 'Chưa ghi nhận mã phiếu'}</summary>
                              <p>
                                {receipt.status === 'CANCELLED'
                                  ? 'Đã hủy'
                                  : receipt.status === 'COST_CONFIRMED'
                                    ? 'Đã ghi nhận chi phí nhà cung cấp'
                                    : 'Chưa ghi nhận chi phí nhà cung cấp'}
                              </p>
                              {receipt.cost ? (
                                <p>
                                  Tiền hàng: {formatVnd(receipt.cost.goodsCostVnd)} · Vận chuyển:{' '}
                                  {formatVnd(receipt.cost.transportationFeeVnd)} · Bốc vác:{' '}
                                  {formatVnd(receipt.cost.handlingFeeVnd)} · Tổng chi phí:{' '}
                                  {formatVnd(receipt.cost.totalCostVnd)}
                                </p>
                              ) : null}
                              {receipt.vat ? (
                                <p>
                                  VAT ghi nhận trước đây: {formatVnd(receipt.vat.amountVnd)} (
                                  {receipt.vat.ratePercent}%)
                                </p>
                              ) : null}
                            </details>
                            {receipt.status === 'CANCELLED' ? <strong>Đã hủy</strong> : null}
                          </td>
                          <td rowSpan={lines.length}>{receipt.supplierName}</td>
                        </>
                      ) : null}
                      <td>{line.name}</td>
                      <td>{line.quantity}</td>
                      {index === 0 ? (
                        <>
                          <td rowSpan={lines.length}>{receipt.bags.length}</td>
                          <td rowSpan={lines.length}>
                            {receipt.receivedByDisplayName ?? 'Chưa ghi nhận'}
                          </td>
                        </>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              );
            })}
          </table>
        </div>
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
