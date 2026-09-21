import { describe, expect, it } from 'vitest';
import { formatKg } from './format';

describe('Vietnamese kilogram display', () => {
  it.each([
    ['2.000', '2 kg'],
    ['2.330', '2,33 kg'],
    ['4.777', '4,78 kg'],
    ['4.7776', '4,78 kg'],
    ['5.009', '5,01 kg'],
    ['7.097', '7,1 kg'],
    ['1.9995', '2 kg'],
    ['0.0005', '0 kg'],
    ['0.0004', '0 kg'],
    ['-0.0004', '0 kg'],
    ['-2.3456', '-2,35 kg'],
    ['9007199254740993.007', '9.007.199.254.740.993,01 kg'],
  ])('formats %s without precision loss or trailing zeroes', (value, expected) => {
    expect(formatKg(value)).toBe(expected);
  });
  it('also rounds numeric UI projections to at most two decimals', () => {
    expect(formatKg(2)).toBe('2 kg');
    expect(formatKg(2.33)).toBe('2,33 kg');
    expect(formatKg(7.0974)).toBe('7,1 kg');
  });
});
