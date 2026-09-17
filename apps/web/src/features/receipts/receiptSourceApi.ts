import {
  ErrorEnvelopeSchema,
  ListStoreReceiptSourcesResponseSchema,
  type StoreReceiptSource,
} from '@idosi/contracts';

import { ApiClientError } from '../../lib/api';

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
const apiBaseUrl = (configuredBaseUrl || '/api/v1').replace(/\/$/, '');

export interface ReceiptSourceFilters {
  readonly storeId?: string;
}

/** Source-backed only: this endpoint intentionally has no local or mock fallback. */
export async function listStoreReceiptSources(
  filters: ReceiptSourceFilters = {},
): Promise<StoreReceiptSource[]> {
  const query = new URLSearchParams({ page: '1', pageSize: '100' });
  if (filters.storeId) query.set('storeId', filters.storeId);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/store-receipt-sources?${query.toString()}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new ApiClientError(
      'Không thể tải lệnh xuất đang chờ nhận. Vui lòng kiểm tra mạng và thử lại.',
      0,
      'NETWORK_ERROR',
    );
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsedError = ErrorEnvelopeSchema.safeParse(payload);
    if (parsedError.success) {
      throw new ApiClientError(
        parsedError.data.error.message,
        response.status,
        parsedError.data.error.code,
        parsedError.data.error.requestId,
      );
    }
    throw new ApiClientError(`Không thể tải lệnh xuất (${response.status}).`, response.status);
  }

  return ListStoreReceiptSourcesResponseSchema.parse(payload).data;
}
