import type {
  AuthenticatedPrincipal,
  CreateProductConversionRequest,
  CreateProductRequest,
  CreateStoreOrderRequest,
  CreateStoreRequest,
  ListProductsQuery,
  ListProductConversionsQuery,
  ListStoreOrderRequestsQuery,
  ListStoresQuery,
  PaginationMeta,
  Product,
  ProductConversion,
  Session,
  Store,
  StoreOrderRequest,
  UpdateProductRequest,
  UpdateProductConversionRequest,
  DeleteProductConversionRequest,
} from '@idosi/contracts';

export interface RequestContext {
  readonly requestId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface AccountCredentials {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: AuthenticatedPrincipal['role'];
  readonly status: 'ACTIVE' | 'LOCKED' | 'DISABLED';
  readonly storeId: string | null;
  readonly passwordHash: string;
  readonly sessionVersion: number;
  readonly assignedStoreIds: readonly string[];
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly pagination: PaginationMeta;
}

export interface CreatedSession {
  readonly token: string;
  readonly session: Session;
}

export interface SubmittedOrderRequest {
  readonly data: StoreOrderRequest;
  readonly replayed: boolean;
}

export interface OrderStatistics {
  readonly storeCode: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly totals: {
    readonly revenueByType: {
      readonly NORMAL: number;
      readonly SALE_KG: number;
      readonly SALE_PIECE: number;
    };
    readonly revenue: number;
    readonly weight: {
      readonly actualKg: string;
      readonly estimatedKg: string;
      readonly totalKg: string;
      readonly isComplete: boolean;
    };
  };
  readonly products: readonly {
    readonly productId: string;
    readonly sku: string;
    readonly name: string;
    readonly revenueVnd: number;
    readonly weightKg: string;
  }[];
  readonly generatedAt: string;
}

export interface WarehouseRepository {
  ready(): Promise<boolean>;
  close(): Promise<void>;

  findCredentials(username: string): Promise<AccountCredentials | null>;
  createSession(
    account: AccountCredentials,
    token: string,
    expiresAt: Date,
    context: RequestContext,
  ): Promise<Session>;
  resolveSession(token: string): Promise<Session>;
  revokeSession(token: string, reason: string): Promise<boolean>;

  listProducts(query: ListProductsQuery): Promise<Page<Product>>;
  createProduct(
    actor: AuthenticatedPrincipal,
    input: CreateProductRequest,
    context: RequestContext,
  ): Promise<Product>;
  updateProduct(
    actor: AuthenticatedPrincipal,
    productId: string,
    input: UpdateProductRequest,
    context: RequestContext,
  ): Promise<Product>;
  listProductConversions(
    productId: string,
    query: ListProductConversionsQuery,
  ): Promise<Page<ProductConversion>>;
  listAllProductConversions(query: ListProductConversionsQuery): Promise<Page<ProductConversion>>;
  createProductConversion(
    actor: AuthenticatedPrincipal,
    productId: string,
    input: CreateProductConversionRequest,
    context: RequestContext,
  ): Promise<ProductConversion>;
  replaceProductConversion(
    actor: AuthenticatedPrincipal,
    productId: string,
    conversionId: string,
    input: UpdateProductConversionRequest,
    context: RequestContext,
  ): Promise<ProductConversion>;
  retireProductConversion(
    actor: AuthenticatedPrincipal,
    productId: string,
    conversionId: string,
    input: DeleteProductConversionRequest,
    context: RequestContext,
  ): Promise<ProductConversion>;

  listStores(actor: AuthenticatedPrincipal, query: ListStoresQuery): Promise<Page<Store>>;
  createStore(
    actor: AuthenticatedPrincipal,
    input: CreateStoreRequest,
    context: RequestContext,
  ): Promise<Store>;

  listOrderRequests(
    actor: AuthenticatedPrincipal,
    query: ListStoreOrderRequestsQuery,
  ): Promise<Page<StoreOrderRequest>>;
  submitOrderRequest(
    actor: AuthenticatedPrincipal,
    input: CreateStoreOrderRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<SubmittedOrderRequest>;

  getOrderStatistics(
    actor: AuthenticatedPrincipal,
    storeCode: string,
    from: string,
    to: string,
  ): Promise<OrderStatistics>;
}

export function canAccessStore(principal: AuthenticatedPrincipal, storeId: string): boolean {
  if (principal.role === 'ADMIN') return true;
  if (principal.role === 'STORE') return principal.storeId === storeId;
  return principal.assignedStoreIds.includes(storeId);
}

export function pagination(page: number, pageSize: number, totalItems: number): PaginationMeta {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize),
  };
}

export function slicePage<T>(values: readonly T[], page: number, pageSize: number): readonly T[] {
  const start = (page - 1) * pageSize;
  return values.slice(start, start + pageSize);
}
