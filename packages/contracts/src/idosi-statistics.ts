import { z } from 'zod';

import {
  AuditReasonSchema,
  EntityIdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  MoneyVndSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
} from './common.js';

const PERIOD_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const IdosiStatisticsPeriodSchema = z
  .string()
  .regex(PERIOD_PATTERN, 'Expected a month in YYYY-MM format');
export type IdosiStatisticsPeriod = z.infer<typeof IdosiStatisticsPeriodSchema>;

export const IdosiStatisticsPaymentMethodSchema = z.enum(['cash', 'transfer']);
export type IdosiStatisticsPaymentMethod = z.infer<typeof IdosiStatisticsPaymentMethodSchema>;

export const IdosiStatisticsScopeSchema = z
  .object({
    storeId: EntityIdSchema,
    period: IdosiStatisticsPeriodSchema,
    date: IsoDateSchema.nullable().default(null),
    shiftId: z.string().trim().min(1).max(200).nullable().default(null),
    paymentMethod: IdosiStatisticsPaymentMethodSchema.nullable().default(null),
  })
  .strict()
  .refine((scope) => scope.date === null || scope.date.startsWith(`${scope.period}-`), {
    path: ['date'],
    message: 'Date must belong to the selected period',
  });
export type IdosiStatisticsScope = z.infer<typeof IdosiStatisticsScopeSchema>;

export const GetIdosiStatisticsQuerySchema = IdosiStatisticsScopeSchema;
export type GetIdosiStatisticsQuery = z.infer<typeof GetIdosiStatisticsQuerySchema>;

export const SyncIdosiStatisticsRequestSchema = IdosiStatisticsScopeSchema;
export type SyncIdosiStatisticsRequest = z.infer<typeof SyncIdosiStatisticsRequestSchema>;

const NonNegativeNumberSchema = z.number().finite().nonnegative();
const NonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const productNameKey = (value: string) =>
  value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('vi-VN');
const CURRENT_MENS_PRODUCT_NAME = 'Quần áo nam';

/** Keep report/history labels current while retaining source IDs and immutable source records. */
export function canonicalIdosiProductName(value: string): string {
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const key = productNameKey(normalized);
  return key === productNameKey('Đồ nam') || key === productNameKey(CURRENT_MENS_PRODUCT_NAME)
    ? CURRENT_MENS_PRODUCT_NAME
    : normalized;
}

const IdosiProductNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .transform(canonicalIdosiProductName);

export const IdosiRevenueByTypeSchema = z
  .object({
    NORMAL: MoneyVndSchema,
    SALE_KG: MoneyVndSchema,
    SALE_PIECE: MoneyVndSchema,
  })
  .strict();

const IdosiWeightBucketSchema = z
  .object({
    actualKg: NonNegativeNumberSchema,
    estimatedKg: NonNegativeNumberSchema,
    knownKg: NonNegativeNumberSchema,
    totalKg: NonNegativeNumberSchema.nullable(),
    isComplete: z.boolean(),
    missingFactorLines: NonNegativeIntegerSchema,
    invalidLines: NonNegativeIntegerSchema,
    unclassifiedOrders: NonNegativeIntegerSchema,
  })
  .passthrough();

export const IdosiWeightSummarySchema = IdosiWeightBucketSchema.extend({
  schemaVersion: z.number().int().positive(),
  unit: z.literal('KG'),
  tableVersion: z.string().trim().min(1).max(128),
  byRevenueType: z
    .object({
      NORMAL: IdosiWeightBucketSchema,
      SALE_KG: IdosiWeightBucketSchema,
      SALE_PIECE: IdosiWeightBucketSchema,
    })
    .strict(),
}).passthrough();
export type IdosiWeightSummary = z.infer<typeof IdosiWeightSummarySchema>;

/**
 * IDOSI renames and retires products, and a retired code can be handed to another
 * product. `productId` is therefore the identity the order was SOLD with, not a
 * stable one: aggregate on `canonicalProductId` (the entry IDOSI uses today) and
 * keep `productId` for reconciliation only.
 */
const CanonicalProductIdentitySchema = {
  canonicalProductId: z.string().trim().min(1).max(200).optional(),
  canonicalProductCode: z.string().trim().max(200).optional(),
} as const;

