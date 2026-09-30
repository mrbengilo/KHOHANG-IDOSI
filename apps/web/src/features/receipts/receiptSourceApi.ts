import { ListStoreReceiptSourcesResponseSchema, type StoreReceiptSource } from '@idosi/contracts';

import { request, mapWithConcurrency, PAGE_FETCH_CONCURRENCY } from '../../lib/api';

export interface ReceiptSourceFilters {
  readonly storeId?: string;
}

async function loadReceiptSourcePage(filters: ReceiptSourceFilters, page: number) {
  const query = new URLSearchParams({ page: String(page), pageSize: '100' });
  if (filters.storeId) query.set('storeId', filters.storeId);

  const payload = await request(`/store-receipt-sources?${query.toString()}`);
  return ListStoreReceiptSourcesResponseSchema.parse(payload);
}

/** Source-backed only: this endpoint intentionally has no local or mock fallback. */
export async function listStoreReceiptSources(
  filters: ReceiptSourceFilters = {},
): Promise<StoreReceiptSource[]> {
  const first = await loadReceiptSourcePage(filters, 1);
  if (first.pagination.totalPages <= 1) return first.data;
  const remaining = await mapWithConcurrency(
    first.pagination.totalPages - 1,
    PAGE_FETCH_CONCURRENCY,
    (index) => loadReceiptSourcePage(filters, index + 2),
  );
  return [first, ...remaining].flatMap((page) => page.data);
}
