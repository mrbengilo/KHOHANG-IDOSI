import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateReceiptAdjustmentRequest,
  ReceiptAdjustment,
  ReceiptAdjustmentActionRequest,
  ReceiptAdjustmentCause,
  ReceiptAdjustmentContext,
  ReceiptAdjustmentContextBag,
  ReceiptAdjustmentLine,
  ReceiptMoney,
  ReceiptReturn,
  ReceiptReturnActionRequest,
} from '@idosi/contracts';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  PackageSearch,
  RotateCcw,
  Send,
  ShieldCheck,
  Truck,
  XCircle,
} from 'lucide-react';
import { useId, useRef, useState } from 'react';

import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { MoneyInput } from '../../../components/MoneyInput';
import { DashboardSkeleton } from '../../../components/Skeleton';
import { ApiClientError } from '../../../lib/api';
import { formatKg } from '../../../lib/format';
import {
  actOnReceiptAdjustment,
  actOnReceiptReturn,
  createReceiptAdjustment,
  createReceiptReturn,
  getReceiptAdjustment,
  getReceiptAdjustmentContext,
} from './adjustmentApi';
import {
  adjustmentStatusCopy,
  blockerCopy,
  causeCopy,
  causeHint,
  describeEntitlement,
  formatExactVnd,
  formatSignedVnd,
  previewAdjustment,
  returnStatusCopy,
  type AdjustmentAudience,
} from './adjustmentModel';
import './receipt-adjustments.css';

/** The workflow side, not the account role: the wholesale desk arrives here as STORE. */
type Role = AdjustmentAudience;

interface ProductOption {
  readonly id: string;
  readonly name: string;
}

interface SharedProps {
  readonly role: Role;
  readonly productNameById: ReadonlyMap<string, string>;
  readonly products: readonly ProductOption[];
}

/**
 * Retries of one command reuse its idempotency key, so a lost response can be retried safely;
 * a changed payload gets a new key. Nothing is shown as done until the server confirms it.
 */
function useCommand<TInput, TResult>(
  run: (input: TInput, idempotencyKey: string) => Promise<TResult>,
  onDone: (result: TResult) => Promise<void> | void,
) {
  const queryClient = useQueryClient();
  const keys = useRef(new Map<string, string>());
  const mutation = useMutation({
    mutationFn: ({ input, key }: { input: TInput; key: string }) => run(input, key),
    onSuccess: async (result) => onDone(result),
  });
  return {
    error: mutation.error,
    pending: mutation.isPending,
    reset: mutation.reset,
    execute: async (input: TInput): Promise<boolean> => {
      if (mutation.isPending) return false;
      const fingerprint = JSON.stringify(input);
      const key = keys.current.get(fingerprint) ?? crypto.randomUUID();
      keys.current.set(fingerprint, key);
      try {
        await mutation.mutateAsync({ input, key });
        keys.current.delete(fingerprint);
        return true;
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 409) {
          await queryClient.invalidateQueries({ queryKey: ['receipt-adjustment-context'] });
          await queryClient.invalidateQueries({ queryKey: ['receipt-adjustment'] });
        }
        return false;
      }
    },
  };
}

function useInvalidateAdjustments(receiptId: string) {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['receipt-adjustment-context', receiptId] }),
      queryClient.invalidateQueries({ queryKey: ['receipt-adjustment'] }),
      queryClient.invalidateQueries({ queryKey: ['receipt-adjustments'] }),
      queryClient.invalidateQueries({ queryKey: ['receipt-returns'] }),
      queryClient.invalidateQueries({ queryKey: ['store-receipt', receiptId] }),
      queryClient.invalidateQueries({ queryKey: ['store-receipts'] }),
      queryClient.invalidateQueries({ queryKey: ['wait-tickets'] }),
      queryClient.invalidateQueries({ queryKey: ['store-inventory-bags'] }),
      queryClient.invalidateQueries({ queryKey: ['store-bag-openings'] }),
      queryClient.invalidateQueries({ queryKey: ['store-normal-sale-pending'] }),
    ]);
  };
}

