import {
  WarehouseInventoryResponseSchema,
  ListWarehouseOutboundRequestsResponseSchema,
  CreateStoreOutboundRequestSchema,
  ErrorEnvelopeSchema,
  ListStoreInventoryBagLedgerResponseSchema,
  ListStoreInventoryBagsResponseSchema,
  ListStoreOutboundsResponseSchema,
  OpenStoreInventoryBagRequestSchema,
  ReviewStoreOutboundRequestSchema,
  StoreInventoryBagResponseSchema,
  StoreOutboundResponseSchema,
  ListStoreSortedStocksResponseSchema,
  StoreSortingResultResponseSchema,
  CreateStoreSortingRequestSchema,
  MoveProductCharityToSaleRequestSchema,
  ProductCharityBalanceResponseSchema,
  CreateCharityExportRequestSchema,
  CharityExportResponseSchema,
  CharityExportsResponseSchema,
  ListStoreSortingHistoryResponseSchema,
  type CreateStoreOutboundRequest,
  type OpenStoreInventoryBagRequest,
  type OutboundReason,
  type ReviewStoreOutboundRequest,
  type StoreInventoryBag,
  type StoreInventoryBagLedgerEntry,
  type StoreInventoryBagStatus,
  type StoreOutbound,
  type StoreOutboundStatus,
  type StoreSortedStock,
  type StoreSortingResult,
  type CreateStoreSortingRequest,
  type MoveProductCharityToSaleRequest,
  type ProductCharityBalance,
  type CreateCharityExportRequest,
  type CharityExport,
  type ListStoreSortingHistoryResponse,
} from '@idosi/contracts';
import { reportUnauthorizedResponse } from '../../lib/session-expiry';
import { addTabSessionHeader } from '../../lib/tab-session';

import { ApiClientError } from '../../lib/api';

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
const apiBaseUrl = (configuredBaseUrl || '/api/v1').replace(/\/$/, '');

export async function loadWarehouseInventory(page: number, search: string) {
  return WarehouseInventoryResponseSchema.parse(
    await request(
      `/warehouse-inventory?${new URLSearchParams({ page: String(page), pageSize: '20', search })}`,
    ),
  );
}

export async function loadWarehouseOutboundHistory(page: number) {
  return ListWarehouseOutboundRequestsResponseSchema.parse(
    await request(
      `/outbound-requests?${new URLSearchParams({ page: String(page), pageSize: '20' })}`,
    ),
  );
}

interface InventoryFilters {
  readonly storeId?: string;
  readonly productId?: string;
  readonly status?: StoreInventoryBagStatus;
  readonly bagCode?: string;
}

interface OutboundFilters {
  readonly storeId?: string;
  readonly inventoryLotId?: string;
  readonly status?: StoreOutboundStatus;
  readonly reason?: OutboundReason;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  if (init?.body !== undefined) headers.set('Content-Type', 'application/json');
  addTabSessionHeader(headers);

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

function pageQuery(filters: Record<string, string | undefined>, page: number): string {
  const query = new URLSearchParams({ page: String(page), pageSize: '100' });
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  return query.toString();
}

interface ParsedPage<T> {
  readonly data: T[];
  readonly pagination: { readonly totalPages: number };
}

async function listAllPages<T>(
  path: string,
  filters: Record<string, string | undefined>,
  parse: (payload: unknown) => ParsedPage<T>,
): Promise<T[]> {
  const first = parse(await request(`${path}?${pageQuery(filters, 1)}`));
  if (first.pagination.totalPages <= 1) return first.data;

  const remaining = await Promise.all(
    Array.from({ length: first.pagination.totalPages - 1 }, async (_, index) =>
      parse(await request(`${path}?${pageQuery(filters, index + 2)}`)),
    ),
  );
  return [first, ...remaining].flatMap((page) => page.data);
}

export async function listInventoryBags(
  filters: InventoryFilters = {},
): Promise<StoreInventoryBag[]> {
  return listAllPages(
    '/store-inventory-bags',
    {
      storeId: filters.storeId,
      productId: filters.productId,
      status: filters.status,
      bagCode: filters.bagCode,
    },
    (payload) => ListStoreInventoryBagsResponseSchema.parse(payload),
  );
}

export async function listInventoryLedger(bagId: string): Promise<StoreInventoryBagLedgerEntry[]> {
  return listAllPages(`/store-inventory-bags/${encodeURIComponent(bagId)}/ledger`, {}, (payload) =>
    ListStoreInventoryBagLedgerResponseSchema.parse(payload),
  );
}

export async function openInventoryBag(
  bagId: string,
  input: OpenStoreInventoryBagRequest,
  idempotencyKey: string,
): Promise<StoreInventoryBag> {
  const parsed = OpenStoreInventoryBagRequestSchema.parse(input);
  const payload = await request(`/store-inventory-bags/${encodeURIComponent(bagId)}/open`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(parsed),
  });
  return StoreInventoryBagResponseSchema.parse(payload).data;
}

