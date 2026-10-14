import type { AllocationDecision } from '@idosi/contracts';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  actionableLines,
  allocationDecisionKeys,
  decisionActions,
  decisionCode,
  listAllocationDecisions,
} from '../features/allocations/allocationDecisionApi';
import { useAllocationDecisionResponder } from '../features/allocations/useAllocationDecisionResponder';
import { WaitlistConfirmDialog } from '../features/allocations/WaitlistConfirmDialog';
import { listAccessibleStores, listCatalog } from '../lib/api';
import { useSession } from '../lib/auth';
import type { Role } from '../lib/types';
import { Button } from './Button';
import '../features/allocations/allocation-decisions.css';

const NOTICE_PAGE_SIZE = 5;

const timeFormatter = new Intl.DateTimeFormat('vi-VN', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Ho_Chi_Minh',
});

/**
 * Persistent blue notice for every account that answers results: STORE, the wholesale desk and
 * an assigned HTKD. The server's PENDING decisions are the only source, so it survives reloads
 * and logins until each result is answered (here, on the result page or by another account).
 * Opening or reading it never answers anything; there is no "skip" and no timer.
 */
export function AllocationResultNotice({ role }: { readonly role: Role }) {
  const principal = useSession().data?.principal;
  const accountKey = principal ? `${principal.accountId}:${principal.storeId ?? ''}` : '';
  const enabled =
    principal !== undefined && (role === 'STORE' || role === 'WHOLESALE' || role === 'HTKD');
  const [page, setPage] = useState(1);
  const filters = {
    status: 'PENDING' as const,
    pageSize: NOTICE_PAGE_SIZE,
    ...(page > 1 ? { page } : {}),
  };
  const pendingQuery = useQuery({
    enabled,
    queryFn: () => listAllocationDecisions(filters),
    queryKey: allocationDecisionKeys.list(accountKey, filters),
    // Keep showing the last page while it refreshes: the box never flickers away.
    placeholderData: (previous) => previous,
    refetchInterval: 15_000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const pending = pendingQuery.data?.data ?? [];
  const total = pendingQuery.data?.pagination.totalItems ?? 0;
  const totalPages = pendingQuery.data?.pagination.totalPages ?? 0;
  const catalogQuery = useQuery({
    enabled: pending.length > 0,
    queryFn: listCatalog,
    queryKey: ['catalog'],
    retry: false,
  });
  const storesQuery = useQuery({
    enabled: pending.length > 0,
    queryFn: listAccessibleStores,
    queryKey: ['stores', 'accessible'],
    retry: false,
  });
  const responder = useAllocationDecisionResponder();
  const [confirming, setConfirming] = useState<AllocationDecision | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const lastTotal = useRef<number | null>(null);
  const boxRef = useRef<HTMLElement | null>(null);

  // A newly arrived result is announced once and scrolled into view, without moving focus,
  // so polling never steals the keyboard or a form being filled in.
  useEffect(() => {
    if (!pendingQuery.isSuccess) return;
    const previous = lastTotal.current;
    lastTotal.current = total;
    if (previous !== null && total > previous) {
      setAnnouncement(`Có ${total - previous} kết quả phân bổ mới cần xử lý.`);
      boxRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    }
  }, [pendingQuery.isSuccess, total]);
  // The page we were on can disappear after answering; fall back to the last real page.
  useEffect(() => {
    if (page > 1 && totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  if (!enabled) return null;
  if (pending.length === 0 && pendingQuery.isError) {
    return (
      <aside className="allocation-decision-notice" role="alert">
        <strong>
          Chưa tải được kết quả phân bổ cần xử lý. Có thể vẫn còn kết quả đang chờ; vui lòng thử
          lại.
        </strong>
        <Button onClick={() => void pendingQuery.refetch()} tone="secondary">
          Thử lại
        </Button>
      </aside>
    );
  }
  if (pending.length === 0) {
    return (
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
    );
  }

  const productName = (id: string) =>
    catalogQuery.data?.find((product) => product.id === id)?.name ?? 'Mặt hàng';
  const storeName = new Map(storesQuery.data?.map((store) => [store.id, store.name]));
  const busyDecision = responder.busy?.decisionId ?? null;
  return (
    <aside
      aria-labelledby="allocation-result-notice-title"
      className="allocation-decision-notice allocation-decision-notice--info"
      ref={boxRef}
    >
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <h2 id="allocation-result-notice-title">Có kết quả phân bổ cần xử lý ({total})</h2>
      <p>
        Chọn “Xác nhận phân bổ” để tạo đơn Reshare (mã RE) và xuất kho tổng, hoặc “Chuyển phiếu chờ”
        để trả hàng về kho và đưa nhu cầu trở lại phiếu chờ. Khung này còn hiển thị đến khi mọi kết
        quả được xử lý.
        {pendingQuery.isError ? ' Đang thử tải lại danh sách mới nhất…' : ''}
      </p>
      <ul>
        {pending.map((decision) => {
          const actions = decisionActions(decision);
          const lines = actionableLines(decision).filter((line) => line.actionableQuantity > 0);
          const busy = busyDecision === decision.id ? responder.busy?.action : null;
          const error = responder.error?.decisionId === decision.id ? responder.error : null;
          return (
            <li key={decision.id}>
              <div>
                <strong>Phiếu {decisionCode(decision)}</strong>
                <span>
                  {storeName.get(decision.storeId) ?? 'Cửa hàng'} · Phiên {decision.sessionCode} ·
                  Ngày {decision.businessDate} · Công bố{' '}
                  {timeFormatter.format(new Date(decision.createdAt))}
                </span>
                <span>
                  {lines
                    .map((line) => `${productName(line.productId)}: ${line.actionableQuantity} bao`)
                    .join(' · ')}
                  {(decision.revokedQuantity ?? 0) > 0
                    ? ` · ${decision.revokedQuantity} bao đã thu hồi do hủy phiếu chờ`
                    : ''}
                </span>
                {error ? (
                  <span className="form-error" role="alert">
                    {error.message}
                  </span>
                ) : null}
              </div>
              <div className="allocation-decision-notice__actions">
                {actions.includes('WAITLIST') ? (
                  <Button
                    busy={busy === 'WAITLIST'}
                    disabled={responder.busy !== null}
                    onClick={() => setConfirming(decision)}
                    tone="secondary"
                  >
                    <Undo2 aria-hidden="true" size={18} /> Chuyển phiếu chờ
                  </Button>
                ) : null}
                {actions.includes('ACCEPT') ? (
                  <Button
                    busy={busy === 'ACCEPT'}
                    disabled={responder.busy !== null}
                    onClick={() =>
                      void responder.respond(decision, {
                        action: 'ACCEPT',
                        expectedVersion: decision.version,
                      })
                    }
                    tone="primary"
                  >
                    <CheckCircle2 aria-hidden="true" size={18} /> Xác nhận phân bổ
                  </Button>
                ) : null}
                <Link
                  aria-label={`Xem chi tiết phiếu ${decisionCode(decision)}`}
                  className="button button--secondary"
                  to={`/allocations?decision=${encodeURIComponent(decision.id)}`}
                >
                  Chi tiết
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
      {responder.success ? (
        <div className="inline-notice inline-notice--success" role="status">
          {responder.success.message}
        </div>
      ) : null}
      {totalPages > 1 ? (
        <div className="allocation-decision-notice__footer">
          <span>
            Trang {Math.min(page, totalPages)}/{totalPages} · {total} kết quả đang chờ xử lý.
          </span>
          <Button disabled={page <= 1} onClick={() => setPage(page - 1)} tone="secondary">
            Trước
          </Button>
          <Button disabled={page >= totalPages} onClick={() => setPage(page + 1)} tone="secondary">
            Sau
          </Button>
        </div>
      ) : null}
      {confirming ? (
        <WaitlistConfirmDialog
          busy={busyDecision === confirming.id && responder.busy?.action === 'WAITLIST'}
          decision={confirming}
          error={responder.error?.decisionId === confirming.id ? responder.error.message : null}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            const done = await responder.respond(confirming, {
              action: 'WAITLIST',
              expectedVersion: confirming.version,
            });
            if (done) setConfirming(null);
          }}
          productName={productName}
        />
      ) : null}
    </aside>
  );
}