const IdosiProductItemSchema = z
  .object({
    productId: z.string().trim().min(1).max(200),
    productCode: z.string().trim().max(200).optional(),
    ...CanonicalProductIdentitySchema,
    productName: IdosiProductNameSchema,
    quantity: NonNegativeNumberSchema,
    unit: z.enum(['PIECE', 'KG']),
    revenueType: z.enum(['NORMAL', 'SALE_KG', 'SALE_PIECE']),
    classification: z.enum(['NORMAL', 'SALE_KG', 'SALE_PIECE', 'UNCLASSIFIED']),
    orders: NonNegativeIntegerSchema,
    weight: IdosiWeightSummarySchema,
  })
  .passthrough();

const IdosiProductWeightSchema = z
  .object({
    productId: z.string().trim().min(1).max(200),
    productCode: z.string().trim().max(200).optional(),
    ...CanonicalProductIdentitySchema,
    productName: IdosiProductNameSchema,
    orders: NonNegativeIntegerSchema,
    totalQuantity: NonNegativeIntegerSchema,
    weight: IdosiWeightSummarySchema,
  })
  .passthrough();

const IdosiTotalsSchema = z
  .object({
    orders: NonNegativeIntegerSchema,
    cash: MoneyVndSchema,
    transfer: MoneyVndSchema,
    revenue: MoneyVndSchema,
    cashOrders: NonNegativeIntegerSchema,
    transferOrders: NonNegativeIntegerSchema,
    revenueByType: IdosiRevenueByTypeSchema,
    unclassifiedRevenue: MoneyVndSchema,
    unclassifiedOrders: NonNegativeIntegerSchema,
    weight: IdosiWeightSummarySchema,
  })
  .passthrough();

const IdosiGroupSchema = IdosiTotalsSchema.extend({
  key: z.string().trim().min(1).max(500),
}).passthrough();

export interface IdosiOrderStatisticsPayload {
  readonly ok: true;
  readonly apiVersion: 1;
  readonly storeId: string;
  readonly currency: 'VND';
  readonly timezone: 'Asia/Ho_Chi_Minh';
  readonly revenueBasis: 'ACTIVE_ORDER_AMOUNT';
  readonly generatedAt: string;
  readonly store: { readonly id: string; readonly name: string; readonly [key: string]: unknown };
  readonly filters: {
    readonly period: string;
    readonly date: string | null;
    readonly shiftId: string | null;
    readonly paymentMethod: string | null;
    readonly [key: string]: unknown;
  };
  readonly totals: z.infer<typeof IdosiTotalsSchema>;
  readonly products: {
    readonly totalQuantity: number;
    readonly salePieceQuantity: number;
    readonly totalWeightKg: number;
    readonly productTypes: number;
    readonly ordersWithItems: number;
    readonly unclassifiedOrders: number;
    readonly items: readonly z.infer<typeof IdosiProductItemSchema>[];
    readonly weight: IdosiWeightSummary;
    readonly weightByProduct: readonly z.infer<typeof IdosiProductWeightSchema>[];
    readonly [key: string]: unknown;
  };
  readonly groups: {
    readonly shift: readonly z.infer<typeof IdosiGroupSchema>[];
    readonly day: readonly z.infer<typeof IdosiGroupSchema>[];
    readonly month: readonly z.infer<typeof IdosiGroupSchema>[];
    readonly [key: string]: unknown;
  };
  readonly serverTime: string;
  readonly requestId: string;
  readonly [key: string]: unknown;
}

