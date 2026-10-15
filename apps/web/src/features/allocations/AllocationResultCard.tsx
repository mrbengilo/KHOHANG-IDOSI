import type { SessionDocument, SessionDocumentSource } from '@idosi/contracts';
import type { ReactNode } from 'react';

import { Badge } from '../../components/Badge';
import './allocation-summary.css';
import { Button } from '../../components/Button';
import { decisionCode, decisionStatusLabel, decisionStatusTone } from './allocationDecisionApi';
import { summarizeAllocation, summaryText, type SummaryItem } from './allocationSummary';

function ItemChips({
  items,
  empty,
}: {
  readonly items: readonly SummaryItem[];
  readonly empty: string;
}) {
  if (items.length === 0) return <span className="allocation-summary__empty">{empty}</span>;
  return (
    <ul className="allocation-chips">
      {items.map((item) => (
        <li key={item.productId}>
          <strong>{item.quantity}</strong> {item.name}
        </li>
      ))}
    </ul>
  );
}

function SummaryRow({
  label,
  total,
  tone,
  children,
}: {
  readonly label: ReactNode;
  readonly total?: number;
  readonly tone: 'ordered' | 'granted' | 'waiting' | 'previous' | 'next' | 'neutral';
  readonly children: ReactNode;
}) {
  return (
    <div className={`allocation-summary__row allocation-summary__row--${tone}`}>
      <dt>
        <span className="allocation-summary__label">{label}</span>
        {total === undefined ? null : <span>{total} bao</span>}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

function WaitDocumentLabel({
  title,
  code,
}: {
  readonly title: string;
  readonly code: string | undefined;
}) {
  return (
    <>
      {title}
      {code ? <span className="allocation-summary__code">{code}</span> : null}
    </>
  );
}

/**
 * One store in one session, read top to bottom like the store says it: what it ordered, what it
 * got, what waits for priority, the wait document before the run and the one after it. Codes,
 * sources and rounds stay one click away for audit, not on the face of the card.
 */
export function AllocationResultCard({
  document,
  storeName,
  sessionText,
  createdAtText,
  productName,
  sourceText,
  onOpenDecision,
}: {
  readonly document: SessionDocument;
  readonly storeName: string;
  readonly sessionText: string;
  readonly createdAtText: string;
  readonly productName: (productId: string) => string;
  readonly sourceText: (source: SessionDocumentSource) => string;
  readonly onOpenDecision: (decisionId: string) => void;
}) {
  const summary = summarizeAllocation(document, productName);
  const decision = document.decision ?? null;
  const wait = summary.waitDocuments;
  return (
    <article className="panel session-document allocation-summary-card" aria-label={storeName}>
      <header className="allocation-summary-card__header">
        <div className="allocation-summary-card__title">
          <h3>{storeName}</h3>
          <small>Phân bổ lúc {createdAtText}</small>
          <small className="allocation-summary-card__session">Phiên {sessionText}</small>
        </div>
        {decision ? (
          <div className="allocation-summary-card__decision">
            <Badge tone={decisionStatusTone[decision.status]}>
              {decisionStatusLabel[decision.status]}
            </Badge>
            <Button
              aria-label={`${decision.canRespond ? 'Xác nhận' : 'Xem'} phiếu ${decisionCode(decision)}`}
              onClick={() => onOpenDecision(decision.id)}
              tone={decision.canRespond ? 'primary' : 'secondary'}
            >
              {decision.canRespond ? 'Xác nhận phiếu' : 'Xem phiếu'}
            </Button>
          </div>
        ) : null}
      </header>
      <dl className="allocation-summary">
        <SummaryRow label={`${storeName} đặt`} total={summary.orderedTotal} tone="ordered">
          <ItemChips items={summary.ordered} empty="Không có đơn đặt mới trong phiên này" />
        </SummaryRow>
        <SummaryRow label="Kết quả" total={summary.grantedTotal} tone="granted">
          <ItemChips items={summary.granted} empty="Chưa được cấp trong phiên này" />
          {summary.grantedForWait.length > 0 ? (
            <p className="allocation-summary__note">
              Trong đó cấp cho phiếu chờ cũ: {summaryText(summary.grantedForWait, '')}
            </p>
          ) : null}
        </SummaryRow>
        <div className="allocation-summary__group">
          <SummaryRow label="Chờ ưu tiên" total={summary.waitingTotal} tone="waiting">
            <ItemChips items={summary.waiting} empty="Không có hàng chờ mới" />
          </SummaryRow>
          {wait && !wait.untracked ? (
            <SummaryRow
              label={<WaitDocumentLabel title="Phiếu chờ cũ" code={wait.before?.code} />}
              total={wait.before?.total ?? 0}
              tone="previous"
            >
              <ItemChips items={wait.before?.items ?? []} empty="Không có phiếu chờ cũ" />
            </SummaryRow>
          ) : null}
        </div>
        {wait && wait.untracked ? (
          <SummaryRow label="Phiếu chờ" tone="neutral">
            <span className="allocation-summary__empty">
              Phiên này diễn ra trước khi có phiếu chờ tổng; xem hàng chờ ở mục Phiếu chờ.
            </span>
          </SummaryRow>
        ) : null}
        {wait && !wait.untracked ? (
          <SummaryRow
            label={<WaitDocumentLabel title="⇒ Phiếu chờ mới" code={wait.after?.code} />}
            total={wait.after?.total ?? 0}
            tone="next"
          >
            <ItemChips items={wait.after?.items ?? []} empty="Không còn phiếu chờ" />
            {wait.after && !wait.changed ? (
              <p className="allocation-summary__note">
                Phiên này không làm đổi phiếu chờ của cửa hàng.
              </p>
            ) : null}
            {wait.after && wait.after.pendingTotal > 0 ? (
              <p className="allocation-summary__note">
                Trong đó {wait.after.pendingTotal} bao đã được cấp, chờ xác nhận phân bổ.
              </p>
            ) : null}
          </SummaryRow>
        ) : null}
        {summary.carried.length > 0 ? (
          <SummaryRow label="Hàng ưu tiên đã cấp, giao chung" tone="neutral">
            <ItemChips items={summary.carried} empty="" />
          </SummaryRow>
        ) : null}
      </dl>
      <details className="allocation-summary-card__details">
        <summary>Chi tiết · {document.resultCode}</summary>
        <div className="document-history">
          <table className="table-density table-density--metrics">
            <thead>
              <tr>
                <th>Mặt hàng</th>
                <th>Đặt</th>
                <th>Được phân bổ</th>
                <th>Chờ ưu tiên</th>
              </tr>
            </thead>
            <tbody>
              {document.lines.map((line) => (
                <tr key={line.productId}>
                  <td>{productName(line.productId)}</td>
                  <td>{line.requestedQuantity}</td>
                  <td>{line.allocatedQuantity}</td>
                  <td>{line.waitlistedQuantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="allocation-summary-card__codes">
          Phiếu đặt {document.orderCode} · Phiếu kết quả {document.resultCode} · phiên bản{' '}
          {document.version}
        </p>
        <h4>Phiếu nguồn và các vòng phân bổ</h4>
        <ul className="allocation-summary-card__sources">
          {document.sources.map((source) => (
            <li key={source.result.id}>{sourceText(source)}</li>
          ))}
        </ul>
      </details>
    </article>
  );
}
