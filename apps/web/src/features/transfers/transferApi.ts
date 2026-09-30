import { requestJson } from '../../lib/http-request';
import {
  CancelStoreTransferRequestSchema,
  CreateStoreTransferRequestSchema,
  DispatchStoreTransferRequestSchema,
  ListStoreTransferDestinationsResponseSchema,
  ListStoreTransfersResponseSchema,
  ReceiveStoreTransferRequestSchema,
  StoreTransferResponseSchema,
  type CancelStoreTransferRequest,
  type CreateStoreTransferRequest,
  type DispatchStoreTransferRequest,
  type ReceiveStoreTransferRequest,
  type Store,
  type StoreTransfer,
  type StoreTransferStatus,
} from '@idosi/contracts';

import { ApiClientError, mapWithConcurrency, PAGE_FETCH_CONCURRENCY } from '../../lib/api';

interface TransferFilters {
  readonly storeId?: string;
  readonly sourceStoreId?: string;
  readonly destinationStoreId?: string;
  readonly productId?: string;
  readonly status?: StoreTransferStatus;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  return requestJson(path, init, ApiClientError);
}

function pageQuery(filters: TransferFilters, page: number): string {
  const query = new URLSearchParams({ page: String(page), pageSize: '100' });
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  return query.toString();
}

export async function listStoreTransfers(filters: TransferFilters = {}): Promise<StoreTransfer[]> {
  const first = ListStoreTransfersResponseSchema.parse(
    await request(`/store-transfers?${pageQuery(filters, 1)}`),
  );
  if (first.pagination.totalPages <= 1) return first.data;

  const remaining = await mapWithConcurrency(
    first.pagination.totalPages - 1,
    PAGE_FETCH_CONCURRENCY,
    async (index) =>
      ListStoreTransfersResponseSchema.parse(
        await request(`/store-transfers?${pageQuery(filters, index + 2)}`),
      ),
  );
  return [first, ...remaining].flatMap((page) => page.data);
}

export async function listStoreTransferDestinations(): Promise<Store[]> {
  const payload = await request('/store-transfers/destinations');
  return ListStoreTransferDestinationsResponseSchema.parse(payload).data;
}

async function mutateTransfer(
  path: string,
  input: unknown,
  idempotencyKey: string,
  status: 'create' | 'update',
): Promise<StoreTransfer> {
  const payload = await request(path, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(input),
  });
  const parsed = StoreTransferResponseSchema.parse(payload).data;
  if (status === 'create' && parsed.status !== 'DRAFT') {
    throw new ApiClientError('Máy chủ trả về trạng thái phiếu tạo mới không hợp lệ.', 500);
  }
  return parsed;
}

export async function createStoreTransfer(
  input: CreateStoreTransferRequest,
  idempotencyKey: string,
): Promise<StoreTransfer> {
  return mutateTransfer(
    '/store-transfers',
    CreateStoreTransferRequestSchema.parse(input),
    idempotencyKey,
    'create',
  );
}

export async function dispatchStoreTransfer(
  transferId: string,
  input: DispatchStoreTransferRequest,
  idempotencyKey: string,
): Promise<StoreTransfer> {
  return mutateTransfer(
    `/store-transfers/${encodeURIComponent(transferId)}/dispatch`,
    DispatchStoreTransferRequestSchema.parse(input),
    idempotencyKey,
    'update',
  );
}

export async function receiveStoreTransfer(
  transferId: string,
  input: ReceiveStoreTransferRequest,
  idempotencyKey: string,
): Promise<StoreTransfer> {
  return mutateTransfer(
    `/store-transfers/${encodeURIComponent(transferId)}/receive`,
    ReceiveStoreTransferRequestSchema.parse(input),
    idempotencyKey,
    'update',
  );
}

export async function cancelStoreTransfer(
  transferId: string,
  input: CancelStoreTransferRequest,
  idempotencyKey: string,
): Promise<StoreTransfer> {
  return mutateTransfer(
    `/store-transfers/${encodeURIComponent(transferId)}/cancel`,
    CancelStoreTransferRequestSchema.parse(input),
    idempotencyKey,
    'update',
  );
}
