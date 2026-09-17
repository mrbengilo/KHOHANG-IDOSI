import { describe, expect, it } from 'vitest';

import {
  calculateWeightedCostVnd,
  gramsToKilogramsExact,
  kilogramsToGramsExact,
  planWaitShortageMerge,
  StoreOperationValidationError,
} from '../src/store-operations.js';

describe('exact store inventory values', () => {
  it('round-trips canonical kilograms at gram precision', () => {
    expect(kilogramsToGramsExact('0')).toBe(0n);
    expect(kilogramsToGramsExact('12.345')).toBe(12_345n);
    expect(gramsToKilogramsExact(12_345n)).toBe('12.345');
  });

  it('rejects non-canonical or over-precision kilograms', () => {
    for (const value of ['1.2345', '-1', '01.000', '1e3', '100000000000.000']) {
      expect(() => kilogramsToGramsExact(value)).toThrow(StoreOperationValidationError);
    }
  });

  it('rounds bag cost to the nearest whole VND using exact bigint math', () => {
    expect(calculateWeightedCostVnd('1.234', 10_001n)).toBe(12_341n);
    expect(calculateWeightedCostVnd('0.001', 500n)).toBe(1n);
  });

  it('rejects negative and overflowing VND values', () => {
    expect(() => calculateWeightedCostVnd('1.000', -1n)).toThrow(StoreOperationValidationError);
    expect(() => calculateWeightedCostVnd('1.000', 9_223_372_036_854_775_808n)).toThrow(
      StoreOperationValidationError,
    );
  });
});

describe('receipt shortage wait restoration', () => {
  it('restores source fulfillment, consolidates active demand, and keeps the oldest queue age', () => {
    const sourceQueuedAt = new Date('2026-09-01T01:00:00.000Z');
    const activeQueuedAt = new Date('2026-09-02T01:00:00.000Z');
    const plan = planWaitShortageMerge(
      {
        id: 'source',
        originalQuantity: 8,
        remainingQuantity: 0,
        fulfilledQuantity: 8,
        queuedAt: sourceQueuedAt,
      },
      {
        id: 'active',
        originalQuantity: 5,
        remainingQuantity: 4,
        fulfilledQuantity: 1,
        queuedAt: activeQueuedAt,
      },
      3,
    );

    expect(plan).toEqual({
      originalQuantity: 12,
      remainingQuantity: 7,
      fulfilledQuantity: 5,
      queuedAt: sourceQueuedAt,
    });
    expect(plan.remainingQuantity + plan.fulfilledQuantity).toBe(plan.originalQuantity);
  });

  it('uses an older concurrently active queue timestamp without losing conservation', () => {
    const activeQueuedAt = new Date('2026-08-31T01:00:00.000Z');
    const plan = planWaitShortageMerge(
      {
        id: 'source',
        originalQuantity: 4,
        remainingQuantity: 0,
        fulfilledQuantity: 4,
        queuedAt: new Date('2026-09-01T01:00:00.000Z'),
      },
      {
        id: 'active',
        originalQuantity: 2,
        remainingQuantity: 2,
        fulfilledQuantity: 0,
        queuedAt: activeQueuedAt,
      },
      1,
    );

    expect(plan.queuedAt).toBe(activeQueuedAt);
    expect(plan.remainingQuantity + plan.fulfilledQuantity).toBe(plan.originalQuantity);
  });
});
