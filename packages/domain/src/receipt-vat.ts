import { invariant } from './errors.js';

/** Whole percentage points, 0..100. Money arithmetic is exclusively integer half-up. */
export function calculateReceiptVat(taxableVnd: bigint, ratePercent: number): bigint {
  invariant(
    Number.isInteger(ratePercent) && ratePercent >= 0 && ratePercent <= 100,
    'INVALID_ARGUMENT',
    'VAT rate must be an integer percentage from 0 to 100',
  );
  invariant(
    taxableVnd >= 0n && taxableVnd <= BigInt(Number.MAX_SAFE_INTEGER),
    'INVALID_ARGUMENT',
    'VAT base exceeds the safe money range',
  );
  const vat = (taxableVnd * BigInt(ratePercent) + 50n) / 100n;
  invariant(
    taxableVnd + vat <= BigInt(Number.MAX_SAFE_INTEGER),
    'INVALID_ARGUMENT',
    'Receipt total exceeds the safe money range',
  );
  return vat;
}
