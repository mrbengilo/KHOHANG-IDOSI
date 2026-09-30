import { requestJson } from '../../lib/http-request';
import {
  CancelSortedSaleTransferRequestSchema,
  CreateSortedSaleTransferRequestSchema,
  ReceiveSortedSaleTransferRequestSchema,
  SortedSaleTransferResponseSchema,
  SortedSaleTransfersResponseSchema,
  type CancelSortedSaleTransferRequest,
  type CreateSortedSaleTransferRequest,
  type ReceiveSortedSaleTransferRequest,
} from '@idosi/contracts';
import { ApiClientError } from '../../lib/api';

async function request(path: string, init?: RequestInit): Promise<unknown> {
  return requestJson(path, init, ApiClientError);
}

function post(path: string, body: unknown, key: string): Promise<unknown> {
  return request(path, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
}

export async function listSortedSaleTransfers(page = 1) {
  return SortedSaleTransfersResponseSchema.parse(
    await request('/sorted-sale-transfers?page=' + page + '&pageSize=20'),
  );
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
