import { describe, expect, it } from 'vitest';
import { caretAfterDigits, formatMoneyDigits, parseMoneyInput } from './money-input';

describe('VND money input formatting', () => {
  it.each([
    ['', ''],
    ['0', '0'],
    ['999', '999'],
    ['1000', '1,000'],
    ['2000', '2,000'],
    ['1234567', '1,234,567'],
    ['9007199254740993', '9,007,199,254,740,993'],
  ])('shows %s as %s', (digits, expected) => {
    expect(formatMoneyDigits(digits)).toBe(expected);
  });

  it.each([
    ['1,000', '1000'],
    ['1.000.000', '1000000'],
    ['1 000 000 ₫', '1000000'],
    ['05', '5'],
    ['0,000', '0'],
    ['abc', ''],
  ])('keeps only integer digits when typing or pasting %s', (text, digits) => {
    expect(parseMoneyInput(text).digits).toBe(digits);
  });

  it('restores the caret after the same digit once separators move', () => {
    // User types "5" between "1" and "000" in "1,000" → "15,000", caret stays after "5".
    const typed = parseMoneyInput('15,000', 2);
    expect(typed).toEqual({ digits: '15000', digitsBeforeCaret: 2 });
    expect(caretAfterDigits(formatMoneyDigits(typed.digits), typed.digitsBeforeCaret)).toBe(2);
    // Typing a 4th digit at the end of "100" → "1,000", caret at the end.
    const grown = parseMoneyInput('1000', 4);
    expect(caretAfterDigits(formatMoneyDigits(grown.digits), grown.digitsBeforeCaret)).toBe(5);
    // A dropped leading zero does not push the caret past the next digit.
    const leadingZero = parseMoneyInput('05', 2);
    expect(leadingZero).toEqual({ digits: '5', digitsBeforeCaret: 1 });
    expect(caretAfterDigits('', 0)).toBe(0);
  });
});
