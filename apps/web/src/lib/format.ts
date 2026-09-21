export const formatInteger = (value: number): string =>
  new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(value);

/** Decimal API values stay exact, including weights above Number.MAX_SAFE_INTEGER. */
export function formatKg(value: number | string): string {
  if (typeof value === 'number') {
    return `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(value)} kg`;
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return '—';
  const [, sign, whole = '0', fraction = ''] = match;
  const grams =
    BigInt(whole) * 100n +
    BigInt(fraction.padEnd(2, '0').slice(0, 2)) +
    (Number(fraction[2] ?? '0') >= 5 ? 1n : 0n);
  const decimals = String(grams % 100n)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${sign && grams > 0n ? '-' : ''}${new Intl.NumberFormat('vi-VN').format(grams / 100n)}${decimals ? `,${decimals}` : ''} kg`;
}

export const formatVnd = (value: number | null): string =>
  value === null
    ? 'Không áp dụng'
    : new Intl.NumberFormat('vi-VN', {
        currency: 'VND',
        maximumFractionDigits: 0,
        notation: value >= 1_000_000_000 ? 'compact' : 'standard',
        style: 'currency',
      }).format(value);

export const formatPercent = (value: number | null): string =>
  value === null
    ? 'N/A'
    : `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(value)}%`;
