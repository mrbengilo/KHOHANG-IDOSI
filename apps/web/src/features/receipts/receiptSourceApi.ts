import {
  ErrorEnvelopeSchema,
  ListStoreReceiptSourcesResponseSchema,
  type StoreReceiptSource,
} from '@idosi/contracts';

import { ApiClientError } from '../../lib/api';
import { reportUnauthorizedResponse } from '../../lib/session-expiry';

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
const apiBaseUrl = (configuredBaseUrl || '/api/v1').replace(/\/$/, '');

export interface ReceiptSourceFilters {
  readonly storeId?: string;
}

async function loadReceiptSourcePage(filters: ReceiptSourceFilters, page: number) {
  const query = new URLSearchParams({ page: String(page), pageSize: '100' });
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

  reportUnauthorizedResponse(response.status, '/store-receipt-sources');
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

  return ListStoreReceiptSourcesResponseSchema.parse(payload);
}

/** Source-backed only: this endpoint intentionally has no local or mock fallback. */
export async function listStoreReceiptSources(
  filters: ReceiptSourceFilters = {},
): Promise<StoreReceiptSource[]> {
  const first = await loadReceiptSourcePage(filters, 1);
  if (first.pagination.totalPages <= 1) return first.data;
  const remaining = await Promise.all(
    Array.from({ length: first.pagination.totalPages - 1 }, async (_, index) =>
      loadReceiptSourcePage(filters, index + 2),
    ),
  );
  return [first, ...remaining].flatMap((page) => page.data);
}
