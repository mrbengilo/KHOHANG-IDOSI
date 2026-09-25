import {
  ListReceiptAdjustmentsResponseSchema,
  ReceiptAdjustmentHistoryResponseSchema,
  ListReceiptReturnsResponseSchema,
  ReceiptAdjustmentContextResponseSchema,
  ReceiptAdjustmentResponseSchema,
  ReceiptReturnResponseSchema,
  type CreateReceiptAdjustmentRequest,
  type CreateReceiptReturnRequest,
  type ReceiptAdjustment,
  type ReceiptAdjustmentActionRequest,
  type PaginationMeta,
  type ReceiptAdjustmentContext,
  type ReceiptAdjustmentDateField,
  type ReceiptAdjustmentHistoryEvent,
  type ReceiptAdjustmentListItem,
  type ReceiptAdjustmentStatus,
  type ReceiptReturn,
  type ReceiptReturnActionRequest,
  type ReceiptReturnStatus,
} from '@idosi/contracts';

import { listAllPages, request } from '../../../lib/api';

/**
 * How an open screen learns about another session's decision (an admin applying on another
 * machine): active discrepancy queries poll every 15 s while the tab is visible, and refetch
 * at once when the tab regains focus or the network returns. Hidden tabs do not poll. This is
 * short-delay consistency, not instant realtime; it is scoped to these queries only.
 */
export const ADJUSTMENT_SYNC_INTERVAL_MS = 15_000;
export const adjustmentSyncOptions = {
  refetchInterval: ADJUSTMENT_SYNC_INTERVAL_MS,
  refetchIntervalInBackground: false,
  refetchOnReconnect: 'always',
  refetchOnWindowFocus: 'always',
} as const;

export interface Page<T> {
  readonly data: T[];
  readonly pagination: PaginationMeta;
}

export interface AdjustmentPageFilters {
  readonly page: number;
  readonly pageSize: number;
  readonly status?: ReceiptAdjustmentStatus;
  readonly storeId?: string;
  readonly receiptId?: string;
  readonly q?: string;
  readonly dateField?: ReceiptAdjustmentDateField;
  /** Inclusive Vietnam business dates (YYYY-MM-DD). */
  readonly from?: string;
  readonly to?: string;
}

export function adjustmentPageQuery(filters: AdjustmentPageFilters): URLSearchParams {
  const query = new URLSearchParams({
    page: String(filters.page),
    pageSize: String(filters.pageSize),
  });
  if (filters.status) query.set('status', filters.status);
  if (filters.storeId) query.set('storeId', filters.storeId);
  if (filters.receiptId) query.set('receiptId', filters.receiptId);
  const search = filters.q?.trim();
  if (search) query.set('q', search);
  if (filters.from || filters.to) {
    query.set('dateField', filters.dateField ?? 'REPORTED');
    if (filters.from) query.set('from', filters.from);
    if (filters.to) query.set('to', filters.to);
  }
  return query;
}

/** One server page with its pagination; list screens never download every page. */
export async function listReceiptAdjustmentsPage(
  filters: AdjustmentPageFilters,
): Promise<Page<ReceiptAdjustmentListItem>> {
  const payload = await request(`/receipt-adjustments?${adjustmentPageQuery(filters)}`);
  return ListReceiptAdjustmentsResponseSchema.parse(payload);
}

export async function listReceiptAdjustmentHistory(
  adjustmentId: string,
  page: number,
  pageSize = 20,
): Promise<Page<ReceiptAdjustmentHistoryEvent>> {
  const payload = await request(
    `/receipt-adjustments/${encodeURIComponent(adjustmentId)}/history?${new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    })}`,
  );
  return ReceiptAdjustmentHistoryResponseSchema.parse(payload);
}

/** Every read goes to the server; tồn và tiền are never updated optimistically. */
export async function getReceiptAdjustmentContext(
  receiptId: string,
): Promise<ReceiptAdjustmentContext> {
  const payload = await request(
    `/store-receipts/${encodeURIComponent(receiptId)}/adjustment-context`,
  );
  return ReceiptAdjustmentContextResponseSchema.parse(payload).data;
}

/** Every document of one status (a bounded work queue), for the role's to-do list. */
export async function listReceiptAdjustments(filters: {
  readonly status?: ReceiptAdjustmentStatus;
  readonly storeId?: string;
}): Promise<ReceiptAdjustmentListItem[]> {
  const query = new URLSearchParams();
  if (filters.status) query.set('status', filters.status);
  if (filters.storeId) query.set('storeId', filters.storeId);
  return listAllPages('/receipt-adjustments', query, (payload) =>
    ListReceiptAdjustmentsResponseSchema.parse(payload),
  );
}

export async function getReceiptAdjustment(adjustmentId: string): Promise<ReceiptAdjustment> {
  const payload = await request(`/receipt-adjustments/${encodeURIComponent(adjustmentId)}`);
  return ReceiptAdjustmentResponseSchema.parse(payload).data;
}

async function post(path: string, input: unknown, idempotencyKey: string): Promise<unknown> {
  return request(path, {
    body: JSON.stringify(input),
    headers: { 'idempotency-key': idempotencyKey },
    method: 'POST',
  });
}

export async function createReceiptAdjustment(
  input: CreateReceiptAdjustmentRequest,
  idempotencyKey: string,
): Promise<ReceiptAdjustment> {
  return ReceiptAdjustmentResponseSchema.parse(
    await post('/receipt-adjustments', input, idempotencyKey),
  ).data;
}

export async function actOnReceiptAdjustment(
  adjustmentId: string,
  input: ReceiptAdjustmentActionRequest,
  idempotencyKey: string,
): Promise<ReceiptAdjustment> {
  return ReceiptAdjustmentResponseSchema.parse(
    await post(
      `/receipt-adjustments/${encodeURIComponent(adjustmentId)}/actions`,
      input,
      idempotencyKey,
    ),
  ).data;
}

export async function createReceiptReturn(
  adjustmentId: string,
  lineId: string,
  input: CreateReceiptReturnRequest,
  idempotencyKey: string,
): Promise<ReceiptReturn> {
  return ReceiptReturnResponseSchema.parse(
    await post(
      `/receipt-adjustments/${encodeURIComponent(adjustmentId)}/lines/${encodeURIComponent(lineId)}/returns`,
      input,
      idempotencyKey,
    ),
  ).data;
}

export async function listReceiptReturns(filters: {
  readonly status?: ReceiptReturnStatus;
  readonly storeId?: string;
}): Promise<ReceiptReturn[]> {
  const query = new URLSearchParams();
  if (filters.status) query.set('status', filters.status);
  if (filters.storeId) query.set('storeId', filters.storeId);
  return listAllPages('/receipt-returns', query, (payload) =>
    ListReceiptReturnsResponseSchema.parse(payload),
  );
}

export async function actOnReceiptReturn(
  returnId: string,
  input: ReceiptReturnActionRequest,
  idempotencyKey: string,
): Promise<ReceiptReturn> {
  return ReceiptReturnResponseSchema.parse(
    await post(`/receipt-returns/${encodeURIComponent(returnId)}/actions`, input, idempotencyKey),
  ).data;
}
