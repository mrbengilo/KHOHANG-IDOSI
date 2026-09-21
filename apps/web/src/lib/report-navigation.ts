import { EntityIdSchema } from '@idosi/contracts';

/** URL filters are navigation hints only; API authorization remains authoritative. */
export function readReportNavigation(
  search: URLSearchParams,
  fallbackPeriod: string,
  allowAll: boolean,
) {
  const period = search.get('period') ?? '';
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  const validPeriod = match && Number(match[1]) >= 2000 && Number(match[1]) <= 2100;
  const scope = search.get('scope') ?? '';
  return {
    period: validPeriod ? period : fallbackPeriod,
    scope:
      scope === 'ALL' && allowAll
        ? 'ALL'
        : EntityIdSchema.safeParse(scope).success
          ? scope
          : allowAll
            ? 'ALL'
            : '',
  };
}

export function reportDrilldownPath(period: string, scope: string): string {
  return `/reports?${new URLSearchParams({ period, scope })}`;
}

export function updateReportNavigation(
  search: URLSearchParams,
  key: 'period' | 'scope',
  value: string,
) {
  const next = new URLSearchParams(search);
  next.set(key, value);
  return next;
}
