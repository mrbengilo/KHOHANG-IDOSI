import { describe, expect, it } from 'vitest';
import { nextOrderingWindow, OrderSessionSchema } from '../src/index.js';

describe('continuous ordering schedule', () => {
  it.each([
    ['2026-09-19T07:59:59+07:00', '2026-09-19'],
    ['2026-09-19T08:00:00+07:00', '2026-09-20'],
    ['2026-09-19T23:59:59+07:00', '2026-09-20'],
    ['2026-09-20T00:00:00+07:00', '2026-09-20'],
    ['2026-12-31T23:59:59+07:00', '2027-01-01'],
  ])('assigns %s to the next unfrozen business date', (timestamp, date) => {
    const now = new Date(timestamp);
    const window = nextOrderingWindow(now, '08:00:00', '09:00:00');
    expect(window.businessDate).toBe(date);
    expect(Date.parse(window.requestClosesAt)).toBeGreaterThan(now.getTime());
    expect(
      OrderSessionSchema.safeParse({
        ...window,
        id: '11111111-1111-4111-8111-111111111111',
        status: 'OPEN',
        policyVersion: 'test-policy',
        version: 0,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }).success,
    ).toBe(true);
  });
});
