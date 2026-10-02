import { requestJson } from '../../lib/http-request';
import {
  ListStoreBagOpeningsResponseSchema,
  type ListStoreBagOpeningsQuery,
} from '@idosi/contracts';
import {
  CreateWarehouseStockAdjustmentRequestSchema,
  ListWarehouseStockAdjustmentsResponseSchema,
  WarehouseStockAdjustmentResponseSchema,
  type CreateWarehouseStockAdjustmentRequest,
  type WarehouseAdjustmentDirection,
  type WarehouseStockAdjustment,
} from '@idosi/contracts';
import {
  WarehouseInventoryResponseSchema,
  ListWarehouseOutboundRequestsResponseSchema,
  CreateStoreOutboundRequestSchema,
  ListStoreInventoryBagLedgerResponseSchema,
  ListStoreInventoryBagsResponseSchema,
  ListStoreOutboundsResponseSchema,
  OpenStoreInventoryBagRequestSchema,
  ReviewStoreOutboundRequestSchema,
  StoreInventoryBagResponseSchema,
  StoreOutboundResponseSchema,
  ListStoreSortedStocksResponseSchema,
  ListStoreNormalSalePendingResponseSchema,
  StoreSortingResultResponseSchema,
  CreateStoreSortingRequestSchema,
  MoveProductCharityToSaleRequestSchema,
  ProductCharityBalanceResponseSchema,
  CreateCharityExportRequestSchema,
  CharityExportResponseSchema,
  CharityExportsResponseSchema,
  ListStoreSortingHistoryResponseSchema,
  ListWarehouseShortageChecksResponseSchema,
  ResolveWarehouseShortageCheckRequestSchema,
  WarehouseShortageCheckResponseSchema,
  type ResolveWarehouseShortageCheckRequest,
  type WarehouseShortageCheck,
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
  type StoreNormalSalePending,
  type StoreSortingResult,
  type CreateStoreSortingRequest,
  type MoveProductCharityToSaleRequest,
  type ProductCharityBalance,
  type CreateCharityExportRequest,
  type CharityExport,
  type ListStoreSortingHistoryResponse,
} from '@idosi/contracts';

import { ApiClientError, mapWithConcurrency, PAGE_FETCH_CONCURRENCY } from '../../lib/api';

export async function loadWarehouseInventory(page: number, search: string, signal?: AbortSignal) {
  return WarehouseInventoryResponseSchema.parse(
    await request(
      `/warehouse-inventory?${new URLSearchParams({ page: String(page), pageSize: '20', search })}`,
      { signal: signal ?? null },
    ),
  );
}

export interface WarehouseAdjustmentFilters {
  readonly productId?: string;
  readonly direction?: WarehouseAdjustmentDirection;
  readonly from?: string;
  readonly to?: string;
}

export async function loadWarehouseAdjustments(
  page: number,
  filters: WarehouseAdjustmentFilters,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ page: String(page), pageSize: '20' });
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  return ListWarehouseStockAdjustmentsResponseSchema.parse(
    await request(`/warehouse-adjustments?${query}`, { signal: signal ?? null }),
  );
}

/**
 * The key belongs to one operation: a retry after a lost response reuses it with the same
 * payload, so the server replays instead of adjusting twice.
 */
export async function createWarehouseAdjustment(
  input: CreateWarehouseStockAdjustmentRequest,
  idempotencyKey: string,
): Promise<WarehouseStockAdjustment> {
  const parsed = CreateWarehouseStockAdjustmentRequestSchema.parse(input);
  return WarehouseStockAdjustmentResponseSchema.parse(
    await request('/warehouse-adjustments', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(parsed),
    }),
  ).data;
}

export async function loadWarehouseOutboundHistory(page: number, signal?: AbortSignal) {
  return ListWarehouseOutboundRequestsResponseSchema.parse(
    await request(
      `/outbound-requests?${new URLSearchParams({ page: String(page), pageSize: '20' })}`,
      { signal: signal ?? null },
    ),
  );
}

export async function loadPendingShortageChecks() {
  return ListWarehouseShortageChecksResponseSchema.parse(
    await request(
      `/warehouse-shortage-checks?${new URLSearchParams({ status: 'PENDING', pageSize: '100' })}`,
    ),
  );
}

export async function resolveShortageCheck(
  checkId: string,
  input: ResolveWarehouseShortageCheckRequest,
  idempotencyKey: string,
): Promise<WarehouseShortageCheck> {
  const parsed = ResolveWarehouseShortageCheckRequestSchema.parse(input);
  return WarehouseShortageCheckResponseSchema.parse(
    await request(`/warehouse-shortage-checks/${encodeURIComponent(checkId)}/resolve`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(parsed),
    }),
  ).data;
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
  return requestJson(path, init, ApiClientError);
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

  const remaining = await mapWithConcurrency(
    first.pagination.totalPages - 1,
    PAGE_FETCH_CONCURRENCY,
    async (index) => parse(await request(`${path}?${pageQuery(filters, index + 2)}`)),
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

/** IDOSI regular-price sales still waiting for the next bag the store opens. */
export async function listStoreNormalSalePending(
  storeId?: string,
): Promise<StoreNormalSalePending[]> {
  const query = storeId ? `?${new URLSearchParams({ storeId })}` : '';
  return ListStoreNormalSalePendingResponseSchema.parse(
    await request(`/store-normal-sale-pending${query}`),
  ).data;
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

export async function listUnopenedInventoryPage(filters: InventoryFilters & { page: number }) {
  const query = new URLSearchParams({
    page: String(filters.page),
    pageSize: '20',
    unopenedOnly: 'true',
  });
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, String(value));
  return ListStoreInventoryBagsResponseSchema.parse(
    await request('/store-inventory-bags?' + query),
  );
}
export async function listBagOpenings(filters: ListStoreBagOpeningsQuery) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, String(value));
  return ListStoreBagOpeningsResponseSchema.parse(await request('/store-bag-openings?' + query));
}
