import {
  CancelStoreTransferRequestSchema,
  CreateStoreTransferRequestSchema,
  DispatchStoreTransferRequestSchema,
  ErrorEnvelopeSchema,
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
import { reportUnauthorizedResponse } from '../../lib/session-expiry';

import { ApiClientError } from '../../lib/api';

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
const apiBaseUrl = (configuredBaseUrl || '/api/v1').replace(/\/$/, '');

interface TransferFilters {
  readonly storeId?: string;
  readonly sourceStoreId?: string;
  readonly destinationStoreId?: string;
  readonly productId?: string;
  readonly status?: StoreTransferStatus;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  if (init?.body !== undefined) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      credentials: 'include',
      headers,
    });
  } catch {
    throw new ApiClientError(
      'Không thể kết nối máy chủ. Vui lòng kiểm tra mạng và thử lại.',
      0,
      'NETWORK_ERROR',
    );
  }

  reportUnauthorizedResponse(response.status, path);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ErrorEnvelopeSchema.safeParse(payload);
    if (parsed.success) {
      throw new ApiClientError(
        parsed.data.error.message,
        response.status,
        parsed.data.error.code,
        parsed.data.error.requestId,
      );
    }
    throw new ApiClientError(`Yêu cầu thất bại (${response.status}).`, response.status);
  }
  return payload;
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

  const remaining = await Promise.all(
    Array.from({ length: first.pagination.totalPages - 1 }, async (_, index) =>
      ListStoreTransfersResponseSchema.parse(
        await request(`/store-transfers?${pageQuery(filters, index + 2)}`),
      ),
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
