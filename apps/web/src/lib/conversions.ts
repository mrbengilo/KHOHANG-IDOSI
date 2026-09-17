import type { ProductConversion } from './types';

const DECIMAL_KILOGRAMS = /^(?:0|[1-9]\d*)(?:[.,](\d{1,3}))?$/;

/** Converts the API decimal string to integer grams without binary-float parsing. */
export function kilogramsToGrams(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  const match = DECIMAL_KILOGRAMS.exec(normalized);
  if (!match) return null;

  const [whole = '0'] = normalized.split('.');
  const fraction = (match[1] ?? '').padEnd(3, '0');
  const grams = Number(whole) * 1_000 + Number(fraction);
  return Number.isSafeInteger(grams) && grams > 0 ? grams : null;
}

export function normalizeKilograms(value: string): string | null {
  const grams = kilogramsToGrams(value);
  if (grams === null) return null;
  return `${Math.floor(grams / 1_000)}.${String(grams % 1_000).padStart(3, '0')}`;
}

export function itemsPerKilogram(conversion: ProductConversion): number | null {
  const grams =
    conversion.weightKilograms === null ? null : kilogramsToGrams(conversion.weightKilograms);
  return grams === null || conversion.itemQuantity === null
    ? null
    : (conversion.itemQuantity * 1_000) / grams;
}

export function kilogramsPerItem(conversion: ProductConversion): number | null {
  const grams =
    conversion.weightKilograms === null ? null : kilogramsToGrams(conversion.weightKilograms);
  return grams === null || conversion.itemQuantity === null
    ? null
    : grams / 1_000 / conversion.itemQuantity;
}

/**
 * Applies the exact rational conversion and rounds once, after aggregation, to the nearest gram.
 * Persisted and intermediate values stay integer-based; the kilogram number is display-only.
 */
export function estimateGrams(conversion: ProductConversion, items: number): number | null {
  if (
    !Number.isSafeInteger(items) ||
    items < 0 ||
    conversion.itemQuantity === null ||
    !Number.isSafeInteger(conversion.itemQuantity) ||
    conversion.itemQuantity <= 0
  ) {
    return null;
  }
  const grams =
    conversion.weightKilograms === null ? null : kilogramsToGrams(conversion.weightKilograms);
  if (grams === null) return null;

  const numerator = BigInt(grams) * BigInt(items);
  const denominator = BigInt(conversion.itemQuantity);
  const rounded = (numerator * 2n + denominator) / (denominator * 2n);
  const result = Number(rounded);
  return Number.isSafeInteger(result) ? result : null;
}

export function estimateKilograms(conversion: ProductConversion, items: number): number | null {
  const grams = estimateGrams(conversion, items);
  return grams === null ? null : grams / 1_000;
}