export function ReceiptAdjustmentsSection({
  focusAdjustmentId,
  receiptId,
  ...shared
}: SharedProps & { readonly receiptId: string; readonly focusAdjustmentId?: string | null }) {
  const [reporting, setReporting] = useState(false);
  const [selected, setSelected] = useState<string | null>(focusAdjustmentId ?? null);
  const [notice, setNotice] = useState('');
  const contextQuery = useQuery({
    queryFn: () => getReceiptAdjustmentContext(receiptId),
    queryKey: ['receipt-adjustment-context', receiptId],
    retry: false,
  });
  const invalidate = useInvalidateAdjustments(receiptId);
  const create = useCommand(
    (input: CreateReceiptAdjustmentRequest, key: string) => createReceiptAdjustment(input, key),
    async (adjustment) => {
      setReporting(false);
      setSelected(adjustment.id);
      setNotice(
        `Đã gửi hồ sơ ${adjustment.code}. Bao bị ảnh hưởng đang tạm giữ; tiền và quyền chờ bù chỉ có hiệu lực khi Admin duyệt.`,
      );
      await invalidate();
    },
  );
  const context = contextQuery.data;
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="adjustment-section">
      <div className="adjustment-section__heading">
        <div>
          <h3 id={headingId}>
            <PackageSearch aria-hidden="true" size={18} /> Sai lệch sau khui bao
          </h3>
          <p>
            Phiếu đã chốt không mở lại. Mỗi điều chỉnh là chứng từ riêng, liên kết bao gốc và chỉ có
            hiệu lực khi Admin áp dụng.
          </p>
        </div>
        {shared.role === 'STORE' && context && !reporting ? (
          <Button onClick={() => setReporting(true)} tone="primary">
            <AlertTriangle aria-hidden="true" size={16} /> Báo sai lệch sau khui bao
          </Button>
        ) : null}
      </div>

      {notice ? (
        <div className="receipt-notice" role="status">
          <CheckCircle2 aria-hidden="true" size={18} />
          <span>{notice}</span>
        </div>
      ) : null}

      {contextQuery.isPending ? (
        <DashboardSkeleton />
      ) : contextQuery.isError && !context ? (
        <CommandError error={contextQuery.error} onRetry={() => void contextQuery.refetch()} />
      ) : context ? (
        <>
          <MoneySummary context={context} />
          {reporting ? (
            <ReportForm
              busy={create.pending || contextQuery.isFetching}
              context={context}
              error={create.error}
              onCancel={() => {
                setReporting(false);
                create.reset();
              }}
              onSubmit={(input) => create.execute(input)}
              productNameById={shared.productNameById}
              products={shared.products}
            />
          ) : null}
          {context.adjustments.length === 0 ? (
            <p className="adjustment-empty">Chưa có hồ sơ sai lệch cho phiếu này.</p>
          ) : (
            <ul className="adjustment-list" aria-label="Hồ sơ sai lệch của phiếu">
              {context.adjustments.map((item) => {
                const copy = adjustmentStatusCopy[item.status];
                return (
                  <li key={item.id}>
                    <button
                      aria-expanded={selected === item.id}
                      className={
                        selected === item.id ? 'adjustment-card selected' : 'adjustment-card'
                      }
                      onClick={() => setSelected(selected === item.id ? null : item.id)}
                      type="button"
                    >
                      <span className="adjustment-card__identity">
                        <strong>{item.code}</strong>
                        <small>
                          {item.lineCount} bao · báo {formatDateTime(item.reportedAt)}
                        </small>
                      </span>
                      <Badge tone={copy.tone}>{copy.label}</Badge>
                      <span className="adjustment-card__meta">
                        {item.shortageQuantity > 0
                          ? `Quyền chờ bù ${item.shortageQuantity} bao`
                          : item.status === 'APPLIED' || item.status === 'PENDING_ADMIN'
                            ? 'Không phát sinh chờ bù'
                            : 'Quyền chờ bù xác định khi HTKD xác minh'}
                        {item.status === 'APPLIED' || item.status === 'PENDING_ADMIN'
                          ? ` · Tiền hàng ${formatSignedVnd(item.goodsDeltaVnd)}`
                          : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {selected ? (
            <AdjustmentDetail
              adjustmentId={selected}
              key={selected}
              onChanged={invalidate}
              receiptId={receiptId}
              {...shared}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function MoneySummary({ context }: { readonly context: ReceiptAdjustmentContext }) {
  const { original, effective } = context.summary;
  const changed = context.summary.appliedCount > 0;
  return (
    <div className="adjustment-money" aria-label="Giá trị phiếu nhận">
      <div>
        <span>Giá trị chốt gốc (gồm VAT)</span>
        <strong>{formatExactVnd(original.totalVnd)}</strong>
        <small>Giá vốn {formatExactVnd(original.costVnd)}</small>
      </div>
      <div>
        <span>Chênh lệch đã áp dụng</span>
        <strong>
          {changed ? formatSignedVnd(BigInt(effective.costVnd) - BigInt(original.costVnd)) : '0 ₫'}
        </strong>
        <small>
          {context.summary.appliedCount} điều chỉnh đã áp dụng · {context.summary.openCount} đang xử
          lý
        </small>
      </div>
      <div className="adjustment-money__effective">
        <span>Giá trị sau điều chỉnh (có hiệu lực)</span>
        <strong>{formatExactVnd(effective.totalVnd)}</strong>
        <small>Giá vốn {formatExactVnd(effective.costVnd)}</small>
      </div>
    </div>
  );
}

function bagLabel(bag: ReceiptAdjustmentContextBag, productNameById: ReadonlyMap<string, string>) {
  return `Bao ${bag.bagNumber}${bag.bagDisplayCode ? ` · ${bag.bagDisplayCode}` : ''} · ${
    productNameById.get(bag.effectiveProductId) ?? 'Mặt hàng'
  } · ${formatKg(bag.effectiveWeightKg)}`;
}

interface DraftLine {
  readonly actualProductId: string;
  readonly disposition: 'KEEP' | 'RETURN';
}

export function ReportForm({
  busy,
  context,
  error,
  initial,
  onCancel,
  onSubmit,
  productNameById,
  products,
  submitLabel = 'Gửi HTKD xác minh',
}: {
  readonly busy: boolean;
  readonly context: Pick<ReceiptAdjustmentContext, 'bags' | 'receiptId' | 'finalizedAt'>;
  readonly error: unknown;
  readonly initial?: {
    readonly reason: string;
    readonly evidenceNote: string | null;
    readonly discoveredAt: string;
    readonly lines: Readonly<Record<string, DraftLine>>;
  };
  readonly onCancel: () => void;
  readonly onSubmit: (input: CreateReceiptAdjustmentRequest) => Promise<boolean>;
  readonly productNameById: ReadonlyMap<string, string>;
  readonly products: readonly ProductOption[];
  readonly submitLabel?: string;
}) {
  const [lines, setLines] = useState<Record<string, DraftLine>>(() => ({ ...initial?.lines }));
  const [reason, setReason] = useState(initial?.reason ?? '');
  const [evidence, setEvidence] = useState(initial?.evidenceNote ?? '');
  const [discoveredAt, setDiscoveredAt] = useState(() =>
    toLocalInput(initial?.discoveredAt ?? new Date().toISOString()),
  );
  const [formError, setFormError] = useState('');
  const editingExisting = initial !== undefined;
  const invalidSelection =
    !editingExisting &&
    context.bags.some((bag) => lines[bag.receiptBagId] && !bag.canReportDiscrepancy);
  const selectedBags = context.bags.filter((bag) => lines[bag.receiptBagId]);
  const shortagePreview = selectedBags.filter(
    (bag) =>
      bag.approvedProductId !== null &&
      bag.effectiveProductId === bag.approvedProductId &&
      !bag.shortageGranted &&
      lines[bag.receiptBagId]?.actualProductId !== bag.approvedProductId,
  );

  const submit = async () => {
    if (invalidSelection) {
      setFormError('Bao đã mất điều kiện báo sai lệch; bỏ chọn bao bị khóa trước khi gửi.');
      return;
    }
    if (selectedBags.length === 0) {
      setFormError('Chọn ít nhất một bao bị sai.');
      return;
    }
    if (selectedBags.some((bag) => !lines[bag.receiptBagId]?.actualProductId)) {
      setFormError('Chọn mặt hàng thực tế cho từng bao.');
      return;
    }
    if (
      selectedBags.some(
        (bag) => lines[bag.receiptBagId]?.actualProductId === bag.effectiveProductId,
      )
    ) {
      setFormError('Mặt hàng thực tế phải khác mặt hàng đang ghi nhận.');
      return;
    }
    if (reason.trim().length < 3) {
      setFormError('Nhập lý do tối thiểu 3 ký tự.');
      return;
    }
    const discovered = new Date(discoveredAt);
    if (Number.isNaN(discovered.getTime())) {
      setFormError('Nhập thời điểm phát hiện.');
      return;
    }
    setFormError('');
    await onSubmit({
      receiptId: context.receiptId,
      reason: reason.trim(),
      evidenceNote: evidence.trim() || null,
      discoveredAt: discovered.toISOString(),
      lines: selectedBags.map((bag) => ({
        receiptBagId: bag.receiptBagId,
        actualProductId: lines[bag.receiptBagId]!.actualProductId,
        disposition: lines[bag.receiptBagId]!.disposition,
      })),
    });
  };

  return (
    <div className="adjustment-form" role="group" aria-label="Báo sai lệch sau khui bao">
      <fieldset>
        <legend>Chọn bao bị sai và loại thực tế</legend>
        <p>Nếu phát hiện sai hàng, hãy báo sai lệch trước khi xác nhận khui kiện để bán.</p>
        <div className="adjustment-bags">
          {context.bags.map((bag) => {
            const line = lines[bag.receiptBagId];
            const unavailable = !editingExisting && !bag.canReportDiscrepancy;
            const lockedByEdit = editingExisting && !line;
            return (
              <div
                className={line ? 'adjustment-bag selected' : 'adjustment-bag'}
                key={bag.receiptBagId}
              >
                <label className="adjustment-bag__pick">
                  <input
                    checked={Boolean(line)}
                    disabled={busy || unavailable || lockedByEdit || editingExisting}
                    onChange={(event) =>
                      setLines((current) => {
                        const next = { ...current };
                        if (event.target.checked) {
                          next[bag.receiptBagId] = { actualProductId: '', disposition: 'KEEP' };
                        } else {
                          delete next[bag.receiptBagId];
                        }
                        return next;
                      })
                    }
                    type="checkbox"
                  />
                  <span>
                    <strong>{bagLabel(bag, productNameById)}</strong>
                    <small>
                      {bag.reportBlockers.includes('BAG_ALREADY_OPENED')
                        ? 'Bao đã khui kiện bán' +
                          (bag.openedAt ? ' lúc ' + formatDateTime(bag.openedAt) : '') +
                          ' nên không thể báo sai lệch'
                        : unavailable
                          ? bag.reportBlockers.map((code) => blockerCopy[code]).join('; ')
                          : 'Chưa phát sinh giao dịch khác trên bao'}
                    </small>
                  </span>
                </label>
                {unavailable && line ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      setLines((current) => {
                        const next = { ...current };
                        delete next[bag.receiptBagId];
                        return next;
                      })
                    }
                  >
                    Bỏ chọn bao mất điều kiện
                  </button>
                ) : null}
                {line ? (
                  <div className="adjustment-bag__fields">
                    <label>
                      <span className="field-label">Mặt hàng thực tế</span>
                      <select
                        disabled={busy}
                        onChange={(event) =>
                          setLines((current) => ({
                            ...current,
                            [bag.receiptBagId]: { ...line, actualProductId: event.target.value },
                          }))
                        }
                        required
                        value={line.actualProductId}
                      >
                        <option value="">Chọn mặt hàng</option>
                        {products
                          .filter((product) => product.id !== bag.effectiveProductId)
                          .map((product) => (
                            <option key={product.id} value={product.id}>
                              {product.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <div
                      className="adjustment-disposition"
                      role="radiogroup"
                      aria-label="Phương án"
                    >
                      {(
                        [
                          ['KEEP', 'Giữ lại để bán'],
                          ['RETURN', 'Trả về kho tổng'],
                        ] as const
                      ).map(([value, label]) => (
                        <label key={value}>
                          <input
                            checked={line.disposition === value}
                            disabled={busy}
                            name={`disposition-${bag.receiptBagId}`}
                            onChange={() =>
                              setLines((current) => ({
                                ...current,
                                [bag.receiptBagId]: { ...line, disposition: value },
                              }))
                            }
                            type="radio"
                          />
                          <span>{label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </fieldset>

      {shortagePreview.length > 0 ? (
        <div className="receipt-policy" role="note">
          <ShieldCheck aria-hidden="true" size={18} />
          <span>
            <strong>Quyền chờ ưu tiên khi được duyệt</strong>
            {shortagePreview
              .map(
                (bag) =>
                  `1 bao ${productNameById.get(bag.approvedProductId ?? '') ?? 'mặt hàng đã duyệt'}`,
              )
              .join(', ')}{' '}
            được tạo/bổ sung vào phiếu chờ ưu tiên P0B ngay khi Admin áp dụng — cho cả phương án giữ
            lại hay trả kho. Hàng thực tế không được tính là hàng thay thế.
          </span>
        </div>
      ) : null}

      <div className="adjustment-form__grid">
        <label>
          <span className="field-label">Thời điểm phát hiện</span>
          <input
            disabled={busy}
            max={toLocalInput(new Date().toISOString())}
            {...(context.finalizedAt ? { min: toLocalInput(context.finalizedAt) } : {})}
            onChange={(event) => setDiscoveredAt(event.target.value)}
            type="datetime-local"
            value={discoveredAt}
          />
        </label>
        <label>
          <span className="field-label">Lý do</span>
          <textarea
            disabled={busy}
            maxLength={1000}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Ví dụ: khui bao số 3 thấy toàn quần jeans"
            rows={3}
            value={reason}
          />
        </label>
        <label>
          <span className="field-label">Bằng chứng (nơi lưu ảnh/biên bản)</span>
          <textarea
            disabled={busy}
            maxLength={2000}
            onChange={(event) => setEvidence(event.target.value)}
            placeholder="Hệ thống chưa lưu tệp đính kèm; ghi nơi lưu ảnh, người chứng kiến…"
            rows={2}
            value={evidence}
          />
        </label>
      </div>
      {formError ? (
        <div className="form-error" role="alert">
          {formError}
        </div>
      ) : null}
      {error ? <CommandError error={error} /> : null}
      <div className="adjustment-actions">
        <Button disabled={busy} onClick={onCancel} tone="secondary">
          Đóng
        </Button>
        <Button
          busy={busy}
          disabled={invalidSelection || selectedBags.length === 0}
          onClick={() => void submit()}
        >
          <Send aria-hidden="true" size={16} /> {submitLabel}
        </Button>
      </div>
    </div>
  );
}

function AdjustmentDetail({
  adjustmentId,
  onChanged,
  productNameById,
  products,
  receiptId,
  role,
}: SharedProps & {
  readonly adjustmentId: string;
  readonly onChanged: () => Promise<void>;
  readonly receiptId: string;
}) {
  const query = useQuery({
    queryFn: () => getReceiptAdjustment(adjustmentId),
    queryKey: ['receipt-adjustment', adjustmentId],
    retry: false,
  });
  const contextQuery = useQuery({
    queryFn: () => getReceiptAdjustmentContext(receiptId),
    queryKey: ['receipt-adjustment-context', receiptId],
    retry: false,
  });
  const [notice, setNotice] = useState('');
  const act = useCommand(
    (input: ReceiptAdjustmentActionRequest, key: string) =>
      actOnReceiptAdjustment(adjustmentId, input, key),
    async (adjustment) => {
      setNotice(actionNotice(adjustment));
      await onChanged();
    },
  );
  const adjustment = query.data;
  if (query.isPending) return <DashboardSkeleton />;
  if (query.isError || !adjustment) {
    return <CommandError error={query.error} onRetry={() => void query.refetch()} />;
  }
  const name = (id: string | null) => (id ? (productNameById.get(id) ?? 'Mặt hàng') : '—');
  const copy = adjustmentStatusCopy[adjustment.status];
  const verified = adjustment.money.after !== null;
  const allowed = new Set(adjustment.allowedActions);

  return (
    <article className="adjustment-detail" aria-label={`Hồ sơ ${adjustment.code}`}>
      <header className="adjustment-detail__header">
        <div>
          <span>
            Hồ sơ {adjustment.code} · phiếu {adjustment.receiptNumber}
          </span>
          <strong>{adjustment.reason}</strong>
          <small>
            Phát hiện {formatDateTime(adjustment.discoveredAt)} · báo{' '}
            {formatDateTime(adjustment.reportedAt)}
            {adjustment.evidenceNote ? ` · Bằng chứng: ${adjustment.evidenceNote}` : ''}
          </small>
        </div>
        <Badge tone={copy.tone}>{copy.label}</Badge>
      </header>

      {adjustment.infoRequestNote && adjustment.status === 'NEEDS_INFO' ? (
        <div className="receipt-review-note">
          <RotateCcw aria-hidden="true" size={17} />
          <span>
            <strong>Yêu cầu bổ sung</strong>
            {adjustment.infoRequestNote}
          </span>
        </div>
      ) : null}
      {adjustment.decisionNote &&
      ['REJECTED', 'CANCELLED', 'APPLIED'].includes(adjustment.status) ? (
        <p className="adjustment-note">
          {adjustment.status === 'APPLIED' ? 'Ghi chú duyệt' : 'Lý do'}: {adjustment.decisionNote}
        </p>
      ) : null}
      {adjustment.cause ? (
        <p className="adjustment-note">
          Nguyên nhân xác minh: {causeCopy[adjustment.cause]} ({causeHint[adjustment.cause]})
          {adjustment.verificationNote ? ` · ${adjustment.verificationNote}` : ''}
        </p>
      ) : null}

      <div className="responsive-table adjustment-lines">
        <table>
          <thead>
            <tr>
              <th>Bao</th>
              <th>Ghi nhận → thực tế</th>
              <th>Kg</th>
              <th>Tiền hàng</th>
              <th>Phương án</th>
            </tr>
          </thead>
          <tbody>
            {adjustment.lines.map((line) => (
              <tr key={line.id}>
                <td data-label="Bao">
                  <span className="adjustment-cell">
                    <strong>Bao {line.receiptBagNumber}</strong>
                    <small>{line.bagDisplayCode}</small>
                  </span>
                </td>
                <td data-label="Ghi nhận → thực tế">
                  <span className="adjustment-cell">
                    <span className="adjustment-sku">
                      {name(line.recordedProductId)}
                      <ArrowRight aria-label="thành" size={14} />
                      <strong>{name(line.actualProductId)}</strong>
                    </span>
                    {line.approvedProductId ? (
                      <small>Đơn duyệt: {name(line.approvedProductId)}</small>
                    ) : (
                      <small>Hàng dư khi nhận</small>
                    )}
                  </span>
                </td>
                <td data-label="Kg">
                  <span className="adjustment-cell">
                    {formatKg(line.recordedWeightKg)}
                    {line.verifiedWeightKg && line.verifiedWeightKg !== line.recordedWeightKg ? (
                      <small>
                        → {formatKg(line.verifiedWeightKg)} ({line.weightChangeNote})
                      </small>
                    ) : null}
                  </span>
                </td>
                <td data-label="Tiền hàng">
                  <span className="adjustment-cell">
                    {formatExactVnd(line.recordedCostVnd)}
                    {line.verifiedCostVnd !== null ? (
                      <small>
                        → {formatExactVnd(line.verifiedCostVnd)} (
                        {formatSignedVnd(line.verifiedCostVnd - line.recordedCostVnd)})
                      </small>
                    ) : (
                      <small>Chờ HTKD xác minh giá</small>
                    )}
                  </span>
                </td>
                <td data-label="Phương án">
                  <span className="adjustment-cell">
                    {line.disposition === 'KEEP' ? 'Giữ lại bán' : 'Trả kho tổng'}
                    <small>{holdCopy(line)}</small>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adjustment.lines.some((line) => line.blockers.length > 0) ? (
        <div className="receipt-error adjustment-blockers" role="alert">
          <AlertTriangle aria-hidden="true" size={18} />
          <span>
            <strong>Chưa thể áp dụng — cần đối soát trước:</strong>
            {adjustment.lines
              .filter((line) => line.blockers.length > 0)
              .map(
                (line) =>
                  ` Bao ${line.receiptBagNumber} (còn ${formatKg(line.bagCurrentWeightKg)}): ${line.blockers
                    .map((code) => blockerCopy[code])
                    .join('; ')}.`,
              )}
          </span>
        </div>
      ) : null}

      <EntitlementList adjustment={adjustment} name={name} />

      <div className="adjustment-compare" aria-label="So sánh trước và sau">
        <CompareColumn label="Trước điều chỉnh (đang hiệu lực)" money={adjustment.money.before} />
        <div className="adjustment-compare__delta">
          <span>Chênh lệch</span>
          <strong>
            {verified
              ? formatSignedVnd(
                  adjustment.delta.goodsVnd +
                    adjustment.delta.freightVnd +
                    adjustment.delta.handlingVnd +
                    adjustment.delta.vatVnd,
                )
              : 'Chờ xác minh'}
          </strong>
          {verified ? (
            <small>
              Hàng {formatSignedVnd(adjustment.delta.goodsVnd)} · VC{' '}
              {formatSignedVnd(adjustment.delta.freightVnd)} · BX{' '}
              {formatSignedVnd(adjustment.delta.handlingVnd)} · VAT{' '}
              {formatSignedVnd(adjustment.delta.vatVnd)}
            </small>
          ) : null}
        </div>
        {adjustment.money.after ? (
          <CompareColumn
            label={
              adjustment.status === 'APPLIED'
                ? 'Sau điều chỉnh (đã có hiệu lực)'
                : 'Sau điều chỉnh (tạm tính, chưa hiệu lực)'
            }
            money={adjustment.money.after}
            tone={adjustment.status === 'APPLIED' ? 'effective' : 'draft'}
          />
        ) : null}
      </div>

      {notice ? (
        <div className="receipt-notice" role="status">
          <CheckCircle2 aria-hidden="true" size={18} />
          <span>{notice}</span>
        </div>
      ) : null}
      {act.error ? <CommandError error={act.error} /> : null}

      {allowed.has('VERIFY') ? (
        <VerifyForm
          adjustment={adjustment}
          busy={act.pending}
          name={name}
          onVerify={(input) => act.execute(input)}
          products={products}
        />
      ) : null}
      {allowed.has('RESUBMIT') && contextQuery.data ? (
        <ReportForm
          busy={act.pending}
          context={{
            ...contextQuery.data,
            bags: contextQuery.data.bags.filter((bag) =>
              adjustment.lines.some((line) => line.receiptBagId === bag.receiptBagId),
            ),
          }}
          error={null}
          initial={{
            reason: adjustment.reason,
            evidenceNote: adjustment.evidenceNote,
            discoveredAt: adjustment.discoveredAt,
            lines: Object.fromEntries(
              adjustment.lines.map((line) => [
                line.receiptBagId,
                { actualProductId: line.actualProductId, disposition: line.disposition },
              ]),
            ),
          }}
          onCancel={() => undefined}
          onSubmit={(input) =>
            act.execute({
              action: 'RESUBMIT',
              expectedVersion: adjustment.version,
              reason: input.reason,
              evidenceNote: input.evidenceNote,
              discoveredAt: input.discoveredAt,
              lines: input.lines,
            })
          }
          productNameById={productNameById}
          products={products}
          submitLabel="Gửi lại HTKD"
        />
      ) : null}
      <DecisionBar
        adjustment={adjustment}
        allowed={allowed}
        busy={act.pending}
        onAct={(input) => act.execute(input)}
      />
      <ReturnsPanel adjustment={adjustment} name={name} onChanged={onChanged} role={role} />
    </article>
  );
}

function holdCopy(line: ReceiptAdjustmentLine): string {
  switch (line.holdState) {
    case 'HELD':
      return 'Đang tạm giữ, không bán/xuất/chuyển';
    case 'RETURNING':
      return 'Giữ chờ trả kho';
    case 'RELEASED':
      return 'Đã gỡ giữ';
    default:
      return 'Không giữ được (bao không còn trên kệ)';
  }
}

function EntitlementList({
  adjustment,
  name,
}: {
  readonly adjustment: ReceiptAdjustment;
  readonly name: (id: string | null) => string;
}) {
  const granted = adjustment.lines.filter((line) => line.entitlement);
  const pending = adjustment.lines.filter(
    (line) => !line.entitlement && line.approvedProductId && adjustment.status !== 'APPLIED',
  );
  if (granted.length === 0 && pending.length === 0) return null;
  return (
    <div className="adjustment-rights" aria-label="Quyền chờ ưu tiên">
      <strong>
        <ClipboardList aria-hidden="true" size={16} /> Quyền chờ ưu tiên hàng thiếu
      </strong>
      {granted.map((line) => {
        const right = line.entitlement!;
        return (
          <p key={line.id}>
            {right.quantity} bao {name(right.productId)} · phiếu chờ {right.waitTicketCode || '—'} (
            {right.waitMode === 'CREATED' ? 'tạo mới' : 'bổ sung vào phiếu chờ sẵn có'}) ·{' '}
            <strong>{describeEntitlement(right)}</strong>
          </p>
        );
      })}
      {['PENDING_HTKD', 'NEEDS_INFO', 'PENDING_ADMIN'].includes(adjustment.status)
        ? pending
            .filter((line) =>
              adjustment.status === 'PENDING_ADMIN' ? line.shortageQuantity > 0 : true,
            )
            .map((line) => (
              <p key={line.id}>
                {adjustment.status === 'PENDING_ADMIN'
                  ? `Sẽ phát sinh ${line.shortageQuantity} bao ${name(line.approvedProductId)} chờ ưu tiên P0B khi Admin áp dụng.`
                  : `Nếu được duyệt: phát sinh quyền chờ bù bao ${name(line.approvedProductId)} (ưu tiên P0B), dù giữ hay trả hàng thực tế.`}
              </p>
            ))
        : null}
    </div>
  );
}

function CompareColumn({
  label,
  money,
  tone,
}: {
  readonly label: string;
  readonly money: ReceiptMoney;
  readonly tone?: 'effective' | 'draft';
}) {
  return (
    <dl className={tone ? `adjustment-compare__col ${tone}` : 'adjustment-compare__col'}>
      <dt>{label}</dt>
      <dd>
        <span>Tiền hàng</span>
        <strong>{formatExactVnd(money.goodsVnd)}</strong>
      </dd>
      <dd>
        <span>Vận chuyển + bốc xếp</span>
        <strong>{formatExactVnd(money.freightVnd + money.handlingVnd)}</strong>
      </dd>
      <dd>
        <span>VAT</span>
        <strong>{formatExactVnd(money.vatVnd)}</strong>
      </dd>
      <dd className="total">
        <span>Tổng</span>
        <strong>
          {formatExactVnd(money.totalVnd, `${formatExactVnd(money.costVnd)} + VAT ?`)}
        </strong>
      </dd>
    </dl>
  );
}

function VerifyForm({
  adjustment,
  busy,
  name,
  onVerify,
  products,
}: {
  readonly adjustment: ReceiptAdjustment;
  readonly busy: boolean;
  readonly name: (id: string | null) => string;
  readonly onVerify: (input: ReceiptAdjustmentActionRequest) => Promise<boolean>;
  readonly products: readonly ProductOption[];
}) {
  const [lines, setLines] = useState(() =>
    adjustment.lines.map((line) => ({
      receiptBagId: line.receiptBagId,
      actualProductId: line.actualProductId,
      weightKg: line.verifiedWeightKg ?? line.recordedWeightKg,
      pricePerKgVnd: line.verifiedPricePerKgVnd?.toString() ?? '',
      weightChangeNote: line.weightChangeNote ?? '',
      recordedWeightKg: line.recordedWeightKg,
      recordedCostVnd: line.recordedCostVnd,
      recordedProductId: line.recordedProductId,
    })),
  );
  const [cause, setCause] = useState<ReceiptAdjustmentCause | ''>(adjustment.cause ?? '');
  const [freight, setFreight] = useState('0');
  const [handling, setHandling] = useState('0');
  const [vat, setVat] = useState('0');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState('');
  const preview = previewAdjustment(adjustment.money.before, lines, { freight, handling, vat });

  const submit = async () => {
    if (!cause) {
      setFormError('Chọn nguyên nhân đã xác minh.');
      return;
    }
    if (preview.problem) {
      setFormError(preview.problem);
      return;
    }
    if (
      lines.some(
        (line) =>
          line.weightKg !== line.recordedWeightKg && line.weightChangeNote.trim().length < 3,
      )
    ) {
      setFormError('Bao có kg thay đổi cần ghi căn cứ cân lại.');
      return;
    }
    if (note.trim().length < 3) {
      setFormError('Nhập ghi chú xác minh tối thiểu 3 ký tự.');
      return;
    }
    setFormError('');
    await onVerify({
      action: 'VERIFY',
      expectedVersion: adjustment.version,
      cause,
      note: note.trim(),
      lines: lines.map((line) => ({
        receiptBagId: line.receiptBagId,
        actualProductId: line.actualProductId,
        weightKg: line.weightKg,
        pricePerKgVnd: Number(line.pricePerKgVnd),
        weightChangeNote:
          line.weightKg === line.recordedWeightKg ? null : line.weightChangeNote.trim(),
      })),
      freightDeltaVnd: Number(freight || '0'),
      handlingDeltaVnd: Number(handling || '0'),
      vatDeltaVnd: Number(vat || '0'),
    });
  };

  return (
    <div className="adjustment-form" role="group" aria-label="Xác minh của HTKD">
      <h4>Xác minh hàng, kg, giá và chi phí</h4>
      {lines.map((line, index) => (
        <div className="adjustment-verify-line" key={line.receiptBagId}>
          <strong>
            Bao {adjustment.lines[index]?.receiptBagNumber} · ghi nhận{' '}
            {name(line.recordedProductId)} · {formatExactVnd(line.recordedCostVnd)}
          </strong>
          <div className="adjustment-verify-line__fields">
            <label>
              <span className="field-label">Mặt hàng thực tế</span>
              <select
                disabled={busy}
                onChange={(event) =>
                  setLines((current) =>
                    current.map((item, i) =>
                      i === index ? { ...item, actualProductId: event.target.value } : item,
                    ),
                  )
                }
                value={line.actualProductId}
              >
                {products
                  .filter((product) => product.id !== line.recordedProductId)
                  .map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span className="field-label">Kg xác minh</span>
              <input
                disabled={busy}
                inputMode="decimal"
                onChange={(event) =>
                  setLines((current) =>
                    current.map((item, i) =>
                      i === index
                        ? { ...item, weightKg: event.target.value.replace(',', '.') }
                        : item,
                    ),
                  )
                }
                value={line.weightKg}
              />
            </label>
            <label>
              <span className="field-label">Giá / kg mặt hàng thực tế (VND)</span>
              <MoneyInput
                disabled={busy}
                onValueChange={(digits) =>
                  setLines((current) =>
                    current.map((item, i) =>
                      i === index ? { ...item, pricePerKgVnd: digits } : item,
                    ),
                  )
                }
                placeholder="0"
                value={line.pricePerKgVnd}
              />
            </label>
            {line.weightKg !== line.recordedWeightKg ? (
              <label>
                <span className="field-label">Căn cứ cân lại</span>
                <input
                  disabled={busy}
                  onChange={(event) =>
                    setLines((current) =>
                      current.map((item, i) =>
                        i === index ? { ...item, weightChangeNote: event.target.value } : item,
                      ),
                    )
                  }
                  value={line.weightChangeNote}
                />
              </label>
            ) : null}
          </div>
          <small aria-live="polite">
            Giá trị mới:{' '}
            {preview.lineCosts[index] === null || preview.lineCosts[index] === undefined
              ? 'chưa đủ dữ liệu'
              : `${formatExactVnd(preview.lineCosts[index]!)} (${formatSignedVnd(
                  preview.lineCosts[index]! - BigInt(line.recordedCostVnd),
                )})`}
          </small>
        </div>
      ))}
      <div className="adjustment-form__grid adjustment-form__grid--fees">
        <label>
          <span className="field-label">Nguyên nhân</span>
          <select
            disabled={busy}
            onChange={(event) => setCause(event.target.value as ReceiptAdjustmentCause)}
            value={cause}
          >
            <option value="">Chọn nguyên nhân</option>
            <option value="SOURCE_MISCLASSIFICATION">{causeCopy.SOURCE_MISCLASSIFICATION}</option>
            <option value="WAREHOUSE_MISPICK">{causeCopy.WAREHOUSE_MISPICK}</option>
          </select>
          {cause ? <small>{causeHint[cause]}</small> : null}
        </label>
        {(
          [
            ['Chênh lệch vận chuyển (VND, có thể âm)', freight, setFreight],
            ['Chênh lệch bốc xếp (VND, có thể âm)', handling, setHandling],
            [
              adjustment.money.before.vatVnd === null
                ? 'VAT (phiếu gốc chưa ghi nhận – giữ 0)'
                : 'Chênh lệch VAT (VND, có thể âm)',
              vat,
              setVat,
            ],
          ] as const
        ).map(([label, value, setter]) => (
          <label key={label}>
            <span className="field-label">{label}</span>
            <input
              disabled={
                busy || (label.startsWith('VAT (') && adjustment.money.before.vatVnd === null)
              }
              inputMode="numeric"
              onChange={(event) => setter(event.target.value.replace(/[^\d-]/g, ''))}
              value={value}
            />
          </label>
        ))}
      </div>
      <label className="adjustment-form__note">
        <span className="field-label">Ghi chú xác minh</span>
        <textarea
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Đã xem ảnh, cân lại, đối chiếu phiếu giao…"
          rows={2}
          value={note}
        />
      </label>
      {preview.after && !preview.problem ? (
        <p className="adjustment-note" aria-live="polite">
          Tạm tính sau điều chỉnh: tiền hàng {formatExactVnd(preview.after.goods)} · tổng{' '}
          {formatExactVnd(
            preview.after.total,
            `${formatExactVnd(preview.after.cost)} + VAT chưa ghi nhận`,
          )}{' '}
          (chênh lệch hàng {formatSignedVnd(preview.delta!.goods)}). Máy chủ tính lại khi gửi.
        </p>
      ) : null}
      {formError ? (
        <div className="form-error" role="alert">
          {formError}
        </div>
      ) : null}
      <div className="adjustment-actions">
        <Button busy={busy} onClick={() => void submit()} tone="success">
          <ShieldCheck aria-hidden="true" size={16} /> Xác minh, gửi Admin duyệt
        </Button>
      </div>
    </div>
  );
}

function DecisionBar({
  adjustment,
  allowed,
  busy,
  onAct,
}: {
  readonly adjustment: ReceiptAdjustment;
  readonly allowed: ReadonlySet<string>;
  readonly busy: boolean;
  readonly onAct: (input: ReceiptAdjustmentActionRequest) => Promise<boolean>;
}) {
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState('');
  const noteActions = (['REQUEST_INFO', 'RETURN_TO_VERIFIER', 'REJECT', 'CANCEL'] as const).filter(
    (action) => allowed.has(action),
  );
  if (noteActions.length === 0 && !allowed.has('APPLY')) return null;
  const blocked = adjustment.lines.some((line) => line.blockers.length > 0);
  const withNote = async (action: 'REQUEST_INFO' | 'RETURN_TO_VERIFIER' | 'REJECT' | 'CANCEL') => {
    if (note.trim().length < 3) {
      setFormError('Nhập nội dung/lý do tối thiểu 3 ký tự.');
      return;
    }
    setFormError('');
    await onAct({ action, expectedVersion: adjustment.version, note: note.trim() });
  };
  const labels = {
    REQUEST_INFO: 'Yêu cầu cửa hàng bổ sung',
    RETURN_TO_VERIFIER: 'Trả HTKD xác minh lại',
    REJECT: 'Từ chối hồ sơ',
    CANCEL: 'Hủy hồ sơ',
  } as const;
  return (
    <div className="adjustment-decision">
      <label>
        <span className="field-label">
          {allowed.has('APPLY') ? 'Ghi chú (bắt buộc khi từ chối/trả lại)' : 'Nội dung/lý do'}
        </span>
        <textarea
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          value={note}
        />
      </label>
      {formError ? (
        <div className="form-error" role="alert">
          {formError}
        </div>
      ) : null}
      <div className="adjustment-actions">
        {noteActions.map((action) => (
          <Button
            disabled={busy}
            key={action}
            onClick={() => void withNote(action)}
            tone={action === 'REJECT' || action === 'CANCEL' ? 'danger' : 'secondary'}
          >
            {action === 'REJECT' || action === 'CANCEL' ? (
              <XCircle aria-hidden="true" size={16} />
            ) : (
              <RotateCcw aria-hidden="true" size={16} />
            )}{' '}
            {labels[action]}
          </Button>
        ))}
        {allowed.has('APPLY') ? (
          <Button
            busy={busy}
            disabled={blocked}
            onClick={() =>
              void onAct({
                action: 'APPLY',
                expectedVersion: adjustment.version,
                note: note.trim() || null,
              })
            }
            title={blocked ? 'Còn bao cần đối soát trước khi áp dụng' : undefined}
            tone="success"
          >
            <CheckCircle2 aria-hidden="true" size={16} /> Duyệt và áp dụng
          </Button>
        ) : null}
      </div>
      {allowed.has('APPLY') ? (
        <small className="adjustment-note">
          Áp dụng trong một giao dịch: đổi phân loại bao, ghi chênh lệch tiền, tạo/bổ sung chờ ưu
          tiên, chuyển hàng sang bán hoặc phiếu trả. Lỗi bất kỳ bước nào thì không thay đổi gì.
        </small>
      ) : null}
    </div>
  );
}

function ReturnsPanel({
  adjustment,
  name,
  onChanged,
  role,
}: {
  readonly adjustment: ReceiptAdjustment;
  readonly name: (id: string | null) => string;
  readonly onChanged: () => Promise<void>;
  readonly role: Role;
}) {
  const [notice, setNotice] = useState('');
  const act = useCommand(
    (input: { returnId: string; body: ReceiptReturnActionRequest }, key: string) =>
      actOnReceiptReturn(input.returnId, input.body, key),
    async (row) => {
      setNotice(`Phiếu trả ${row.code}: ${returnStatusCopy[row.status].label}.`);
      await onChanged();
    },
  );
  const switchToReturn = useCommand(
    (input: { lineId: string; reason: string }, key: string) =>
      createReceiptReturn(adjustment.id, input.lineId, { reason: input.reason }, key),
    async (row) => {
      setNotice(`Đã tạo phiếu trả ${row.code}; bao được giữ chờ bàn giao. Quyền chờ bù không đổi.`);
      await onChanged();
    },
  );
  const [notes, setNotes] = useState<Record<string, string>>({});
  if (adjustment.status !== 'APPLIED') return null;
  const busy = act.pending || switchToReturn.pending;
  const rows = adjustment.lines.flatMap((line) => line.returns.map((row) => ({ line, row })));
  const keepLines = adjustment.lines.filter(
    (line) =>
      line.holdState === 'RELEASED' && !line.returns.some((row) => row.status !== 'CANCELLED'),
  );
  if (rows.length === 0 && (role !== 'STORE' || keepLines.length === 0)) return null;
  const noteFor = (id: string) => notes[id]?.trim() ?? '';
  const run = (row: ReceiptReturn, body: ReceiptReturnActionRequest) =>
    void act.execute({ returnId: row.id, body });

  return (
    <div className="adjustment-returns" aria-label="Phiếu trả kho">
      <strong>
        <Truck aria-hidden="true" size={16} /> Trả hàng về kho tổng
      </strong>
      <p className="adjustment-note">
        Hàng rời tồn cửa hàng khi bàn giao; kho tổng chỉ tăng tồn khi xác nhận thực nhận. Giá trị
        hàng trả ghi giảm một lần tại thời điểm bàn giao; phí và VAT của phiếu nhận không đổi.
      </p>
      {rows.map(({ line, row }) => {
        const copy = returnStatusCopy[row.status];
        return (
          <div className="adjustment-return" key={row.id}>
            <div className="adjustment-return__head">
              <span>
                <strong>{row.code}</strong> · Bao {line.receiptBagNumber} · {name(row.productId)} ·{' '}
                {formatKg(row.weightKg)} · {formatExactVnd(row.costVnd)}
              </span>
              <Badge tone={copy.tone}>{copy.label}</Badge>
            </div>
            {row.receiveNote || row.resolutionNote || row.cancellationReason ? (
              <small>{row.resolutionNote ?? row.receiveNote ?? row.cancellationReason}</small>
            ) : null}
            {row.status === 'PENDING_HANDOVER' ||
            (['IN_TRANSIT', 'DISPUTED'].includes(row.status) && role === 'ADMIN') ? (
              <div className="adjustment-return__actions">
                <input
                  aria-label={`Ghi chú cho ${row.code}`}
                  disabled={busy}
                  onChange={(event) =>
                    setNotes((current) => ({ ...current, [row.id]: event.target.value }))
                  }
                  placeholder={
                    row.status === 'PENDING_HANDOVER'
                      ? 'Lý do nếu đổi sang giữ bán'
                      : 'Ghi chú đối soát (bắt buộc khi thiếu/sai)'
                  }
                  value={notes[row.id] ?? ''}
                />
                {row.status === 'PENDING_HANDOVER' && role === 'STORE' ? (
                  <Button
                    busy={act.pending}
                    onClick={() => run(row, { action: 'HANDOVER', expectedVersion: row.version })}
                  >
                    <Truck aria-hidden="true" size={16} /> Bàn giao trả kho
                  </Button>
                ) : null}
                {row.status === 'PENDING_HANDOVER' ? (
                  <Button
                    disabled={busy || noteFor(row.id).length < 3}
                    onClick={() =>
                      run(row, {
                        action: 'CANCEL',
                        expectedVersion: row.version,
                        note: noteFor(row.id),
                      })
                    }
                    tone="secondary"
                  >
                    Hủy trả, giữ bán
                  </Button>
                ) : null}
                {row.status === 'IN_TRANSIT' && role === 'ADMIN' ? (
                  <>
                    <Button
                      busy={act.pending}
                      onClick={() =>
                        run(row, {
                          action: 'RECEIVE',
                          expectedVersion: row.version,
                          outcome: 'RECEIVED',
                          note: noteFor(row.id) || null,
                        })
                      }
                      tone="success"
                    >
                      Kho nhận đủ
                    </Button>
                    <Button
                      disabled={busy || noteFor(row.id).length < 3}
                      onClick={() =>
                        run(row, {
                          action: 'RECEIVE',
                          expectedVersion: row.version,
                          outcome: 'NOT_RECEIVED',
                          note: noteFor(row.id),
                        })
                      }
                      tone="danger"
                    >
                      Không nhận được
                    </Button>
                    <Button
                      disabled={busy || noteFor(row.id).length < 3}
                      onClick={() =>
                        run(row, {
                          action: 'RECEIVE',
                          expectedVersion: row.version,
                          outcome: 'WRONG_ITEM',
                          note: noteFor(row.id),
                        })
                      }
                      tone="danger"
                    >
                      Sai mặt hàng
                    </Button>
                  </>
                ) : null}
                {row.status === 'DISPUTED' && role === 'ADMIN' ? (
                  <>
                    <Button
                      disabled={busy || noteFor(row.id).length < 3}
                      onClick={() =>
                        run(row, {
                          action: 'RESOLVE',
                          expectedVersion: row.version,
                          outcome: 'RECEIVED',
                          note: noteFor(row.id),
                        })
                      }
                      tone="success"
                    >
                      Đã tìm thấy – nhập kho
                    </Button>
                    <Button
                      disabled={busy || noteFor(row.id).length < 3}
                      onClick={() =>
                        run(row, {
                          action: 'RESOLVE',
                          expectedVersion: row.version,
                          outcome: 'LOST',
                          note: noteFor(row.id),
                        })
                      }
                      tone="danger"
                    >
                      Xác nhận thất lạc
                    </Button>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {role === 'STORE'
        ? keepLines.map((line) => (
            <div className="adjustment-return" key={`keep:${line.id}`}>
              <div className="adjustment-return__head">
                <span>
                  Bao {line.receiptBagNumber} · {name(line.actualProductId)} đang giữ bán
                </span>
              </div>
              <div className="adjustment-return__actions">
                <input
                  aria-label={`Lý do trả bao ${line.receiptBagNumber}`}
                  disabled={busy}
                  onChange={(event) =>
                    setNotes((current) => ({ ...current, [line.id]: event.target.value }))
                  }
                  placeholder="Lý do chuyển sang trả kho"
                  value={notes[line.id] ?? ''}
                />
                <Button
                  busy={switchToReturn.pending}
                  disabled={busy || noteFor(line.id).length < 3}
                  onClick={() =>
                    void switchToReturn.execute({ lineId: line.id, reason: noteFor(line.id) })
                  }
                  tone="secondary"
                >
                  Chuyển sang trả kho
                </Button>
              </div>
            </div>
          ))
        : null}
      {notice ? (
        <div className="receipt-notice" role="status">
          <CheckCircle2 aria-hidden="true" size={18} />
          <span>{notice}</span>
        </div>
      ) : null}
      {act.error ? <CommandError error={act.error} /> : null}
      {switchToReturn.error ? <CommandError error={switchToReturn.error} /> : null}
    </div>
  );
}

function actionNotice(adjustment: ReceiptAdjustment): string {
  switch (adjustment.status) {
    case 'PENDING_ADMIN':
      return `Đã xác minh ${adjustment.code}; số sau điều chỉnh là tạm tính cho tới khi Admin duyệt.`;
    case 'APPLIED':
      return `Đã áp dụng ${adjustment.code}: tiền, phân loại bao và quyền chờ ưu tiên đã có hiệu lực.`;
    case 'NEEDS_INFO':
      return `Đã yêu cầu cửa hàng bổ sung ${adjustment.code}.`;
    case 'PENDING_HTKD':
      return `${adjustment.code} đang chờ HTKD xác minh.`;
    case 'REJECTED':
      return `Đã từ chối ${adjustment.code}; bao do hồ sơ giữ đã được gỡ giữ.`;
    case 'CANCELLED':
      return `Đã hủy ${adjustment.code}; bao do hồ sơ giữ đã được gỡ giữ.`;
  }
}

function CommandError({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry?: () => void;
}) {
  const message =
    error instanceof ApiClientError
      ? error.status === 409
        ? `${error.message} Dữ liệu đã được tải lại, hãy kiểm tra rồi thao tác lại.`
        : error.status === 403
          ? 'Tài khoản không có quyền với hồ sơ này hoặc đã bị gỡ phân công.'
          : error.message
      : error instanceof Error
        ? error.message
        : 'Không thể xử lý hồ sơ sai lệch.';
  return (
    <div className="receipt-error" role="alert">
      <AlertTriangle aria-hidden="true" size={18} />
      <span>{message}</span>
      {onRetry ? (
        <button onClick={onRetry} type="button">
          Thử lại
        </button>
      ) : null}
    </div>
  );
}

function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    year: 'numeric',
    month: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(value));
}
