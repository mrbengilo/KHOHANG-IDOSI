import type { ListOrderHistoryResponse, OrderHistoryEntry } from '@idosi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { readOrderHistoryFilters } from './orderHistoryNavigation';
import { StoreOrderHistory } from './StoreOrderHistory';

const session = {
  id: '10000000-0000-4000-8000-000000000002',
  code: 'PDH-000042',
  kind: 'MANUAL' as const,
  businessDate: '2026-10-02',
  status: 'ALLOCATED' as const,
  requestOpensAt: '2026-10-01T17:00:00.000Z',
  requestClosesAt: '2026-10-02T03:00:00.000Z',
  allocationStartsAt: '2026-10-02T04:00:00.000Z',
  completedAt: '2026-10-02T04:00:05.000Z',
};

const entry = (overrides: Partial<OrderHistoryEntry>): OrderHistoryEntry => ({
  id: '40000000-0000-4000-8000-000000000001',
  code: 'PDT-000101',
  requestSequence: 1,
  status: 'ALLOCATED',
  storeId: '20000000-0000-4000-8000-00000000000a',
  storeCode: 'CH01',
  storeName: 'Cửa hàng Một',
  session,
  submittedAt: '2026-10-01T18:05:09.000Z',
  submittedBy: { accountId: '50000000-0000-4000-8000-000000000001', displayName: 'HTKD Một' },
  cancelledAt: null,
  cancellationReason: null,
  mergedDocument: {
    sessionId: session.id,
    storeId: '20000000-0000-4000-8000-00000000000a',
    mergedOrderId: '60000000-0000-4000-8000-000000000001',
    version: 1,
  },
  lines: [
    {
      id: '70000000-0000-4000-8000-000000000001',
      productId: '30000000-0000-4000-8000-000000000001',
      sku: 'AO-NAM',
      productName: 'Áo nam',
      unit: 'BAG',
      requestedQuantity: 2,
      matchesFilter: true,
    },
    {
      id: '70000000-0000-4000-8000-000000000002',
      productId: '30000000-0000-4000-8000-000000000002',
      sku: 'QUAN-NU',
      productName: 'Quần nữ',
      unit: 'BAG',
      requestedQuantity: 3,
      matchesFilter: true,
    },
  ],
  ...overrides,
});

function render(url: string, response?: ListOrderHistoryResponse) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(['catalog'], []);
  if (response) {
    const filters = readOrderHistoryFilters(new URL(url, 'http://local').searchParams);
    client.setQueryData(['order-history', 'account-1', filters], response);
  }
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={client}>
        <StoreOrderHistory
          accountKey="account-1"
          onOpenDocument={() => undefined}
          sessions={[]}
          stores={[]}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const page = (data: OrderHistoryEntry[]): ListOrderHistoryResponse => ({
  data,
  pagination: { page: 1, pageSize: 20, totalItems: data.length, totalPages: data.length ? 1 : 0 },
});

describe('store order history', () => {
  it('shows every original line with its quantity, session identity and document link', () => {
    const html = render(
      '/allocation?tab=history',
      page([
        entry({}),
        entry({
          id: '40000000-0000-4000-8000-000000000002',
          code: 'PDT-000102',
          status: 'CANCELLED',
          cancelledAt: '2026-10-01T19:00:00.000Z',
          cancellationReason: 'Nhập nhầm',
          mergedDocument: null,
        }),
      ]),
    );
    expect(html).toContain('PDT-000101');
    expect(html).toContain('Áo nam');
    expect(html).toContain('Quần nữ');
    expect(html).toContain('tổng đặt 5 bao');
    expect(html).toContain('PDH-000042');
    expect(html).toContain('Phiên bổ sung');
    expect(html).toContain('Chốt nhận 10:00 · phân bổ 11:00');
    // Submitted 01:05:09 on 02/10 in Vietnam although the instant is the previous UTC day.
    expect(html).toContain('02/10/2026');
    expect(html).toContain('01:05:09');
    expect(html).toContain('Đã gộp · cấp đủ');
    expect(html).toContain('Xem chứng từ phiên PDH-000042 của Cửa hàng Một');
    expect(html).toContain('Lý do: Nhập nhầm');
    expect(html.match(/aria-label="Xem chứng từ phiên/g)).toHaveLength(1);
  });

  it('separates loading, empty and filtered-empty states', () => {
    expect(render('/allocation?tab=history')).toContain('Đang tải lịch sử đặt hàng');
    expect(render('/allocation?tab=history', page([]))).toContain('Chưa có cửa hàng nào');
    expect(render('/allocation?tab=history&ls.status=CANCELLED', page([]))).toContain(
      'Không có phiếu khớp bộ lọc',
    );
  });
});
