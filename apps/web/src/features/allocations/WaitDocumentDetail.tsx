import { DataTable } from '../../components/DataTable';
import type { StoreWaitDocumentCancelPreview, StoreWaitDocumentDetail } from '@idosi/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ApiClientError, cancelWaitDocument, getWaitDocument } from '../../lib/api';
import { retainIdempotencyForExactRetry, type RetryAttempt } from '../../lib/idempotency-retry';
import { formatDateTime } from '../../lib/session-label';
import { CancelWaitDocumentDialog } from './CancelWaitDocumentDialog';
import {
  currentDocumentDetail,
  lineOpenQuantity,
  waitDocumentActor,
  waitDocumentEventDescription,
  waitDocumentLabel,
  waitDocumentTone,
  waitDocumentTotals,
} from './waitDocumentNavigation';

export const waitDocumentKey = (accountKey: string, documentId: string) =>
  ['wait-document', accountKey, documentId] as const;

/** Every query a document cancellation can change. */
const AFFECTED_QUERY_KEYS = [
  'wait-documents',
  'wait-document',
  'wait-document-cancel-preview',
  'wait-tickets',
  'wait-ticket-history',
  'priority-offers',
  'priority-offer-notices',
  'allocation-decisions',
  'session-documents',
  'held-allocations',
  'warehouse-inventory',
  'warehouse-balances',
];

const memberStatusLabel = {
  ACTIVE: 'Đang chờ',
  FULFILLED: 'Đã cấp đủ',
  CANCELLED: 'Đã hủy',
  EXPIRED: 'Hết hạn (dữ liệu cũ)',
} as const;

/**
 * One store wait document: what it opened with (bags handed over by the previous document and
 * bags added), what it waits for now or what happened to each line when it closed, the results
 * still holding its goods, the line tickets (PC) it covers and its whole B → C → D chain.
 */
