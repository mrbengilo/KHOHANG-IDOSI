import { invariant } from './errors.js';
import { nonNegativeInteger, safeIntegerSum } from './validation.js';

declare const vndBrand: unique symbol;
declare const weightBrand: unique symbol;

export type Vnd = number & { readonly [vndBrand]: 'Vnd' };

export type Weight = Readonly<{
  milligrams: bigint;
  readonly [weightBrand]: 'Weight';
}>;

export type WeightUnit = 'g' | 'kg';

const FRACTION_DIGITS: Readonly<Record<WeightUnit, number>> = {
  g: 3,
  kg: 6,
};

export function vnd(value: number): Vnd {
  return nonNegativeInteger(value, 'VND amount') as Vnd;
}

export function addVnd(left: Vnd, right: Vnd): Vnd {
  return safeIntegerSum(left, right, 'VND amount') as Vnd;
}

export function multiplyVnd(unitPrice: Vnd, quantity: number): Vnd {
  nonNegativeInteger(quantity, 'quantity');
  const total = unitPrice * quantity;
  invariant(
    Number.isSafeInteger(total),
    'INVALID_ARGUMENT',
    'VND multiplication exceeds the safe integer range',
  );
  return total as Vnd;
}

export function weight(value: string, unit: WeightUnit): Weight {
  const fractionDigits = FRACTION_DIGITS[unit];
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  invariant(match !== null, 'INVALID_ARGUMENT', 'Weight must be an unsigned plain decimal string', {
    unit,
    value,
  });

  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  invariant(
    fraction.length <= fractionDigits,
    'INVALID_ARGUMENT',
    `Weight in ${unit} supports at most ${fractionDigits} fractional digits`,
    { unit, value },
  );

  const scale = 10n ** BigInt(fractionDigits);
  const fractionPadded = fraction.padEnd(fractionDigits, '0');
  const milligrams = BigInt(whole) * scale + BigInt(fractionPadded || '0');
  return { milligrams } as Weight;
}

export function weightFromMilligrams(milligrams: bigint): Weight {
  invariant(milligrams >= 0n, 'INVALID_ARGUMENT', 'Weight milligrams must be non-negative');
  return { milligrams } as Weight;
}

export function addWeight(left: Weight, right: Weight): Weight {
  return weightFromMilligrams(left.milligrams + right.milligrams);
}

export function subtractWeight(left: Weight, right: Weight): Weight {
  invariant(
    left.milligrams >= right.milligrams,
    'INVALID_ARGUMENT',
    'Weight subtraction cannot produce a negative value',
  );
  return weightFromMilligrams(left.milligrams - right.milligrams);
}

export function formatWeight(value: Weight, unit: WeightUnit): string {
  const fractionDigits = FRACTION_DIGITS[unit];
  const scale = 10n ** BigInt(fractionDigits);
  const whole = value.milligrams / scale;
  const fraction = (value.milligrams % scale).toString().padStart(fractionDigits, '0');
  const trimmedFraction = fraction.replace(/0+$/, '');
  return trimmedFraction.length === 0 ? whole.toString() : `${whole}.${trimmedFraction}`;
}

export function serializeWeight(value: Weight): Readonly<{ milligrams: string }> {
  return { milligrams: value.milligrams.toString() };
}

export function deserializeWeight(value: Readonly<{ milligrams: string }>): Weight {
  invariant(
    /^(0|[1-9]\d*)$/.test(value.milligrams),
    'INVALID_ARGUMENT',
    'Serialized weight must contain canonical non-negative integer milligrams',
    { milligrams: value.milligrams },
  );
  return weightFromMilligrams(BigInt(value.milligrams));
}
