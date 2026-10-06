import { ListWaitTicketsQuerySchema, type ListWaitTicketsQuery } from '@idosi/contracts';

const keys = ['q', 'status', 'storeId', 'productId', 'createdFrom', 'createdTo', 'page'] as const;
export function readWaitTicketListNavigation(params: URLSearchParams): ListWaitTicketsQuery {
  const raw: Record<string, unknown> = { pageSize: 20, projection: 'TABLE' };
  for (const key of keys) {
    const value = params.get(`wt.${key}`);
    if (value) raw[key] = value;
  }
  // Invalid links fall back to an auditable all-status first page rather than requesting an invalid filter.
  const parsed = ListWaitTicketsQuerySchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : ListWaitTicketsQuerySchema.parse({ pageSize: 20, projection: 'TABLE' });
}
export function withWaitTicketListNavigation(
  params: URLSearchParams,
  changes: Record<string, string | number>,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (!('page' in changes)) next.delete('wt.page');
  for (const [key, value] of Object.entries(changes)) {
    if (value === '' || (key === 'page' && value === 1)) next.delete(`wt.${key}`);
    else next.set(`wt.${key}`, String(value));
  }
  return next;
}
