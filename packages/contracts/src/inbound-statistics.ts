import { z } from 'zod';
import { EntityIdSchema } from './common.js';

export const InboundSourceSchema = z.enum(['ALL', 'WAREHOUSE', 'PARTNER']);
export const InboundStatisticsQuerySchema = z
  .object({
    periodType: z.enum(['DAY', 'MONTH']).default('MONTH'),
    date: z.string().optional(),
    month: z.string().optional(),
    storeKind: z.enum(['RETAIL', 'WHOLESALE']).optional(),
    storeId: EntityIdSchema.optional(),
    source: InboundSourceSchema.default('ALL'),
    storeSearch: z.string().trim().max(200).default(''),
    productSearch: z.string().trim().max(200).default(''),
    sortBy: z.enum(['bags', 'weight']).default('bags'),
    sortDirection: z.enum(['asc', 'desc']).default('desc'),
    storePage: z.coerce.number().int().min(1).max(1_000_000).default(1),
    productPage: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()
  .superRefine((query, ctx) => {
    const value = query.periodType === 'DAY' ? query.date : query.month;
    const pattern =
      query.periodType === 'DAY'
        ? /^(20\d{2}|2100)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
        : /^(20\d{2}|2100)-(0[1-9]|1[0-2])$/;
    const day = query.periodType === 'DAY' ? value : `${value}-01`;
    if (
      !value ||
      !pattern.test(value) ||
      new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day
    ) {
      ctx.addIssue({
        code: 'custom',
        path: [query.periodType === 'DAY' ? 'date' : 'month'],
        message: 'Kỳ thống kê không hợp lệ',
      });
    }
    if (
      (query.periodType === 'DAY' && query.month !== undefined) ||
      (query.periodType === 'MONTH' && query.date !== undefined)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Chỉ cung cấp ngày hoặc tháng của kỳ đã chọn' });
    }
  });
export type InboundStatisticsQuery = z.infer<typeof InboundStatisticsQuerySchema>;
export type InboundSource = z.infer<typeof InboundSourceSchema>;

const exact = z.string().regex(/^(0|[1-9]\d*)$/);
export const InboundMetricSchema = z
  .object({
    bagQuantity: exact,
    weightGrams: exact,
    bagsComplete: z.boolean(),
    weightComplete: z.boolean(),
  })
  .strict();
export type InboundMetric = z.infer<typeof InboundMetricSchema>;
export const InboundBreakdownSchema = z
  .object({
    warehouse: InboundMetricSchema,
    partner: InboundMetricSchema,
    total: InboundMetricSchema,
  })
  .strict();
export type InboundBreakdown = z.infer<typeof InboundBreakdownSchema>;
export const InboundProductRowSchema = z
  .object({
    productId: z.string(),
    sku: z.string(),
    productName: z.string(),
    amounts: InboundBreakdownSchema,
    selected: InboundMetricSchema,
    bagShareBasisPoints: z.number().int().nullable(),
    weightShareBasisPoints: z.number().int().nullable(),
  })
  .strict();
export type InboundProductRow = z.infer<typeof InboundProductRowSchema>;
const ranking = z
  .object({
    most: InboundProductRowSchema.nullable(),
    least: InboundProductRowSchema.nullable(),
    mostTied: z.boolean(),
    leastTied: z.boolean(),
    complete: z.boolean(),
  })
  .strict();
const store = z
  .object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    kind: z.enum(['RETAIL', 'WHOLESALE']),
  })
  .strict();
const pagination = z
  .object({
    page: z.number().int(),
    pageSize: z.number().int(),
    totalItems: z.number().int(),
    totalPages: z.number().int(),
  })
  .strict();
export const InboundStatisticsSchema = z
  .object({
    generatedAt: z.string().datetime(),
    timezone: z.literal('Asia/Ho_Chi_Minh'),
    period: z
      .object({
        start: z.string().datetime(),
        endExclusive: z.string().datetime(),
        label: z.string(),
      })
      .strict(),
    selectedSource: InboundSourceSchema,
    overviewAllSources: InboundBreakdownSchema,
    summaryBySource: InboundBreakdownSchema,
    selectedTotal: InboundMetricSchema,
    ranking,
    groupRows: z.array(
      z
        .object({ kind: z.enum(['RETAIL', 'WHOLESALE', 'ALL']), amounts: InboundBreakdownSchema })
        .strict(),
    ),
    storeOptions: z.array(store),
    storeRows: z.array(store.extend({ amounts: InboundBreakdownSchema, ranking }).strict()),
    storePagination: pagination,
    productRows: z.array(InboundProductRowSchema),
    productPagination: pagination,
    charts: z
      .object({ bags: z.array(InboundProductRowSchema), weight: z.array(InboundProductRowSchema) })
      .strict(),
    dataCompleteness: z.object({ bagsComplete: z.boolean(), weightComplete: z.boolean() }).strict(),
  })
  .strict();
export type InboundStatistics = z.infer<typeof InboundStatisticsSchema>;
export const InboundStatisticsResponseSchema = z.object({ data: InboundStatisticsSchema }).strict();
