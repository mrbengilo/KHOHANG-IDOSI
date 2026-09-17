import { describe, expect, it } from 'vitest';

import {
  formatKg,
  gramsToKilograms,
  isOutboundWeightAllowed,
  kilogramsToGrams,
  outboundReasonsForMode,
} from './InventoryOperations';

describe('inventory exact-weight helpers', () => {
  it('round-trips kilogram strings at gram precision without floating-point conversion', () => {
    const exact = '9007199254740993.007';
    expect(gramsToKilograms(kilogramsToGrams(exact))).toBe(exact);
    expect(formatKg(exact)).toBe('9.007.199.254.740.993,007 kg');
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
  it('keeps sale and sorting reasons mutually exclusive and complete', () => {
    expect(outboundReasonsForMode('SALE')).toEqual(['DISCOUNT_SALE']);
    expect(outboundReasonsForMode('SORTING')).toEqual([
      'CHARITY',
      'TORN',
      'DEFECTIVE',
      'DIRTY',
      'OTHER',
    ]);
  });
});
