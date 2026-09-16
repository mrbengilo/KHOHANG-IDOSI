import { describe, expect, it } from 'vitest';

import { isRequestDeadlineClosed } from '../src/order-requests.js';

describe('order request deadline', () => {
  const deadline = new Date('2026-09-10T01:00:00.000Z');

  it('is closed at the exact cutoff', () => {
    expect(isRequestDeadlineClosed(deadline, new Date(deadline))).toBe(true);
  });

  it('remains open strictly before the cutoff', () => {
    expect(isRequestDeadlineClosed(deadline, new Date(deadline.getTime() - 1))).toBe(false);
  });
});
