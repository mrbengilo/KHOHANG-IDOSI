import { invariant } from './errors.js';

declare const isoTimestampBrand: unique symbol;
declare const businessDateBrand: unique symbol;

export type IsoTimestamp = string & { readonly [isoTimestampBrand]: 'IsoTimestamp' };
export type BusinessDate = string & { readonly [businessDateBrand]: 'BusinessDate' };

export function nonEmpty(value: string, fieldName: string): string {
  invariant(
    value.trim().length > 0,
    'INVALID_ARGUMENT',
    `${fieldName} must be a non-empty string`,
    { fieldName },
  );
  return value;
}

export function positiveInteger(value: number, fieldName: string): number {
  invariant(
    Number.isSafeInteger(value) && value > 0,
    'INVALID_ARGUMENT',
    `${fieldName} must be a positive safe integer`,
    { fieldName, value },
  );
  return value;
}

export function nonNegativeInteger(value: number, fieldName: string): number {
  invariant(
    Number.isSafeInteger(value) && value >= 0,
    'INVALID_ARGUMENT',
    `${fieldName} must be a non-negative safe integer`,
    { fieldName, value },
  );
  return value;
}

export function nonZeroInteger(value: number, fieldName: string): number {
  invariant(
    Number.isSafeInteger(value) && value !== 0,
    'INVALID_ARGUMENT',
    `${fieldName} must be a non-zero safe integer`,
    { fieldName, value },
  );
  return value;
}

export function safeIntegerSum(left: number, right: number, fieldName: string): number {
  const total = left + right;
  invariant(
    Number.isSafeInteger(total),
    'INVALID_ARGUMENT',
    `${fieldName} exceeds the safe integer range`,
    { fieldName },
  );
  return total;
}

export function isoTimestamp(value: string, fieldName = 'timestamp'): IsoTimestamp {
  invariant(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value),
    'INVALID_ARGUMENT',
    `${fieldName} must be an ISO-8601 timestamp with an explicit timezone`,
    { fieldName, value },
  );
  const milliseconds = Date.parse(value);
  invariant(
    Number.isFinite(milliseconds),
    'INVALID_ARGUMENT',
    `${fieldName} must be a valid ISO-8601 timestamp`,
    { fieldName, value },
  );
  return new Date(milliseconds).toISOString() as IsoTimestamp;
}

export function businessDate(value: string, fieldName = 'businessDate'): BusinessDate {
  invariant(
    /^\d{4}-\d{2}-\d{2}$/.test(value),
    'INVALID_ARGUMENT',
    `${fieldName} must use YYYY-MM-DD`,
    { fieldName, value },
  );
  const parsed = new Date(`${value}T00:00:00.000Z`);
  invariant(
    !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value,
    'INVALID_ARGUMENT',
    `${fieldName} must be a real calendar date`,
    { fieldName, value },
  );
  return value as BusinessDate;
}

export function compareTimestamps(left: string, right: string): number {
  return isoTimestamp(left).localeCompare(isoTimestamp(right));
}

export function stableTupleKey(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('|');
}

export function uniqueStrings(values: readonly string[], fieldName: string): readonly string[] {
  const normalized = values.map((value) => nonEmpty(value, fieldName));
  invariant(
    new Set(normalized).size === normalized.length,
    'INVALID_ARGUMENT',
    `${fieldName} must not contain duplicates`,
    { fieldName },
  );
  return normalized;
}
