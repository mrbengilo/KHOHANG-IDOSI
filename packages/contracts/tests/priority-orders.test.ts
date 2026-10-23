import { describe, expect, it } from 'vitest';
import { PriorityOrderInputSchema } from '../src/priority-orders.js';
const id = '00000000-0000-4000-8000-000000000001';
const input = {
  storeId: id,
  sources: [{ id, revision: 'issued:1:now' }],
  additionalLines: [{ productId: id, quantity: 1 }],
  notes: '',
};
describe('emergency command boundary', () => {
  it('accepts selected held source and additional quantity', () =>
    expect(PriorityOrderInputSchema.parse(input)).toEqual(input));
  for (const quantity of [0, -1, 0.5, 10001, Infinity, NaN])
    it(`rejects quantity ${quantity}`, () =>
      expect(
        PriorityOrderInputSchema.safeParse({
          ...input,
          additionalLines: [{ productId: id, quantity }],
        }).success,
      ).toBe(false));
  it('rejects duplicate source, duplicate SKU, empty additions and forged origin fields', () => {
    for (const change of [
      { sources: [...input.sources, ...input.sources] },
      { additionalLines: [...input.additionalLines, ...input.additionalLines] },
      { additionalLines: [] },
      { sources: [] },
      { allocationRunId: id },
    ])
      expect(PriorityOrderInputSchema.safeParse({ ...input, ...change }).success).toBe(false);
  });
});