export const IdosiOrderStatisticsPayloadSchema: z.ZodType<IdosiOrderStatisticsPayload> = z
  .object({
    ok: z.literal(true),
    apiVersion: z.literal(1),
    storeId: z.string().trim().min(1).max(200),
    currency: z.literal('VND'),
    timezone: z.literal('Asia/Ho_Chi_Minh'),
    revenueBasis: z.literal('ACTIVE_ORDER_AMOUNT'),
    generatedAt: IsoDateTimeSchema,
    store: z
      .object({
        id: z.string().trim().min(1).max(200),
        name: z.string().trim().min(1).max(500),
      })
      .passthrough(),
    filters: z
      .object({
        period: IdosiStatisticsPeriodSchema,
        date: IsoDateSchema.nullable(),
        shiftId: z.string().trim().min(1).max(200).nullable(),
        paymentMethod: z.string().trim().min(1).max(100).nullable(),
      })
      .passthrough(),
    totals: IdosiTotalsSchema,
    products: z
      .object({
        totalQuantity: NonNegativeIntegerSchema,
        salePieceQuantity: NonNegativeIntegerSchema,
        totalWeightKg: NonNegativeNumberSchema,
        productTypes: NonNegativeIntegerSchema,
        ordersWithItems: NonNegativeIntegerSchema,
        unclassifiedOrders: NonNegativeIntegerSchema,
        items: z.array(IdosiProductItemSchema),
        weight: IdosiWeightSummarySchema,
        weightByProduct: z.array(IdosiProductWeightSchema),
      })
      .passthrough(),
    groups: z
      .object({
        shift: z.array(IdosiGroupSchema),
        day: z.array(IdosiGroupSchema),
        month: z.array(IdosiGroupSchema),
      })
      .passthrough(),
    serverTime: IsoDateTimeSchema,
    requestId: z.string().trim().min(1).max(200),
  })
  .passthrough()
  .superRefine((payload, context) => {
    const byType = payload.totals.revenueByType;
    if (
      payload.totals.unclassifiedRevenue > byType.NORMAL ||
      payload.totals.unclassifiedOrders > payload.totals.orders
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totals', 'unclassifiedRevenue'],
        message: 'Unclassified revenue and order count must fit within NORMAL and total orders',
      });
    }
    const salePieces = payload.products.items.reduce(
      (sum, item) => sum + (item.revenueType === 'SALE_PIECE' ? item.quantity : 0),
      0,
    );
    if (!Number.isSafeInteger(salePieces) || salePieces !== payload.products.salePieceQuantity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['products', 'salePieceQuantity'],
        message: 'Sale piece quantity must equal the aggregate product lines',
      });
    }
    for (const [index, item] of payload.products.items.entries()) {
      if (
        (item.revenueType === 'SALE_KG') !== (item.unit === 'KG') ||
        (item.classification !== item.revenueType &&
          !(item.revenueType === 'NORMAL' && item.classification === 'UNCLASSIFIED'))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['products', 'items', index],
          message: 'Product sale type, classification and unit do not match',
        });
      }
    }
  });

export interface IdosiStatisticsAttempt {
  readonly id: string;
  readonly source: 'MANUAL' | 'SCHEDULED';
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
}

export const IdosiStatisticsAttemptSchema: z.ZodType<IdosiStatisticsAttempt> = z
  .object({
    id: EntityIdSchema,
    source: z.enum(['MANUAL', 'SCHEDULED']),
    status: z.enum(['SUCCEEDED', 'FAILED']),
    errorCode: z.string().trim().min(1).max(100).nullable(),
    errorMessage: z.string().trim().min(1).max(1_000).nullable(),
    startedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema,
  })
  .strict();

export interface IdosiStatisticsSnapshot {
  readonly id: string;
  readonly storeId: string;
  readonly scopeKey: string;
  readonly payload: IdosiOrderStatisticsPayload;
  readonly firstSyncedAt: string;
  readonly lastSyncedAt: string;
}

export const IdosiStatisticsSnapshotSchema: z.ZodType<IdosiStatisticsSnapshot> = z
  .object({
    id: EntityIdSchema,
    storeId: EntityIdSchema,
    scopeKey: z.string().trim().min(1).max(500),
    payload: IdosiOrderStatisticsPayloadSchema,
    firstSyncedAt: IsoDateTimeSchema,
    lastSyncedAt: IsoDateTimeSchema,
  })
  .strict();

export interface IdosiStatisticsState {
  readonly scope: IdosiStatisticsScope;
  readonly integrationStatus: 'CONFIGURED' | 'NOT_CONFIGURED';
  readonly freshness: 'CURRENT' | 'STALE' | 'EMPTY' | 'RESYNC_REQUIRED';
  readonly snapshot: IdosiStatisticsSnapshot | null;
  readonly latestAttempt: IdosiStatisticsAttempt | null;
}

export const IdosiStatisticsStateSchema: z.ZodType<IdosiStatisticsState, z.ZodTypeDef, unknown> = z
  .object({
    scope: IdosiStatisticsScopeSchema,
    integrationStatus: z.enum(['CONFIGURED', 'NOT_CONFIGURED']),
    freshness: z.enum(['CURRENT', 'STALE', 'EMPTY', 'RESYNC_REQUIRED']),
    snapshot: IdosiStatisticsSnapshotSchema.nullable(),
    latestAttempt: IdosiStatisticsAttemptSchema.nullable(),
  })
  .strict();

