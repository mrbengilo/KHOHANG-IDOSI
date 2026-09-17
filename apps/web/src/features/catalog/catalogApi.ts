import {
  ErrorEnvelopeSchema,
  ListProductConversionsResponseSchema,
  ListProductsResponseSchema,
  ProductConversionResponseSchema,
  ProductResponseSchema,
  type CreateProductConversionRequest,
  type CreateProductRequest,
  type DeleteProductConversionRequest,
  type Product,
  type ProductConversion,
  type ProductStatus,
  type UpdateProductConversionRequest,
} from '@idosi/contracts';

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
const apiBaseUrl = (configuredBaseUrl || '/api/v1').replace(/\/$/, '');

export class CatalogApiError extends Error {
  readonly code: string;
  readonly requestId: string | undefined;
  readonly status: number;

  constructor(message: string, status: number, code = 'HTTP_ERROR', requestId?: string) {
    super(message);
    this.name = 'CatalogApiError';
    this.code = code;
    this.requestId = requestId;
    this.status = status;
  }
}

export class CatalogPartialCreateError extends CatalogApiError {
  readonly product: Product;

  constructor(product: Product, cause: unknown) {
    const detail =
      cause instanceof Error ? cause.message : 'Máy chủ không chấp nhận hệ số quy đổi.';
    super(
      `Mặt hàng ${product.sku} đã được tạo nhưng chưa có hệ số quy đổi. ${detail}`,
      cause instanceof CatalogApiError ? cause.status : 0,
      'PRODUCT_CREATED_WITHOUT_CONVERSION',
      cause instanceof CatalogApiError ? cause.requestId : undefined,
    );
    this.name = 'CatalogPartialCreateError';
    this.product = product;
  }
}

export interface CatalogEntry {
  readonly conversion: ProductConversion | null;
  readonly historyCount: number;
  readonly latestConversion: ProductConversion | null;
  readonly product: Product;
}

export interface CatalogSnapshot {
  readonly effectiveAt: string;
  readonly entries: CatalogEntry[];
}

async function loadAllProducts(): Promise<Product[]> {
  const values: Product[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const payload = await request(`/products?page=${page}&pageSize=100`);
    const parsed = ListProductsResponseSchema.parse(payload);
    values.push(...parsed.data);
    totalPages = parsed.pagination.totalPages;
    page += 1;
  } while (page <= totalPages);
  return values;
}

async function loadAllConversions(
  parameters: Readonly<Record<string, string>>,
): Promise<ProductConversion[]> {
  const values: ProductConversion[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const query = new URLSearchParams({
      ...parameters,
      page: String(page),
      pageSize: '100',
    });
    const payload = await request(`/product-conversions?${query.toString()}`);
    const parsed = ListProductConversionsResponseSchema.parse(payload);
    values.push(...parsed.data);
    totalPages = parsed.pagination.totalPages;
    page += 1;
  } while (page <= totalPages);
  return values;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      cache: 'no-store',
      credentials: 'include',
      headers,
    });
  } catch {
    throw new CatalogApiError(
      'Không thể kết nối máy chủ. Vui lòng kiểm tra mạng và thử lại.',
      0,
      'NETWORK_ERROR',
    );
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ErrorEnvelopeSchema.safeParse(payload);
    if (parsed.success) {
      throw new CatalogApiError(
        parsed.data.error.message,
        response.status,
        parsed.data.error.code,
        parsed.data.error.requestId,
      );
    }
    throw new CatalogApiError(`Yêu cầu thất bại (${response.status}).`, response.status);
  }
  return payload;
}

export async function loadCatalogSnapshot(effectiveAt: string): Promise<CatalogSnapshot> {
  const [products, conversions, history] = await Promise.all([
    loadAllProducts(),
    loadAllConversions({ effectiveAt, includeRetired: 'true' }),
    loadAllConversions({ includeRetired: 'true' }),
  ]);
  const effectiveByProduct = groupConversionsByProduct(conversions);
  const historyByProduct = groupConversionsByProduct(history);

  return {
    effectiveAt,
    entries: products.map((product) => {
      const productHistory = historyByProduct.get(product.id) ?? [];
      return {
        conversion: effectiveByProduct.get(product.id)?.[0] ?? null,
        historyCount: productHistory.length,
        latestConversion:
          productHistory.find((candidate) => candidate.retiredAt === null) ??
          productHistory[0] ??
          null,
        product,
      };
    }),
  };
}

function groupConversionsByProduct(
  conversions: readonly ProductConversion[],
): Map<string, ProductConversion[]> {
  const grouped = new Map<string, ProductConversion[]>();
  for (const conversion of conversions) {
    const values = grouped.get(conversion.productId);
    if (values) values.push(conversion);
    else grouped.set(conversion.productId, [conversion]);
  }
  for (const [productId, values] of grouped) {
    grouped.set(
      productId,
      values.toSorted((left, right) => right.version - left.version),
    );
  }
  return grouped;
}

export async function loadProductConversionHistory(
  productId: string,
): Promise<ProductConversion[]> {
  const values: ProductConversion[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const payload = await request(
      `/products/${encodeURIComponent(productId)}/conversions?page=${page}&pageSize=100&includeRetired=true`,
    );
    const parsed = ListProductConversionsResponseSchema.parse(payload);
    values.push(...parsed.data);
    totalPages = parsed.pagination.totalPages;
    page += 1;
  } while (page <= totalPages);
  return values;
}

export async function createInitialConversion(
  productId: string,
  input: CreateProductConversionRequest,
): Promise<ProductConversion> {
  const payload = await request(`/products/${encodeURIComponent(productId)}/conversions`, {
    body: JSON.stringify(input),
    method: 'POST',
  });
  return ProductConversionResponseSchema.parse(payload).data;
}

export async function createProductWithConversion(
  productInput: CreateProductRequest,
  conversionInput: CreateProductConversionRequest,
): Promise<CatalogEntry> {
  const productPayload = await request('/products', {
    body: JSON.stringify(productInput),
    method: 'POST',
  });
  const product = ProductResponseSchema.parse(productPayload).data;

  try {
    const conversion = await createInitialConversion(product.id, conversionInput);
    return { conversion, historyCount: 1, latestConversion: conversion, product };
  } catch (cause) {
    throw new CatalogPartialCreateError(product, cause);
  }
}

export async function createNextConversionVersion(
  productId: string,
  conversionId: string,
  input: UpdateProductConversionRequest,
): Promise<ProductConversion> {
  const payload = await request(
    `/products/${encodeURIComponent(productId)}/conversions/${encodeURIComponent(conversionId)}`,
    { body: JSON.stringify(input), method: 'PATCH' },
  );
  return ProductConversionResponseSchema.parse(payload).data;
}

export async function retireProductConversion(
  productId: string,
  conversionId: string,
  input: DeleteProductConversionRequest,
): Promise<ProductConversion> {
  const payload = await request(
    `/products/${encodeURIComponent(productId)}/conversions/${encodeURIComponent(conversionId)}`,
    { body: JSON.stringify(input), method: 'DELETE' },
  );
  return ProductConversionResponseSchema.parse(payload).data;
}

export async function setProductStatus(productId: string, status: ProductStatus): Promise<Product> {
  const payload = await request(`/products/${encodeURIComponent(productId)}`, {
    body: JSON.stringify({ status }),
    method: 'PATCH',
  });
  return ProductResponseSchema.parse(payload).data;
}
