import type { SessionDocument } from '@idosi/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AllocationResultCard } from './AllocationResultCard';
import { testDecision } from './testDecision';

const names: Record<string, string> = {
  nam: 'Nam',
  nu: 'Nữ',
  jeans: 'Jeans',
  ao: 'Áo',
  bo: 'Đồ bộ',
  tienich: 'Sản phẩm tiện ích',
};

type Source = SessionDocument['sources'][number];

function source(
  productId: string,
  requested: number,
  allocated: number,
  waitlisted: number,
  waitTicketId: string | null = null,
): Source {
  return {
    waitTicketId,
    orderRequestId: waitTicketId ? null : 'order',
    orderRequestCode: waitTicketId ? null : 'PDH-000001',
    orderRequestItemId: null,
    submittedAt: null,
    priorityOfferId: null,
    result: {
      id: `result-${productId}-${waitTicketId ?? 'order'}`,
      productId,
      requestedQuantity: requested,
      allocatedQuantity: allocated,
      waitlistedQuantity: waitlisted,
    },
  } as unknown as Source;
}

/** A P0A line: bags granted from the store's wait ticket of the product. */
function ticketGrant(productId: string, quantity: number): Source {
  return source(productId, quantity, quantity, 0, `ticket-${productId}`);
}

const orderSources = [source('nam', 3, 2, 1), source('nu', 2, 0, 2), source('jeans', 4, 1, 3)];

function document(
  waitDocuments: SessionDocument['waitDocuments'],
  sources: readonly Source[],
  decision: SessionDocument['decision'] = testDecision({
    status: 'ACCEPTED',
    canRespond: false,
    allowedActions: [],
  }),
): SessionDocument {
  // Only the fields the card reads; the full contract is covered by the API tests.
  return {
    id: 'session:store',
    orderCode: 'TH-1',
    resultCode: 'KQ-1',
    version: 1,
    carriedAllocations: [],
    decision,
    sources,
    lines: [],
    ...(waitDocuments === undefined ? {} : { waitDocuments }),
  } as unknown as SessionDocument;
}

function renderCard(
  waitDocuments: SessionDocument['waitDocuments'],
  sources: readonly Source[] = orderSources,
  decision?: SessionDocument['decision'],
) {
  return renderToStaticMarkup(
    <AllocationResultCard
      createdAtText="09:00 15/10/26"
      document={document(waitDocuments, sources, decision)}
      onOpenDecision={() => undefined}
      productName={(id) => names[id] ?? id}
      sessionText="PDH-000042 · 15/10/2026 · chốt 09:00 · phân bổ 09:00"
      sourceText={() => ''}
      storeName="Cửa hàng A"
    />,
  );
}

function render(waitDocuments: SessionDocument['waitDocuments']) {
  return renderCard(waitDocuments);
}

function text(html: string) {
  return html.replace(/<[^>]+>/g, '');
}

