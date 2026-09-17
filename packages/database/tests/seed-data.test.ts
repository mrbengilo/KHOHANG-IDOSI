import { describe, expect, it } from 'vitest';

import {
  PRODUCT_CONVERSION_SEEDS,
  PRODUCT_SEEDS,
  STORE_GROUP_SEEDS,
  STORE_SEEDS,
} from '../src/seed-data.js';

describe('reference seed data', () => {
  it('contains the 14 configured stores and only known group references', () => {
    expect(STORE_SEEDS).toHaveLength(14);
    expect(new Set(STORE_SEEDS.map((store) => store.code)).size).toBe(14);

    const groupCodes = new Set(STORE_GROUP_SEEDS.map((group) => group.code));
    expect(STORE_SEEDS.every((store) => groupCodes.has(store.groupCode))).toBe(true);
  });

  it('marks only SI_TINH stores as wholesale', () => {
    const kindByGroup = new Map(
      STORE_GROUP_SEEDS.map((group) => [group.code, group.kind] as const),
    );

    expect(kindByGroup.get('SI_TINH')).toBe('wholesale');
    expect(
      STORE_SEEDS.every(
        (store) =>
          kindByGroup.get(store.groupCode) ===
          (store.groupCode === 'SI_TINH' ? 'wholesale' : 'retail'),
      ),
    ).toBe(true);
  });

  it('contains the 25 approved and unique product identifiers', () => {
    expect(PRODUCT_SEEDS).toHaveLength(25);
    expect(new Set(PRODUCT_SEEDS.map((product) => product.sku)).size).toBe(25);
    expect(new Set(PRODUCT_SEEDS.map((product) => product.slug)).size).toBe(25);
    expect(PRODUCT_SEEDS.every((product) => product.unit === 'bag')).toBe(true);
  });

  it('keeps display order deterministic', () => {
    expect(STORE_SEEDS.map((store) => store.displayOrder)).toEqual(
      Array.from({ length: 14 }, (_, index) => index + 1),
    );
    expect(PRODUCT_SEEDS.map((product) => product.displayOrder)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
  });

  it('contains all 25 exact Figma conversion ratios without floating-point factors', () => {
    expect(PRODUCT_CONVERSION_SEEDS).toHaveLength(25);
    expect(PRODUCT_CONVERSION_SEEDS.map((conversion) => conversion.productSku)).toEqual(
      PRODUCT_SEEDS.map((product) => product.sku),
    );
    expect(
      PRODUCT_CONVERSION_SEEDS.map(({ itemQuantity, weightKilograms }) => [
        itemQuantity,
        weightKilograms,
      ]),
    ).toEqual([
      [3, '1.000'],
      [2, '1.000'],
      [3, '1.000'],
      [3, '1.000'],
      [4, '1.000'],
      [6, '1.000'],
      [1, '1.000'],
      [3, '1.000'],
      [4, '1.000'],
      [2, '1.000'],
      [5, '1.000'],
      [3, '1.000'],
      [3, '1.000'],
      [5, '1.000'],
      [1, '1.000'],
      [2, '1.000'],
      [1, '1.000'],
      [1, '1.000'],
      [3, '1.000'],
      [3, '1.000'],
      [6, '1.000'],
      [2, '1.000'],
      [1, '3.000'],
      [4, '1.000'],
      [2, '1.000'],
    ]);
    expect(
      PRODUCT_CONVERSION_SEEDS.every(
        (conversion) =>
          Number.isSafeInteger(conversion.itemQuantity) &&
          /^\d+\.\d{3}$/.test(conversion.weightKilograms),
      ),
    ).toBe(true);
  });
});
