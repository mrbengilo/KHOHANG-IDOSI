import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Store, StoreSortedStock } from '@idosi/contracts';
import { useMemo, useRef, useState } from 'react';

import { BagWeightsInput } from '../../components/BagWeightsInput';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ApiClientError } from '../../lib/api';
import { checkBagWeights } from '../../lib/bag-weights';
import { formatKgExact } from '../../lib/format';
import type { Role } from '../../lib/types';
import { listStoreSortedStocks } from '../inventory/inventoryApi';
import {
  cancelSortedSaleTransfer,
  createSortedSaleTransfer,
  listSortedSaleTransfers,
  receiveSortedSaleTransfer,
} from './sortedSaleApi';

function grams(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0') || '0');
}

function kilograms(value: bigint): string {
  return `${value / 1000n}.${String(value % 1000n).padStart(3, '0')}`;
}

export interface SaleProductBalance {
  readonly productId: string;
  readonly saleWeightKg: string;
}

/** Sale is transferred per product, from every sorted lot of that product. */
export function saleBalancesByProduct(
  stocks: readonly StoreSortedStock[],
  storeId: string,
): SaleProductBalance[] {
  const totals = new Map<string, bigint>();
  for (const stock of stocks) {
    if (stock.storeId !== storeId) continue;
    totals.set(stock.productId, (totals.get(stock.productId) ?? 0n) + grams(stock.saleWeightKg));
  }
  return [...totals]
    .filter(([, total]) => total > 0n)
    .map(([productId, total]) => ({ productId, saleWeightKg: kilograms(total) }));
}

function message(error: unknown): string {
  return error instanceof ApiClientError ? error.message : 'Không thể xử lý dữ liệu điều chuyển.';
}

