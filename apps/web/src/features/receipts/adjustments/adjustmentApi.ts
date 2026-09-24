import {
  ListReceiptAdjustmentsResponseSchema,
  ListReceiptReturnsResponseSchema,
  ReceiptAdjustmentContextResponseSchema,
  ReceiptAdjustmentResponseSchema,
  ReceiptReturnResponseSchema,
  type CreateReceiptAdjustmentRequest,
  type CreateReceiptReturnRequest,
  type ReceiptAdjustment,
  type ReceiptAdjustmentActionRequest,
  type ReceiptAdjustmentContext,
  type ReceiptAdjustmentListItem,
  type ReceiptAdjustmentStatus,
  type ReceiptReturn,
  type ReceiptReturnActionRequest,
  type ReceiptReturnStatus,
} from '@idosi/contracts';

import { listAllPages, request } from '../../../lib/api';

/** Every read goes to the server; tồn và tiền are never updated optimistically. */
export async function getReceiptAdjustmentContext(
  receiptId: string,
): Promise<ReceiptAdjustmentContext> {
  const payload = await request(
    `/store-receipts/${encodeURIComponent(receiptId)}/adjustment-context`,
  );
  return ReceiptAdjustmentContextResponseSchema.parse(payload).data;
}

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
