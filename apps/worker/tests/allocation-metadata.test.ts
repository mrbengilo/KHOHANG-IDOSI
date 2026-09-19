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
    });
    expect(allocationMetadata({ ...plan, availableBefore: 1 }, [], 'P0A')).toMatchObject({
      appliedPriority: 'P0A',
      policyRounds: [],
    });
  });
});
