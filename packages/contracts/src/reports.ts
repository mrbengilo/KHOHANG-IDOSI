import { z } from 'zod';

import {
  EntityIdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  KilogramsDecimalSchema,
  MoneyVndSchema,
  UnitQuantitySchema,
} from './common.js';
import { InventoryAmountSchema } from './warehouse.js';

export const ReportScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ALL') }).strict(),
  z.object({ kind: z.literal('GROUP'), groupId: EntityIdSchema }).strict(),
  z.object({ kind: z.literal('STORE'), storeId: EntityIdSchema }).strict(),
]);
export type ReportScope = z.infer<typeof ReportScopeSchema>;

export const MonthlyReportQuerySchema = z
  .object({
    year: z.coerce.number().int().min(2000).max(2100),
    month: z.coerce.number().int().min(1).max(12),
    scopeKind: z.enum(['ALL', 'GROUP', 'STORE']).default('ALL'),
    scopeId: EntityIdSchema.optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.scopeKind === 'ALL' && query.scopeId !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeId'],
        message: 'An all-store report cannot have a scope ID',
      });
    }
    if (query.scopeKind !== 'ALL' && query.scopeId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeId'],
        message: 'A group or store report requires a scope ID',
      });
    }
  });
export type MonthlyReportQuery = z.infer<typeof MonthlyReportQuerySchema>;

export const UnitInventoryMovementSchema = z
  .object({
    kind: z.literal('UNIT'),
    opening: UnitQuantitySchema,
    inbound: UnitQuantitySchema,
    allocated: UnitQuantitySchema,
    outbound: UnitQuantitySchema,
    adjustmentIncrease: UnitQuantitySchema,
    adjustmentDecrease: UnitQuantitySchema,
    closing: UnitQuantitySchema,
  })
  .strict();
export type UnitInventoryMovement = z.infer<typeof UnitInventoryMovementSchema>;

export const WeightInventoryMovementSchema = z
  .object({
    kind: z.literal('WEIGHT'),
    unit: z.literal('kg'),
    opening: KilogramsDecimalSchema,
    inbound: KilogramsDecimalSchema,
    allocated: KilogramsDecimalSchema,
    outbound: KilogramsDecimalSchema,
    adjustmentIncrease: KilogramsDecimalSchema,
    adjustmentDecrease: KilogramsDecimalSchema,
    closing: KilogramsDecimalSchema,
  })
  .strict();
export type WeightInventoryMovement = z.infer<typeof WeightInventoryMovementSchema>;

export const InventoryMovementSchema = z.discriminatedUnion('kind', [
  UnitInventoryMovementSchema,
  WeightInventoryMovementSchema,
]);
export type InventoryMovement = z.infer<typeof InventoryMovementSchema>;

export const MonthlyProductReportLineSchema = z
  .object({
    productId: EntityIdSchema,
    sku: z.string().trim().min(1).max(80),
    productName: z.string().trim().min(1).max(200),
    movement: InventoryMovementSchema,
    confirmedInboundCostVnd: MoneyVndSchema,
  })
  .strict();
export type MonthlyProductReportLine = z.infer<typeof MonthlyProductReportLineSchema>;

export const MonthlyStoreFulfilmentLineSchema = z
  .object({
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    requested: InventoryAmountSchema,
    allocated: InventoryAmountSchema,
    received: InventoryAmountSchema,
    unfulfilled: InventoryAmountSchema,
    fulfilmentBasisPoints: z.number().int().min(0).max(10_000),
  })
  .strict()
  .superRefine((line, context) => {
    if (
      new Set([line.requested.kind, line.allocated.kind, line.received.kind, line.unfulfilled.kind])
        .size !== 1
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allocated', 'kind'],
        message: 'All fulfilment amounts must use the same measurement',
      });
    }
  });
export type MonthlyStoreFulfilmentLine = z.infer<typeof MonthlyStoreFulfilmentLineSchema>;

export const MonthlyReportSummarySchema = z
  .object({
    inboundReceiptCount: z.number().int().nonnegative(),
    outboundOrderCount: z.number().int().nonnegative(),
    allocationBatchCount: z.number().int().nonnegative(),
    waitTicketCount: z.number().int().nonnegative(),
    totalInboundWeightKg: KilogramsDecimalSchema,
    totalOutboundWeightKg: KilogramsDecimalSchema,
    totalShortageWeightKg: KilogramsDecimalSchema,
    confirmedInboundCostVnd: MoneyVndSchema,
    transportationFeeVnd: MoneyVndSchema,
    handlingFeeVnd: MoneyVndSchema,
  })
  .strict();
