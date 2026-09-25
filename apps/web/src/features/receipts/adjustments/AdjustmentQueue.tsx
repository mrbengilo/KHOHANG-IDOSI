import { useQuery } from '@tanstack/react-query';
import type { ReceiptAdjustmentStatus, ReceiptReturnStatus } from '@idosi/contracts';
import { ClipboardList } from 'lucide-react';

import { Badge } from '../../../components/Badge';
import { listReceiptAdjustments, listReceiptReturns } from './adjustmentApi';
import { adjustmentStatusCopy, returnStatusCopy, type AdjustmentAudience } from './adjustmentModel';

type Role = AdjustmentAudience;

/** What each role has to act on next; the server scopes both lists to the caller. */
const WAITING_ON: Record<Role, readonly ReceiptAdjustmentStatus[]> = {
  STORE: ['NEEDS_INFO'],
  HTKD: ['PENDING_HTKD'],
  ADMIN: ['PENDING_ADMIN', 'PENDING_HTKD'],
};
const RETURNS_WAITING_ON: Record<Role, readonly ReceiptReturnStatus[]> = {
  STORE: ['PENDING_HANDOVER'],
  HTKD: ['PENDING_HANDOVER'],
  ADMIN: ['IN_TRANSIT', 'DISPUTED'],
};

export function AdjustmentQueue({
  onOpen,
  role,
  storeNameById,
}: {
  readonly onOpen: (receiptId: string, adjustmentId: string, storeId: string) => void;
  readonly role: Role;
  readonly storeNameById: ReadonlyMap<string, string>;
}) {
  const adjustments = useQuery({
    queryFn: async () =>
      (
        await Promise.all(WAITING_ON[role].map((status) => listReceiptAdjustments({ status })))
      ).flat(),
    queryKey: ['receipt-adjustments', 'queue', role],
    retry: false,
  });
  const returns = useQuery({
    queryFn: async () =>
      (
        await Promise.all(RETURNS_WAITING_ON[role].map((status) => listReceiptReturns({ status })))
      ).flat(),
    queryKey: ['receipt-returns', 'queue', role],
    retry: false,
  });
  const items = adjustments.data ?? [];
  const returnItems = returns.data ?? [];
  if (items.length === 0 && returnItems.length === 0) return null;
  return (
    <section className="panel adjustment-queue" aria-label="Hồ sơ sai lệch cần xử lý">
      <div className="section-heading section-heading--compact">
        <div>
          <h2>
            <ClipboardList aria-hidden="true" size={18} /> Sai lệch sau chốt cần xử lý
          </h2>
          <p>Chọn hồ sơ để mở phiếu nhận gốc và thao tác theo đúng vai trò.</p>
        </div>
      </div>
      <ul className="adjustment-list">
        {items.map((item) => {
          const copy = adjustmentStatusCopy[item.status];
          return (
            <li key={item.id}>
              <button
                className="adjustment-card"
                onClick={() => onOpen(item.receiptId, item.id, item.storeId)}
                type="button"
              >
                <span className="adjustment-card__identity">
                  <strong>
                    {item.code} · {item.receiptNumber}
                  </strong>
                  <small>{storeNameById.get(item.storeId) ?? 'Cửa hàng'}</small>
                </span>
                <Badge tone={copy.tone}>{copy.label}</Badge>
                <span className="adjustment-card__meta">{item.reason}</span>
              </button>
            </li>
          );
        })}
        {returnItems.map((item) => {
          const copy = returnStatusCopy[item.status];
          return (
            <li key={item.id}>
              <button
                className="adjustment-card"
                onClick={() => onOpen(item.receiptId, item.adjustmentId, item.storeId)}
                type="button"
              >
                <span className="adjustment-card__identity">
                  <strong>
                    {item.code} · từ {item.adjustmentCode}
                  </strong>
                  <small>{storeNameById.get(item.storeId) ?? 'Cửa hàng'}</small>
                </span>
                <Badge tone={copy.tone}>{copy.label}</Badge>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
