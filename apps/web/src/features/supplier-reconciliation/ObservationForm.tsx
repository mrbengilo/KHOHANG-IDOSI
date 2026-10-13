import type { SupplierObservationPreview, SupplierObservationRequest } from '@idosi/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ApiClientError } from '../../lib/api';
import { formatDocumentTime } from '../../lib/business-time';
import { formatInteger } from '../../lib/format';
import { retainIdempotencyForExactRetry, type RetryAttempt } from '../../lib/idempotency-retry';
import {
  STATE_LABEL,
  STATE_TONE,
  freeChangeSentence,
  fromBusinessLocalInput,
  parseBags,
  toBusinessLocalInput,
} from './model';
import {
  SUPPLIER_QUERY_ROOTS,
  confirmSupplierObservation,
  previewSupplierObservation,
} from './supplierApi';

export interface ObservationTarget {
  readonly productId: string;
  /** The source the SKU is mapped to; one observation covers one source. */
  readonly sourceId: string;
  readonly sourceCode: string;
  readonly sku: string;
  readonly productName: string;
  readonly baselineQuantity: number | null;
}

const EVENT_LABEL = {
  ORDER: 'Đơn Reshare đã nhận',
  ORDER_CANCEL: 'Reshare hủy đơn',
  SOURCE_RETURN: 'Reshare hoàn lượng đặt được',
} as const;

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.code !== 'NETWORK_ERROR' && error.status < 500) {
    if (error.code === 'VERSION_CONFLICT') {
      return 'Số liệu vừa thay đổi (giữ hàng, phân bổ hoặc đơn Reshare mới). Bấm "Xem trước" lại rồi kiểm tra trước khi lưu.';
    }
    return error.message;
  }
  return 'Không gửi được yêu cầu. Kiểm tra mạng rồi bấm lại: cùng thao tác sẽ không bị ghi hai lần.';
}

/**
 * C enters the TOTAL orderable stock seen at Reshare for each chosen SKU. The server computes
 * everything else; this form only shows the preview and the explicit coverage answers.
 */