describe('AllocationResultCard', () => {
  it('hides internal document identifiers behind a plain "Xem chi tiết" button', () => {
    const html = render(undefined);
    expect(html).toContain(
      '<summary aria-label="Xem chi tiết phân bổ của Cửa hàng A">Xem chi tiết</summary>',
    );
    expect(html).not.toContain('KQ-1');
    expect(html).not.toContain('TH-1');
    expect(html).not.toContain('phiên bản');
    expect(html).toContain('Nguồn đặt hàng và các vòng phân bổ');
  });

  it('reads like the store talks: session, order, result, waiting, old and new wait document', () => {
    const html = render({
      before: {
        id: 'b',
        code: 'PCT-000011',
        lines: [{ productId: 'ao', quantity: 1, remainingQuantity: 1, pendingQuantity: 0 }],
      },
      after: {
        id: 'c',
        code: 'PCT-000012',
        lines: [
          { productId: 'nam', quantity: 1, remainingQuantity: 1, pendingQuantity: 0 },
          { productId: 'nu', quantity: 2, remainingQuantity: 2, pendingQuantity: 0 },
          { productId: 'ao', quantity: 1, remainingQuantity: 1, pendingQuantity: 0 },
          { productId: 'jeans', quantity: 3, remainingQuantity: 3, pendingQuantity: 0 },
        ],
      },
      changed: true,
    });
    expect(html).toContain('Phân bổ lúc 09:00 15/10/26');
    expect(html).toContain('Phiên PDH-000042');
    expect(html).toContain('Đã xác nhận phân bổ');
    expect(html).toContain('Xem phiếu');
    expect(text(html)).toContain('Cửa hàng A đặt');
    expect(html).toContain('<span class="store-name">Cửa hàng A</span>');
    expect(html).toContain('9 bao');
    expect(html).toContain('Kết quả');
    expect(html).toContain('Chờ ưu tiên');
    expect(html).toContain('Phiếu chờ cũ');
    expect(html).toContain('PCT-000011');
    expect(html).toContain('⇒ Phiếu chờ mới');
    expect(html).toContain('PCT-000012');
    expect(html).toContain('7 bao');
    expect(html).not.toContain('không làm đổi phiếu chờ');
  });

  it('lists only bags still waiting on the new wait document, grants awaiting the answer apart', () => {
    const html = text(
      render({
        before: {
          id: 'b',
          code: 'PCT-000012',
          lines: [{ productId: 'ao', quantity: 3, remainingQuantity: 3, pendingQuantity: 0 }],
        },
        after: {
          id: 'c',
          code: 'PCT-000014',
          lines: [
            { productId: 'ao', quantity: 3, remainingQuantity: 2, pendingQuantity: 1 },
            { productId: 'nam', quantity: 1, remainingQuantity: 1, pendingQuantity: 0 },
          ],
        },
        changed: true,
      }),
    );
    expect(html).toContain('Phiếu chờ cũPCT-0000123 bao');
    expect(html).toContain('⇒ Phiếu chờ mớiPCT-0000143 bao');
    expect(html).toContain('2 Áo');
    expect(html).toContain('Không gồm 1 bao đã cấp, chờ xác nhận phân bổ: 1 Áo');
    expect(html).not.toContain('Ngoài ra');
  });

  it('a run that only granted old wait bags does not claim the wait document is unchanged', () => {
    const html = text(
      renderCard(
        {
          before: {
            id: 'a',
            code: 'PCT-000005',
            lines: [{ productId: 'nu', quantity: 2, remainingQuantity: 2, pendingQuantity: 0 }],
          },
          after: {
            id: 'a',
            code: 'PCT-000005',
            lines: [{ productId: 'nu', quantity: 2, remainingQuantity: 1, pendingQuantity: 1 }],
          },
          changed: false,
        },
        [ticketGrant('nu', 1)],
      ),
    );
    expect(html).not.toContain('không làm đổi phiếu chờ');
    expect(html).toContain('Phiếu chờ cũPCT-0000052 bao');
    expect(html).toContain('⇒ Phiếu chờ mớiPCT-0000051 bao');
    expect(html).toContain('Không gồm 1 bao đã cấp, chờ xác nhận phân bổ: 1 Nữ');
  });

  it('shows bags the run removed from the old wait document, so old ⇒ new adds up', () => {
    const html = text(
      renderCard(
        {
          before: {
            id: 'b',
            code: 'PCT-000017',
            lines: [
              { productId: 'nam', quantity: 1, remainingQuantity: 1, pendingQuantity: 0 },
              { productId: 'tienich', quantity: 1, remainingQuantity: 1, pendingQuantity: 0 },
            ],
          },
          after: {
            id: 'c',
            code: 'PCT-000021',
            lines: [
              { productId: 'nam', quantity: 1, remainingQuantity: 1, pendingQuantity: 0 },
              { productId: 'bo', quantity: 1, remainingQuantity: 1, pendingQuantity: 0 },
            ],
          },
          changed: true,
          removed: [{ productId: 'tienich', quantity: 1, reason: 'PRIORITY_RESPONSE_TIMEOUT' }],
        },
        [source('ao', 1, 1, 0), source('bo', 1, 0, 1)],
      ),
    );
    expect(html).toContain('Phiếu chờ cũPCT-0000172 bao');
    expect(html).toContain('Hủy khỏi phiếu chờ1 bao1 Sản phẩm tiện ích');
    expect(html).toContain('Đề nghị nhận đủ hàng không được phản hồi trước giờ chốt phân bổ');
    expect(html).toContain('⇒ Phiếu chờ mớiPCT-0000212 bao');
    // The removal row sits between the old and the new document.
    expect(html.indexOf('Hủy khỏi phiếu chờ')).toBeGreaterThan(html.indexOf('Phiếu chờ cũ'));
    expect(html.indexOf('Hủy khỏi phiếu chờ')).toBeLessThan(html.indexOf('⇒ Phiếu chờ mới'));
    expect(html).not.toContain('Điều chỉnh phiếu chờ');
  });

  it('never shows revoked or moved-back bags as still coming', () => {
    const revoked = text(
      renderCard(
        undefined,
        orderSources,
        testDecision({
          status: 'PENDING',
          grantedQuantity: 3,
          actionableQuantity: 2,
          revokedQuantity: 1,
          actionableLines: [
            { productId: 'nam', grantedQuantity: 2, revokedQuantity: 1, actionableQuantity: 1 },
            { productId: 'jeans', grantedQuantity: 1, revokedQuantity: 0, actionableQuantity: 1 },
          ],
        }),
      ),
    );
    expect(revoked).toContain('Đã thu hồi 1 bao do hủy phiếu chờ: 1 Nam. Còn hiệu lực 2 bao.');
    expect(revoked).not.toContain('Đã chuyển phiếu chờ:');

    const moved = text(
      renderCard(
        undefined,
        orderSources,
        testDecision({ status: 'WAITLISTED', canRespond: false, allowedActions: [] }),
      ),
    );
    expect(moved).toContain('Đã chuyển phiếu chờ: 3 bao trả lại kho tổng');
    expect(moved).not.toContain('Đã thu hồi');

    // An accepted result without revocations reads as before.
    const accepted = text(render(undefined));
    expect(accepted).not.toContain('Đã thu hồi');
    expect(accepted).not.toContain('Đã chuyển phiếu chờ:');
  });

  it('says when the run left the wait document unchanged or had none', () => {
    const same = {
      id: 'b',
      code: 'PCT-000011',
      lines: [
        { productId: 'nam', quantity: 2, remainingQuantity: 2, pendingQuantity: 0 },
        { productId: 'ao', quantity: 1, remainingQuantity: 0, pendingQuantity: 1 },
      ],
    };
    const unchanged = text(render({ before: same, after: same, changed: false }));
    expect(unchanged).toContain('Phiên này không làm đổi phiếu chờ của cửa hàng.');
    // Granted bags awaiting the answer no longer wait: listed apart, not counted as waiting.
    expect(unchanged).toContain('Phiếu chờ cũPCT-0000112 bao');
    expect(unchanged).toContain('Ngoài ra 1 bao đã cấp ở phiên trước, chờ xác nhận phân bổ: 1 Áo');
    expect(unchanged).toContain('Không gồm 1 bao đã cấp, chờ xác nhận phân bổ: 1 Áo');
    const legacy = render({ before: null, after: null, changed: false });
    expect(legacy).toContain('trước khi có phiếu chờ tổng');
    expect(legacy).not.toContain('Phiếu chờ cũ');
    expect(render(undefined)).not.toContain('Phiếu chờ mới');
  });
});
