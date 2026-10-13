import type { SupplierCommitmentsResponse } from '@idosi/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CommitmentTable } from './CommitmentTable';

const page = (scoped: boolean, totalPages = 1): SupplierCommitmentsResponse => ({
  data: [
    {
      kind: 'RESERVATION',
      id: '10000000-0000-4000-8000-000000000001',
      commitmentKey: '10000000-0000-4000-8000-000000000002',
      productId: '10000000-0000-4000-8000-000000000003',
      sku: 'NAM-01',
      productName: 'Đồ nam',
      storeId: '10000000-0000-4000-8000-000000000004',
      storeCode: 'CH01',
      storeName: 'Cửa hàng 1',
      orderSessionId: '10000000-0000-4000-8000-000000000005',
      orderSessionCode: 'PH-12/10',
      businessDate: '2026-10-12',
      allocationRunId: null,
      allocationLineId: null,
      priorityLevel: 'P1',
      decisionStatus: 'accepted',
      outboundRequestNumber: null,
      outboundStatus: null,
      quantity: 3,
      orderedQuantity: 0,
      cancelledQuantity: 0,
      unorderedQuantity: 3,
      orderState: 'NOT_ORDERED',
      orderable: true,
      notOrderableReason: null,
      heldSince: '2026-10-12T02:00:00.000Z',
      deadlineAt: null,
      htkdNames: ['HTKD A'],
    },
  ],
  pagination: { page: 1, pageSize: 20, totalItems: totalPages * 20, totalPages },
  totals: { quantity: 30, orderedQuantity: 4, unorderedQuantity: 26 },
  scoped,
});

describe('CommitmentTable', () => {
  it('shows server totals for every page and says when the view is scoped', () => {
    const html = renderToStaticMarkup(
      <CommitmentTable caption="Có thể đặt" page={page(true, 2)} />,
    );
    expect(html).toContain('30 bao đang giữ');
    expect(html).toContain('<strong>26</strong> bao');
    expect(html).toContain('trang này: 3 giữ / 3 chưa đặt');
    expect(html).toContain('Chỉ gồm cửa hàng thuộc phạm vi tài khoản');
    expect(html).toContain('Chưa đặt Reshare');
    expect(html).toContain('PH-12/10');
    expect(html).toContain('data-label="Chưa đặt"');
  });

  it('renders the order picker with accessible names only when selecting', () => {
    const readOnly = renderToStaticMarkup(
      <CommitmentTable caption="Hàng đang giữ" page={page(false)} />,
    );
    expect(readOnly).not.toContain('type="checkbox"');
    expect(readOnly).not.toContain('phạm vi tài khoản');
    const picker = renderToStaticMarkup(
      <CommitmentTable
        caption="Có thể đặt"
        page={page(true)}
        selection={{
          quantities: new Map([['10000000-0000-4000-8000-000000000001', '2']]),
          lineRefs: new Map(),
          disabled: false,
          onToggle: () => undefined,
          onQuantity: () => undefined,
          onLineRef: () => undefined,
        }}
      />,
    );
    expect(picker).toContain('aria-label="Chọn NAM-01 của CH01"');
    expect(picker).toContain('aria-label="Số bao Reshare đã nhận cho NAM-01 của CH01"');
    expect(picker).toContain('max="3"');
  });
});
