import { describe, expect, it } from 'vitest';

import { formatBusinessDate, formatDateTime, sessionLabel } from './session-label';

describe('session labels', () => {
  it('names same-day sessions by code, business date and their own clock times', () => {
    const base = { businessDate: '2026-10-02' };
    const labels = [
      {
        id: 'a',
        code: 'PDH-000001',
        requestClosesAt: '2026-10-02T01:00:00.000Z',
        allocationStartsAt: '2026-10-02T02:00:00.000Z',
      },
      {
        id: 'b',
        code: 'PDH-000002',
        requestClosesAt: '2026-10-02T03:00:00.000Z',
        allocationStartsAt: '2026-10-02T04:00:00.000Z',
      },
      {
        id: 'c',
        code: 'PDH-000003',
        requestClosesAt: '2026-10-02T07:00:00.000Z',
        allocationStartsAt: '2026-10-02T08:00:00.000Z',
      },
    ].map((session) => sessionLabel({ ...base, ...session }));
    expect(labels[0]).toBe('PDH-000001 · 02/10/2026 · chốt 08:00 · phân bổ 09:00');
    expect(labels[1]).toBe('PDH-000002 · 02/10/2026 · chốt 10:00 · phân bổ 11:00');
    expect(new Set(labels).size).toBe(3);
  });

  it('formats dates in Asia/Ho_Chi_Minh regardless of the browser zone', () => {
    expect(formatBusinessDate('2026-10-02')).toBe('02/10/2026');
    expect(formatDateTime('2026-10-01T17:30:05.000Z')).toContain('00:30:05');
    expect(formatDateTime('2026-10-01T17:30:05.000Z')).toContain('02/10/2026');
  });
});
