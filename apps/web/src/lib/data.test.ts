import { describe, expect, it } from 'vitest';
import { estimateGrams, kilogramsPerItem, kilogramsToGrams } from './conversions';
import { productConversions } from './data';

describe('product conversion catalog', () => {
  it('contains the approved 25 products without duplicate IDs', () => {
    expect(productConversions).toHaveLength(25);
    expect(new Set(productConversions.map((product) => product.id)).size).toBe(25);
  });

  it('uses the approved bedding conversion of one item to three kilograms', () => {
    const bedding = productConversions.find((product) => product.name.startsWith('Chăn, ga'));
    expect(bedding?.itemQuantity).toBe(1);
    expect(bedding?.weightKilograms).toBe('3.000');
    expect(bedding && kilogramsPerItem(bedding)).toBe(3);
  });

  it('parses decimal kilograms as exact integer grams', () => {
    expect(kilogramsToGrams('0.333')).toBe(333);
    expect(kilogramsToGrams('3,000')).toBe(3_000);
    expect(kilogramsToGrams('1.0004')).toBeNull();
  });

  it('rounds an exact rational conversion only after aggregating the item count', () => {
    const dresses = productConversions.find((product) => product.name === 'Đầm');
    expect(dresses && estimateGrams(dresses, 1)).toBe(333);
    expect(dresses && estimateGrams(dresses, 3)).toBe(1_000);
  });

  it('does not silently turn a missing conversion into zero or one-to-one', () => {
    const missing = { ...productConversions[0]!, itemQuantity: null, weightKilograms: null };
    expect(estimateGrams(missing, 3)).toBeNull();
    expect(kilogramsPerItem(missing)).toBeNull();
  });

  it('uses the Khách sỉ terminology', () => {
    expect(productConversions.map((product) => product.name)).not.toContain('Sỉ Miền Tây');
  });
});
