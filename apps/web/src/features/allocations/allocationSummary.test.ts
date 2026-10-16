import { describe, expect, it } from 'vitest';

import { summarizeAllocation, summaryText, type AllocationSummaryInput } from './allocationSummary';

const names: Record<string, string> = {
  nam: 'Nam',
  nu: 'Nữ',
  jeans: 'Jeans',
  ao: 'Áo',
  quan: 'Quần',
  short: 'Quần short',
  dam: 'Đầm',
  bo: 'Đồ bộ',
};
const productName = (id: string) => names[id] ?? id;

function source(
  productId: string,
  requested: number,
  allocated: number,
  waitlisted: number,
  waitTicketId: string | null = null,
): AllocationSummaryInput['sources'][number] {
  return {
    waitTicketId,
    result: {
      productId,
      requestedQuantity: requested,
      allocatedQuantity: allocated,
      waitlistedQuantity: waitlisted,
    },
  };
}

function line(productId: string, quantity: number, pendingQuantity = 0) {
  return { productId, quantity, remainingQuantity: quantity - pendingQuantity, pendingQuantity };
}

describe('summarizeAllocation', () => {
  it('reads the owner example: ordered, result, waiting, old and new wait documents', () => {
    const summary = summarizeAllocation(
      {
        sources: [source('nam', 3, 2, 1), source('nu', 2, 0, 2), source('jeans', 4, 1, 3)],
        carriedAllocations: [],
        waitDocuments: {
          before: {
            id: 'b',
            code: 'PCT-000011',
            lines: [line('ao', 1), line('quan', 2), line('nu', 3)],
          },
          after: {
            id: 'c',
            code: 'PCT-000012',
            lines: [
              line('nam', 1),
              line('nu', 5),
              line('ao', 1),
              line('quan', 2),
              line('jeans', 3),
            ],
          },
          changed: true,
        },
      },
      productName,
    );
    expect(summaryText(summary.ordered, '—')).toBe('3 Nam, 2 Nữ, 4 Jeans');
    expect(summaryText(summary.granted, '—')).toBe('2 Nam, 1 Jeans');
    expect(summaryText(summary.waiting, '—')).toBe('1 Nam, 2 Nữ, 3 Jeans');
    expect(summary.orderedTotal).toBe(9);
    expect(summary.grantedTotal).toBe(3);
    expect(summary.waitingTotal).toBe(6);
    expect(summary.waitDocuments?.before?.code).toBe('PCT-000011');
    expect(summaryText(summary.waitDocuments?.before?.items ?? [], '—')).toBe('1 Áo, 2 Quần, 3 Nữ');
    expect(summaryText(summary.waitDocuments?.after?.items ?? [], '—')).toBe(
      '1 Nam, 5 Nữ, 1 Áo, 2 Quần, 3 Jeans',
    );
    expect(summary.waitDocuments?.after?.total).toBe(12);
    expect(summary.waitDocuments?.untracked).toBe(false);
  });

  it('counts grants of old wait tickets in the result but never as new waiting bags', () => {
    const summary = summarizeAllocation(
      {
        sources: [source('nam', 2, 2, 0), source('ao', 3, 1, 2, 'ticket-ao')],
        carriedAllocations: [],
        waitDocuments: {
          before: { id: 'b', code: 'PCT-000020', lines: [line('ao', 3)] },
          after: { id: 'b', code: 'PCT-000020', lines: [line('ao', 3)] },
          changed: false,
        },
      },
      productName,
    );
    expect(summaryText(summary.ordered, '—')).toBe('2 Nam');
    expect(summaryText(summary.granted, '—')).toBe('2 Nam, 1 Áo');
    expect(summaryText(summary.grantedForWait, '—')).toBe('1 Áo');
    expect(summary.waiting).toEqual([]);
    expect(summary.waitDocuments?.changed).toBe(false);
  });

  it('DS TH 16/10: the new wait document is the old one minus its grants plus new waiting', () => {
    const summary = summarizeAllocation(
      {
        sources: [
          source('dam', 2, 2, 0),
          source('bo', 2, 1, 1),
          source('nam', 1, 1, 0, 'ticket-nam'),
          source('short', 1, 1, 0, 'ticket-short'),
          source('nu', 1, 1, 0, 'ticket-nu'),
        ],
        carriedAllocations: [{ productId: 'nu', quantity: 1 }],
        waitDocuments: {
          before: {
            id: 'b',
            code: 'PCT-000012',
            lines: [line('nam', 3), line('short', 1), line('nu', 1)],
          },
          after: {
            id: 'c',
            code: 'PCT-000014',
            lines: [line('nam', 3, 1), line('bo', 1), line('short', 1, 1), line('nu', 1, 1)],
          },
          changed: true,
        },
      },
      productName,
    );
    expect(summaryText(summary.ordered, '—')).toBe('2 Đầm, 2 Đồ bộ');
    expect(summaryText(summary.grantedForWait, '—')).toBe('1 Nam, 1 Quần short, 1 Nữ');
    expect(summaryText(summary.waiting, '—')).toBe('1 Đồ bộ');
    const wait = summary.waitDocuments!;
    expect(summaryText(wait.before!.items, '—')).toBe('3 Nam, 1 Quần short, 1 Nữ');
    expect(wait.before!.total).toBe(5);
    expect(wait.before!.pendingTotal).toBe(0);
    expect(summaryText(wait.after!.items, '—')).toBe('2 Nam, 1 Đồ bộ');
    expect(wait.after!.total).toBe(3);
    expect(summaryText(wait.after!.pendingItems, '—')).toBe('1 Nam, 1 Quần short, 1 Nữ');
    expect(wait.after!.pendingTotal).toBe(3);
  });

  it('DS TH 15/10: a grant from the old wait document leaves it but no longer waits', () => {
    const summary = summarizeAllocation(
      {
        sources: [source('nu', 1, 1, 0, 'ticket-nu')],
        carriedAllocations: [],
        waitDocuments: {
          before: {
            id: 'a',
            code: 'PCT-000005',
            lines: [line('nam', 3), line('short', 1), line('nu', 2)],
          },
          after: {
            id: 'a',
            code: 'PCT-000005',
            lines: [line('nam', 3), line('short', 1), line('nu', 2, 1)],
          },
          changed: false,
        },
      },
      productName,
    );
    const wait = summary.waitDocuments!;
    expect(summaryText(wait.before!.items, '—')).toBe('3 Nam, 1 Quần short, 2 Nữ');
    expect(wait.before!.total).toBe(6);
    expect(summaryText(wait.after!.items, '—')).toBe('3 Nam, 1 Quần short, 1 Nữ');
    expect(wait.after!.total).toBe(5);
    expect(summaryText(wait.after!.pendingItems, '—')).toBe('1 Nữ');
  });

  it('omits zero quantities, sums carried goods and flags runs older than wait documents', () => {
    const summary = summarizeAllocation(
      {
        sources: [source('nam', 1, 0, 1)],
        carriedAllocations: [
          { productId: 'jeans', quantity: 1 },
          { productId: 'jeans', quantity: 2 },
        ],
        waitDocuments: { before: null, after: null, changed: false },
      },
      productName,
    );
    expect(summaryText(summary.granted, 'Chưa được cấp')).toBe('Chưa được cấp');
    expect(summary.carried).toEqual([{ productId: 'jeans', name: 'Jeans', quantity: 3 }]);
    expect(summary.waitDocuments?.untracked).toBe(true);
  });

  it('keeps wait documents absent when the response did not carry them', () => {
    const summary = summarizeAllocation(
      { sources: [source('nam', 1, 1, 0)], carriedAllocations: [] },
      productName,
    );
    expect(summary.waitDocuments).toBeNull();
  });
});
