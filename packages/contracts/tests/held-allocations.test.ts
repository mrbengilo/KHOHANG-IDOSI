import { describe, expect, it } from 'vitest';

import {
  HeldAllocationSchema,
  ListHeldAllocationsQuerySchema,
  ListHeldAllocationsResponseSchema,
} from '../src/index.js';

const held = {
  storeId: '44444444-4444-4444-8444-444444444444',
  productId: '22222222-2222-4222-8222-222222222222',
  heldUnits: 2,
  heldSince: '2026-09-22T09:00:00+07:00',
};

describe('held allocation contracts', () => {
  it('describes reserved priority goods waiting for the next ordinary order', () => {
    expect(HeldAllocationSchema.parse(held)).toEqual(held);
    expect(ListHeldAllocationsResponseSchema.safeParse({ data: [held] }).success).toBe(true);
    expect(ListHeldAllocationsQuerySchema.parse({})).toEqual({});
    expect(ListHeldAllocationsQuerySchema.parse({ storeId: held.storeId })).toEqual({
      storeId: held.storeId,
    });
  });

  it('rejects empty holds, duplicate rows and unknown fields', () => {
    expect(HeldAllocationSchema.safeParse({ ...held, heldUnits: 0 }).success).toBe(false);
    expect(HeldAllocationSchema.safeParse({ ...held, heldUnits: 1.5 }).success).toBe(false);
    expect(HeldAllocationSchema.safeParse({ ...held, extra: true }).success).toBe(false);
    expect(ListHeldAllocationsResponseSchema.safeParse({ data: [held, held] }).success).toBe(false);
    expect(ListHeldAllocationsQuerySchema.safeParse({ storeId: 'not-an-id' }).success).toBe(false);
  });
});
