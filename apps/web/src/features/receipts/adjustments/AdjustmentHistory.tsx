import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ReceiptAdjustmentHistoryEvent } from '@idosi/contracts';
import { History } from 'lucide-react';
import { useId, useState } from 'react';

import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { ApiClientError } from '../../../lib/api';
import type { StatusTone } from '../../../lib/types';
import { adjustmentSyncOptions, listReceiptAdjustmentHistory } from './adjustmentApi';
import {
  accountLabel,
  adjustmentStatusCopy,
  auditRoleCopy,
  causeCopy,
  formatExactVnd,
  formatSignedVnd,
  historyEventCopy,
  NOT_RECORDED,
  returnStatusCopy,
  storeLabel,
} from './adjustmentModel';
import { SyncNotice } from './SyncNotice';

export const HISTORY_PAGE_SIZE = 20;

const eventTime = new Intl.DateTimeFormat('vi-VN', {
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  month: '2-digit',
  second: '2-digit',
  timeZone: 'Asia/Ho_Chi_Minh',
  year: 'numeric',
});

export function formatEventTime(iso: string): string {
  return eventTime.format(new Date(iso));
}

function statusCopy(
  event: ReceiptAdjustmentHistoryEvent,
  value: ReceiptAdjustmentHistoryEvent['statusAfter'],
): { readonly label: string; readonly tone: StatusTone } {
  if (value === null) return { label: NOT_RECORDED, tone: 'neutral' };
  const copy =
    event.subject === 'RETURN'
      ? returnStatusCopy[value as keyof typeof returnStatusCopy]
      : adjustmentStatusCopy[value as keyof typeof adjustmentStatusCopy];
  return copy ?? { label: NOT_RECORDED, tone: 'neutral' };
}

/** The business facts one event recorded, in reading order; missing facts are left out. */
export function historyFacts(event: ReceiptAdjustmentHistoryEvent): string[] {
  const facts: string[] = [];
  const { changes } = event;
  if (changes.reason) facts.push(`Lý do: ${changes.reason}`);
  if (changes.evidenceNote) facts.push(`Bằng chứng: ${changes.evidenceNote}`);
  if (changes.lineCount !== null && event.type !== 'APPLIED') {
    facts.push(`${changes.lineCount} bao`);
  }
  if (changes.cause) facts.push(`Nguyên nhân: ${causeCopy[changes.cause]}`);
  if (changes.goodsDeltaVnd !== null) {
    facts.push(`Chênh lệch tiền hàng ${formatSignedVnd(changes.goodsDeltaVnd)}`);
  }
  const fees = [
    ['vận chuyển', changes.freightDeltaVnd],
    ['bốc xếp', changes.handlingDeltaVnd],
    ['VAT', changes.vatDeltaVnd],
  ] as const;
  for (const [label, value] of fees) {
    if (value !== null && value !== 0) facts.push(`Chênh lệch ${label} ${formatSignedVnd(value)}`);
  }
  if (changes.totalBeforeVnd !== null || changes.totalAfterVnd !== null) {
    facts.push(
      `Tổng ${formatExactVnd(changes.totalBeforeVnd)} → ${formatExactVnd(changes.totalAfterVnd)}`,
    );
  }
  if (changes.appliedSequence !== null) facts.push(`Điều chỉnh thứ ${changes.appliedSequence}`);
  if (changes.entitlementCount !== null && changes.entitlementCount > 0) {
    facts.push(`${changes.entitlementCount} quyền chờ bù P0B`);
  }
  if (changes.returnCount !== null && changes.returnCount > 0) {
    facts.push(`${changes.returnCount} phiếu trả kho`);
  }
  if (changes.releasedBagCount !== null && changes.releasedBagCount > 0) {
    facts.push(`Gỡ giữ ${changes.releasedBagCount} bao`);
  }
  return facts;
}

/**
 * Timeline of one document from the immutable audit log, oldest first and paged by the server.
 * Unrecorded actors, notes or states read "Chưa ghi nhận"; nothing is inferred.
 */