export function ObservationForm({
  sourceId,
  targets,
  onCancel,
  onDone,
}: {
  readonly sourceId: string;
  readonly targets: readonly ObservationTarget[];
  readonly onCancel: () => void;
  readonly onDone: (message: string) => void;
}) {
  const client = useQueryClient();
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [observedAt, setObservedAt] = useState(() => toBusinessLocalInput(new Date()));
  const [note, setNote] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('');
  const [coverage, setCoverage] = useState<Record<string, boolean>>({});
  const [attest, setAttest] = useState(false);
  /** RE line → bags the person states the entered total already deducted. */
  const [reflected, setReflected] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<SupplierObservationPreview | null>(null);
  const [previewStale, setPreviewStale] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'confirm' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<RetryAttempt | null>(null);

  const changed = () => {
    setPreviewStale(true);
    setError(null);
  };

  const buildRequest = (): SupplierObservationRequest | string => {
    const iso = fromBusinessLocalInput(observedAt);
    if (!iso) return 'Nhập thời điểm xem tồn Reshare (giờ Việt Nam).';
    const lines = [];
    for (const target of targets) {
      const value = parseBags(quantities[target.productId] ?? '');
      if (value === null) {
        return `${target.sku}: nhập tổng số bao Reshare đang cho đặt (số nguyên, có thể là 0).`;
      }
      lines.push({ productId: target.productId, observedQuantity: value });
    }
    const reshareCoverage = [];
    for (const [reshareOrderLineId, value] of Object.entries(reflected)) {
      if (value.trim() === '') continue;
      const quantity = parseBags(value);
      if (quantity === null) return 'Số bao đơn RE đã trừ phải là số nguyên không âm.';
      if (quantity > 0) reshareCoverage.push({ reshareOrderLineId, quantity });
    }
    return {
      sourceId,
      observedAt: iso,
      lines,
      reshareCoverage,
      eventCoverage: Object.entries(coverage).map(([eventId, included]) => ({ eventId, included })),
      attestUnlinkedAsNotOrdered: attest,
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(evidenceRef.trim() ? { evidenceRef: evidenceRef.trim() } : {}),
    };
  };

  const runPreview = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    const input = buildRequest();
    if (typeof input === 'string') {
      setError(input);
      return;
    }
    setBusy('preview');
    setError(null);
    try {
      setPreview(await previewSupplierObservation(input));
      setPreviewStale(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (busy || !preview || previewStale) return;
    const input = buildRequest();
    if (typeof input === 'string') {
      setError(input);
      return;
    }
    const payload = { ...input, expectedRevision: preview.revision };
    attempt.current = retainIdempotencyForExactRetry(attempt.current, JSON.stringify(payload));
    setBusy('confirm');
    setError(null);
    try {
      const saved = await confirmSupplierObservation(payload, attempt.current.key);
      attempt.current = null;
      const beforeBySku = new Map(
        preview.lines.map((line) => [line.productId, line.before.ledgerAvailable]),
      );
      await Promise.all(
        SUPPLIER_QUERY_ROOTS.map((root) => client.invalidateQueries({ queryKey: [root] })),
      );
      onDone(
        `Đã lưu cập nhật tồn lúc ${formatDocumentTime(saved.observedAt)}. ${saved.lines
          .map((line) =>
            freeChangeSentence(line.sku, beforeBySku.get(line.productId) ?? 0, line.freeQuantity),
          )
          .join(' ')}`,
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const undecided =
    preview?.lines.reduce((total, line) => total + line.undecidedEventCount, 0) ?? 0;
  const needsAttestation = preview?.lines.some((line) => line.unlinkedLegacyQuantity > 0) ?? false;
  const canConfirm =
    preview !== null &&
    !previewStale &&
    undecided === 0 &&
    (!needsAttestation || attest) &&
    !preview.blockingIssues.includes('VERSION_CONFLICT');

  return (
    <form
      className="panel supplier-observation"
      noValidate
      onSubmit={(event) => void runPreview(event)}
    >
      <h2>Cập nhật tổng tồn Reshare</h2>
      <p className="supplier-hint">
        Nhập <strong>tổng số bao hiện có thể đặt trên Reshare</strong>, không phải số nhập thêm. Sau
        khi xem trước, đánh dấu các đơn RE mà số tồn này đã trừ; hệ thống tự tính phần còn phân bổ
        được và không trừ một đơn hai lần.
      </p>
      <fieldset className="supplier-observation__meta" disabled={busy !== null}>
        <label>
          Thời điểm xem tồn Reshare (giờ Việt Nam)
          <input
            onChange={(event) => {
              setObservedAt(event.target.value);
              changed();
            }}
            required
            step={1}
            type="datetime-local"
            value={observedAt}
          />
        </label>
        <label>
          Chứng từ / ảnh chụp (tùy chọn)
          <input
            maxLength={200}
            onChange={(event) => {
              setEvidenceRef(event.target.value);
              changed();
            }}
            value={evidenceRef}
          />
        </label>
        <label className="supplier-observation__note">
          Ghi chú (tùy chọn)
          <input
            maxLength={500}
            onChange={(event) => {
              setNote(event.target.value);
              changed();
            }}
            value={note}
          />
        </label>
      </fieldset>
      <div className="responsive-table supplier-table-scroll">
        <table className="supplier-table">
          <thead>
            <tr>
              <th scope="col">Mặt hàng</th>
              <th scope="col">Số đối chiếu trước</th>
              <th scope="col">Tổng Reshare đang cho đặt</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((target) => (
              <tr key={target.productId}>
                <td data-label="Mặt hàng">
                  <strong>{target.productName}</strong>
                  <small>{target.sku}</small>
                </td>
                <td data-label="Số đối chiếu trước">
                  {target.baselineQuantity === null
                    ? 'Chưa có'
                    : `${formatInteger(target.baselineQuantity)} bao`}
                </td>
                <td data-label="Tổng Reshare đang cho đặt">
                  <input
                    aria-label={`Tổng số bao Reshare đang cho đặt của ${target.sku}`}
                    className="supplier-quantity-input"
                    disabled={busy !== null}
                    inputMode="numeric"
                    min={0}
                    onChange={(event) => {
                      setQuantities((current) => ({
                        ...current,
                        [target.productId]: event.target.value,
                      }));
                      changed();
                    }}
                    type="number"
                    value={quantities[target.productId] ?? ''}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="button-row supplier-actions">
        <Button busy={busy === 'preview'} disabled={busy === 'confirm'} type="submit">
          {preview ? 'Xem trước lại' : 'Xem trước'}
        </Button>
        <Button disabled={busy !== null} onClick={onCancel} tone="secondary">
          Đóng
        </Button>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {preview ? (
        <section aria-label="Xem trước đối chiếu" className="supplier-preview">
          {previewStale ? (
            <p className="inline-notice" role="status">
              Bạn đã sửa thông tin sau lần xem trước. Bấm “Xem trước lại” trước khi lưu.
            </p>
          ) : null}
          {preview.lines.map((line) => (
            <article className="supplier-preview__line" key={line.productId}>
              <header>
                <h3>
                  {line.productName} <small>{line.sku}</small>
                </h3>
                <Badge tone={STATE_TONE[line.after.state]}>{STATE_LABEL[line.after.state]}</Badge>
              </header>
              <dl className="supplier-figures">
                <div>
                  <dt>Reshare cho đặt (S)</dt>
                  <dd>{formatInteger(line.observedQuantity)}</dd>
                </div>
                <div>
                  <dt>Biến động sau lúc xem</dt>
                  <dd>{formatInteger(line.after.pendingDelta)}</dd>
                </div>
                <div>
                  <dt>Giữ ưu tiên chưa đặt</dt>
                  <dd>{formatInteger(line.after.offerHoldQuantity)}</dd>
                </div>
                <div>
                  <dt>Đã cấp, đang giữ chưa đặt</dt>
                  <dd>{formatInteger(line.after.unorderedReservedQuantity)}</dd>
                </div>
                <div>
                  <dt>Đơn RE số tồn chưa trừ</dt>
                  <dd>{formatInteger(line.after.issuedUnreflectedQuantity ?? 0)}</dd>
                </div>
                <div>
                  <dt>Khả dụng hiện tại → sau</dt>
                  <dd>
                    {formatInteger(line.before.ledgerAvailable)} →{' '}
                    {formatInteger(line.after.freeQuantity)}
                  </dd>
                </div>
                <div className={line.after.shortfallQuantity > 0 ? 'is-danger' : undefined}>
                  <dt>Thiếu nguồn</dt>
                  <dd>{formatInteger(line.after.shortfallQuantity)}</dd>
                </div>
              </dl>
              {line.unlinkedLegacyQuantity > 0 ? (
                <p className="inline-notice" role="note">
                  {formatInteger(line.unlinkedLegacyQuantity)} bao đang giữ từ trước khi bật đối
                  chiếu chưa có đơn Reshare. Nếu đã đặt Reshare, ghi nhận đơn trước ở mục “Đơn ghi
                  nhận thủ công”.
                </p>
              ) : null}
              {(line.issuedOrders ?? []).length > 0 ? (
                <fieldset
                  className="supplier-coverage supplier-reshare-coverage"
                  disabled={busy !== null}
                >
                  <legend>Số tồn này đã trừ các đơn RE nào?</legend>
                  <p className="supplier-hint">
                    Đánh dấu đơn đã đặt trên Reshare trước lúc xem tồn (số tồn đã giảm theo đơn đó).
                    Đơn chưa đặt thì để trống: hệ thống vẫn giữ phần đó, không cấp trùng.
                  </p>
                  <ul>
                    {(line.issuedOrders ?? []).map((order) => {
                      const value = reflected[order.lineId] ?? '';
                      const checked = value !== '' && Number(value) > 0;
                      return (
                        <li key={order.lineId}>
                          <span>
                            <strong>
                              {order.code} · {formatInteger(order.unreflectedQuantity)} bao chưa trừ
                            </strong>
                            <small>
                              {order.storeName} · lập lúc {formatDocumentTime(order.orderedAt)}
                            </small>
                          </span>
                          {order.afterObservation ? (
                            <small>Lập sau lúc xem tồn: số tồn chưa thể trừ đơn này.</small>
                          ) : (
                            <span className="supplier-coverage__choice">
                              <label>
                                <input
                                  checked={checked}
                                  onChange={(event) => {
                                    setReflected((current) => ({
                                      ...current,
                                      [order.lineId]: event.target.checked
                                        ? String(order.unreflectedQuantity)
                                        : '',
                                    }));
                                    changed();
                                  }}
                                  type="checkbox"
                                />
                                Đã trừ trong số vừa nhập
                              </label>
                              {checked ? (
                                <label>
                                  Số bao đã trừ
                                  <input
                                    aria-label={`Số bao của ${order.code} đã trừ trong số tồn`}
                                    className="supplier-quantity-input"
                                    inputMode="numeric"
                                    max={order.unreflectedQuantity}
                                    min={1}
                                    onChange={(event) => {
                                      setReflected((current) => ({
                                        ...current,
                                        [order.lineId]: event.target.value,
                                      }));
                                      changed();
                                    }}
                                    type="number"
                                    value={value}
                                  />
                                </label>
                              ) : null}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              ) : null}
              {line.events.length > 0 ? (
                <fieldset className="supplier-coverage" disabled={busy !== null}>
                  <legend>Biến động Reshare đã ghi nhận chưa nằm trong số đối chiếu trước</legend>
                  <ul>
                    {line.events.map((event) => (
                      <li key={event.id}>
                        <span>
                          <strong>
                            {EVENT_LABEL[event.kind]} {formatInteger(event.quantity)} bao
                          </strong>
                          <small>
                            {event.externalRef} · dòng {event.externalLineRef} · lúc{' '}
                            {formatDocumentTime(event.occurredAt)}
                          </small>
                        </span>
                        {event.decision === 'AFTER_OBSERVATION' ? (
                          <small>Xảy ra sau lúc xem tồn: tự tính riêng.</small>
                        ) : (
                          <span className="supplier-coverage__choice" role="radiogroup">
                            <label>
                              <input
                                checked={coverage[event.id] === true}
                                name={`coverage-${event.id}`}
                                onChange={() => {
                                  setCoverage((current) => ({ ...current, [event.id]: true }));
                                  changed();
                                }}
                                type="radio"
                              />
                              Đã gồm trong số vừa nhập
                            </label>
                            <label>
                              <input
                                checked={coverage[event.id] === false}
                                name={`coverage-${event.id}`}
                                onChange={() => {
                                  setCoverage((current) => ({ ...current, [event.id]: false }));
                                  changed();
                                }}
                                type="radio"
                              />
                              Chưa gồm
                            </label>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </fieldset>
              ) : null}
            </article>
          ))}
          {needsAttestation ? (
            <label className="supplier-attest">
              <input
                checked={attest}
                disabled={busy !== null}
                onChange={(event) => {
                  setAttest(event.target.checked);
                  changed();
                }}
                type="checkbox"
              />
              Tôi xác nhận các lượng giữ trước khi bật đối chiếu chưa có đơn Reshare là{' '}
              <strong>chưa đặt</strong>.
            </label>
          ) : null}
          {undecided > 0 ? (
            <p className="form-error" role="alert">
              Còn {undecided} biến động chưa trả lời “đã gồm / chưa gồm”.
            </p>
          ) : null}
          <div className="button-row supplier-actions">
            <Button
              busy={busy === 'confirm'}
              disabled={!canConfirm || busy === 'preview'}
              onClick={() => void confirm()}
              tone="success"
            >
              Lưu cập nhật tồn
            </Button>
          </div>
        </section>
      ) : null}
    </form>
  );
}
