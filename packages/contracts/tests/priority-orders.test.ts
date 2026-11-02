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
  it('accepts additional goods without any held source or wait document', () => {
    const fresh = { ...input, sources: [] };
    expect(PriorityOrderInputSchema.parse(fresh)).toEqual(fresh);
  });
  it('accepts selected held goods without additions, but never an empty order', () => {
    expect(
      PriorityOrderInputSchema.parse({ ...input, additionalLines: [] }).additionalLines,
    ).toEqual([]);
    expect(
      PriorityOrderInputSchema.safeParse({ ...input, sources: [], additionalLines: [] }).success,
    ).toBe(false);
  });
  for (const quantity of [0, -1, 0.5, 10001, Infinity, NaN])
    it(`rejects quantity ${quantity}`, () =>
      expect(
        PriorityOrderInputSchema.safeParse({
          ...input,
          additionalLines: [{ productId: id, quantity }],
        }).success,
      ).toBe(false));
  it('rejects duplicate source, duplicate SKU and forged origin fields', () => {
    for (const change of [
      { sources: [...input.sources, ...input.sources] },
      { additionalLines: [...input.additionalLines, ...input.additionalLines] },
      { allocationRunId: id },
    ])
      expect(PriorityOrderInputSchema.safeParse({ ...input, ...change }).success).toBe(false);
  });
});