export type MonthlyReportSummary = z.infer<typeof MonthlyReportSummarySchema>;

export const MonthlyReportSchema = z
  .object({
    year: z.number().int().min(2000).max(2100),
    month: z.number().int().min(1).max(12),
    scope: ReportScopeSchema,
    generatedAt: IsoDateTimeSchema,
    summary: MonthlyReportSummarySchema,
    products: z.array(MonthlyProductReportLineSchema),
    storeFulfilment: z.array(MonthlyStoreFulfilmentLineSchema),
  })
  .strict();
export type MonthlyReport = z.infer<typeof MonthlyReportSchema>;

export const MonthlyReportResponseSchema = z.object({ data: MonthlyReportSchema }).strict();
export type MonthlyReportResponse = z.infer<typeof MonthlyReportResponseSchema>;

/**
 * Exact non-negative integer encoded as JSON text. Operational report totals can exceed
 * JavaScript's safe-integer range, so bigint-backed values must never be emitted as numbers.
 */
export const ReportExactIntegerSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^(0|[1-9]\d*)$/, 'Expected a canonical non-negative integer string');
export type ReportExactInteger = z.infer<typeof ReportExactIntegerSchema>;

export const ReportMetricSourceSchema = z.enum([
  'WAREHOUSE_RECEIPTS',
  'STORE_RECEIPTS',
  'STORE_OUTBOUNDS',
  'WAREHOUSE_RECEIPTS_AND_STORE_OUTBOUNDS',
  'STORE_RECEIPTS_AND_STORE_OUTBOUNDS',
  'NOT_AVAILABLE',
]);
export type ReportMetricSource = z.infer<typeof ReportMetricSourceSchema>;

export const ReportUnavailableReasonSchema = z.enum([
  'MISSING_INBOUND_WEIGHT',
  'MISSING_SALE_REVENUE',
  'ZERO_INBOUND_WEIGHT',
  'VAT_NOT_CAPTURED',
  'COGS_NOT_RECORDED_PER_SALE',
]);
export type ReportUnavailableReason = z.infer<typeof ReportUnavailableReasonSchema>;

function reportMetricSchema<TValue extends z.ZodTypeAny>(valueSchema: TValue) {
  return z
    .object({
      value: valueSchema.nullable(),
      unavailableReason: ReportUnavailableReasonSchema.nullable(),
      source: ReportMetricSourceSchema,
    })
    .strict()
    .superRefine((metric, context) => {
      if (metric.value === null && metric.unavailableReason === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['unavailableReason'],
          message: 'An unavailable metric requires a reason',
        });
      }
      if (metric.value !== null && metric.unavailableReason !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['unavailableReason'],
          message: 'An available metric cannot have an unavailable reason',
        });
      }
      if (metric.value !== null && metric.source === 'NOT_AVAILABLE') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['source'],
          message: 'An available metric requires a concrete data source',
        });
      }
    });
}

/** JSON-safe representation of a bigint-backed operational metric. */
export const ExactIntegerReportMetricSchema = reportMetricSchema(ReportExactIntegerSchema);
export type ExactIntegerReportMetric = z.infer<typeof ExactIntegerReportMetricSchema>;

/** Gross margin may be negative, so only integer/safe-number constraints apply here. */
export const BasisPointsReportMetricSchema = reportMetricSchema(z.number().int().safe());
export type BasisPointsReportMetric = z.infer<typeof BasisPointsReportMetricSchema>;

export const MonthlyOperationalReportPeriodSchema = z
  .object({
    start: IsoDateTimeSchema,
    endExclusive: IsoDateTimeSchema,
    startBusinessDate: IsoDateSchema,
    endBusinessDateExclusive: IsoDateSchema,
    timeZone: z.literal('Asia/Ho_Chi_Minh'),
  })
  .strict();
export type MonthlyOperationalReportPeriod = z.infer<typeof MonthlyOperationalReportPeriodSchema>;

export const MonthlyOperationalReportCountsSchema = z
  .object({
    inboundReceipts: z.number().int().nonnegative().safe(),
    outboundOrdersReceived: z.number().int().nonnegative().safe(),
    allocationBatchesCompleted: z.number().int().nonnegative().safe(),
    waitTicketsQueued: z.number().int().nonnegative().safe(),
    approvedDiscountSales: z.number().int().nonnegative().safe(),
  })
  .strict();
export type MonthlyOperationalReportCounts = z.infer<typeof MonthlyOperationalReportCountsSchema>;

