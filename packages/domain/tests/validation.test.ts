import { describe, expect, it } from 'vitest';

import { isoTimestamp } from '../src/index.js';

describe('ISO timestamp validation', () => {
  it.each(['2026-02-30T08:00:00Z', '2026-04-31T08:00:00Z', '2026-01-01T24:00:00Z'])(
    'rejects impossible calendar/time value %s instead of normalizing it',
    (value) => {
      expect(() => isoTimestamp(value)).toThrowError(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      );
    },
  );

  it('continues to normalize valid timezone offsets to UTC', () => {
    expect(isoTimestamp('2026-09-10T08:00:00+07:00')).toBe('2026-09-10T01:00:00.000Z');
  });
});