export interface IdosiStatisticsStateResponse {
  readonly data: IdosiStatisticsState;
}

export const IdosiStatisticsStateResponseSchema: z.ZodType<
  IdosiStatisticsStateResponse,
  z.ZodTypeDef,
  unknown
> = z.object({ data: IdosiStatisticsStateSchema }).strict();

export type IdosiFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const ListIdosiStatisticsQuerySchema = PaginationQuerySchema.extend({
  period: IdosiStatisticsPeriodSchema,
  storeId: EntityIdSchema.optional(),
}).strict();
export type ListIdosiStatisticsQuery = z.infer<typeof ListIdosiStatisticsQuerySchema>;
export const ListIdosiStatisticsResponseSchema = z
  .object({
    data: z.array(IdosiStatisticsStateSchema),
    pagination: PaginationMetaSchema,
  })
  .strict();

export interface FetchIdosiStatisticsOptions {
  readonly endpoint: string;
  readonly secret: string;
  readonly storeCode: string;
  readonly storeIdMap?: Readonly<Record<string, string>>;
  readonly scope: Omit<IdosiStatisticsScope, 'storeId'>;
  readonly requestId: string;
  readonly fetch?: IdosiFetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/** Server-side configuration only; warehouse identifiers are never rewritten. */
export function parseIdosiStoreIdMap(raw: string | undefined): Readonly<Record<string, string>> {
  if (!raw?.trim()) return {};
  try {
    // This configuration is a flat string-to-string object. Validate that grammar
    // and inspect decoded key tokens before JSON.parse can discard duplicates.
    const stringToken = '"(?:[^"\\\\]|\\\\.)*"';
    const pair = `(${stringToken})\\s*:\\s*${stringToken}`;
    const flatObject = new RegExp(`^\\s*\\{\\s*(?:${pair}(?:\\s*,\\s*${pair})*)?\\s*\\}\\s*$`, 'u');
    if (raw.length > 500_000 || !flatObject.test(raw)) throw new Error();
    const localKeys = [...raw.matchAll(new RegExp(pair, 'gu'))].map(
      (match) => JSON.parse(match[1]!) as string,
    );
    if (new Set(localKeys).size !== localKeys.length) throw new Error();
    const input: unknown = JSON.parse(raw);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    const keys = Object.keys(input);
    if (
      keys.some(
        (key) => key !== key.trim() || ['__proto__', 'constructor', 'prototype'].includes(key),
      )
    )
      throw new Error();
    const map = z
      .record(z.string().min(1).max(200), z.string().trim().min(1).max(200))
      .parse(input);
    const entries = Object.entries(map);
    if (
      entries.length > 1000 ||
      new Set(Object.values(map)).size !== entries.length ||
      entries.some(([key]) => ['__proto__', 'constructor', 'prototype'].includes(key))
    )
      throw new Error();
    return Object.freeze(map);
  } catch {
    throw new TypeError(
      'IDOSI_STORE_ID_MAP must be a JSON object with unique, nonempty external store IDs.',
    );
  }
}

export type IdosiGatewayErrorCode =
  'IDOSI_REQUEST_FAILED' | 'IDOSI_RESPONSE_INVALID' | 'IDOSI_RESPONSE_TOO_LARGE';

export class IdosiGatewayError extends Error {
  public constructor(
    public readonly code: IdosiGatewayErrorCode,
    message: string,
    public readonly upstreamStatus: number | null = null,
  ) {
    super(message);
    this.name = 'IdosiGatewayError';
  }
}

export async function fetchIdosiOrderStatistics(
  options: FetchIdosiStatisticsOptions,
): Promise<IdosiOrderStatisticsPayload> {
  const secret = options.secret.trim();
  if (!secret) throw new TypeError('IDOSI integration secret is required');
  const endpoint = new URL(options.endpoint);
  const localCode = options.storeCode.trim();
  if (!localCode) throw new TypeError('IDOSI store code is required');
  const map = options.storeIdMap ?? {};
  const storeCode =
    Object.keys(map).length === 0
      ? localCode
      : Object.hasOwn(map, localCode)
        ? map[localCode]!
        : '';
  if (!storeCode)
    throw new IdosiGatewayError(
      'IDOSI_REQUEST_FAILED',
      'Chưa cấu hình mã cửa hàng IDOSI tương ứng.',
    );
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('IDOSI request timeout must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new RangeError('IDOSI response limit must be a positive safe integer');
  }

  endpoint.search = '';
  endpoint.searchParams.set('storeId', storeCode);
  endpoint.searchParams.set('period', options.scope.period);
  if (options.scope.date !== null) endpoint.searchParams.set('date', options.scope.date);
  if (options.scope.shiftId !== null) endpoint.searchParams.set('shiftId', options.scope.shiftId);
  if (options.scope.paymentMethod !== null) {
    endpoint.searchParams.set('paymentMethod', options.scope.paymentMethod);
  }

  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(endpoint, {
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${secret}`,
        'X-Request-ID': options.requestId,
      },
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new IdosiGatewayError('IDOSI_REQUEST_FAILED', 'Không thể kết nối API thống kê IDOSI.');
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new IdosiGatewayError(
      'IDOSI_REQUEST_FAILED',
      `API thống kê IDOSI phản hồi HTTP ${response.status}.`,
      response.status,
    );
  }

  const payload = await readBoundedJson(response, maxResponseBytes);
  const parsed = IdosiOrderStatisticsPayloadSchema.safeParse(payload);
  if (!parsed.success || !matchesRequestedScope(parsed.data, storeCode, options.scope)) {
    throw new IdosiGatewayError(
      'IDOSI_RESPONSE_INVALID',
      'API thống kê IDOSI trả về dữ liệu không hợp lệ hoặc sai phạm vi.',
      response.status,
    );
  }
  return parsed.data;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new IdosiGatewayError(
      'IDOSI_RESPONSE_TOO_LARGE',
      'API thống kê IDOSI trả về dữ liệu vượt giới hạn.',
      response.status,
    );
  }
  if (!response.body) {
    throw new IdosiGatewayError(
      'IDOSI_RESPONSE_INVALID',
      'API thống kê IDOSI trả về response rỗng.',
      response.status,
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new IdosiGatewayError(
          'IDOSI_RESPONSE_TOO_LARGE',
          'API thống kê IDOSI trả về dữ liệu vượt giới hạn.',
          response.status,
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new IdosiGatewayError(
      'IDOSI_RESPONSE_INVALID',
      'API thống kê IDOSI trả về JSON không hợp lệ.',
      response.status,
    );
  }
}

function matchesRequestedScope(
  payload: IdosiOrderStatisticsPayload,
  storeCode: string,
  scope: Omit<IdosiStatisticsScope, 'storeId'>,
): boolean {
  return (
    payload.storeId === storeCode &&
    payload.store.id === storeCode &&
    payload.filters.period === scope.period &&
    payload.filters.date === scope.date &&
    payload.filters.shiftId === scope.shiftId &&
    (scope.paymentMethod === null ||
      normalizePaymentMethod(payload.filters.paymentMethod) === scope.paymentMethod)
  );
}

function normalizePaymentMethod(value: string | null): IdosiStatisticsPaymentMethod | null {
  if (value === null) return null;
  const normalized = value
    .trim()
    .toLocaleLowerCase('vi-VN')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[\s_-]+/gu, '');
  if (normalized === 'cash' || normalized === 'tienmat') return 'cash';
  if (
    normalized === 'transfer' ||
    normalized === 'chuyenkhoan' ||
    normalized === 'banktransfer' ||
    normalized === 'bank'
  ) {
    return 'transfer';
  }
  return null;
}

/** An IDOSI product id and the warehouse product its sales are charged to. */
export const IdosiProductLinkSchema = z
  .object({
    idosiProductId: z.string().trim().min(1).max(200),
    firstSeenName: z.string().max(500),
    productId: EntityIdSchema,
    productName: z.string(),
    productSku: z.string(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type IdosiProductLink = z.infer<typeof IdosiProductLinkSchema>;

/**
 * An IDOSI product whose sales are not charged to any warehouse stock yet. NO_PRODUCT: no
 * warehouse product has its name. AMBIGUOUS: several have it. PENDING_SYNC: exactly one has it
 * and the next sync links it automatically.
 */
export const UnmatchedIdosiProductSchema = z
  .object({
    idosiProductId: z.string().trim().min(1).max(200),
    productName: z.string().max(500),
    storeCount: z.number().int().nonnegative(),
    reason: z.enum(['NO_PRODUCT', 'AMBIGUOUS', 'PENDING_SYNC']),
    candidateProductIds: z.array(EntityIdSchema),
  })
  .strict();
export type UnmatchedIdosiProduct = z.infer<typeof UnmatchedIdosiProductSchema>;

export const IdosiProductMatchingSchema = z
  .object({
    period: IdosiStatisticsPeriodSchema,
    links: z.array(IdosiProductLinkSchema),
    unmatched: z.array(UnmatchedIdosiProductSchema),
  })
  .strict();
export type IdosiProductMatching = z.infer<typeof IdosiProductMatchingSchema>;
export const IdosiProductMatchingResponseSchema = z
  .object({ data: IdosiProductMatchingSchema })
  .strict();

export const IdosiProductMatchingQuerySchema = z
  .object({ period: IdosiStatisticsPeriodSchema })
  .strict();

export const IdosiProductLinkParamsSchema = z
  .object({ idosiProductId: z.string().trim().min(1).max(200) })
  .strict();

export const SetIdosiProductLinkRequestSchema = z
  .object({
    productId: EntityIdSchema,
    idosiProductName: z.string().trim().max(500).default(''),
    reason: AuditReasonSchema,
  })
  .strict();
export type SetIdosiProductLinkRequest = z.infer<typeof SetIdosiProductLinkRequestSchema>;
export const IdosiProductLinkResponseSchema = z.object({ data: IdosiProductLinkSchema }).strict();

/** Where the IDOSI id of a store comes from, in order of precedence. */
export type IdosiStoreCodeSource = 'STORE' | 'ENVIRONMENT_MAP' | 'STORE_CODE' | 'MISSING';

/**
 * The store id sent to IDOSI. A code set on the store in the app wins; otherwise the
 * IDOSI_STORE_ID_MAP environment map applies, and with no map at all the local code is used.
 */
export function resolveIdosiStoreCode(
  store: { readonly storeCode: string; readonly idosiStoreCode?: string | null },
  storeIdMap: Readonly<Record<string, string>> = {},
): { readonly code: string | null; readonly source: IdosiStoreCodeSource } {
  const explicit = store.idosiStoreCode?.trim();
  if (explicit) return { code: explicit, source: 'STORE' };
  if (Object.keys(storeIdMap).length === 0) return { code: store.storeCode, source: 'STORE_CODE' };
  return Object.hasOwn(storeIdMap, store.storeCode)
    ? { code: storeIdMap[store.storeCode]!, source: 'ENVIRONMENT_MAP' }
    : { code: null, source: 'MISSING' };
}

/** Arguments for fetchIdosiOrderStatistics that honour resolveIdosiStoreCode. */
export function idosiFetchStore(
  store: { readonly storeCode: string; readonly idosiStoreCode?: string | null },
  storeIdMap?: Readonly<Record<string, string>>,
): { readonly storeCode: string; readonly storeIdMap?: Readonly<Record<string, string>> } {
  const explicit = store.idosiStoreCode?.trim();
  if (explicit) return { storeCode: explicit };
  return { storeCode: store.storeCode, ...(storeIdMap ? { storeIdMap } : {}) };
}

export const IdosiStoreCodeSchema = z
  .object({
    storeId: EntityIdSchema,
    storeCode: z.string(),
    storeName: z.string(),
    idosiStoreCode: z.string().nullable(),
    effectiveIdosiStoreCode: z.string().nullable(),
    source: z.enum(['STORE', 'ENVIRONMENT_MAP', 'STORE_CODE', 'MISSING']),
  })
  .strict();
export type IdosiStoreCode = z.infer<typeof IdosiStoreCodeSchema>;
export const ListIdosiStoreCodesResponseSchema = z
  .object({ data: z.array(IdosiStoreCodeSchema) })
  .strict();
export const IdosiStoreCodeResponseSchema = z.object({ data: IdosiStoreCodeSchema }).strict();
export const SetIdosiStoreCodeRequestSchema = z
  .object({
    /** Null clears the code so the environment map (or the local code) applies again. */
    idosiStoreCode: z.string().trim().min(1).max(100).nullable(),
    reason: AuditReasonSchema,
  })
  .strict();
export type SetIdosiStoreCodeRequest = z.infer<typeof SetIdosiStoreCodeRequestSchema>;
