import type { Session } from '@idosi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { allocationDecisionKeys } from '../features/allocations/allocationDecisionApi';
import { TEST_PRODUCT_ID, TEST_STORE_ID, testDecision } from '../features/allocations/testDecision';
import { sessionQueryKey } from '../lib/auth';
import { AllocationResultNotice } from './AllocationResultNotice';

function session(role: Session['principal']['role']): Session {
  return {
    id: '51000000-0000-4000-8000-000000000001',
    createdAt: '2026-10-05T00:00:00.000Z',
    expiresAt: '2026-10-06T00:00:00.000Z',
    lastSeenAt: '2026-10-05T00:05:00.000Z',
    principal: {
      accountId: '50000000-0000-4000-8000-000000000001',
      assignedStoreIds: role === 'STORE' ? [] : [TEST_STORE_ID],
      displayName: 'Người dùng thử',
      role,
      status: 'ACTIVE',
      storeId: role === 'STORE' ? TEST_STORE_ID : null,
      username: 'notice-test',
    },
  };
}

function render(role: Session['principal']['role'], total = 1) {
  const current = session(role);
  const client = new QueryClient();
  client.setQueryData(sessionQueryKey, current);
  const { sources: _sources, ...summary } = testDecision();
  client.setQueryData(
    allocationDecisionKeys.list(
      `${current.principal.accountId}:${current.principal.storeId ?? ''}`,
      {
        status: 'PENDING',
        pageSize: 5,
      },
    ),
    {
      data: [summary],
      pagination: { page: 1, pageSize: 5, totalItems: total, totalPages: Math.ceil(total / 5) },
    },
  );
  client.setQueryData(['catalog'], [{ id: TEST_PRODUCT_ID, name: 'Áo nữ' }]);
  client.setQueryData(['stores', 'accessible'], [{ id: TEST_STORE_ID, name: 'Cửa hàng thử' }]);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AllocationResultNotice role={role} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('allocation result notice', () => {
  it.each(['STORE', 'WHOLESALE'] as const)(
    'tells %s which result to confirm and links it',
    (role) => {
      const html = render(role, 7);
      expect(html).toContain('Có kết quả phân bổ cần xác nhận (7)');
      expect(html).toContain('Phiếu KQ-PDH-000042-A1B2C3D4');
      expect(html).toContain('Áo nữ: 3 bao');
      expect(html).toContain(`/allocations?decision=${testDecision().id}`);
      expect(html).toContain('Còn 6 phiếu khác');
      expect(html).toContain('/allocations?decisionStatus=PENDING');
    },
  );

  it.each(['ADMIN', 'HTKD'] as const)(
    'stays silent for %s, who never answers for a store',
    (role) => {
      expect(render(role)).toBe('');
    },
  );
});
