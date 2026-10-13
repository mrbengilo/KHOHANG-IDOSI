import {
  AddSupplierSourceProductsResponseSchema,
  CancelSupplierOrderRequestSchema,
  ConfirmSupplierObservationRequestSchema,
  CreateSupplierSourceRequestSchema,
  CreateSupplierSourceResponseSchema,
  ListSupplierOrdersResponseSchema,
  ListSupplierSourcesResponseSchema,
  RecordSupplierOrderRequestSchema,
  SupplierBatchResponseSchema,
  SupplierCommitmentsResponseSchema,
  SupplierObservationHistoryResponseSchema,
  SupplierObservationPreviewResponseSchema,
  SupplierObservationRequestSchema,
  SupplierObservationResponseSchema,
  SupplierReconciliationResponseSchema,
  type CancelSupplierOrderRequest,
  type ConfirmSupplierObservationRequest,
  type CreateSupplierSourceRequest,
  type RecordSupplierOrderRequest,
  type SupplierCommitmentFilter,
  type SupplierObservationRequest,
  type SupplierReconciliationFilter,
} from '@idosi/contracts';

import { request } from '../../lib/api';

/** Query-key roots; every key also carries the account and role (see useSupplierScope). */
export const SUPPLIER_QUERY_ROOTS = [
  'supplier-reconciliation',
  'supplier-commitments',
  'supplier-orders',
  'supplier-history',
  'supplier-sources',
  'warehouse-inventory',
] as const;

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return params.toString();
}

export async function loadSupplierSources(signal?: AbortSignal) {
  return ListSupplierSourcesResponseSchema.parse(
    await request('/supplier-sources', { signal: signal ?? null }),
  ).data;
}

export async function createSupplierSource(input: CreateSupplierSourceRequest, key: string) {
  return CreateSupplierSourceResponseSchema.parse(
    await request('/supplier-sources', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify(CreateSupplierSourceRequestSchema.parse(input)),
    }),
  ).data;
}

export async function addSupplierSourceProducts(
  sourceId: string,
  productIds: readonly string[],
  key: string,
) {
  return AddSupplierSourceProductsResponseSchema.parse(
    await request(`/supplier-sources/${encodeURIComponent(sourceId)}/products`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ productIds }),
    }),
  ).data;
}

export async function loadSupplierReconciliation(
  filters: {
    readonly page: number;
    readonly search: string;
    readonly filter: SupplierReconciliationFilter;
    readonly sourceId?: string;
  },
  signal?: AbortSignal,
) {
  return SupplierReconciliationResponseSchema.parse(
    await request(`/supplier-reconciliation?${query({ pageSize: 20, ...filters })}`, {
      signal: signal ?? null,
    }),
  );
}

export async function loadSupplierCommitments(
  filters: {
    readonly page: number;
    readonly filter: SupplierCommitmentFilter;
    readonly productId?: string;
    readonly storeId?: string;
    readonly pageSize?: number;
  },
  signal?: AbortSignal,
) {
  return SupplierCommitmentsResponseSchema.parse(
    await request(`/supplier-commitments?${query({ pageSize: 20, ...filters })}`, {
      signal: signal ?? null,
    }),
  );
}

export async function loadSupplierOrders(
  filters: { readonly page: number; readonly productId?: string; readonly storeId?: string },
  signal?: AbortSignal,
) {
  return ListSupplierOrdersResponseSchema.parse(
    await request(`/supplier-orders?${query({ pageSize: 10, ...filters })}`, {
      signal: signal ?? null,
    }),
  );
}

export async function loadSupplierHistory(
  filters: { readonly page: number; readonly productId?: string },
  signal?: AbortSignal,
) {
  return SupplierObservationHistoryResponseSchema.parse(
    await request(`/supplier-reconciliation/history?${query({ pageSize: 20, ...filters })}`, {
      signal: signal ?? null,
    }),
  );
}

export async function previewSupplierObservation(input: SupplierObservationRequest) {
  return SupplierObservationPreviewResponseSchema.parse(
    await request('/supplier-stock-observations/preview', {
      method: 'POST',
      body: JSON.stringify(SupplierObservationRequestSchema.parse(input)),
    }),
  ).data;
}

/** The key belongs to one exact payload: a retry after a lost response replays it. */
export async function confirmSupplierObservation(
  input: ConfirmSupplierObservationRequest,
  key: string,
) {
  return SupplierObservationResponseSchema.parse(
    await request('/supplier-stock-observations', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify(ConfirmSupplierObservationRequestSchema.parse(input)),
    }),
  ).data;
}

export async function recordSupplierOrder(input: RecordSupplierOrderRequest, key: string) {
  return SupplierBatchResponseSchema.parse(
    await request('/supplier-orders', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify(RecordSupplierOrderRequestSchema.parse(input)),
    }),
  ).data;
}

export async function cancelSupplierOrder(
  eventId: string,
  input: CancelSupplierOrderRequest,
  key: string,
) {
  return SupplierBatchResponseSchema.parse(
    await request(`/supplier-orders/${encodeURIComponent(eventId)}/cancellations`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify(CancelSupplierOrderRequestSchema.parse(input)),
    }),
  ).data;
}