export async function listStoreOutbounds(filters: OutboundFilters = {}): Promise<StoreOutbound[]> {
  return listAllPages(
    '/store-outbounds',
    {
      storeId: filters.storeId,
      inventoryLotId: filters.inventoryLotId,
      status: filters.status,
      reason: filters.reason,
    },
    (payload) => ListStoreOutboundsResponseSchema.parse(payload),
  );
}

export async function createStoreOutbound(
  input: CreateStoreOutboundRequest,
  idempotencyKey: string,
): Promise<StoreOutbound> {
  const parsed = CreateStoreOutboundRequestSchema.parse(input);
  const payload = await request('/store-outbounds', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(parsed),
  });
  return StoreOutboundResponseSchema.parse(payload).data;
}

export async function reviewStoreOutbound(
  outboundId: string,
  input: ReviewStoreOutboundRequest,
  idempotencyKey: string,
): Promise<StoreOutbound> {
  const parsed = ReviewStoreOutboundRequestSchema.parse(input);
  const payload = await request(`/store-outbounds/${encodeURIComponent(outboundId)}/review`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(parsed),
  });
  return StoreOutboundResponseSchema.parse(payload).data;
}

export async function listStoreSortedStocks(storeId?: string): Promise<StoreSortedStock[]> {
  const query = storeId ? `?${new URLSearchParams({ storeId })}` : '';
  return ListStoreSortedStocksResponseSchema.parse(await request(`/store-sorted-stocks${query}`))
    .data;
}

export async function createStoreSorting(
  input: CreateStoreSortingRequest,
  idempotencyKey: string,
): Promise<StoreSortingResult> {
  const parsed = CreateStoreSortingRequestSchema.parse(input);
  return StoreSortingResultResponseSchema.parse(
    await request('/store-sortings', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(parsed),
    }),
  ).data;
}

export async function moveProductCharityToSale(
  input: MoveProductCharityToSaleRequest,
  idempotencyKey: string,
): Promise<ProductCharityBalance> {
  const parsed = MoveProductCharityToSaleRequestSchema.parse(input);
  return ProductCharityBalanceResponseSchema.parse(
    await request('/store-charity/move-to-sale', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(parsed),
    }),
  ).data;
}

export async function listCharityExports(storeId?: string): Promise<CharityExport[]> {
  const query = storeId ? `?${new URLSearchParams({ storeId })}` : '';
  return CharityExportsResponseSchema.parse(await request(`/store-charity-exports${query}`)).data;
}

export async function listStoreSortingHistory(filters: {
  readonly storeId?: string;
  readonly date?: string;
  readonly page: number;
  readonly pageSize: number;
}): Promise<ListStoreSortingHistoryResponse> {
  const query = new URLSearchParams({
    page: String(filters.page),
    pageSize: String(filters.pageSize),
  });
  if (filters.storeId) query.set('storeId', filters.storeId);
  if (filters.date) query.set('date', filters.date);
  return ListStoreSortingHistoryResponseSchema.parse(
    await request(`/store-sorting-history?${query}`),
  );
}

export async function createCharityExport(
  input: CreateCharityExportRequest,
  idempotencyKey: string,
): Promise<CharityExport> {
  const parsed = CreateCharityExportRequestSchema.parse(input);
  return CharityExportResponseSchema.parse(
    await request('/store-charity-exports', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(parsed),
    }),
  ).data;
}
