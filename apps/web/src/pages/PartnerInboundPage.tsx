import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreateStorePartnerInboundRequestSchema } from '@idosi/contracts';
import { useRef, useState, type FormEvent } from 'react';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { ProductBagPicker } from '../components/ProductBagPicker';
import { StatCard } from '../components/StatCard';
import {
  createStorePartnerInbound,
  listCatalog,
  listStorePartnerInbounds,
  mockModeEnabled,
} from '../lib/api';
import { useSession } from '../lib/auth';
import { formatKg, formatInteger } from '../lib/format';
import { UnavailableFeature } from '../components/UnavailableFeature';

interface DraftLine {
  readonly productId: string;
  readonly quantity: number;
  /** One entry per unit; kept as raw text so a half-typed weight is not silently rounded. */
  readonly bagWeightsKg: readonly string[];
}

const partnerInboundQueryKey = ['store-partner-inbounds'] as const;

/** Positive kilograms with at most three decimals, matching the contract's weight format. */
export function partnerBagWeightsValid(lines: readonly DraftLine[]): boolean {
  if (lines.length === 0) return false;
  return lines.every(
    (line) =>
      Number.isSafeInteger(line.quantity) &&
      line.quantity > 0 &&
      line.bagWeightsKg.length === line.quantity &&
      line.bagWeightsKg.every(
        (weight) => /^\d+(\.\d{1,3})?$/.test(weight.trim()) && Number(weight) > 0,
      ),
  );
}

export function partnerInboundRequest(
  storeId: string,
  partnerName: string,
  note: string,
  lines: readonly DraftLine[],
  receivedAt: string,
) {
  return CreateStorePartnerInboundRequestSchema.safeParse({
    storeId,
    partnerName: partnerName.trim(),
    note: note.trim() === '' ? null : note.trim(),
    receivedAt,
    lines: lines.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      bagWeightsKg: line.bagWeightsKg.map((weight) => Number(weight).toFixed(3)),
    })),
  });
}

export function PartnerInboundPage() {
  return mockModeEnabled ? (
    <UnavailableFeature title="Nhập hàng đối tác khác" />
  ) : (
    <PartnerInboundContent />
  );
}