export function SortedSaleTransferWorkspace({
  role,
  principalStoreId,
  destinations,
  stores,
  productNames,
}: {
  readonly role: Role;
  readonly principalStoreId: string;
  readonly destinations: readonly Store[];
  readonly stores: readonly Store[];
  readonly productNames: ReadonlyMap<string, string>;
}) {
  const queryClient = useQueryClient();
  const stocksQuery = useQuery({
    queryKey: ['store-sorted-stocks', principalStoreId],
    queryFn: () => listStoreSortedStocks(principalStoreId || undefined),
    retry: false,
  });
  const transfersQuery = useQuery({
    queryKey: ['sorted-sale-transfers'],
    queryFn: listSortedSaleTransfers,
    retry: false,
  });
  const [destinationId, setDestinationId] = useState('');
  const [productId, setProductId] = useState('');
  const [bagCount, setBagCount] = useState('');
  const [bagWeights, setBagWeights] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const mutationKeys = useRef(new Map<string, string>());
  const products = useMemo(
    () => saleBalancesByProduct(stocksQuery.data ?? [], principalStoreId),
    [stocksQuery.data, principalStoreId],
  );
  const selectedProduct =
    products.find((product) => product.productId === productId) ?? products[0];
  const productName = (id: string) => productNames.get(id) ?? id;
  const effectiveDestinationId = destinations.some((store) => store.id === destinationId)
    ? destinationId
    : (destinations[0]?.id ?? '');
  const bagCheck = checkBagWeights(bagCount, bagWeights, selectedProduct?.saleWeightKg ?? '0');
  const canCreate =
    role === 'STORE' &&
    Boolean(selectedProduct) &&
    Boolean(effectiveDestinationId) &&
    bagCheck.valid;

  const invalidate = async () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['store-sorted-stocks'] }),
      queryClient.invalidateQueries({ queryKey: ['sorted-sale-transfers'] }),
    ]);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedProduct || !effectiveDestinationId || !bagCheck.valid)
        throw new Error('Chưa chọn mặt hàng, cửa hàng nhận hoặc kg từng bao.');
      const signature = [
        selectedProduct.productId,
        effectiveDestinationId,
        bagCheck.bagWeightsKg.join(','),
        note,
      ].join(':');
      const key = mutationKeys.current.get(signature) ?? crypto.randomUUID();
      mutationKeys.current.set(signature, key);
      const result = await createSortedSaleTransfer(
        {
          sourceStoreId: principalStoreId,
          destinationStoreId: effectiveDestinationId,
          productId: selectedProduct.productId,
          bagWeightsKg: bagCheck.bagWeightsKg,
          note: note.trim() || null,
        },
        key,
      );
      mutationKeys.current.delete(signature);
      return result;
    },
    onError: (error) => setNotice({ tone: 'error', text: message(error) }),
    onSuccess: async (transfer) => {
      setNotice({
        tone: 'success',
        text: `Đã điều chuyển ${transfer.bagQuantity} bao ${productName(transfer.productId)} (${formatKgExact(transfer.weightKg)}) theo phiếu ${transfer.transferNumber}.`,
      });
      setBagCount('');
      setBagWeights([]);
      setNote('');
      await invalidate();
    },
  });

  const receiveMutation = useMutation({
    mutationFn: async ({ id, version }: { id: string; version: number }) =>
      receiveSortedSaleTransfer(id, { expectedVersion: version }, crypto.randomUUID()),
    onError: (error) => setNotice({ tone: 'error', text: message(error) }),
    onSuccess: async (transfer) => {
      setNotice({
        tone: 'success',
        text: `Đã nhận phiếu ${transfer.transferNumber}; tồn Sale cửa hàng nhận đã tăng.`,
      });
      await invalidate();
    },
  });

  const [cancelReasons, setCancelReasons] = useState<Record<string, string>>({});
  const cancelMutation = useMutation({
    mutationFn: async ({ id, version }: { id: string; version: number }) => {
      const reason = (cancelReasons[id] ?? '').trim();
      if (reason.length < 3) throw new Error('Ghi lý do hủy phiếu tối thiểu 3 ký tự.');
      const signature = `cancel:${id}:${version}`;
      const key = mutationKeys.current.get(signature) ?? crypto.randomUUID();
      mutationKeys.current.set(signature, key);
      return cancelSortedSaleTransfer(id, { expectedVersion: version, reason }, key);
    },
    onError: (error) =>
      setNotice({
        tone: 'error',
        text:
          error instanceof Error && !(error instanceof ApiClientError)
            ? error.message
            : message(error),
      }),
    onSuccess: async (transfer) => {
      setNotice({
        tone: 'success',
        text: `Đã hủy phiếu ${transfer.transferNumber}; ${formatKgExact(transfer.weightKg)} đã trở lại tồn Sale của cửa hàng.`,
      });
      await invalidate();
    },
  });

  const loadError = stocksQuery.error ?? transfersQuery.error;
  const saleOverview = [...new Set((stocksQuery.data ?? []).map((stock) => stock.storeId))].flatMap(
    (storeId) =>
      saleBalancesByProduct(stocksQuery.data ?? [], storeId).map((item) => ({ ...item, storeId })),
  );
  const storeName = (id: string) => {
    const store = stores.find((item) => item.id === id);
    return store ? `${store.code} · ${store.name}` : id;
  };

  return (
    <>
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
          <strong>Không thể tải tồn Sale hoặc phiếu điều chuyển</strong>
          <p>{message(loadError)}</p>
          <Button
            tone="secondary"
            onClick={() => void Promise.all([stocksQuery.refetch(), transfersQuery.refetch()])}
          >
            Thử lại
          </Button>
        </section>
      ) : null}
      {role === 'STORE' ? (
        <section className="panel transfer-create">
          <div className="section-heading section-heading--compact">
            <div>
              <h2>Điều chuyển từ Sale sau lọc</h2>
              <p>
                Chọn mặt hàng, nhập số bao và kg từng bao. Tồn Sale nguồn giảm ngay khi bấm Điều
                chuyển; cửa hàng nhận xác nhận trước khi được cộng tồn.
              </p>
            </div>
          </div>
          <div className="transfer-create__grid">
            <label>
              Cửa hàng nhận
              <select
                value={effectiveDestinationId}
                onChange={(event) => setDestinationId(event.target.value)}
              >
                {destinations.length === 0 ? (
                  <option value="">Không có cửa hàng nhận</option>
                ) : null}
                {destinations.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.code} · {store.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Mặt hàng Sale sau lọc
              <select
                value={selectedProduct?.productId ?? ''}
                onChange={(event) => setProductId(event.target.value)}
              >
                {products.length === 0 ? <option value="">Chưa có tồn Sale sau lọc</option> : null}
                {products.map((product) => (
                  <option key={product.productId} value={product.productId}>
                    {productName(product.productId)} · {formatKgExact(product.saleWeightKg)}
                  </option>
                ))}
              </select>
              <small>
                {selectedProduct
                  ? `Sale khả dụng: ${formatKgExact(selectedProduct.saleWeightKg)}`
                  : 'Chưa có mặt hàng Sale để điều chuyển'}
              </small>
            </label>
            <label className="transfer-create__note">
              Ghi chú
              <input
                maxLength={500}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Không bắt buộc"
              />
            </label>
          </div>
          {selectedProduct ? (
            <BagWeightsInput
              idPrefix="sale-transfer"
              productName={productName(selectedProduct.productId)}
              availableKg={selectedProduct.saleWeightKg}
              count={bagCount}
              weights={bagWeights}
              check={bagCheck}
              onChange={(count, weights) => {
                setBagCount(count);
                setBagWeights(weights);
              }}
            />
          ) : null}
          <Button
            busy={createMutation.isPending}
            disabled={!canCreate || createMutation.isPending}
            onClick={() => {
              setNotice(null);
              createMutation.mutate();
            }}
          >
            Điều chuyển
          </Button>
        </section>
      ) : null}
      <section className="panel transfer-list">
        <div className="section-heading section-heading--compact">
          <div>
            <h2>Tồn Sale sau lọc</h2>
            <p>Khối lượng Sale hiện còn theo cửa hàng và mặt hàng.</p>
          </div>
        </div>
        {saleOverview.length === 0 ? (
          <EmptyState
            title="Chưa có tồn Sale"
            detail="Sau khi lọc, đưa hàng vào Sale để bán hoặc điều chuyển."
          />
        ) : (
          <div className="transfer-card-grid">
            {saleOverview.map((item) => (
              <article className="transfer-card" key={`${item.storeId}:${item.productId}`}>
                <strong>{storeName(item.storeId)}</strong>
                <p>
                  {productName(item.productId)} · {formatKgExact(item.saleWeightKg)}
                </p>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="panel transfer-list">
        <div className="section-heading section-heading--compact">
          <div>
            <h2>Phiếu điều chuyển Sale</h2>
            <p>{transfersQuery.data?.length ?? 0} phiếu trong phạm vi hiện tại.</p>
          </div>
        </div>
        {(transfersQuery.data ?? []).length === 0 ? (
          <EmptyState
            title="Chưa có phiếu điều chuyển Sale"
            detail="Chọn cửa hàng nhận, mặt hàng, số bao và kg từng bao để điều chuyển."
          />
        ) : (
          <div className="transfer-card-grid">
            {(transfersQuery.data ?? []).map((transfer) => (
              <article className="transfer-card" key={transfer.id}>
                <header>
                  <strong>{transfer.transferNumber}</strong>
                  <span>
                    {transfer.status === 'RECEIVED'
                      ? 'Đã nhận'
                      : transfer.status === 'CANCELLED'
                        ? 'Đã hủy'
                        : 'Đang vận chuyển'}
                  </span>
                </header>
                <p>
                  {storeName(transfer.sourceStoreId)} → {storeName(transfer.destinationStoreId)}
                </p>
                <p>
                  {productName(transfer.productId)} · {transfer.bagQuantity} bao ·{' '}
                  {formatKgExact(transfer.weightKg)}
                </p>
                {transfer.bagWeightsKg.length > 0 ? (
                  <ul className="transfer-card__bags" aria-label="Khối lượng từng bao">
                    {transfer.bagWeightsKg.map((weight, index) => (
                      <li key={index}>
                        Bao {index + 1} · {productName(transfer.productId)} ·{' '}
                        {formatKgExact(weight)}
                      </li>
                    ))}
                  </ul>
                ) : transfer.enteredWeightKg === null ? (
                  <small>Kg tính theo tỷ lệ số bao</small>
                ) : null}
                {transfer.note ? <p>{transfer.note}</p> : null}
                {role === 'STORE' &&
                transfer.destinationStoreId === principalStoreId &&
                transfer.status === 'IN_TRANSIT' ? (
                  <Button
                    busy={
                      receiveMutation.isPending && receiveMutation.variables?.id === transfer.id
                    }
                    disabled={receiveMutation.isPending}
                    onClick={() =>
                      receiveMutation.mutate({ id: transfer.id, version: transfer.version })
                    }
                  >
                    Xác nhận đã nhận
                  </Button>
                ) : null}
                {transfer.status === 'CANCELLED' && transfer.cancellationReason ? (
                  <small>Lý do hủy: {transfer.cancellationReason}</small>
                ) : null}
                {role === 'STORE' &&
                transfer.sourceStoreId === principalStoreId &&
                transfer.status === 'IN_TRANSIT' ? (
                  <div className="transfer-card__cancel">
                    <input
                      aria-label={`Lý do hủy phiếu ${transfer.transferNumber}`}
                      maxLength={500}
                      placeholder="Lý do hủy, ví dụ: chọn nhầm cửa hàng"
                      value={cancelReasons[transfer.id] ?? ''}
                      disabled={cancelMutation.isPending}
                      onChange={(event) =>
                        setCancelReasons((current) => ({
                          ...current,
                          [transfer.id]: event.target.value,
                        }))
                      }
                    />
                    <Button
                      tone="danger"
                      busy={
                        cancelMutation.isPending && cancelMutation.variables?.id === transfer.id
                      }
                      disabled={cancelMutation.isPending}
                      onClick={() =>
                        cancelMutation.mutate({ id: transfer.id, version: transfer.version })
                      }
                    >
                      Hủy phiếu, trả Sale về cửa hàng
                    </Button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
