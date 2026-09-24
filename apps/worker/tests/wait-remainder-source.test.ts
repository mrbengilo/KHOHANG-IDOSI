import { describe, expect, it } from 'vitest';

import { firstUnderallocatedSourceLine } from '../src/postgres-repository.js';

describe('firstUnderallocatedSourceLine', () => {
  const lines = [
    { lineId: 'request-1', quantity: 3 },
    { lineId: 'request-2', quantity: 2 },
  ];

  it('points the wait ticket at the first request line with a shortfall', () => {
    expect(firstUnderallocatedSourceLine(lines, 0)?.lineId).toBe('request-1');
    expect(firstUnderallocatedSourceLine(lines, 2)?.lineId).toBe('request-1');
    expect(firstUnderallocatedSourceLine(lines, 3)?.lineId).toBe('request-2');
    expect(firstUnderallocatedSourceLine(lines, 4)?.lineId).toBe('request-2');
  });

  it('falls back to the last line when nothing is short', () => {
    expect(firstUnderallocatedSourceLine(lines, 5)?.lineId).toBe('request-2');
    expect(firstUnderallocatedSourceLine([], 0)).toBeUndefined();
  });
});
