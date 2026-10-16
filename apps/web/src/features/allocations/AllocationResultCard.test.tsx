import type { SessionDocument } from '@idosi/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AllocationResultCard } from './AllocationResultCard';
import { testDecision } from './testDecision';

const names: Record<string, string> = { nam: 'Nam', nu: 'Nữ', jeans: 'Jeans', ao: 'Áo' };

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
): SessionDocument {
  // Only the fields the card reads; the full contract is covered by the API tests.
  return {
    id: 'session:store',
    orderCode: 'TH-1',
    resultCode: 'KQ-1',
    version: 1,
    carriedAllocations: [],
    decision: testDecision({ status: 'ACCEPTED', canRespond: false, allowedActions: [] }),
    sources,
    lines: [],
    ...(waitDocuments === undefined ? {} : { waitDocuments }),
  } as unknown as SessionDocument;
}

function renderCard(
  waitDocuments: SessionDocument['waitDocuments'],
  sources: readonly Source[] = orderSources,
) {
  return renderToStaticMarkup(
    <AllocationResultCard
      createdAtText="09:00 15/10/26"
      document={document(waitDocuments, sources)}
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