export const MonthlyOperationalReportTotalsSchema = z
  .object({
    inboundWeightGrams: ExactIntegerReportMetricSchema,
    soldWeightGrams: ExactIntegerReportMetricSchema,
    revenueVnd: ExactIntegerReportMetricSchema,
    inboundGoodsCostVnd: ExactIntegerReportMetricSchema,
    transportationFeeVnd: ExactIntegerReportMetricSchema,
    handlingFeeVnd: ExactIntegerReportMetricSchema,
    otherInboundCostVnd: ExactIntegerReportMetricSchema,
    landedInboundCostVnd: ExactIntegerReportMetricSchema,
    vatCostVnd: ExactIntegerReportMetricSchema,
  })
  .strict();
export type MonthlyOperationalReportTotals = z.infer<typeof MonthlyOperationalReportTotalsSchema>;

export const MonthlyOperationalReportRatiosSchema = z
  .object({
    averageInboundCostPerKgVnd: ExactIntegerReportMetricSchema,
    revenuePerInboundKgVnd: ExactIntegerReportMetricSchema,
    effectiveCostPerSoldKgVnd: ExactIntegerReportMetricSchema,
    grossMarginBasisPoints: BasisPointsReportMetricSchema,
  })
  .strict();
export type MonthlyOperationalReportRatios = z.infer<typeof MonthlyOperationalReportRatiosSchema>;

export const MonthlyProductOperationalReportSchema = z
  .object({
    productId: EntityIdSchema,
    sku: z.string().trim().min(1).max(80),
    productName: z.string().trim().min(1).max(200),
    inboundWeightGrams: ExactIntegerReportMetricSchema,
    inboundGoodsCostVnd: ExactIntegerReportMetricSchema,
    soldWeightGrams: ExactIntegerReportMetricSchema,
    revenueVnd: ExactIntegerReportMetricSchema,
  })
  .strict();
export type MonthlyProductOperationalReport = z.infer<typeof MonthlyProductOperationalReportSchema>;

/**
 * Source-backed operational report. This deliberately coexists with MonthlyReportSchema:
 * the older projection models inventory movement while this projection mirrors verified
 * transactional totals and explicitly records unavailable source data.
 */
export const MonthlyOperationalReportSchema = z
  .object({
    period: MonthlyOperationalReportPeriodSchema,
    scope: ReportScopeSchema,
    generatedAt: IsoDateTimeSchema,
    dataOrigin: z.literal('LOCAL_TRANSACTIONAL_DATA'),
    counts: MonthlyOperationalReportCountsSchema,
    totals: MonthlyOperationalReportTotalsSchema,
    ratios: MonthlyOperationalReportRatiosSchema,
    products: z.array(MonthlyProductOperationalReportSchema),
  })
  .strict();
export type MonthlyOperationalReport = z.infer<typeof MonthlyOperationalReportSchema>;

export const MonthlyOperationalReportResponseSchema = z
  .object({ data: MonthlyOperationalReportSchema })
  .strict();
export type MonthlyOperationalReportResponse = z.infer<
  typeof MonthlyOperationalReportResponseSchema
>;

/** Uses the established month/scope query shape without breaking existing consumers. */
export const MonthlyOperationalReportQuerySchema = MonthlyReportQuerySchema;
export type MonthlyOperationalReportQuery = z.infer<typeof MonthlyOperationalReportQuerySchema>;

export const ExportMonthlyReportQuerySchema = z
  .object({
    year: z.coerce.number().int().min(2000).max(2100),
    month: z.coerce.number().int().min(1).max(12),
    scopeKind: z.enum(['ALL', 'GROUP', 'STORE']).default('ALL'),
    scopeId: EntityIdSchema.optional(),
    format: z.enum(['csv', 'xlsx']),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.scopeKind === 'ALL' && query.scopeId !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeId'],
        message: 'An all-store report cannot have a scope ID',
      });
    }
    if (query.scopeKind !== 'ALL' && query.scopeId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeId'],
        message: 'A group or store report requires a scope ID',
      });
    }
  });
export type ExportMonthlyReportQuery = z.infer<typeof ExportMonthlyReportQuerySchema>;

export const ExportMonthlyReportResponseSchema = z
  .object({
    data: z
      .object({
        downloadUrl: z.string().url(),
        expiresAt: IsoDateTimeSchema,
      })
      .strict(),
  })
  .strict();
export type ExportMonthlyReportResponse = z.infer<typeof ExportMonthlyReportResponseSchema>;
