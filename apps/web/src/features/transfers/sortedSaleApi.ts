import {
  CancelSortedSaleTransferRequestSchema,
  CreateSortedSaleTransferRequestSchema,
  ErrorEnvelopeSchema,
  ReceiveSortedSaleTransferRequestSchema,
  SortedSaleTransferResponseSchema,
  SortedSaleTransfersResponseSchema,
  type CancelSortedSaleTransferRequest,
  type CreateSortedSaleTransferRequest,
  type ReceiveSortedSaleTransferRequest,
} from '@idosi/contracts';
import { ApiClientError } from '../../lib/api';
import { reportUnauthorizedResponse } from '../../lib/session-expiry';
import { addTabSessionHeader } from '../../lib/tab-session';

const baseUrl = (import.meta.env.VITE_API_BASE_URL?.trim() || '/api/v1').replace(/\/$/, '');

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  if (init?.body !== undefined) headers.set('Content-Type', 'application/json');
  addTabSessionHeader(headers);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, { ...init, credentials: 'include', headers });
  } catch {
    throw new ApiClientError('Không thể kết nối máy chủ. Vui lòng thử lại.', 0, 'NETWORK_ERROR');
  }
  reportUnauthorizedResponse(response.status, path);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ErrorEnvelopeSchema.safeParse(payload);
    if (parsed.success)
      throw new ApiClientError(
        parsed.data.error.message,
        response.status,
        parsed.data.error.code,
        parsed.data.error.requestId,
      );
    throw new ApiClientError(`Yêu cầu thất bại (${response.status}).`, response.status);
  }
  return payload;
}

function post(path: string, body: unknown, key: string): Promise<unknown> {
  return request(path, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
}

export async function listSortedSaleTransfers() {
  return SortedSaleTransfersResponseSchema.parse(await request('/sorted-sale-transfers')).data;
}

export async function createSortedSaleTransfer(
  input: CreateSortedSaleTransferRequest,
  key: string,
) {
  return SortedSaleTransferResponseSchema.parse(
    await post('/sorted-sale-transfers', CreateSortedSaleTransferRequestSchema.parse(input), key),
  ).data;
}

export async function receiveSortedSaleTransfer(
  transferId: string,
  input: ReceiveSortedSaleTransferRequest,
  key: string,
) {
  return SortedSaleTransferResponseSchema.parse(
    await post(
      `/sorted-sale-transfers/${encodeURIComponent(transferId)}/receive`,
      ReceiveSortedSaleTransferRequestSchema.parse(input),
      key,
    ),
  ).data;
}

export async function cancelSortedSaleTransfer(
  transferId: string,
  input: CancelSortedSaleTransferRequest,
  key: string,
) {
  return SortedSaleTransferResponseSchema.parse(
    await post(
      `/sorted-sale-transfers/${encodeURIComponent(transferId)}/cancel`,
      CancelSortedSaleTransferRequestSchema.parse(input),
      key,
    ),
  ).data;
}
