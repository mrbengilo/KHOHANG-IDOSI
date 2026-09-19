import {
  CreateInboundReceiptRequestSchema,
  type CreateInboundReceiptRequest,
  type InboundReceipt,
} from '@idosi/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { AdminAccess } from '../features/admin/AdminAccess';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { ProductBagPicker } from '../components/ProductBagPicker';
import {
  createWarehouseInbound,
  listCatalog,
  listWarehouseInbounds,
  updateWarehouseInboundVat,
} from '../lib/api';
import { formatVnd } from '../lib/format';

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
  const [vatAmount, setVatAmount] = useState('');
  const [entryTab, setEntryTab] = useState<'GOODS' | 'VAT'>('GOODS');
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
      vatAmount !== '' &&
      (!/^\d+$/.test(vatAmount) || !Number.isSafeInteger(Number(vatAmount)))
    ) {
      setEntryTab('VAT');
      setNotice({
        error: true,
        message: 'Số tiền VAT phải là số nguyên VND không âm, trong giới hạn an toàn.',
      });
      return;
    }
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
        ...(vatAmount === '' ? {} : { vat: { amountVnd: Number(vatAmount), ratePercent: 8 } }),
        receivedAt: new Date().toISOString(),
        bags: draft.flatMap((item) =>
          item.bags.map((bag) => ({ ...bag, productId: item.productId })),
        ),
      },
    );
    if (!parsed.success) {
      setEntryTab('GOODS');
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
      setVatAmount('');
      setEntryTab('GOODS');
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
      <form className="panel" noValidate onSubmit={(event) => void submit(event)}>
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
          <div className="button-row" aria-label="Nội dung phiếu nhập">
            <Button
              tone={entryTab === 'GOODS' ? 'primary' : 'secondary'}
              aria-pressed={entryTab === 'GOODS'}
              onClick={() => setEntryTab('GOODS')}
            >
              Mặt hàng
            </Button>
            <Button
              tone={entryTab === 'VAT' ? 'primary' : 'secondary'}
              aria-pressed={entryTab === 'VAT'}
              onClick={() => setEntryTab('VAT')}
            >
              Nhập VAT · 8%
            </Button>
          </div>
          <section hidden={entryTab !== 'VAT'} aria-label="Nhập VAT">
            <div className="form-grid">
              <label>
                Số tiền VAT (VND)
                <input
                  inputMode="numeric"
                  placeholder="Ví dụ: 1000000"
                  value={vatAmount}
                  onChange={(event) => {
                    setVatAmount(event.target.value);
                    changed();
                  }}
                />
                <small>
                  Nhập trực tiếp tiền thuế. Để trống nếu chưa ghi nhận; nhập 0 nếu đã xác nhận không
                  phát sinh. Có thể bổ sung/sửa ở lịch sử phiếu nhập bên dưới.
                </small>
              </label>
              <label>
                Thuế suất mặc định
                <input value="8%" readOnly />
              </label>
            </div>
            <p>Số tiền thuế được lưu nguyên giá trị đã nhập, không nhân thêm 8%.</p>
          </section>
          <div hidden={entryTab !== 'GOODS'}>
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
                        placeholder="Ví dụ: 80,5"
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
          </div>
          <p aria-live="polite">
            Đã chọn {draft.length} mặt hàng · {Number.isFinite(total) ? total : 0} bao
          </p>
          <p>
            VAT 8%:{' '}
            {vatAmount === ''
              ? 'Chưa ghi nhận'
              : /^\d+$/.test(vatAmount) && Number.isSafeInteger(Number(vatAmount))
                ? formatVnd(Number(vatAmount))
                : 'Số tiền không hợp lệ'}
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
                VAT:{' '}
                {receipt.vat
                  ? `${formatVnd(receipt.vat.amountVnd)} (${receipt.vat.ratePercent}%)`
                  : 'Chưa ghi nhận'}
              </span>
              <span>
                {receipt.bags.length} bao ·{' '}
                {receipt.status === 'COST_CONFIRMED'
                  ? 'Đã xác nhận chi phí'
                  : receipt.status === 'CANCELLED'
                    ? 'Đã hủy'
                    : 'Đã nhập, chờ xác nhận chi phí'}
              </span>
              {receipt.status !== 'CANCELLED' ? <InboundVatEditor receipt={receipt} /> : null}
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

function InboundVatEditor({ receipt }: { receipt: InboundReceipt }) {
  const client = useQueryClient();
  const [amount, setAmount] = useState(receipt.vat?.amountVnd.toString() ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; message: string } | null>(null);
  const attempt = useRef<{ key: string; serialized: string } | null>(null);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (
      !/^\d+$/.test(amount) ||
      !Number.isSafeInteger(Number(amount)) ||
      reason.trim().length < 3
    ) {
      setNotice({
        error: true,
        message: 'Nhập số tiền VND nguyên không âm và lý do ít nhất 3 ký tự.',
      });
      return;
    }
    const input = {
      vat: { amountVnd: Number(amount), ratePercent: 8 as const },
      expectedVersion: receipt.version,
      reason: reason.trim(),
    };
    const serialized = JSON.stringify(input);
    if (attempt.current?.serialized !== serialized)
      attempt.current = { key: crypto.randomUUID(), serialized };
    setBusy(true);
    setNotice(null);
    try {
      await updateWarehouseInboundVat(receipt.id, input, attempt.current.key);
      attempt.current = null;
      setNotice({
        error: false,
        message: 'Đã lưu VAT 8% và lịch sử thay đổi; số lượng kho không đổi.',
      });
      await Promise.all([
        client.invalidateQueries({ queryKey: ['warehouse-inbounds'] }),
        client.invalidateQueries({ queryKey: ['reports'] }),
        client.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    } catch (error) {
      setNotice({
        error: true,
        message: error instanceof Error ? error.message : 'Không lưu được VAT.',
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>Cập nhật VAT · 8%</summary>
      <form onSubmit={save}>
        <fieldset disabled={busy} className="form-grid">
          <label>
            Số tiền VAT cho {receipt.referenceCode}
            <input
              inputMode="numeric"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
            />
          </label>
          <label>
            Lý do cập nhật VAT cho {receipt.referenceCode}
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={3}
              maxLength={500}
              required
            />
          </label>
          <Button type="submit" busy={busy}>
            Lưu VAT
          </Button>
        </fieldset>
        {notice ? <p role={notice.error ? 'alert' : 'status'}>{notice.message}</p> : null}
      </form>
    </details>
  );
}
