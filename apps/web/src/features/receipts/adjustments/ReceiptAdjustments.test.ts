import type { ReceiptAdjustmentContextBag } from '@idosi/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ReportForm } from './ReceiptAdjustments';

describe('discrepancy report selection', () => {
  it('renders an opened bag disabled while an unopened bag remains selectable', () => {
    const bag: ReceiptAdjustmentContextBag = {
      receiptBagId: 'receipt-bag',
      bagNumber: 1,
      inventoryBagId: 'inventory-bag',
      bagDisplayCode: 'MB-00001',
      bagStatus: 'OPEN',
      currentWeightKg: '20.000',
      approvedProductId: 'dress',
      effectiveProductId: 'dress',
      effectiveWeightKg: '20.000',
      effectivePricePerKgVnd: 50000,
      effectiveCostVnd: 1000000,
      shortageGranted: false,
      openAdjustmentId: null,
      openReturnId: null,
      dependencies: [],
      openedAt: '2026-09-25T01:02:03.000Z',
      canReportDiscrepancy: false,
      reportBlockers: ['BAG_ALREADY_OPENED'],
    };
    const html = renderToStaticMarkup(
      createElement(ReportForm, {
        busy: false,
        error: null,
        context: {
          receiptId: 'receipt',
          finalizedAt: null,
          bags: [
            bag,
            {
              ...bag,
              receiptBagId: 'second',
              bagNumber: 2,
              bagStatus: 'AVAILABLE',
              openedAt: null,
              canReportDiscrepancy: true,
              reportBlockers: [],
            },
          ],
        },
        onCancel: vi.fn(),
        onSubmit: vi.fn(async () => true),
        productNameById: new Map([['dress', 'Đầm']]),
        products: [],
      }),
    );
    const checkboxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g)!;
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toContain('disabled');
    expect(checkboxes[1]).not.toContain('disabled');
    expect(html).toContain('Bao đã khui kiện bán lúc');
    expect(html).toContain('08:02:03');
  });
});
