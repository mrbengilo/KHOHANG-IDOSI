import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Store } from '@idosi/contracts';
import { useMemo, useRef, useState } from 'react';

import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ApiClientError } from '../../lib/api';
import { formatKg } from '../../lib/format';
import type { Role } from '../../lib/types';
import { listStoreSortedStocks } from '../inventory/inventoryApi';
import {
  createSortedSaleTransfer,
  listSortedSaleTransfers,
  receiveSortedSaleTransfer,
} from './sortedSaleApi';

const kilogramsPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/;

function grams(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0') || '0');
}

export function validSortedSaleTransfer(
  quantity: string,
  weightKg: string,
  availableBags: number,
  availableKg: string,
): boolean {
  if (!/^[1-9]\d*$/.test(quantity) || !Number.isSafeInteger(Number(quantity))) return false;
  const bags = Number(quantity);
  if (bags > availableBags) return false;
  if (!weightKg.trim()) return (grams(availableKg) * BigInt(bags)) / BigInt(availableBags) > 0n;
  if (!kilogramsPattern.test(weightKg)) return false;
  const entered = grams(weightKg);
  return (
    entered > 0n &&
    entered <= grams(availableKg) &&
    (bags === availableBags ? entered === grams(availableKg) : entered < grams(availableKg))
  );
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
  const [stockId, setStockId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const mutationKeys = useRef(new Map<string, string>());
  const sourceStocks = useMemo(
    () =>
      (stocksQuery.data ?? []).filter(
        (stock) => stock.storeId === principalStoreId && stock.bagQuantity > 0,
      ),
    [stocksQuery.data, principalStoreId],
  );
  const effectiveStockId = sourceStocks.some((stock) => stock.id === stockId)
    ? stockId
    : (sourceStocks[0]?.id ?? '');
  const selectedStock = sourceStocks.find((stock) => stock.id === effectiveStockId);
  const effectiveDestinationId = destinations.some((store) => store.id === destinationId)
    ? destinationId
    : (destinations[0]?.id ?? '');
  const canCreate =
    role === 'STORE' &&
    Boolean(selectedStock) &&
    Boolean(effectiveDestinationId) &&
    validSortedSaleTransfer(
      quantity,
      weightKg,
      selectedStock?.bagQuantity ?? 0,
      selectedStock?.saleWeightKg ?? '0',
    );

  const invalidate = async () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['store-sorted-stocks'] }),
      queryClient.invalidateQueries({ queryKey: ['sorted-sale-transfers'] }),
    ]);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedStock || !effectiveDestinationId)
        throw new Error('Chưa chọn tồn Sale hoặc cửa hàng nhận.');
      const signature = [
        selectedStock.id,
        selectedStock.version,
        effectiveDestinationId,
        quantity,
        weightKg,
        note,
      ].join(':');
      const key = mutationKeys.current.get(signature) ?? crypto.randomUUID();
      mutationKeys.current.set(signature, key);
      const result = await createSortedSaleTransfer(
        {
          sourceStoreId: principalStoreId,
          destinationStoreId: effectiveDestinationId,
          sourceStockId: selectedStock.id,
          bagQuantity: Number(quantity),
          weightKg: weightKg.trim() || null,
          expectedStockVersion: selectedStock.version,
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
        text: `Đã điều chuyển ${transfer.bagQuantity} bao (${formatKg(transfer.weightKg)}) theo phiếu ${transfer.transferNumber}.`,
      });
      setQuantity('');
      setWeightKg('');
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

  const loadError = stocksQuery.error ?? transfersQuery.error;
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
                Tồn Sale nguồn giảm ngay khi bấm Điều chuyển. Cửa hàng nhận xác nhận trước khi được
                cộng tồn.
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
              <select value={effectiveStockId} onChange={(event) => setStockId(event.target.value)}>
                {sourceStocks.length === 0 ? (
                  <option value="">Chưa có tồn Sale sau lọc</option>
                ) : null}
                {sourceStocks.map((stock) => (
                  <option key={stock.id} value={stock.id}>
                    {productNames.get(stock.productId) ?? stock.productId} · {stock.bagCode} ·{' '}
                    {stock.bagQuantity} bao · {formatKg(stock.saleWeightKg)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Số lượng (bao)
              <input
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                placeholder="Ví dụ: 2"
              />
              <small>
                {selectedStock ? `Tối đa ${selectedStock.bagQuantity} bao` : 'Chọn mặt hàng trước'}
              </small>
            </label>
            <label>
              Khối lượng (kg), không bắt buộc
              <input
                inputMode="decimal"
                value={weightKg}
                onChange={(event) => setWeightKg(event.target.value)}
                placeholder="Để trống để hệ thống tính theo số bao"
              />
              <small>
                {selectedStock
                  ? `Tồn Sale: ${formatKg(selectedStock.saleWeightKg)}`
                  : 'Chọn mặt hàng trước'}
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
            <p>Số bao và khối lượng hiện còn trong phạm vi được xem.</p>
          </div>
        </div>
        {(stocksQuery.data ?? []).length === 0 ? (
          <EmptyState
            title="Chưa có tồn Sale"
            detail="Sau khi lọc, đưa hàng vào Sale để bán hoặc điều chuyển."
          />
        ) : (
          <div className="transfer-card-grid">
            {(stocksQuery.data ?? []).map((stock) => (
              <article className="transfer-card" key={stock.id}>
                <strong>{storeName(stock.storeId)}</strong>
                <p>{productNames.get(stock.productId) ?? stock.productId}</p>
                <p>
                  {stock.bagQuantity} bao · {formatKg(stock.saleWeightKg)} · v{stock.version}
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
            detail="Chọn cửa hàng nhận, mặt hàng và số bao để điều chuyển."
          />
        ) : (
          <div className="transfer-card-grid">
            {(transfersQuery.data ?? []).map((transfer) => (
              <article className="transfer-card" key={transfer.id}>
                <header>
                  <strong>{transfer.transferNumber}</strong>
                  <span>{transfer.status === 'RECEIVED' ? 'Đã nhận' : 'Đang vận chuyển'}</span>
                </header>
                <p>
                  {storeName(transfer.sourceStoreId)} → {storeName(transfer.destinationStoreId)}
                </p>
                <p>
                  {productNames.get(transfer.productId) ?? transfer.productId} ·{' '}
                  {transfer.bagQuantity} bao · {formatKg(transfer.weightKg)}
                </p>
                {transfer.enteredWeightKg === null ? (
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
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
