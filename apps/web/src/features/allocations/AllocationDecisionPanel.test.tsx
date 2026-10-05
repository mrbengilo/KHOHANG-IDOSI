import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AllocationDecisionPanel } from './AllocationDecisionPanel';
import { TEST_OTHER_PRODUCT_ID, TEST_PRODUCT_ID, testDecision } from './testDecision';

const responder = { busy: null, error: null, success: null, respond: async () => true };
const names = new Map([
  [TEST_PRODUCT_ID, 'Áo nữ'],
  [TEST_OTHER_PRODUCT_ID, 'Quần áo nam'],
]);

function render(decision: ReturnType<typeof testDecision>) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AllocationDecisionPanel
        canReceive
        decision={decision}
        productName={(id) => names.get(id) ?? id}
        responder={responder}
        storeName="Cửa hàng thử"
      />
    </MemoryRouter>,
  );
}

describe('allocation result panel', () => {
  it('does not describe consumed carried goods as a cancelled shipment or an active hold', () => {
    const decision = testDecision({ status: 'ACCEPTED', canRespond: false });
    const html = render({
      ...decision,
      carried: [
        {
          reservationId: '20000000-0000-4000-8000-000000000003',
          allocationLineId: '20000000-0000-4000-8000-000000000004',
          allocationRunId: decision.allocationRunId,
          sessionId: decision.sessionId,
          productId: TEST_OTHER_PRODUCT_ID,
          quantity: 2,
          reservationStatus: 'CONSUMED',
          waitTicketId: null,
          sourceDecisionStatus: 'ACCEPTED',
        },
      ],
    });
    expect(html).toContain('Đã xử lý theo thực nhận');
    expect(html).not.toContain('Đã tách khỏi chuyến bị hủy');
  });
  it('offers exactly Chấp nhận and Từ chối on a pending result the account may answer', () => {
    const html = render(testDecision());
    expect(html).toContain('Chấp nhận');
    expect(html).toContain('Từ chối');
    expect(html).toContain('Chờ xác nhận');
    expect(html).toContain('Phân bổ phiên này');
    expect(html).toContain('Áo nữ');
    expect(html).toContain('Chưa được cấp');
    expect(html).toContain('PDH-000042');
  });

  it('is read-only for Admin/HTKD views and for answered results', () => {
    expect(render(testDecision({ canRespond: false }))).not.toContain('Từ chối</span>');
    const rejected = render(
      testDecision({
        status: 'REJECTED',
        version: 2,
        canRespond: false,
        respondedAt: '2026-10-05T03:00:00.000Z',
        respondedByName: 'Cửa hàng thử',
        reason: 'Đủ hàng',
        releasedQuantity: 3,
        shipment: { ...testDecision().shipment!, status: 'CANCELLED' },
      }),
    );
    expect(rejected).toContain('đã từ chối nhận');
    expect(rejected).toContain('Lý do: Đủ hàng');
    expect(rejected).toContain('3 bao đã được trả lại kho tổng');
    expect(rejected).not.toContain('Chấp nhận</span>');
  });

  it('shows acceptance apart from the actual receipt and links to receiving', () => {
    const html = render(
      testDecision({
        status: 'ACCEPTED',
        version: 2,
        canRespond: false,
        respondedAt: '2026-10-05T03:00:00.000Z',
        shipment: { ...testDecision().shipment!, status: 'DISPATCHED' },
      }),
    );
    expect(html).toContain('Đã chấp nhận');
    expect(html).toContain('Đã xuất kho, chờ cửa hàng khai nhận');
    expect(html).toContain('Khai nhận thực tế');
    expect(html).not.toContain('Đã nhận hàng');
  });

  it('groups goods carried from an earlier session apart from this session grant', () => {
    const html = render(
      testDecision({
        carried: [
          {
            reservationId: '60000000-0000-4000-8000-000000000001',
            allocationLineId: '61000000-0000-4000-8000-000000000001',
            allocationRunId: '11000000-0000-4000-8000-100000000009',
            sessionId: '10000000-0000-4000-8000-000000000009',
            productId: TEST_OTHER_PRODUCT_ID,
            quantity: 2,
            reservationStatus: 'ACTIVE',
            waitTicketId: null,
            sourceDecisionStatus: 'ACCEPTED',
          },
        ],
      }),
    );
    expect(html).toContain('Hàng đã giữ từ phiên trước · 2 bao');
    expect(html).toContain('Quần áo nam: 2 bao');
  });
});
