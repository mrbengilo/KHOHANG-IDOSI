import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import {
  allocationDecisionKeys,
  decisionCode,
  listAllocationDecisions,
} from '../features/allocations/allocationDecisionApi';
import { listAccessibleStores, listCatalog } from '../lib/api';
import { useSession } from '../lib/auth';
import type { Role } from '../lib/types';
import '../features/allocations/allocation-decisions.css';

const NOTICE_PAGE_SIZE = 5;

/**
 * Persistent in-app notice for the receiving side: the server's PENDING decisions are the source,
 * so it survives reloads and logins until the store answers. Opening it never answers anything.
 */
export function AllocationResultNotice({ role }: { readonly role: Role }) {
  const principal = useSession().data?.principal;
  const accountKey = principal ? `${principal.accountId}:${principal.storeId ?? ''}` : '';
  const enabled = principal !== undefined && (role === 'STORE' || role === 'WHOLESALE');
  const filters = { status: 'PENDING' as const, pageSize: NOTICE_PAGE_SIZE };
  const pendingQuery = useQuery({
    enabled,
    queryFn: () => listAllocationDecisions(filters),
    queryKey: allocationDecisionKeys.list(accountKey, filters),
    refetchInterval: 15_000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const pending = pendingQuery.data?.data ?? [];
  const total = pendingQuery.data?.pagination.totalItems ?? 0;
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

  if (!enabled) return null;
  if (pending.length === 0 && pendingQuery.isError) {
    return (
      <aside className="allocation-decision-notice" role="alert">
        <strong>Chưa tải được kết quả phân bổ cần xác nhận.</strong>
        <button
          className="button button--secondary"
          onClick={() => void pendingQuery.refetch()}
          type="button"
        >
          Thử lại
        </button>
      </aside>
    );
  }
  if (pending.length === 0) return null;

  const productName = new Map(catalogQuery.data?.map((product) => [product.id, product.name]));
  const storeName = new Map(storesQuery.data?.map((store) => [store.id, store.name]));
  return (
    <aside aria-label="Kết quả phân bổ cần xác nhận" className="allocation-decision-notice">
      <h2>Có kết quả phân bổ cần xác nhận ({total})</h2>
      <p>
        Mở từng phiếu để Chấp nhận hoặc Từ chối. Hàng chỉ được xuất kho sau khi cửa hàng chấp nhận.
      </p>
      <ul>
        {pending.map((decision) => (
          <li key={decision.id}>
            <div>
              <strong>Phiếu {decisionCode(decision)}</strong>
              <span>
                {role === 'WHOLESALE' ? `${storeName.get(decision.storeId) ?? 'Cửa hàng'} · ` : ''}
                Phiên {decision.sessionCode} · Ngày {decision.businessDate}
              </span>
              <span>
                {decision.lines
                  .filter((line) => line.allocatedQuantity > 0)
                  .map(
                    (line) =>
                      `${productName.get(line.productId) ?? 'Mặt hàng'}: ${line.allocatedQuantity} bao`,
                  )
                  .join(' · ')}
              </span>
            </div>
            <Link
              aria-label={`Mở phiếu ${decisionCode(decision)} để xác nhận`}
              className="button button--primary"
              to={`/allocations?decision=${encodeURIComponent(decision.id)}`}
            >
              Mở phiếu
            </Link>
          </li>
        ))}
      </ul>
      {total > pending.length ? (
        <div className="allocation-decision-notice__footer">
          <span>Còn {total - pending.length} phiếu khác đang chờ xác nhận.</span>
          <Link className="button button--secondary" to="/allocations?decisionStatus=PENDING">
            Xem tất cả
          </Link>
        </div>
      ) : null}
    </aside>
  );
}
