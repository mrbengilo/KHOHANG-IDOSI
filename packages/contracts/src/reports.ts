import { z } from 'zod';

import {
  EntityIdSchema,
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
