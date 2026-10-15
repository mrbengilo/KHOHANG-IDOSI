import type { SessionDocument, SessionDocumentSource } from '@idosi/contracts';

import { Badge } from '../../components/Badge';
import './allocation-summary.css';
import { Button } from '../../components/Button';
import { decisionCode, decisionStatusLabel, decisionStatusTone } from './allocationDecisionApi';
import { summarizeAllocation, type SummaryItem } from './allocationSummary';

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

/**
 * One store in one session: what it was allocated and what still waits for priority. Codes,
 * sources and rounds stay one click away for audit, not on the face of the card.
 */
export function AllocationResultCard({
  document,
  storeName,
  createdAtText,
  productName,
  sourceText,
  onOpenDecision,
}: {
  readonly document: SessionDocument;
  readonly storeName: string;
  readonly createdAtText: string;
  readonly productName: (productId: string) => string;
  readonly sourceText: (source: SessionDocumentSource) => string;
  readonly onOpenDecision: (decisionId: string) => void;
}) {
  const summary = summarizeAllocation(document, productName);
  const decision = document.decision ?? null;
  return (
    <article className="panel session-document allocation-summary-card" aria-label={storeName}>
      <header className="allocation-summary-card__header">
        <div>
          <h3>{storeName}</h3>
          <small>Phân bổ lúc {createdAtText}</small>
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
        <div className="allocation-summary__row allocation-summary__row--granted">
          <dt>
            Được phân bổ <span>{summary.grantedTotal} bao</span>
          </dt>
          <dd>
            <ItemChips items={summary.granted} empty="Chưa được cấp trong phiên này" />
          </dd>
        </div>
        <div className="allocation-summary__row allocation-summary__row--waiting">
          <dt>
            Đang chờ ưu tiên <span>{summary.waitingTotal} bao</span>
          </dt>
          <dd>
            <ItemChips items={summary.waiting} empty="Không còn hàng chờ" />
          </dd>
        </div>
        {summary.carried.length > 0 ? (
          <div className="allocation-summary__row">
            <dt>Hàng ưu tiên đã cấp, giao chung</dt>
            <dd>
              <ItemChips items={summary.carried} empty="" />
            </dd>
          </div>
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
