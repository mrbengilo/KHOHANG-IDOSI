import { describe, expect, it } from 'vitest';

import { checkBagWeights, parseBagCount, resizeBagWeights } from './bag-weights';

describe('bag weights', () => {
  it('accepts per-bag weights whose total fits the available kilograms', () => {
    expect(checkBagWeights('2', ['20', '30'], '100.000')).toEqual({
      valid: true,
      totalKg: '50.000',
      error: null,
      bagWeightsKg: ['20.000', '30.000'],
    });
    expect(checkBagWeights('2', ['60', '40'], '100.000').valid).toBe(true);
  });

  it('rejects totals above the available kilograms', () => {
    const result = checkBagWeights('2', ['60', '40.001'], '100.000');
    expect(result.valid).toBe(false);
    expect(result.totalKg).toBe('100.001');
    expect(result.error).toMatch(/vượt quá/u);
  });

  it('requires a positive weight for every bag', () => {
    expect(checkBagWeights('2', ['20', ''], '100.000')).toMatchObject({
      valid: false,
      error: null,
    });
    expect(checkBagWeights('2', ['20', '0'], '100.000').error).toMatch(/Bao 2/u);
    expect(checkBagWeights('1', ['1.2345'], '100.000').valid).toBe(false);
  });

  it('limits the bag count and keeps typed weights when it changes', () => {
    expect(parseBagCount('0')).toBeNull();
    expect(parseBagCount('101')).toBeNull();
    expect(parseBagCount('3')).toBe(3);
    expect(resizeBagWeights(['20', '30'], 3)).toEqual(['20', '30', '']);
    expect(resizeBagWeights(['20', '30'], 1)).toEqual(['20']);
  });
});
