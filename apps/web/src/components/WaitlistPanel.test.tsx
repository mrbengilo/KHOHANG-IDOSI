import type { PriorityOffer, Session, WaitTicket } from '@idosi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { sessionQueryKey } from '../lib/auth';
import { WaitlistPanel } from './WaitlistPanel';
import type { Role } from '../lib/types';

const accountId = '50000000-0000-4000-8000-000000000001';
const storeId = '20000000-0000-4000-8000-000000000001';
const otherStoreId = '20000000-0000-4000-8000-000000000002';
const productId = '40000000-0000-4000-8000-000000000001';

function storeSession(): Session {
  return {
    createdAt: '2026-09-17T00:00:00.000Z',
    expiresAt: '2026-09-18T00:00:00.000Z',
    id: '51000000-0000-4000-8000-000000000001',
    lastSeenAt: '2026-09-17T00:05:00.000Z',
    principal: {
      accountId,
      assignedStoreIds: [],
      displayName: 'Cửa hàng Gò Vấp',
      role: 'STORE',
      status: 'ACTIVE',
      storeId,
      username: 'store.govap',
    },
  };
}

function waitTicket(id: string, targetStoreId = storeId): WaitTicket {
  return {
    createdAt: '2026-09-17T00:00:00.000Z',
    fulfilled: { kind: 'UNIT', quantity: 0 },
    id,
    mergedOrderId: null,
    priority: 'P1',
    productId,
    remaining: { kind: 'UNIT', quantity: 3 },
    requested: { kind: 'UNIT', quantity: 3 },
    sessionId: '10000000-0000-4000-8000-000000000001',
    status: 'OFFERED',
    storeId: targetStoreId,
    updatedAt: '2026-09-17T00:05:00.000Z',
  };
}

function priorityOffer(id: string, waitTicketId: string, targetStoreId = storeId): PriorityOffer {
  return {
    accepted: null,
    expiresAt: '2099-09-17T01:00:00.000Z',
    id,
    offered: { kind: 'UNIT', quantity: 3 },
    offeredAt: '2026-09-17T00:05:00.000Z',
    productId,
    respondedAt: null,
    status: 'PENDING',
    storeId: targetStoreId,
    waitTicketId,
  };
}

function renderPanel(
  session: Session,
  role: Role,
  tickets: WaitTicket[],
  offers: PriorityOffer[],
  scopeStoreId?: string,
): string {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const scopeKey = scopeStoreId ?? 'accessible';
  client.setQueryData(sessionQueryKey, session);
  client.setQueryData(['wait-tickets', session.principal.accountId, scopeKey], tickets);
  client.setQueryData(['priority-offers', session.principal.accountId, scopeKey], offers);

  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <WaitlistPanel
        productNameById={new Map([[productId, 'Đồ nam']])}
        role={role}
        {...(scopeStoreId ? { scopeStoreId } : {})}
      />
    </QueryClientProvider>,
  );
}

describe('waitlist panel authorization projection', () => {
  it('renders every pending offer for the authenticated store and filters foreign records', () => {
    const firstTicketId = '70000000-0000-4000-8000-000000000001';
    const secondTicketId = '70000000-0000-4000-8000-000000000002';
    const foreignTicketId = '70000000-0000-4000-8000-000000000003';
    const html = renderPanel(
      storeSession(),
      'STORE',
      [
        waitTicket(firstTicketId),
        waitTicket(secondTicketId),
        waitTicket(foreignTicketId, otherStoreId),
      ],
      [
        priorityOffer('71000000-0000-4000-8000-000000000001', firstTicketId),
        priorityOffer('71000000-0000-4000-8000-000000000002', secondTicketId),
        priorityOffer('71000000-0000-4000-8000-000000000003', foreignTicketId, otherStoreId),
      ],
      storeId,
    );

    expect(html.match(/Nhận đủ/g)).toHaveLength(2);
    expect(html.match(/Hủy phiếu/g)).toHaveLength(2);
    expect(html).not.toContain(foreignTicketId);
  });

  it('keeps global ADMIN oversight read-only', () => {
    const session: Session = {
      ...storeSession(),
      principal: {
        ...storeSession().principal,
        assignedStoreIds: [],
        role: 'ADMIN',
        storeId: null,
      },
    };
    const ticketId = '70000000-0000-4000-8000-000000000001';
    const html = renderPanel(
      session,
      'ADMIN',
      [waitTicket(ticketId)],
      [priorityOffer('71000000-0000-4000-8000-000000000001', ticketId)],
    );

    expect(html).toContain('Chỉ đọc');
    expect(html).not.toContain('Nhận đủ</span>');
    expect(html).not.toContain('Hủy phiếu</button>');
    expect(html).toContain('Mở phiếu');
  });

  it.each(['HTKD', 'WHOLESALE'] as const)(
    'allows %s to respond to scoped priority offers',
    (role) => {
      const session: Session = {
        ...storeSession(),
        principal: {
          ...storeSession().principal,
          assignedStoreIds: [storeId],
          role,
          storeId: null,
        },
      };
      const ticketId = '70000000-0000-4000-8000-000000000004';
      const html = renderPanel(
        session,
        role,
        [waitTicket(ticketId)],
        [priorityOffer('71000000-0000-4000-8000-000000000004', ticketId)],
        storeId,
      );
      expect(html).toContain('Nhận đủ');
      expect(html).toContain('Từ chối');
      expect(html.includes('Hủy phiếu</button>')).toBe(role === 'WHOLESALE');
    },
  );
});
