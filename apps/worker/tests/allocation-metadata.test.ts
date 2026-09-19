import { describe, expect, it } from 'vitest';
import { allocationMetadata } from '../src/postgres-repository.js';

describe('allocation audit priority without grants', () => {
  it('retains the merged planner priority when a source receives zero units', () => {
    const plan = {
      cursorBefore: null,
      nextCursor: null,
      availableBefore: 0,
      snapshotId: 'snapshot',
    };
    expect(allocationMetadata(plan, [], 'P1')).toMatchObject({
      appliedPriority: 'P1',
      policyRounds: [],
      policyRoundsVersion: 1,
    });
    expect(allocationMetadata({ ...plan, availableBefore: 1 }, [], 'P0A')).toMatchObject({
      appliedPriority: 'P0A',
      policyRounds: [],
    });
  });

  it('validates round values before marking immutable audits versioned', () => {
    const plan = {
      cursorBefore: null,
      nextCursor: null,
      availableBefore: 1,
      snapshotId: 'snapshot',
    };
    const step = {
      sequence: 1,
      priority: 'P1' as const,
      round: 1,
      storeId: 'store',
      demandId: 'demand',
      productId: 'product',
      quantity: 1 as const,
    };
    expect(allocationMetadata(plan, [step], 'P1')).toMatchObject({
      policyRounds: [1],
      policyRoundsVersion: 1,
    });
    for (const round of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      expect(() => allocationMetadata(plan, [{ ...step, round }], 'P1')).toThrow(
        'positive safe integers',
      );
    }
  });
});
