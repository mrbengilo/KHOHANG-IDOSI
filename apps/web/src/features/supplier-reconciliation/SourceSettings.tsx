import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState, type FormEvent } from 'react';

import { Button } from '../../components/Button';
import { ApiClientError, listCatalog } from '../../lib/api';
import { formatInteger } from '../../lib/format';
import { retainIdempotencyForExactRetry, type RetryAttempt } from '../../lib/idempotency-retry';
import {
  SUPPLIER_QUERY_ROOTS,
  addSupplierSourceProducts,
  createSupplierSource,
  loadSupplierReconciliation,
  loadSupplierSources,
} from './supplierApi';

function errorText(error: unknown): string {
  return error instanceof ApiClientError
    ? error.message
    : 'Không gửi được yêu cầu. Kiểm tra mạng rồi bấm lại.';
}

/**
 * Admin/HTKD configuration: one Reshare source and the products it supplies (identified by id,
 * shown by name only). A product put here stops accepting cumulative inbound slips and manual
 * adjustments, and waits for its first count.
 */
export function SourceSettings({ accountId }: { readonly accountId: string }) {
  const client = useQueryClient();
  const sources = useQuery({
    queryKey: ['supplier-sources', accountId],
    queryFn: ({ signal }) => loadSupplierSources(signal),
    retry: false,
  });
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: listCatalog, retry: false });
  const mapped = useQuery({
    queryKey: ['supplier-reconciliation', accountId, 'settings'],
    queryFn: ({ signal }) =>
      loadSupplierReconciliation({ page: 1, search: '', filter: 'ALL' }, signal).then(
        async (first) => {
          // The mapped set is bounded by the catalogue; read every page to mark checkboxes.
          const rows = [...first.data];
          for (let page = 2; page <= first.pagination.totalPages; page += 1) {
            rows.push(
              ...(await loadSupplierReconciliation({ page, search: '', filter: 'ALL' })).data,
            );
          }
          return rows;
        },
      ),
    retry: false,
  });
  const [code, setCode] = useState('RESHARE');
  const [name, setName] = useState('Kho Reshare');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [chosenSourceId, setChosenSourceId] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const attempt = useRef<RetryAttempt | null>(null);
  const source =
    sources.data?.find((candidate) => candidate.id === chosenSourceId) ?? sources.data?.[0];
  const mappedSource = useMemo(
    () => new Map((mapped.data ?? []).map((row) => [row.productId, row.sourceCode])),
    [mapped.data],
  );
  const products = (catalog.data ?? []).filter((product) => product.status === 'ACTIVE');

  const refresh = () =>
    Promise.all(SUPPLIER_QUERY_ROOTS.map((root) => client.invalidateQueries({ queryKey: [root] })));

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const payload = { code: code.trim().toUpperCase(), name: name.trim() };
    attempt.current = retainIdempotencyForExactRetry(attempt.current, JSON.stringify(payload));
    setBusy(true);
    setMessage(null);
    try {
      await createSupplierSource(payload, attempt.current.key);
      attempt.current = null;
      setCreating(false);
      setMessage({ error: false, text: `Đã tạo nguồn ${payload.code}.` });
      await refresh();
    } catch (caught) {
      setMessage({ error: true, text: errorText(caught) });
    } finally {
      setBusy(false);
    }
  };

  const map = async () => {
    if (busy || !source || picked.size === 0) return;
    const productIds = [...picked].sort();
    attempt.current = retainIdempotencyForExactRetry(
      attempt.current,
      JSON.stringify({ source: source.id, productIds }),
    );
    setBusy(true);
    setMessage(null);
    try {
      const result = await addSupplierSourceProducts(source.id, productIds, attempt.current.key);
      attempt.current = null;
      setPicked(new Set());
      setMessage({
        error: false,
        text: `Đã đưa ${formatInteger(result.added.length)} mặt hàng vào đối chiếu Reshare. Nhập số tồn Reshare đầu tiên ở tab “Đối chiếu tồn” trước khi phân bổ lại các mặt hàng này.`,
      });
      await refresh();
    } catch (caught) {
      setMessage({ error: true, text: errorText(caught) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel supplier-settings" aria-label="Cấu hình nguồn Reshare">
      <h2>Cấu hình nguồn Reshare</h2>
      {message ? (
        <p
          className={message.error ? 'form-error' : 'inline-notice'}
          role={message.error ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      ) : null}
      {sources.isPending ? (
        <p role="status">Đang tải nguồn…</p>
      ) : sources.isError ? (
        <div role="alert" className="supplier-error">
          <p>Không tải được nguồn Reshare.</p>
          <Button tone="secondary" onClick={() => void sources.refetch()}>
            Thử lại
          </Button>
        </div>
      ) : !source || creating ? (
        <form
          className="supplier-settings__create"
          noValidate
          onSubmit={(event) => void create(event)}
        >
          <fieldset disabled={busy}>
            <label>
              Mã nguồn
              <input
                maxLength={40}
                onChange={(event) => setCode(event.target.value)}
                value={code}
              />
            </label>
            <label>
              Tên nguồn
              <input
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </label>
            <Button busy={busy} type="submit">
              Tạo nguồn Reshare
            </Button>
          </fieldset>
        </form>
      ) : (
        <>
          <div className="supplier-filters">
            {(sources.data?.length ?? 0) > 1 ? (
              <label>
                Nguồn đang cấu hình
                <select
                  onChange={(event) => {
                    setChosenSourceId(event.target.value);
                    setPicked(new Set());
                  }}
                  value={source.id}
                >
                  {sources.data?.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.code} — {candidate.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Button onClick={() => setCreating(true)} tone="secondary">
              Tạo nguồn khác
            </Button>
          </div>
          <p>
            Nguồn <strong>{source.code}</strong> — {source.name}:{' '}
            {formatInteger(source.productCount)} mặt hàng đang đối chiếu.
          </p>
          <p className="supplier-hint">
            Mặt hàng đưa vào đây sẽ không nhận phiếu nhập cộng dồn hoặc điều chỉnh tồn thủ công, và
            tạm dừng cấp mới cho tới khi có số tồn Reshare đầu tiên. Một mặt hàng chỉ thuộc một
            nguồn; việc này không hoàn tác từ màn hình.
          </p>
          {catalog.isPending || mapped.isPending ? (
            <p role="status">Đang tải mặt hàng…</p>
          ) : catalog.isError || mapped.isError ? (
            <p role="alert">Không tải được danh mục mặt hàng.</p>
          ) : (
            <fieldset className="supplier-settings__products" disabled={busy}>
              <legend>Chọn mặt hàng lấy từ Reshare</legend>
              <ul>
                {products.map((product) => {
                  const mappedTo = mappedSource.get(product.id);
                  const already = mappedTo !== undefined;
                  return (
                    <li key={product.id}>
                      <label>
                        <input
                          checked={already || picked.has(product.id)}
                          disabled={already}
                          onChange={(event) =>
                            setPicked((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(product.id);
                              else next.delete(product.id);
                              return next;
                            })
                          }
                          type="checkbox"
                        />
                        <span>
                          {product.name}
                          <small>
                            {already ? `Đang đối chiếu · nguồn ${mappedTo}` : 'Chưa đối chiếu'}
                          </small>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <Button busy={busy} disabled={picked.size === 0} onClick={() => void map()}>
                Đưa {picked.size > 0 ? `${picked.size} mặt hàng` : 'mặt hàng'} vào đối chiếu
              </Button>
            </fieldset>
          )}
        </>
      )}
    </section>
  );
}
