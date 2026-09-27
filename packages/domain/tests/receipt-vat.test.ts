import { describe, expect, it } from 'vitest';
import {
  calculateReceiptVat,
  planReceiptAdjustmentMoney,
  weightedBagCostVnd,
} from '../src/index.js';

describe('receipt VAT integer arithmetic', () => {
  const before = {
    goodsVnd: 5_000_000n,
    freightVnd: 200_000n,
    handlingVnd: 100_000n,
    vatVnd: 424_000n,
  };
  it('taxes goods, freight and handling together and keeps VAT outside cost', () => {
    expect(calculateReceiptVat(5_300_000n, 8)).toBe(424_000n);
    expect(5_300_000n + calculateReceiptVat(5_300_000n, 8)).toBe(5_724_000n);
  });
  it.each([
    [-500_000n, 4_800_000n, 384_000n, 5_184_000n],
    [-1_000_000n, 4_300_000n, 344_000n, 4_644_000n],
    [-5_000_000n, 300_000n, 24_000n, 324_000n],
  ])('recalculates full retained value for delta %s', (goodsVnd, base, vat, total) => {
    const vatVnd = calculateReceiptVat(base, 8) - before.vatVnd;
    const result = planReceiptAdjustmentMoney(before, {
      goodsVnd,
      freightVnd: 0n,
      handlingVnd: 0n,
      vatVnd,
    });
    expect(result.after).toMatchObject({ costVnd: base, vatVnd: vat, totalVnd: total });
  });
  it('uses the old actual VAT when deriving a delta, including manually entered legacy VAT', () => {
    const original = { ...before, vatVnd: 500_000n };
    const vatVnd = calculateReceiptVat(4_800_000n, 8) - original.vatVnd;
    expect(vatVnd).toBe(-116_000n);
    expect(
      planReceiptAdjustmentMoney(original, {
        goodsVnd: -500_000n,
        freightVnd: 0n,
        handlingVnd: 0n,
        vatVnd,
      }).after.vatVnd,
    ).toBe(384_000n);
    expect(original.vatVnd).toBe(500_000n);
  });
  it('rounds half up once on the whole base and supports zero and other rates', () => {
    expect(calculateReceiptVat(5n, 10)).toBe(1n);
    expect(calculateReceiptVat(5n, 0)).toBe(0n);
    expect(calculateReceiptVat(3n, 100)).toBe(3n);
    expect(calculateReceiptVat(10n, 10)).toBe(1n);
    expect(weightedBagCostVnd(1001n, 500n)).toBe(501n);
    expect(calculateReceiptVat(501n, 10)).toBe(50n);
  });
  it.each([-1, 101, 8.5, NaN, Infinity])('rejects invalid rate %s', (rate) => {
    expect(() => calculateReceiptVat(100n, rate)).toThrow();
  });
  it('rejects negative bases and unsafe serialized totals', () => {
    expect(() => calculateReceiptVat(-1n, 8)).toThrow();
    expect(() => calculateReceiptVat(BigInt(Number.MAX_SAFE_INTEGER), 8)).toThrow();
    expect(calculateReceiptVat(BigInt(Number.MAX_SAFE_INTEGER), 0)).toBe(0n);
  });
});
