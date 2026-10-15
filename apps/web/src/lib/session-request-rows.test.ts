import { describe, expect, it } from 'vitest';
import { formatRequestSubmittedAt } from './session-request-rows';

describe('session request time', () => {
  it('formats the send time on the Vietnam clock', () => {
    // 05:14 UTC is 12:14 in Vietnam, and 17:30 UTC already falls on the next Vietnam day.
    expect(formatRequestSubmittedAt('2026-09-23T05:14:49.099Z')).toEqual({
      date: '23/09/2026',
      time: '12:14',
    });
    expect(formatRequestSubmittedAt('2026-09-23T17:30:00.000Z').date).toBe('24/09/2026');
  });
});
