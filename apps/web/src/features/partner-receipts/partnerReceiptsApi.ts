import type {
  CreatePartnerReceiptRequest,
  ListPartnerReceiptsQuery,
  ListPartnerReceiptsResponse,
  GetPartnerReceiptResponse,
} from '@idosi/contracts';
import { apiClient } from '../../lib/api';

export async function listPartnerReceipts(
  query: ListPartnerReceiptsQuery,
): Promise<ListPartnerReceiptsResponse> {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
  if (query.storeId) params.set('storeId', query.storeId);
  if (query.status) params.set('status', query.status);
  if (query.partnerName) params.set('partnerName', query.partnerName);

  const response = await apiClient.get(`/api/v1/partner-receipts?${params.toString()}`);
  return response.json();
}

export async function getPartnerReceipt(receiptId: string): Promise<GetPartnerReceiptResponse> {
  const response = await apiClient.get(`/api/v1/partner-receipts/${receiptId}`);
  return response.json();
}

export async function createPartnerReceipt(
  input: CreatePartnerReceiptRequest,
): Promise<GetPartnerReceiptResponse> {
  const response = await apiClient.post('/api/v1/partner-receipts', { json: input });
  return response.json();
}