export function WaitDocumentDetail({
  accountKey,
  documentId,
  onClose,
  onOpenDecision,
  onOpenDocument,
  showStore,
}: {
  readonly accountKey: string;
  readonly documentId: string;
  readonly onClose: () => void;
  readonly onOpenDecision: (decisionId: string) => void;
  readonly onOpenDocument: (documentId: string | null) => void;
  readonly showStore: boolean;
}) {
  const queryClient = useQueryClient();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const query = useQuery({
    queryFn: ({ signal }) => getWaitDocument(documentId, signal),
    queryKey: waitDocumentKey(accountKey, documentId),
    retry: false,
  });
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const attempt = useRef<RetryAttempt | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (query.data) headingRef.current?.focus();
  }, [documentId, query.data]);

  const refetchAffected = () =>
    Promise.all(
      AFFECTED_QUERY_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
    );

  const confirmCancel = async (
    document: StoreWaitDocumentDetail,
    preview: StoreWaitDocumentCancelPreview,
  ) => {
    if (inFlight.current) return;
    const trimmed = reason.trim();
    if (trimmed.length < 3) return;
    inFlight.current = true;
    // The key is reused only for an exact retry of the same reason and confirmed scope.
    const retry = retainIdempotencyForExactRetry(
      attempt.current,
      `${document.id}:${trimmed}:${preview.fingerprint}`,
    );
    attempt.current = retry;
    setBusy(true);
    setError(null);
    try {
      const result = await cancelWaitDocument(
        document.id,
        { reason: trimmed, expectedFingerprint: preview.fingerprint },
        retry.key,
      );
      attempt.current = null;
      setCancelOpen(false);
      setReason('');
      setNotice(
        `Đã hủy phiếu ${document.code}: ${result.cancelledQuantity} bao${
          result.revokedQuantity > 0
            ? `, trong đó ${result.revokedQuantity} bao thu hồi khỏi kết quả chưa xác nhận`
            : ''
        }. Lý do đã lưu vào lịch sử phiếu.`,
      );
      await refetchAffected();
      if (result.currentDocumentId) onOpenDocument(result.currentDocumentId);
    } catch (cause) {
      if (cause instanceof ApiClientError && [401, 403, 404, 409].includes(cause.status)) {
        await refetchAffected();
      }
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : 'Không thể hủy phiếu chờ. Bấm lại để thử đúng yêu cầu trước đó.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (query.isPending) {
    return (
      <section className="panel wait-document-detail" aria-busy="true">
        <p aria-live="polite">Đang tải phiếu chờ…</p>
      </section>
    );
  }
  if (query.isError) {
    const missing = query.error instanceof ApiClientError && query.error.status === 404;
    return (
      <section className="panel wait-document-detail">
        <div className="form-error" role="alert">
          {missing
            ? 'Không tìm thấy phiếu chờ trong phạm vi tài khoản này.'
            : query.error instanceof ApiClientError
              ? query.error.message
              : 'Không tải được phiếu chờ.'}
        </div>
        <div className="wait-document-detail__actions">
          {missing ? null : (
            <Button onClick={() => void query.refetch()} tone="secondary">
              <RotateCcw aria-hidden="true" size={15} /> Thử lại
            </Button>
          )}
          <Button onClick={onClose} tone="secondary">
            Đóng
          </Button>
        </div>
      </section>
    );
  }

  const document = query.data;
  const current = document.status === 'CURRENT';
  const totals = waitDocumentTotals(document);
  const productName = (productId: string) =>
    document.lines.find((line) => line.productId === productId)?.productName ?? 'Mặt hàng';
  return (
    <section aria-labelledby="wait-document-detail-heading" className="panel wait-document-detail">
      <div className="wait-document-detail__header">
        <div>
          <h3 id="wait-document-detail-heading" ref={headingRef} tabIndex={-1}>
            Phiếu chờ {document.code}
          </h3>
          <p>
            <span className="store-name">{showStore ? `${document.storeName} · ` : ''}</span>
            {current ? currentDocumentDetail(document.lines) : waitDocumentLabel(document)}
          </p>
        </div>
        <div className="wait-document-detail__header-actions">
          <Badge tone={waitDocumentTone(document.status)}>{waitDocumentLabel(document)}</Badge>
          <button aria-label="Đóng chi tiết phiếu chờ" onClick={onClose} type="button">
            <X aria-hidden="true" size={20} />
          </button>
        </div>
      </div>

      {notice ? (
        <p className="inline-notice" role="status">
          {notice}
        </p>
      ) : null}
      {!current && document.currentDocument && document.currentDocument.id !== document.id ? (
        <p className="inline-notice wait-document-detail__current">
          Phiếu này đã được xử lý. Phần còn chờ của cửa hàng nằm ở phiếu hiện hành{' '}
          <button
            className="link-button"
            onClick={() => onOpenDocument(document.currentDocument!.id)}
            type="button"
          >
            {document.currentDocument.code}
          </button>
          .
        </p>
      ) : null}

      <dl className="wait-document-detail__facts">
        <div>
          <dt>Tạo phiếu</dt>
          <dd>{formatDateTime(document.openedAt)}</dd>
        </div>
        <div>
          <dt>Chờ từ</dt>
          <dd>{formatDateTime(document.waitingSince)}</dd>
        </div>
        <div>
          <dt>Nguồn tạo phiếu</dt>
          <dd>
            {waitDocumentEventDescription(document.openedEvent)} ·{' '}
            {waitDocumentActor(document.openedEvent)}
          </dd>
        </div>
        {document.closedEvent && document.closedAt ? (
          <div>
            <dt>Xử lý</dt>
            <dd>
              {formatDateTime(document.closedAt)} ·{' '}
              {waitDocumentEventDescription(document.closedEvent)} ·{' '}
              {waitDocumentActor(document.closedEvent)}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Quy mô</dt>
          <dd>
            {totals.products} mặt hàng · {totals.open} bao khi mở phiếu
            {current ? ` · còn chờ ${totals.remaining} · chờ xác nhận ${totals.pending}` : ''}
          </dd>
        </div>
      </dl>

      <div className="responsive-table wait-document-lines">
        <DataTable>
          <caption className="sr-only">Mặt hàng của phiếu chờ {document.code}</caption>
          <thead>
            <tr>
              <th scope="col" className="table-index">
                STT
              </th>
              <th data-primary-column scope="col">
                Mặt hàng
              </th>
              <th scope="col">
                {document.predecessor ? `Từ phiếu ${document.predecessor.code}` : 'Từ phiếu trước'}
              </th>
              <th scope="col">Bổ sung mới</th>
              {current ? (
                <>
                  <th scope="col">Còn chờ phân bổ</th>
                  <th scope="col">Đã cấp chờ xác nhận</th>
                </>
              ) : (
                <>
                  <th scope="col">Đã xác nhận</th>
                  <th scope="col">Đã hủy</th>
                  <th scope="col">Điều chỉnh</th>
                  <th scope="col">
                    {document.successor ? `Sang phiếu ${document.successor.code}` : 'Chuyển tiếp'}
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {document.lines.map((line, rowIndex) => (
              <tr key={line.productId}>
                <td className="table-index" data-label="STT">
                  {rowIndex + 1}
                </td>
                <th data-primary-column scope="row" data-label="Mặt hàng">
                  {line.productName}
                  <small>
                    {line.sku} · mở phiếu {lineOpenQuantity(line)} bao
                  </small>
                </th>
                <td data-label="Từ phiếu trước">{line.carriedInQuantity}</td>
                <td data-label="Bổ sung mới">{line.addedQuantity}</td>
                {current ? (
                  <>
                    <td data-label="Còn chờ phân bổ">{line.remainingQuantity ?? 0}</td>
                    <td data-label="Đã cấp chờ xác nhận">{line.pendingQuantity ?? 0}</td>
                  </>
                ) : (
                  <>
                    <td data-label="Đã xác nhận">{line.confirmedQuantity ?? 0}</td>
                    <td data-label="Đã hủy">{line.cancelledQuantity ?? 0}</td>
                    <td data-label="Điều chỉnh">{line.adjustedQuantity ?? 0}</td>
                    <td data-label="Chuyển sang phiếu sau">{line.carriedOutQuantity ?? 0}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      </div>

      {current && document.pendingResults.length > 0 ? (
        <section className="wait-document-detail__section" aria-label="Kết quả chờ xác nhận">
          <h4>Hàng đã cấp đang chờ xác nhận</h4>
          <ul className="wait-document-detail__list">
            {document.pendingResults.map((row) => (
              <li key={`${row.allocationDecisionId}:${row.productId}`}>
                <span>
                  {row.quantity} bao {productName(row.productId)} · kết quả phiên {row.session.code}
                </span>
                <Button onClick={() => onOpenDecision(row.allocationDecisionId)} tone="secondary">
                  Mở kết quả
                </Button>
              </li>
            ))}
          </ul>
          <p className="allocation-decision__hint">
            Hàng này chưa được cửa hàng xác nhận: chưa tạo đơn Reshare, chưa xuất kho và không được
            phân bổ lại cho cửa hàng khác.
          </p>
        </section>
      ) : null}

      <section className="wait-document-detail__section" aria-label="Lịch sử phiếu chờ">
        <h4>Dòng thời gian phiếu</h4>
        <ol className="wait-document-chain">
          {document.chain.map((row, index) => (
            <li
              aria-current={row.id === document.id ? 'true' : undefined}
              className={row.id === document.id ? 'wait-document-chain__self' : undefined}
              key={row.id}
            >
              {index > 0 ? <ArrowRight aria-hidden="true" size={14} /> : null}
              {row.id === document.id ? (
                <strong>{row.code}</strong>
              ) : (
                <button
                  className="link-button"
                  onClick={() => onOpenDocument(row.id)}
                  type="button"
                >
                  {row.code}
                </button>
              )}
              <small>
                {waitDocumentLabel({
                  status: row.status,
                  successor: document.chain[index + 1]
                    ? { id: document.chain[index + 1]!.id, code: document.chain[index + 1]!.code }
                    : null,
                })}{' '}
                · {formatDateTime(row.openedAt)}
              </small>
            </li>
          ))}
        </ol>
      </section>

      {document.members.length > 0 ? (
        <details className="wait-document-detail__section">
          <summary>Dòng vận hành theo mặt hàng ({document.members.length})</summary>
          <ul className="wait-document-detail__list">
            {document.members.map((member) => (
              <li key={member.waitTicketId}>
                <span>
                  {member.code} · {productName(member.productId)}
                </span>
                <small>
                  {memberStatusLabel[member.status]} · còn chờ {member.remainingQuantity}/
                  {member.originalQuantity} bao · chờ từ {formatDateTime(member.queuedAt)}
                </small>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {current ? (
        <div className="wait-document-detail__actions">
          <Button
            onClick={() => {
              setError(null);
              setCancelOpen(true);
            }}
            tone="danger"
          >
            Hủy phiếu chờ
          </Button>
        </div>
      ) : null}
      {cancelOpen ? (
        <CancelWaitDocumentDialog
          accountKey={accountKey}
          busy={busy}
          document={document}
          error={error}
          onCancel={() => {
            if (busy) return;
            setCancelOpen(false);
            setError(null);
          }}
          onConfirm={(preview) => void confirmCancel(document, preview)}
          onReasonChange={setReason}
          reason={reason}
        />
      ) : null}
    </section>
  );
}
