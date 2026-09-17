import { describe, expect, it } from 'vitest';
import { businessDate } from './business-time';

describe('businessDate', () => {
  it('uses the Ho Chi Minh business day instead of UTC', () => {
    expect(businessDate(new Date('2026-09-16T18:30:00.000Z'))).toBe('2026-09-17');
  });
});
