import { describe, expect, it } from 'vitest';
import { businessDate, formatDocumentTime } from './business-time';

describe('businessDate', () => {
  it('uses the Ho Chi Minh business day instead of UTC', () => {
    expect(businessDate(new Date('2026-09-16T18:30:00.000Z'))).toBe('2026-09-17');
  });
});

it('formats document seconds across Vietnam month and year boundaries', () => {
  expect(formatDocumentTime('2026-12-31T17:00:01Z')).toBe('00:00:01 01/01/2027');
  expect(formatDocumentTime('2026-09-30T17:00:59Z')).toBe('00:00:59 01/10/2026');
  expect(formatDocumentTime(null)).toBe('Chưa ghi nhận');
  expect(formatDocumentTime('invalid')).toBe('Chưa ghi nhận');
});
