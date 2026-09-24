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

/** The Vietnam calendar date of an instant (Asia/Ho_Chi_Minh has no daylight saving time). */
export function asiaHoChiMinhDate(instant: Date): string {
  return new Date(instant.getTime() + 7 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

/**
 * Exclusive end date for a conversion retired at `now`: the Vietnam business date, never before
 * the conversion started. Using the UTC date here ended conversions a day early whenever they
 * were retired between 00:00 and 07:00 in Vietnam.
 */
export function conversionRetirementDate(effectiveFrom: string, now: Date): string {
  const today = asiaHoChiMinhDate(now);
  return today > effectiveFrom ? today : effectiveFrom;
}

function localMidnightInstant(date: string): Date {
  return new Date(`${date}T00:00:00.000${ASIA_HO_CHI_MINH_OFFSET}`);
}

function nextIsoDate(date: string): string {
  const instant = new Date(`${date}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + 1);
  return instant.toISOString().slice(0, 10);
}
