import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { useSession } from '../../lib/auth';
import {
  allocationDecisionKeys,
  decisionCode,
  decisionStatusLabel,
  listAllocationDecisions,
} from '../allocations/allocationDecisionApi';

/** Resolve only the selected shipment, preserving the server's store scope and pagination. */
export function ReceiptAllocationLink({
  outboundRequestId,
}: {
  readonly outboundRequestId: string;
}) {
  const principal = useSession().data?.principal;
  const accountKey = principal ? `${principal.accountId}:${principal.storeId ?? ''}` : '';
  const filters = { outboundRequestId, pageSize: 1 };
  const query = useQuery({
    enabled: principal !== undefined,
    queryKey: allocationDecisionKeys.list(accountKey, filters),
    queryFn: () => listAllocationDecisions(filters),
    retry: false,
  });
  if (query.isPending) return <p role="status">Đang tải liên kết kết quả phân bổ…</p>;
  if (query.isError)
    return (
      <p role="alert">
        Không thể tải liên kết kết quả phân bổ.{' '}
        <button type="button" onClick={() => void query.refetch()}>
          Thử lại
        </button>
      </p>
    );
  const decision = query.data?.data[0];
  if (!decision) return null;
  return (
    <p>
      <Link to={`/allocations?decision=${encodeURIComponent(decision.id)}`}>
        Phiếu kết quả {decisionCode(decision)}
      </Link>{' '}
      · {decisionStatusLabel[decision.status]} · Thực nhận được theo dõi riêng trên phiếu nhận này.
    </p>
  );
}
