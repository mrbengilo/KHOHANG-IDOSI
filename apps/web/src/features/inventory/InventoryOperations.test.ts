import { describe, expect, it } from 'vitest';

import {
  formatKg,
  formatSortingTime,
  gramsToKilograms,
  isOutboundWeightAllowed,
  kilogramsToGrams,
  outboundReasonsForMode,
} from './InventoryOperations';

describe('inventory exact-weight helpers', () => {
  it('round-trips kilogram strings at gram precision without floating-point conversion', () => {
    const exact = '9007199254740993.007';
    expect(gramsToKilograms(kilogramsToGrams(exact))).toBe(exact);
    expect(formatKg(exact)).toBe('9.007.199.254.740.993,01 kg');
  });

  it('accepts only canonical positive weights that do not exceed the current balance', () => {
    expect(isOutboundWeightAllowed('1.250', '1.250')).toBe(true);
    expect(isOutboundWeightAllowed('1.251', '1.250')).toBe(false);
    expect(isOutboundWeightAllowed('0.000', '1.250')).toBe(false);
    expect(isOutboundWeightAllowed('01.000', '2.000')).toBe(false);
    expect(isOutboundWeightAllowed('1.0000', '2.000')).toBe(false);
  });
});

describe('inventory outbound mode filters', () => {
  it('lists current sorting reasons and historical outbound reasons', () => {
    expect(outboundReasonsForMode('SALE')).toEqual(['DISCOUNT_SALE', 'SALE_KG', 'SALE_PIECE']);
    expect(outboundReasonsForMode('SORTING')).toEqual([
      'CHARITY',
      'SALE_KG',
      'SALE_PIECE',
      'CANCEL',
      'TORN',
      'DEFECTIVE',
      'DIRTY',
      'OTHER',
    ]);
  });
});

describe('sorting history time', () => {
  it('shows day-first Vietnam time for UTC instants, including across midnight', () => {
    expect(formatSortingTime('2026-09-23T07:05:09.000Z')).toBe('23/09/2026 14:05:09');
    expect(formatSortingTime('2026-09-22T17:00:00.000Z')).toBe('23/09/2026 00:00:00');
  });
});
