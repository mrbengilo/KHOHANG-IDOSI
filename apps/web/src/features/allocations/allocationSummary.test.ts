import { describe, expect, it } from 'vitest';

import { summarizeAllocation, summaryText } from './allocationSummary';

const names: Record<string, string> = { nam: 'Nam', nu: 'Nữ', dam: 'Đầm' };
const productName = (id: string) => names[id] ?? id;

describe('summarizeAllocation', () => {
  it('reads the example: ordered 3 Nam, 2 Nữ, 4 Đầm; granted 2/2/2; waiting 1 Nam, 2 Đầm', () => {
    const summary = summarizeAllocation(
      {
        lines: [
          { productId: 'nam', requestedQuantity: 3, allocatedQuantity: 2, waitlistedQuantity: 1 },
          { productId: 'nu', requestedQuantity: 2, allocatedQuantity: 2, waitlistedQuantity: 0 },
          { productId: 'dam', requestedQuantity: 4, allocatedQuantity: 2, waitlistedQuantity: 2 },
        ],
        carriedAllocations: [],
      },
      productName,
    );
    expect(summaryText(summary.granted, '—')).toBe('2 Nam, 2 Nữ, 2 Đầm');
    expect(summaryText(summary.waiting, '—')).toBe('1 Nam, 2 Đầm');
    expect(summary.grantedTotal).toBe(6);
    expect(summary.waitingTotal).toBe(3);
    expect(summary.carried).toEqual([]);
  });

  it('omits zero quantities and sums carried priority goods per item', () => {
    const summary = summarizeAllocation(
      {
        lines: [
          { productId: 'nam', requestedQuantity: 1, allocatedQuantity: 0, waitlistedQuantity: 1 },
        ],
        carriedAllocations: [
          {
            allocationLineId: 'a',
            allocationRunId: 'r1',
            productId: 'dam',
            quantity: 1,
            waitTicketId: null,
          },
          {
            allocationLineId: 'b',
            allocationRunId: 'r2',
            productId: 'dam',
            quantity: 2,
            waitTicketId: 'w',
          },
        ],
      },
      productName,
    );
    expect(summaryText(summary.granted, 'Chưa được cấp')).toBe('Chưa được cấp');
    expect(summary.carried).toEqual([{ productId: 'dam', name: 'Đầm', quantity: 3 }]);
  });
});
