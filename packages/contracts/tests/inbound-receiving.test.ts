import { describe, expect, it } from 'vitest';
import {
  CreateInboundReceiptRequestSchema,
  FinalizeReceiptRequestSchema,
  formatInboundReceiptNumber,
} from '../src/receipts.js';

const productId = '40000000-0000-4000-8000-000000000001';
describe('warehouse count first, store weight later', () => {
  it('accepts three unweighed bags and server-generated receipt number', () => {
    const parsed = CreateInboundReceiptRequestSchema.parse({
      supplierName: 'Supplier',
      receivedAt: '2026-09-20T08:00:00Z',
      bags: [1, 2, 3].map((n) => ({ productId, bagCode: `B-${n}` })),
    });
    expect(parsed.referenceCode).toBeUndefined();
    expect(parsed.bags.map((bag) => bag.weightKg)).toEqual([null, null, null]);
  });
  it('formats an untruncated sequence and Vietnam creation date', () => {
    expect(formatInboundReceiptNumber('1', new Date('2026-09-19T17:00:00Z'))).toBe(
      'PN00001-20/09/2026',
    );
    expect(formatInboundReceiptNumber('100000', new Date('2026-09-19T16:59:59Z'))).toBe(
      'PN100000-19/09/2026',
    );
  });
  it('requires one positive weight for each actually received bag', () => {
    const input = {
      expectedVersion: 1,
      freightVnd: 0,
      handlingVnd: 0,
      lines: [
        {
          productId,
          approvedUnits: 3,
          receivedUnits: 3,
          bagWeightsKg: ['30', '50', '60'],
          pricePerKgVnd: 1000,
        },
      ],
    };
    expect(FinalizeReceiptRequestSchema.safeParse(input).success).toBe(true);
    for (const bagWeightsKg of [[], ['30', '50'], ['30', '50', '0']]) {
      expect(
        FinalizeReceiptRequestSchema.safeParse({
          ...input,
          lines: [{ ...input.lines[0], bagWeightsKg }],
        }).success,
      ).toBe(false);
    }
    expect(
      FinalizeReceiptRequestSchema.safeParse({
        ...input,
        lines: [{ ...input.lines[0], receivedUnits: 2, bagWeightsKg: ['30', '50'] }],
      }).success,
    ).toBe(true);
  });
});
