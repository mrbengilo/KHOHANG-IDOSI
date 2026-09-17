const KILOGRAMS_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,3}))?$/;

/**
 * Converts an already JSON-shaped kg value for cross-field checks.
 * Invalid primitive values return null so a Zod refinement never throws while
 * the owning primitive schema reports the validation issue.
 */
export function kilogramsToGramsForRefinement(value: unknown): bigint | null {
  if (typeof value !== 'string' || value.length > 24) {
    return null;
  }

  const match = KILOGRAMS_PATTERN.exec(value);
  if (match === null) {
    return null;
  }

  const whole = match[1];
  if (whole === undefined) {
    return null;
  }
  const fraction = (match[2] ?? '').padEnd(3, '0');
  return BigInt(whole) * 1_000n + BigInt(fraction || '0');
}

export function safeIntegerToBigIntForRefinement(value: unknown): bigint | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return BigInt(value);
}

export function sumRefinementValues(values: readonly (bigint | null)[]): bigint | null {
  let total = 0n;
  for (const value of values) {
    if (value === null) {
      return null;
    }
    total += value;
  }
  return total;
}