export function AdjustmentHistory({ adjustmentId }: { readonly adjustmentId: string }) {
  const [page, setPage] = useState(1);
  const headingId = useId();
  const query = useQuery({
    placeholderData: keepPreviousData,
    queryFn: () => listReceiptAdjustmentHistory(adjustmentId, page, HISTORY_PAGE_SIZE),
    queryKey: ['receipt-adjustment-history', adjustmentId, page],
    retry: false,
    ...adjustmentSyncOptions,
  });
  const result = query.data;
  return (
    <section aria-labelledby={headingId} className="adjustment-history">
      <h4 id={headingId}>
        <History aria-hidden="true" size={16} /> Lịch sử xử lý
      </h4>
      {query.isPending ? (
        <p className="adjustment-note" role="status">
          Đang tải lịch sử xử lý…
        </p>
      ) : !result ? (
        <div className="receipt-error" role="alert">
          <span>
            {query.error instanceof ApiClientError && query.error.status === 403
              ? 'Tài khoản không có quyền xem lịch sử hồ sơ này.'
              : 'Không tải được lịch sử xử lý.'}
          </span>
          <button onClick={() => void query.refetch()} type="button">
            Thử lại
          </button>
        </div>
      ) : (
        <>
          <SyncNotice query={query} />
          {result.data.length === 0 ? (
            <p className="adjustment-note">Chưa ghi nhận sự kiện nào cho hồ sơ này.</p>
          ) : (
            <ol className="adjustment-timeline">
              {result.data.map((event) => (
                <HistoryItem event={event} key={event.id} />
              ))}
            </ol>
          )}
          {result.pagination.totalPages > 1 ? (
            <div className="adjustment-pager">
              <Button disabled={page <= 1} onClick={() => setPage(page - 1)} tone="secondary">
                Sự kiện trước
              </Button>
              <span>
                Trang {page}/{result.pagination.totalPages} · {result.pagination.totalItems} sự kiện
              </span>
              <Button
                disabled={page >= result.pagination.totalPages}
                onClick={() => setPage(page + 1)}
                tone="secondary"
              >
                Sự kiện sau
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function HistoryItem({ event }: { readonly event: ReceiptAdjustmentHistoryEvent }) {
  const facts = historyFacts(event);
  const final = event.type === 'APPLIED' || event.type === 'REJECTED' || event.type === 'CANCELLED';
  const before = statusCopy(event, event.statusBefore);
  const after = statusCopy(event, event.statusAfter);
  return (
    <li className={final ? 'adjustment-timeline__item final' : 'adjustment-timeline__item'}>
      <div className="adjustment-timeline__head">
        <strong>
          {historyEventCopy[event.type]}
          {event.type === 'OTHER' ? ` (${event.action})` : ''}
          {event.returnCode ? ` · ${event.returnCode}` : ''}
        </strong>
        <time dateTime={event.occurredAt}>{formatEventTime(event.occurredAt)}</time>
      </div>
      <p>
        {accountLabel(event.actor)} ·{' '}
        {event.actor.role
          ? auditRoleCopy[event.actor.role]
          : `Vai trò ${NOT_RECORDED.toLowerCase()}`}{' '}
        · {storeLabel(event.store)}
      </p>
      <p className="adjustment-timeline__status">
        {event.type === 'REPORTED' && event.statusBefore === null ? (
          <Badge tone="neutral">Tạo mới</Badge>
        ) : (
          <Badge tone="neutral">{before.label}</Badge>
        )}
        <span aria-hidden="true">→</span>
        <span className="sr-only">chuyển sang</span>
        <Badge tone={after.tone}>{after.label}</Badge>
      </p>
      <p>Ghi chú: {event.note ?? NOT_RECORDED}</p>
      {facts.length > 0 ? <p className="adjustment-timeline__facts">{facts.join(' · ')}</p> : null}
    </li>
  );
}
