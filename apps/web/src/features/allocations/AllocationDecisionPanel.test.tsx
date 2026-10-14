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
  it('offers exactly Xác nhận phân bổ and Chuyển phiếu chờ on a pending result', () => {
    const html = render(testDecision());
    expect(html).toContain('Xác nhận phân bổ');
    expect(html).toContain('Chuyển phiếu chờ');
    expect(html).not.toContain('Từ chối');
    expect(html).toContain('Chờ xác nhận');
    expect(html).toContain('Phân bổ phiên này');
    expect(html).toContain('Áo nữ');
    expect(html).toContain('Chưa được cấp');
    expect(html).toContain('PDH-000042');
  });

  it('is read-only for Admin/HTKD views and for answered results', () => {
    expect(render(testDecision({ canRespond: false, allowedActions: [] }))).not.toContain(
      'Chuyển phiếu chờ</span>',
    );
    const rejected = render(
      testDecision({
        status: 'REJECTED',
        version: 2,
        canRespond: false,
        allowedActions: [],
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
    expect(rejected).not.toContain('Xác nhận phân bổ</span>');
  });

  it('shows acceptance apart from the actual receipt and links to receiving', () => {
    const html = render(
      testDecision({
        status: 'ACCEPTED',
        version: 2,
        canRespond: false,
        allowedActions: [],
        respondedAt: '2026-10-05T03:00:00.000Z',
        shipment: { ...testDecision().shipment!, status: 'DISPATCHED' },
      }),
    );
    expect(html).toContain('Đã xác nhận phân bổ');
    expect(html).toContain('Đã giao đi, chờ cửa hàng khai nhận');
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

  it('shows the RE tag linked to the order, and keeps issue apart from receipt', () => {
    const html = render(
      testDecision({
        status: 'ACCEPTED',
        version: 2,
        canRespond: false,
        allowedActions: [],
        respondedAt: '2026-10-05T03:00:00.000Z',
        reshareOrder: {
          id: '70000000-0000-4000-8000-000000000001',
          code: 'RE-000007',
          status: 'ORDERED',
          orderedAt: '2026-10-05T03:00:00.000Z',
          totalQuantity: 3,
        },
        shipment: { ...testDecision().shipment!, status: 'DISPATCHED' },
      }),
    );
    expect(html).toContain('Đã lập đơn Reshare · RE-000007');
    expect(html).toContain('/supplier-reconciliation?tab=orders&amp;code=RE-000007');
    expect(html).toContain('Đã xuất 3 bao khỏi kho tổng theo đơn RE-000007');
    expect(html).not.toContain('Đã nhận hàng');
  });

  it('lets an assigned HTKD answer with both actions for the store, audited as itself', () => {
    const html = render(testDecision());
    expect(html).toContain('Xác nhận phân bổ');
    const htkd = renderToStaticMarkup(
      <MemoryRouter>
        <AllocationDecisionPanel
          actingForStore
          decision={testDecision()}
          productName={(id) => names.get(id) ?? id}
          responder={responder}
          storeName="Cửa hàng thử"
        />
      </MemoryRouter>,
    );
    expect(htkd).toContain('Bạn thao tác thay cửa hàng được phân công.');
    expect(htkd).toContain('Chuyển phiếu chờ');
  });

  it('strikes revoked goods, shows the actionable rest and who revoked them', () => {
    const html = render(
      testDecision({
        version: 2,
        lines: [
          {
            productId: TEST_PRODUCT_ID,
            requestedQuantity: 3,
            allocatedQuantity: 3,
            waitlistedQuantity: 0,
          },
          {
            productId: TEST_OTHER_PRODUCT_ID,
            requestedQuantity: 2,
            allocatedQuantity: 2,
            waitlistedQuantity: 0,
          },
        ],
        grantedQuantity: 5,
        actionableQuantity: 2,
        revokedQuantity: 3,
        actionableLines: [
          {
            productId: TEST_PRODUCT_ID,
            grantedQuantity: 3,
            revokedQuantity: 3,
            actionableQuantity: 0,
          },
          {
            productId: TEST_OTHER_PRODUCT_ID,
            grantedQuantity: 2,
            revokedQuantity: 0,
            actionableQuantity: 2,
          },
        ],
        revocations: [
          {
            allocationLineId: '61000000-0000-4000-8000-000000000002',
            productId: TEST_PRODUCT_ID,
            quantity: 3,
            kind: 'WAIT_TICKET_CANCELLED',
            waitTicketId: '62000000-0000-4000-8000-000000000001',
            waitTicketCode: 'PC-0000012',
            actorName: 'HTKD Miền Bắc',
            actorRole: 'HTKD',
            createdAt: '2026-10-05T03:00:00.000Z',
          },
        ],
      }),
    );
    expect(html).toContain('Đã thu hồi (bao)');
    expect(html).toContain('Còn hiệu lực (bao)');
    expect(html).toContain('Phần hàng đã thu hồi · 3 bao');
    expect(html).toContain('Thu hồi do hủy phiếu chờ PC-0000012');
    expect(html).toContain('HTKD Miền Bắc');
    expect(html).toContain('số bao còn hiệu lực (2 bao)');
  });

  it('lists the wait tickets that received the bags of a waitlisted result', () => {
    const html = render(
      testDecision({
        status: 'WAITLISTED',
        version: 2,
        allowedActions: [],
        canRespond: false,
        respondedAt: '2026-10-05T03:00:00.000Z',
        releasedQuantity: 3,
        requeued: [
          {
            waitTicketId: '62000000-0000-4000-8000-000000000003',
            waitTicketCode: 'PC-0000020',
            productId: TEST_PRODUCT_ID,
            quantity: 3,
            mode: 'ADD_DEMAND',
            createdTicket: false,
          },
        ],
      }),
    );
    expect(html).toContain('Đã chuyển phiếu chờ');
    expect(html).toContain('PC-0000020');
    expect(html).toContain('Cộng thêm 3 bao vào phiếu chờ đang có');
    expect(html).toContain('3 bao đã được trả lại kho tổng');
  });
});
