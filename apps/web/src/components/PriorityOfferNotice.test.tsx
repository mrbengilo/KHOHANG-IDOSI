import type { PriorityOffer, Session } from '@idosi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { sessionQueryKey } from '../lib/auth';
import { PriorityOfferNotice } from './PriorityOfferNotice';

const storeId = '20000000-0000-4000-8000-000000000001';
const productId = '40000000-0000-4000-8000-000000000001';

describe('priority offer notification', () => {
  it.each(['STORE', 'HTKD', 'WHOLESALE'] as const)(
    'shows a large actionable notice for %s',
    (role) => {
      const session: Session = {
        id: '51000000-0000-4000-8000-000000000001',
        createdAt: '2026-09-17T00:00:00.000Z',
        expiresAt: '2026-09-18T00:00:00.000Z',
        lastSeenAt: '2026-09-17T00:05:00.000Z',
        principal: {
          accountId: '50000000-0000-4000-8000-000000000001',
          assignedStoreIds: role === 'STORE' ? [] : [storeId],
          displayName: 'Người dùng thử',
          role,
          status: 'ACTIVE',
          storeId: role === 'STORE' ? storeId : null,
          username: 'notice-test',
        },
      };
      const offer: PriorityOffer = {
        id: '71000000-0000-4000-8000-000000000001',
        storeId,
        productId,
        waitTicketId: '70000000-0000-4000-8000-000000000001',
        offered: { kind: 'UNIT', quantity: 2 },
        accepted: null,
        status: 'PENDING',
        offeredAt: '2026-09-17T00:05:00.000Z',
        expiresAt: '2099-09-17T01:00:00.000Z',
        respondedAt: null,
      };
      const client = new QueryClient();
      client.setQueryData(sessionQueryKey, session);
      client.setQueryData(['priority-offer-notices', session.principal.accountId], [offer]);
      client.setQueryData(['priority-offer-notice-catalog'], [{ id: productId, name: 'Áo nam' }]);
      client.setQueryData(
        ['priority-offer-notice-stores', session.principal.accountId],
        [{ id: storeId, name: 'Cửa hàng thử' }],
      );
      const html = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <PriorityOfferNotice role={role} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      expect(html).toContain('xác nhận có nhận không?');
      expect(html).toContain('Cửa hàng thử');
      expect(html).toContain('Áo nam');
      expect(html).toContain('Nhận đủ');
      expect(html).toContain('Từ chối');
    },
  );
});
