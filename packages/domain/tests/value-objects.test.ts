import { describe, expect, it } from 'vitest';

import {
  addVnd,
  addWeight,
  deserializeWeight,
  formatWeight,
  serializeWeight,
  vnd,
  weight,
} from '../src/index.js';

describe('VND', () => {
  it('uses non-negative safe integers and rejects floating-point money', () => {
    expect(vnd(250_000)).toBe(250_000);
    expect(() => vnd(0.1)).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => vnd(Number.MAX_SAFE_INTEGER + 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => addVnd(vnd(Number.MAX_SAFE_INTEGER), vnd(1))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });
});

describe('weight', () => {
  it('adds decimal gram strings without binary floating-point loss', () => {
    const total = addWeight(weight('0.1', 'g'), weight('0.2', 'g'));

    expect(formatWeight(total, 'g')).toBe('0.3');
    expect(serializeWeight(total)).toEqual({ milligrams: '300' });
    expect(formatWeight(deserializeWeight({ milligrams: '300' }), 'kg')).toBe('0.0003');
  });

  it('converts kg and grams through an exact milligram scale', () => {
    const value = weight('1.234', 'kg');

    expect(formatWeight(value, 'g')).toBe('1234');
    expect(formatWeight(value, 'kg')).toBe('1.234');
    expect(serializeWeight(value)).toEqual({ milligrams: '1234000' });
  });

  it('rejects scientific notation, sub-milligram precision, and sub-gram kg precision', () => {
    expect(() => weight('1e3', 'g')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => weight('0.0001', 'g')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => weight('-1', 'kg')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => weight('1.2345', 'kg')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });
});
