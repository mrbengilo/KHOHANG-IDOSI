import { describe, expect, it } from 'vitest';

import {
  ErrorEnvelopeSchema,
  GramsSchema,
  IdempotencyHeadersSchema,
  IsoDateSchema,
  KilogramsDecimalSchema,
  MoneyVndSchema,
  PaginationQuerySchema,
} from '../src/index.js';

describe('common contracts', () => {
  it('accepts only whole, non-negative and safe VND amounts', () => {
    expect(MoneyVndSchema.safeParse(125_000).success).toBe(true);
    expect(MoneyVndSchema.safeParse(12.5).success).toBe(false);
    expect(MoneyVndSchema.safeParse(-1).success).toBe(false);
    expect(MoneyVndSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
  });

  it('accepts decimal kg strings without converting through floating point', () => {
    expect(KilogramsDecimalSchema.safeParse('12.345').success).toBe(true);
    expect(KilogramsDecimalSchema.safeParse('0').success).toBe(true);
    expect(KilogramsDecimalSchema.safeParse(12.345).success).toBe(false);
    expect(KilogramsDecimalSchema.safeParse('01.2').success).toBe(false);
    expect(KilogramsDecimalSchema.safeParse('1.2345').success).toBe(false);
    expect(KilogramsDecimalSchema.safeParse('1e3').success).toBe(false);
  });

  it('accepts integer grams and rejects fractional grams', () => {
    expect(GramsSchema.safeParse(1_250).success).toBe(true);
    expect(GramsSchema.safeParse(1.25).success).toBe(false);
  });

  it('validates real calendar dates', () => {
    expect(IsoDateSchema.safeParse('2028-02-29').success).toBe(true);
    expect(IsoDateSchema.safeParse('2026-02-29').success).toBe(false);
    expect(IsoDateSchema.safeParse('2026-00-10').success).toBe(false);
  });

  it('coerces REST pagination query values and applies bounded defaults', () => {
    expect(PaginationQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(PaginationQuerySchema.parse({ page: '3', pageSize: '100' })).toEqual({
      page: 3,
      pageSize: 100,
    });
    expect(PaginationQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(PaginationQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
  });

  it('requires an explicit, bounded idempotency key while allowing normal HTTP headers', () => {
    expect(
      IdempotencyHeadersSchema.safeParse({ 'idempotency-key': 'order:20260910:abc123' }).success,
    ).toBe(true);
    expect(IdempotencyHeadersSchema.safeParse({ 'idempotency-key': 'short' }).success).toBe(false);
    expect(
      IdempotencyHeadersSchema.safeParse({
        'idempotency-key': 'order:20260910:abc123',
        authorization: 'secret',
      }).success,
    ).toBe(true);
  });

  it('keeps error envelopes structured and strict', () => {
    expect(
      ErrorEnvelopeSchema.safeParse({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          requestId: 'req-123',
          fieldErrors: { storeId: ['Required'] },
        },
      }).success,
    ).toBe(true);
    expect(
      ErrorEnvelopeSchema.safeParse({
        error: { code: 'UNKNOWN_ERROR', message: 'Nope', requestId: 'req-123' },
      }).success,
    ).toBe(false);
  });
});
