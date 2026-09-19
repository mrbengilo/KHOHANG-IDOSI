import { describe, expect, it } from 'vitest';
import { formatKg } from './format';

describe('Vietnamese kilogram display', () => {
  it.each([
    ['2.000', '2 kg'],
    ['2.330', '2,33 kg'],
    ['5.009', '5,009 kg'],
    ['7.097', '7,097 kg'],
    ['1.9995', '2 kg'],
    ['0.0005', '0,001 kg'],
    ['0.0004', '0 kg'],
    ['-0.0004', '0 kg'],
    ['-2.3456', '-2,346 kg'],
    ['9007199254740993.007', '9.007.199.254.740.993,007 kg'],
  ])('formats %s without precision loss or trailing zeroes', (value, expected) => {
    expect(formatKg(value)).toBe(expected);
  });
  it('also rounds numeric UI projections to at most three decimals', () => {
    expect(formatKg(2)).toBe('2 kg');
    expect(formatKg(2.33)).toBe('2,33 kg');
    expect(formatKg(7.0974)).toBe('7,097 kg');
  });
});
