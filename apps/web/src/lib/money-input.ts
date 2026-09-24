/**
 * Helpers for VND money inputs. State always keeps the raw integer digits ("1000000")
 * so validation and API payloads stay unchanged; only the field text shows separators
 * ("1,000,000"). Strings are grouped without Number() so large values never lose precision.
 */

/** Group raw digits with a comma every three digits: "1000000" → "1,000,000". */
export function formatMoneyDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Parse what the user typed or pasted ("1,000", "1.000.000", "05") into raw digits,
 * dropping separators and redundant leading zeros. `digitsBeforeCaret` counts how many
 * of the kept digits sit before the caret so the caret can be restored after reformatting.
 */
export function parseMoneyInput(
  text: string,
  caret: number = text.length,
): { digits: string; digitsBeforeCaret: number } {
  const allDigits = text.replace(/\D/g, '');
  const digits = allDigits.replace(/^0+(?=\d)/, '');
  const removedLeadingZeros = allDigits.length - digits.length;
  const typedBeforeCaret = text.slice(0, caret).replace(/\D/g, '').length;
  return { digits, digitsBeforeCaret: Math.max(0, typedBeforeCaret - removedLeadingZeros) };
}

/** Caret position in formatted text that sits right after `digitCount` digits. */
export function caretAfterDigits(formatted: string, digitCount: number): number {
  if (digitCount <= 0) return 0;
  let seen = 0;
  for (let index = 0; index < formatted.length; index += 1) {
    if (/\d/.test(formatted[index] ?? '')) seen += 1;
    if (seen === digitCount) return index + 1;
  }
  return formatted.length;
}
