import type { SessionDocument } from '@idosi/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AllocationResultCard } from './AllocationResultCard';
import { testDecision } from './testDecision';

const names: Record<string, string> = { nam: 'Nam', nu: 'Nữ', jeans: 'Jeans', ao: 'Áo' };

function document(waitDocuments: SessionDocument['waitDocuments']): SessionDocument {
  const result = (productId: string, requested: number, allocated: number, waitlisted: number) => ({
    waitTicketId: null,
    orderRequestId: 'order',
    orderRequestCode: 'PDH-000001',
    orderRequestItemId: null,
    submittedAt: null,
    priorityOfferId: null,
    result: {
      id: `result-${productId}`,
      productId,
      requestedQuantity: requested,
      allocatedQuantity: allocated,
      waitlistedQuantity: waitlisted,
    },
  });
  // Only the fields the card reads; the full contract is covered by the API tests.
  return {
    id: 'session:store',
    orderCode: 'TH-1',
    resultCode: 'KQ-1',
    version: 1,
    carriedAllocations: [],
    decision: testDecision({ status: 'ACCEPTED', canRespond: false, allowedActions: [] }),
    sources: [result('nam', 3, 2, 1), result('nu', 2, 0, 2), result('jeans', 4, 1, 3)],
    lines: [],
    ...(waitDocuments === undefined ? {} : { waitDocuments }),
  } as unknown as SessionDocument;
}

function render(waitDocuments: SessionDocument['waitDocuments']) {
  return renderToStaticMarkup(
    <AllocationResultCard
      createdAtText="09:00 15/10/26"
      document={document(waitDocuments)}
      onOpenDecision={() => undefined}
      productName={(id) => names[id] ?? id}
      sessionText="PDH-000042 · 15/10/2026 · chốt 09:00 · phân bổ 09:00"
      sourceText={() => ''}
      storeName="Cửa hàng A"
    />,
  );
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
    expect(html.replace(/<[^>]+>/g, '')).toContain('Cửa hàng A đặt');
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

  it('says when the run left the wait document unchanged or had none', () => {
    const same = {
      id: 'b',
      code: 'PCT-000011',
      lines: [{ productId: 'ao', quantity: 1, remainingQuantity: 0, pendingQuantity: 1 }],
    };
    const unchanged = render({ before: same, after: same, changed: false });
    expect(unchanged).toContain('Phiên này không làm đổi phiếu chờ của cửa hàng.');
    expect(unchanged).toContain('Trong đó 1 bao đã được cấp, chờ xác nhận phân bổ.');
    const legacy = render({ before: null, after: null, changed: false });
    expect(legacy).toContain('trước khi có phiếu chờ tổng');
    expect(legacy).not.toContain('Phiếu chờ cũ');
    expect(render(undefined)).not.toContain('Phiếu chờ mới');
  });
});
