import {
  AddSupplierSourceProductsResponseSchema,
  CancelSupplierOrderRequestSchema,
  ConfirmSupplierObservationRequestSchema,
  CreateSupplierSourceRequestSchema,
  CreateSupplierSourceResponseSchema,
  ListReshareOrdersResponseSchema,
  ListReshareStoresResponseSchema,
  ReshareStatusHistoryResponseSchema,
  UpdateReshareOrderStatusRequestSchema,
  UpdateReshareOrderStatusResponseSchema,
  type UpdateReshareOrderStatusRequest,
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
  type ReshareOrderHistoryStatus,
  type SupplierCommitmentFilter,
  type SupplierObservationRequest,
  type SupplierReconciliationFilter,
} from '@idosi/contracts';

import { request } from '../../lib/api';

/**
 * Query-key roots; every key also carries the role and account (`${role}:${accountId}`), so a
 * cache filled under one account or role is never shown to another one.
 */
export const SUPPLIER_QUERY_ROOTS = [
  'supplier-reconciliation',
  'supplier-commitments',
  'supplier-orders',
  'supplier-history',
  'supplier-sources',
  'warehouse-inventory',
  'reshare-orders',
  'reshare-status-history',
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
    await request(
      `/supplier-reconciliation?${query({ pageSize: 20, includeIssued: 'true', ...filters })}`,
      {
        signal: signal ?? null,
      },
    ),
  );
}

export interface ReshareOrderFilters {
  readonly page: number;
  readonly pageSize?: number;
  readonly sessionId?: string;
  readonly storeId?: string;
  readonly productId?: string;
  readonly status?: ReshareOrderHistoryStatus;
  /** ISO instants (Vietnam business days converted by the caller). */
  readonly from?: string;
  readonly to?: string;
  readonly code?: string;
}

/** "Lịch sử đặt hàng theo phân bổ": filtered, sorted and paged on the server. */
export async function loadReshareOrders(filters: ReshareOrderFilters, signal?: AbortSignal) {
  return ListReshareOrdersResponseSchema.parse(
    await request(
      `/reshare-orders?${query({
        pageSize: 20,
        includeStatusControl: 'true',
        includeStatusActor: 'true',
        ...filters,
      })}`,
      {
        signal: signal ?? null,
      },
    ),
  );
}

/** "Lịch sử thay đổi" of one result, newest first; only fetched when the dialog is open. */
export async function loadReshareStatusHistory(
  decisionId: string,
  page: number,
  signal?: AbortSignal,
) {
  return ReshareStatusHistoryResponseSchema.parse(
    await request(
      `/reshare-orders/${encodeURIComponent(decisionId)}/status-history?${query({ page, pageSize: 10 })}`,
      { signal: signal ?? null },
    ),
  );
}

/** Store filter of the Reshare module (every store for Admin/HTKD, own stores otherwise). */
export async function loadReshareStores(signal?: AbortSignal) {
  return ListReshareStoresResponseSchema.parse(
    await request('/reshare-orders/stores', { signal: signal ?? null }),
  );
}

export async function updateReshareOrderStatus(
  decisionId: string,
  input: UpdateReshareOrderStatusRequest,
  key: string,
) {
  return UpdateReshareOrderStatusResponseSchema.parse(
    await request(`/reshare-orders/${encodeURIComponent(decisionId)}/status`, {
      method: 'PUT',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify(UpdateReshareOrderStatusRequestSchema.parse(input)),
    }),
  ).data;
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

/** Always sends reshareCoverage (even empty) so the preview carries the RE details. */
export async function previewSupplierObservation(
  input: SupplierObservationRequest,
  signal?: AbortSignal,
) {
  return SupplierObservationPreviewResponseSchema.parse(
    await request('/supplier-stock-observations/preview', {
      signal: signal ?? null,
      method: 'POST',
      body: JSON.stringify(
        SupplierObservationRequestSchema.parse({
          ...input,
          reshareCoverage: input.reshareCoverage ?? [],
        }),
      ),
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
