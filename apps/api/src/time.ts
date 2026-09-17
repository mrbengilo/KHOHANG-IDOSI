const ASIA_HO_CHI_MINH_OFFSET = '+07:00';

export interface DateRange {
  readonly start: Date;
  readonly endExclusive: Date;
}

/** Converts inclusive Vietnam calendar dates to the corresponding half-open UTC instant range. */
export function asiaHoChiMinhDateRange(from: string, to: string): DateRange {
  const start = localMidnightInstant(from);
  const endExclusive = localMidnightInstant(nextIsoDate(to));
  if (
    Number.isNaN(start.valueOf()) ||
    Number.isNaN(endExclusive.valueOf()) ||
    start >= endExclusive
  ) {
    throw new RangeError('Invalid Asia/Ho_Chi_Minh date range');
  }
  return { start, endExclusive };
}

function localMidnightInstant(date: string): Date {
  return new Date(`${date}T00:00:00.000${ASIA_HO_CHI_MINH_OFFSET}`);
}

function nextIsoDate(date: string): string {
  const instant = new Date(`${date}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + 1);
  return instant.toISOString().slice(0, 10);
}
