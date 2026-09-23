const kilogramsPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/;

/** Upper bound shared with the API contract for one dispatch. */
export const MAX_BAGS_PER_DISPATCH = 100;

function grams(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0') || '0');
}

function kilograms(value: bigint): string {
  return `${value / 1000n}.${String(value % 1000n).padStart(3, '0')}`;
}

export function parseBagCount(value: string): number | null {
  if (!/^[1-9]\d{0,2}$/.test(value.trim())) return null;
  const count = Number(value.trim());
  return count <= MAX_BAGS_PER_DISPATCH ? count : null;
}

/** Keep weights already typed when the bag count changes. */
export function resizeBagWeights(weights: readonly string[], count: number | null): string[] {
  if (count === null) return [...weights];
  return Array.from({ length: count }, (_, index) => weights[index] ?? '');
}

export interface BagWeightsCheck {
  readonly valid: boolean;
  readonly totalKg: string;
  readonly error: string | null;
  /** Canonical kilogram strings to send when valid. */
  readonly bagWeightsKg: string[];
}

export function checkBagWeights(
  countText: string,
  weights: readonly string[],
  availableKg: string,
): BagWeightsCheck {
  const count = parseBagCount(countText);
  const invalid = (error: string | null, total = 0n): BagWeightsCheck => ({
    valid: false,
    totalKg: kilograms(total),
    error,
    bagWeightsKg: [],
  });
  if (count === null)
    return invalid(countText.trim() ? `Số bao phải từ 1 đến ${MAX_BAGS_PER_DISPATCH}.` : null);
  let total = 0n;
  const canonical: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = (weights[index] ?? '').trim();
    if (!value) return invalid(null, total);
    if (!kilogramsPattern.test(value) || grams(value) <= 0n)
      return invalid(`Bao ${index + 1}: nhập kg lớn hơn 0, tối đa 3 chữ số thập phân.`, total);
    total += grams(value);
    canonical.push(kilograms(grams(value)));
  }
  if (total > grams(availableKg)) return invalid('Tổng kg các bao vượt quá số kg đang có.', total);
  return { valid: true, totalKg: kilograms(total), error: null, bagWeightsKg: canonical };
}
