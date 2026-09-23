import type { RespondPriorityOfferRequest } from '@idosi/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  listAccessibleStores,
  listCatalog,
  listPriorityOffers,
  respondPriorityOffer,
} from '../lib/api';
import { useSession } from '../lib/auth';
import { retainIdempotencyForExactRetry, type RetryAttempt } from '../lib/idempotency-retry';
import type { Role } from '../lib/types';
import { PriorityOffer } from './PriorityOffer';

export function PriorityOfferNotice({ role }: { readonly role: Role }) {
  const principal = useSession().data?.principal;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<{ id: string; action: 'ACCEPT' | 'DECLINE' } | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const attempt = useRef<RetryAttempt | null>(null);
  const inFlight = useRef(false);
  const enabled =
    principal !== undefined && (role === 'STORE' || role === 'HTKD' || role === 'WHOLESALE');
  const offersQuery = useQuery({
    enabled,
    queryFn: () => listPriorityOffers({ status: 'PENDING' }),
    queryKey: ['priority-offer-notices', principal?.accountId],
    refetchInterval: 15_000,
    retry: false,
  });
  const offers = offersQuery.data ?? [];
  const catalogQuery = useQuery({
    enabled: offers.length > 0,
    queryFn: listCatalog,
    queryKey: ['priority-offer-notice-catalog'],
    retry: false,
  });
  const storesQuery = useQuery({
    enabled: offers.length > 0,
    queryFn: listAccessibleStores,
    queryKey: ['priority-offer-notice-stores', principal?.accountId],
    retry: false,
  });

  const respond = async (offerId: string, input: RespondPriorityOfferRequest) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const fingerprint = `${offerId}:${JSON.stringify(input)}`;
    const retry = retainIdempotencyForExactRetry(attempt.current, fingerprint);
    attempt.current = retry;
    setBusy({ id: offerId, action: input.action });
    setError(null);
    try {
      await respondPriorityOffer(offerId, input, retry.key);
      attempt.current = null;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['priority-offer-notices'] }),
        queryClient.invalidateQueries({ queryKey: ['priority-offers'] }),
        queryClient.invalidateQueries({ queryKey: ['wait-tickets'] }),
      ]);
    } catch (cause) {
      setError({
        id: offerId,
        message:
          cause instanceof Error ? cause.message : 'Không thể ghi nhận phản hồi. Vui lòng thử lại.',
      });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  if (offers.length === 0 && offersQuery.isError) {
    return (
      <aside className="priority-offer-notices" role="alert">
        <strong>Chưa tải được lượt ưu tiên cần xác nhận.</strong>
        <button onClick={() => void offersQuery.refetch()} type="button">
          Thử lại
        </button>
      </aside>
    );
  }
  if (offers.length === 0) return null;
  const productNames = new Map(catalogQuery.data?.map((product) => [product.id, product.name]));
  const storeNames = new Map(storesQuery.data?.map((store) => [store.id, store.name]));
  return (
    <aside aria-label="Thông báo xác nhận hàng ưu tiên" className="priority-offer-notices">
      <h2>Hàng ưu tiên đang giữ trong kho — xác nhận có nhận không?</h2>
      <p>Cửa hàng hoặc HTKD quản lý có thể phản hồi. Người phản hồi đầu tiên sẽ được ghi nhận.</p>
      {offers.map((offer) => (
        <div key={offer.id}>
          <strong>{storeNames.get(offer.storeId) ?? 'Cửa hàng'}</strong>
          <PriorityOffer
            busyAction={busy?.id === offer.id ? busy.action : null}
            canRespond
            error={error?.id === offer.id ? error.message : null}
            interactionDisabled={busy !== null}
            offer={offer}
            onExpired={() => void offersQuery.refetch()}
            onOpenTicket={() => navigate(role === 'HTKD' ? '/allocations' : '/requests')}
            onRespond={(input) => void respond(offer.id, input)}
            productName={productNames.get(offer.productId) ?? offer.productId}
          />
        </div>
      ))}
    </aside>
  );
}