function PartnerInboundContent() {
  const queryClient = useQueryClient();
  const sessionQuery = useSession();
  const storeId = sessionQuery.data?.principal.storeId ?? '';
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: listCatalog, retry: false });
  const history = useQuery({
    queryKey: partnerInboundQueryKey,
    queryFn: () => listStorePartnerInbounds(storeId || undefined),
    enabled: storeId !== '',
    retry: false,
  });
  const [partnerName, setPartnerName] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [notice, setNotice] = useState<{ error: boolean; message: string } | null>(null);
  // One idempotency key per unchanged draft: a retry after a timeout must not create a
  // second slip, but editing the draft has to start a new operation.
  const operation = useRef<{ key: string; serialized: string } | null>(null);
  const products = (catalog.data ?? []).filter((product) => product.status === 'ACTIVE');
  const productName = (productId: string) =>
    products.find((product) => product.id === productId)?.name ?? productId;

  const changed = () => {
    operation.current = null;
    setNotice(null);
  };

  const save = useMutation({
    mutationFn: async () => {
      const parsed = partnerInboundRequest(
        storeId,
        partnerName,
        note,
        lines,
        new Date().toISOString(),
      );
      if (!parsed.success) throw new Error('Kiểm tra lại tên đối tác, mặt hàng và khối lượng.');
      const serialized = JSON.stringify(parsed.data);
      if (operation.current?.serialized !== serialized) {
        operation.current = { key: crypto.randomUUID(), serialized };
      }
      return createStorePartnerInbound(parsed.data, operation.current.key);
    },
    onSuccess: async (slip) => {
      setLines([]);
      setPartnerName('');
      setNote('');
      operation.current = null;
      setNotice({
        error: false,
        message: `Đã lưu phiếu ${slip.referenceCode} và cộng vào tồn kho cửa hàng.`,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: partnerInboundQueryKey }),
        queryClient.invalidateQueries({ queryKey: ['store-inventory'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
    onError: (error: unknown) => {
      setNotice({
        error: true,
        message: error instanceof Error ? error.message : 'Không lưu được phiếu nhập.',
      });
    },
  });

  const totalUnits = lines.reduce((sum, line) => sum + (line.quantity || 0), 0);
  const totalKg = lines.reduce(
    (sum, line) =>
      sum +
      line.bagWeightsKg.reduce(
        (lineSum, weight) => lineSum + (Number.isFinite(Number(weight)) ? Number(weight) : 0),
        0,
      ),
    0,
  );
  const ready =
    storeId !== '' &&
    partnerName.trim().length > 0 &&
    partnerBagWeightsValid(lines) &&
    lines.every((line) => products.some((product) => product.id === line.productId));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending || !ready) {
      if (!ready) {
        setNotice({
          error: true,
          message: 'Nhập tên đối tác, chọn mặt hàng và điền khối lượng (kg) cho từng kiện.',
        });
      }
      return;
    }
    save.mutate();
  };

  if (sessionQuery.data && storeId === '') {
    return <UnavailableFeature title="Nhập hàng đối tác khác" />;
  }

  return (
    <>
      <PageHeader
        title="Nhập hàng đối tác khác"
        description="Ghi nhận hàng cửa hàng nhận thẳng từ đối tác, ngoài luồng phân bổ của kho tổng. Lưu xong là cộng ngay vào tồn kho cửa hàng."
      />
      <form className="panel" noValidate onSubmit={submit}>
        <fieldset className="product-bag-picker" disabled={save.isPending}>
          <div className="form-grid">
            <label>
              Mã phiếu nhập
              <input readOnly value="Tự tạo khi lưu · PNDT00001-dd/MM/yyyy" />
            </label>
            <label>
              <span>
                Tên đối tác{' '}
                <span style={{ color: 'var(--danger)' }} aria-hidden="true">
                  *
                </span>
              </span>
              <input
                required
                aria-label="Tên đối tác"
                maxLength={200}
                value={partnerName}
                onChange={(event) => {
                  setPartnerName(event.target.value);
                  changed();
                }}
              />
            </label>
            <label>
              Ghi chú
              <input
                aria-label="Ghi chú phiếu nhập đối tác"
                maxLength={1000}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                  changed();
                }}
              />
            </label>
          </div>
          {catalog.isError ? (
            <p role="alert">
              Không tải được danh mục.{' '}
              <Button tone="secondary" onClick={() => void catalog.refetch()}>
                Thử lại danh mục
              </Button>
            </p>
          ) : null}
          {catalog.isPending ? <p role="status">Đang tải mặt hàng…</p> : null}
          <ProductBagPicker
            required
            products={products}
            disabled={save.isPending || catalog.isPending || catalog.isError}
            quantities={Object.fromEntries(lines.map((line) => [line.productId, line.quantity]))}
            onSelect={(productId, selected) => {
              setLines((current) =>
                selected
                  ? [...current, { productId, quantity: 1, bagWeightsKg: [''] }]
                  : current.filter((line) => line.productId !== productId),
              );
              changed();
            }}
            onQuantityChange={(productId, quantity) => {
              setLines((current) =>
                current.map((line) => {
                  if (line.productId !== productId) return line;
                  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2000) {
                    return { ...line, quantity };
                  }
                  return {
                    ...line,
                    quantity,
                    // Keep every weight already typed; only the tail grows or is cut.
                    bagWeightsKg: Array.from(
                      { length: quantity },
                      (_, index) => line.bagWeightsKg[index] ?? '',
                    ),
                  };
                }),
              );
              changed();
            }}
            renderDetails={(productId) => {
              const line = lines.find((entry) => entry.productId === productId);
              if (!line) return null;
              return (
                <div className="form-grid">
                  {line.bagWeightsKg.map((weight, index) => (
                    <label key={`${productId}-${index}`}>
                      <span>
                        Khối lượng kiện {index + 1} (kg) — {productName(productId)}{' '}
                        <span style={{ color: 'var(--danger)' }} aria-hidden="true">
                          *
                        </span>
                      </span>
                      <input
                        required
                        aria-label={`Khối lượng kiện ${index + 1} của ${productName(productId)}`}
                        inputMode="decimal"
                        placeholder="Ví dụ: 45.500"
                        value={weight}
                        onChange={(event) => {
                          const next = event.target.value;
                          setLines((current) =>
                            current.map((entry) =>
                              entry.productId === productId
                                ? {
                                    ...entry,
                                    bagWeightsKg: entry.bagWeightsKg.map((value, position) =>
                                      position === index ? next : value,
                                    ),
                                  }
                                : entry,
                            ),
                          );
                          changed();
                        }}
                      />
                    </label>
                  ))}
                </div>
              );
            }}
          />
          <p aria-live="polite">
            Đã chọn {formatInteger(lines.length)} mặt hàng · {formatInteger(totalUnits)} kiện ·{' '}
            {formatKg(totalKg)}
          </p>
          {notice ? <p role={notice.error ? 'alert' : 'status'}>{notice.message}</p> : null}
          <Button type="submit" busy={save.isPending} disabled={!ready}>
            Lưu phiếu và cộng tồn kho
          </Button>
        </fieldset>
      </form>
      <section className="panel">
        <div className="section-heading section-heading--compact">
          <h2>Phiếu nhập từ đối tác</h2>
          <Button tone="secondary" busy={history.isFetching} onClick={() => void history.refetch()}>
            Làm mới
          </Button>
        </div>
        {history.isError ? <p role="alert">Không tải được phiếu nhập đối tác.</p> : null}
        {history.isPending ? <p role="status">Đang tải phiếu nhập…</p> : null}
        {history.data?.length === 0 ? <p>Chưa có phiếu nhập từ đối tác.</p> : null}
        {history.data && history.data.length > 0 ? (
          <div className="stats-grid stats-grid--small">
            <StatCard
              label="Số phiếu đã nhập"
              value={`${formatInteger(history.data.length)} phiếu`}
              detail="Phiếu nhập từ đối tác của cửa hàng này"
              tone="info"
            />
            <StatCard
              label="Tổng kiện từ đối tác"
              value={`${formatInteger(
                history.data.reduce((sum, slip) => sum + slip.totalQuantity, 0),
              )} kiện`}
              detail="Đã cộng vào tồn kho cửa hàng"
            />
            <StatCard
              label="Tổng khối lượng"
              value={formatKg(
                history.data.reduce((sum, slip) => sum + Number(slip.totalWeightKg), 0),
              )}
              detail="Tổng kg đã nhận từ đối tác"
              tone="success"
            />
          </div>
        ) : null}
        <div className="responsive-table">
          <table>
            <thead>
              <tr>
                <th>Phiếu</th>
                <th>Đối tác</th>
                <th>Mặt hàng</th>
                <th>Số kiện</th>
                <th>Khối lượng</th>
              </tr>
            </thead>
            <tbody>
              {(history.data ?? []).map((slip) => (
                <tr key={slip.id}>
                  <td data-label="Phiếu">
                    <strong>{slip.referenceCode}</strong>
                    <small>
                      {new Date(slip.receivedAt).toLocaleString('vi-VN', {
                        timeZone: 'Asia/Ho_Chi_Minh',
                      })}
                    </small>
                  </td>
                  <td data-label="Đối tác">
                    {slip.partnerName}
                    {slip.note ? <small>{slip.note}</small> : null}
                  </td>
                  <td data-label="Mặt hàng">
                    {slip.lines.map((line) => (
                      <div key={line.productId}>
                        {productName(line.productId)} · {formatInteger(line.quantity)} kiện
                      </div>
                    ))}
                  </td>
                  <td data-label="Số kiện">{formatInteger(slip.totalQuantity)} kiện</td>
                  <td data-label="Khối lượng">{formatKg(Number(slip.totalWeightKg))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
