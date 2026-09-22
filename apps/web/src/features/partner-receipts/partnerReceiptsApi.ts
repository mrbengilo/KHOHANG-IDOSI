import {
  CreatePartnerReceiptRequestSchema,
  CreatePartnerReceiptResponseSchema,
  GetPartnerReceiptResponseSchema,
  ListPartnerReceiptsResponseSchema,
  PartnerReceiptParamsSchema,
  type CreatePartnerReceiptRequest,
  type CreatePartnerReceiptResponse,
  type ListPartnerReceiptsQuery,
  type ListPartnerReceiptsResponse,
  type GetPartnerReceiptResponse,
} from '@idosi/contracts';
import { request } from '../../lib/api';

export async function listPartnerReceipts(
  query: ListPartnerReceiptsQuery,
): Promise<ListPartnerReceiptsResponse> {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
  if (query.storeId) params.set('storeId', query.storeId);
  if (query.status) params.set('status', query.status);
  if (query.partnerName) params.set('partnerName', query.partnerName);
  return ListPartnerReceiptsResponseSchema.parse(
    await request(`/partner-receipts?${params.toString()}`),
  );
}

export async function getPartnerReceipt(receiptId: string): Promise<GetPartnerReceiptResponse> {
  const params = PartnerReceiptParamsSchema.parse({ receiptId });
  return GetPartnerReceiptResponseSchema.parse(
    await request(`/partner-receipts/${encodeURIComponent(params.receiptId)}`),
  );
}

export async function createPartnerReceipt(
  input: CreatePartnerReceiptRequest,
): Promise<CreatePartnerReceiptResponse> {
  const body = CreatePartnerReceiptRequestSchema.parse(input);
  return CreatePartnerReceiptResponseSchema.parse(
    await request('/partner-receipts', { method: 'POST', body: JSON.stringify(body) }),
  );
}
