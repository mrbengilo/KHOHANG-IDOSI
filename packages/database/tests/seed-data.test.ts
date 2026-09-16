import { describe, expect, it } from 'vitest';

import { PRODUCT_SEEDS, STORE_GROUP_SEEDS, STORE_SEEDS } from '../src/seed-data.js';

describe('reference seed data', () => {
  it('contains the 14 configured stores and only known group references', () => {
    expect(STORE_SEEDS).toHaveLength(14);
    expect(new Set(STORE_SEEDS.map((store) => store.code)).size).toBe(14);

    const groupCodes = new Set(STORE_GROUP_SEEDS.map((group) => group.code));
    expect(STORE_SEEDS.every((store) => groupCodes.has(store.groupCode))).toBe(true);
  });

  it('contains 28 stable and unique product identifiers', () => {
    expect(PRODUCT_SEEDS).toHaveLength(28);
    expect(new Set(PRODUCT_SEEDS.map((product) => product.sku)).size).toBe(28);
    expect(new Set(PRODUCT_SEEDS.map((product) => product.slug)).size).toBe(28);
    expect(PRODUCT_SEEDS.every((product) => product.unit === 'bag')).toBe(true);
  });

  it('keeps display order deterministic', () => {
    expect(STORE_SEEDS.map((store) => store.displayOrder)).toEqual(
      Array.from({ length: 14 }, (_, index) => index + 1),
    );
    expect(PRODUCT_SEEDS.map((product) => product.displayOrder)).toEqual(
      Array.from({ length: 28 }, (_, index) => index + 1),
    );
  });
});
