import { z } from 'zod';

import {
  AuditReasonSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  MoneyVndSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
  PositiveKilogramsDecimalSchema,
} from './common.js';
import {
  kilogramsToGramsForRefinement,
  safeIntegerToBigIntForRefinement,
  sumRefinementValues,
} from './refinement-values.js';

export const InboundReceiptStatusSchema = z.enum([
  'RECEIVED',
  'COST_PENDING',
  'COST_CONFIRMED',
  'CANCELLED',
]);
export type InboundReceiptStatus = z.infer<typeof InboundReceiptStatusSchema>;

export const InboundReceiptBagSchema = z
  .object({
    id: EntityIdSchema,
    receiptId: EntityIdSchema,
    productId: EntityIdSchema,
    bagCode: z.string().trim().min(1).max(100),
    weightKg: PositiveKilogramsDecimalSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type InboundReceiptBag = z.infer<typeof InboundReceiptBagSchema>;

export const ReceiptProductCostSchema = z
  .object({
    productId: EntityIdSchema,
    priceVndPerKg: MoneyVndSchema,
  })
  .strict();
export type ReceiptProductCost = z.infer<typeof ReceiptProductCostSchema>;

export const ReceiptCostConfirmationSchema = z
  .object({
    productCosts: z.array(ReceiptProductCostSchema).min(1),
    transportationFeeVnd: MoneyVndSchema,
    handlingFeeVnd: MoneyVndSchema,
    goodsCostVnd: MoneyVndSchema,
    totalCostVnd: MoneyVndSchema,
    confirmedByAccountId: EntityIdSchema,
    confirmedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((cost, context) => {
    const expectedTotal = sumRefinementValues([
      safeIntegerToBigIntForRefinement(cost.goodsCostVnd),
      safeIntegerToBigIntForRefinement(cost.transportationFeeVnd),
      safeIntegerToBigIntForRefinement(cost.handlingFeeVnd),
    ]);
    const declaredTotal = safeIntegerToBigIntForRefinement(cost.totalCostVnd);
    if (expectedTotal !== null && declaredTotal !== null && declaredTotal !== expectedTotal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalCostVnd'],
        message: 'Total cost must equal goods, transportation, and handling costs',
      });
    }
    if (
      new Set(cost.productCosts.map((item) => item.productId)).size !== cost.productCosts.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['productCosts'],
        message: 'A product may appear only once in receipt costs',
      });
    }
  });
export type ReceiptCostConfirmation = z.infer<typeof ReceiptCostConfirmationSchema>;

export const InboundReceiptSchema = z
  .object({
    id: EntityIdSchema,
    referenceCode: z.string().trim().min(1).max(100),
    supplierName: z.string().trim().min(1).max(200),
    status: InboundReceiptStatusSchema,
    bags: z.array(InboundReceiptBagSchema).min(1),
    totalWeightKg: PositiveKilogramsDecimalSchema,
    cost: ReceiptCostConfirmationSchema.nullable(),
    version: z.number().int().nonnegative(),
    receivedByAccountId: EntityIdSchema,
    receivedAt: IsoDateTimeSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.status === 'COST_CONFIRMED' && receipt.cost === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cost'],
        message: 'A cost-confirmed receipt must include its cost confirmation',
      });
    }
    if (new Set(receipt.bags.map((bag) => bag.bagCode)).size !== receipt.bags.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bags'],
        message: 'Bag codes must be unique within a receipt',
      });
    }
    const bagsTotal = sumRefinementValues(
      receipt.bags.map((bag) => kilogramsToGramsForRefinement(bag.weightKg)),
    );
    const declaredTotal = kilogramsToGramsForRefinement(receipt.totalWeightKg);
    if (bagsTotal !== null && declaredTotal !== null && bagsTotal !== declaredTotal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalWeightKg'],
        message: 'Total receipt weight must equal the sum of bag weights',
      });
    }
  });
export type InboundReceipt = z.infer<typeof InboundReceiptSchema>;

export const CreateInboundReceiptBagSchema = z
  .object({
    productId: EntityIdSchema,
    bagCode: z.string().trim().min(1).max(100),
    weightKg: PositiveKilogramsDecimalSchema,
  })
  .strict();
export type CreateInboundReceiptBag = z.infer<typeof CreateInboundReceiptBagSchema>;

export const CreateInboundReceiptRequestSchema = z
  .object({
    referenceCode: z.string().trim().min(1).max(100),
    supplierName: z.string().trim().min(1).max(200),
    receivedAt: IsoDateTimeSchema,
    bags: z
      .array(CreateInboundReceiptBagSchema)
      .min(1)
      .max(2_000)
      .refine(
        (bags) => new Set(bags.map((bag) => bag.bagCode)).size === bags.length,
        'Bag codes must be unique within a receipt',
      ),
  })
  .strict();
export type CreateInboundReceiptRequest = z.infer<typeof CreateInboundReceiptRequestSchema>;

export const ConfirmReceiptCostsRequestSchema = z
  .object({
    productCosts: z
      .array(ReceiptProductCostSchema)
      .min(1)
      .max(500)
      .refine(
        (costs) => new Set(costs.map((cost) => cost.productId)).size === costs.length,
        'A product may appear only once in receipt costs',
      ),
    transportationFeeVnd: MoneyVndSchema,
    handlingFeeVnd: MoneyVndSchema,
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export type ConfirmReceiptCostsRequest = z.infer<typeof ConfirmReceiptCostsRequestSchema>;

export const CancelInboundReceiptRequestSchema = z.object({ reason: AuditReasonSchema }).strict();
export type CancelInboundReceiptRequest = z.infer<typeof CancelInboundReceiptRequestSchema>;

export const InboundReceiptParamsSchema = z.object({ receiptId: EntityIdSchema }).strict();
export type InboundReceiptParams = z.infer<typeof InboundReceiptParamsSchema>;

export const InboundReceiptResponseSchema = z.object({ data: InboundReceiptSchema }).strict();
export type InboundReceiptResponse = z.infer<typeof InboundReceiptResponseSchema>;

export const ListInboundReceiptsQuerySchema = PaginationQuerySchema.extend({
  status: InboundReceiptStatusSchema.optional(),
  receivedFrom: IsoDateTimeSchema.optional(),
  receivedTo: IsoDateTimeSchema.optional(),
  supplier: z.string().trim().min(1).max(200).optional(),
}).strict();
export type ListInboundReceiptsQuery = z.infer<typeof ListInboundReceiptsQuerySchema>;

export const ListInboundReceiptsResponseSchema = z
  .object({ data: z.array(InboundReceiptSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListInboundReceiptsResponse = z.infer<typeof ListInboundReceiptsResponseSchema>;

/** Store acknowledgement and HTKD cost-confirmation workflow for allocated goods. */
export const ReceiptStatusSchema = z.enum(['DRAFT', 'PENDING_HTKD', 'RETURNED', 'FINALIZED']);
export type ReceiptStatus = z.infer<typeof ReceiptStatusSchema>;

export const DeclaredReceiptLineSchema = z
  .object({
    productId: EntityIdSchema,
    approvedUnits: z.number().int().positive().safe(),
    receivedUnits: z.number().int().nonnegative().safe(),
  })
  .strict()
  .refine((line) => line.receivedUnits <= line.approvedUnits, {
    path: ['receivedUnits'],
    message: 'Received units cannot exceed approved units',
  });
export type DeclaredReceiptLine = z.infer<typeof DeclaredReceiptLineSchema>;

export const ReceiptLineSchema = z
  .object({
    productId: EntityIdSchema,
    approvedUnits: z.number().int().positive().safe(),
    receivedUnits: z.number().int().nonnegative().safe(),
    bagWeightsKg: z.array(PositiveKilogramsDecimalSchema).max(2_000),
    pricePerKgVnd: MoneyVndSchema.nullable(),
  })
  .strict()
  .superRefine((line, context) => {
    if (line.receivedUnits > line.approvedUnits) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receivedUnits'],
        message: 'Received units cannot exceed approved units',
      });
    }
    if (line.bagWeightsKg.length > line.receivedUnits) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bagWeightsKg'],
        message: 'Bag count cannot exceed received units',
      });
    }
  });
export type ReceiptLine = z.infer<typeof ReceiptLineSchema>;

export const ReceiptSchema = z
  .object({
    id: EntityIdSchema,
    storeId: EntityIdSchema,
    allocationId: EntityIdSchema,
    declaredByAccountId: EntityIdSchema,
    lines: z.array(ReceiptLineSchema).min(1).max(500),
    discrepancyNote: z.string().trim().min(3).max(1_000).nullable(),
    status: ReceiptStatusSchema,
    freightVnd: MoneyVndSchema,
    handlingVnd: MoneyVndSchema,
    totalCostVnd: MoneyVndSchema.nullable(),
    reviewedByAccountId: EntityIdSchema.nullable(),
    reviewNote: z.string().trim().min(3).max(500).nullable(),
    version: z.number().int().nonnegative(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    const productIds = receipt.lines.map((line) => line.productId);
    if (new Set(productIds).size !== productIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines'],
        message: 'A product may appear only once in a receipt',
      });
    }
    if (receipt.status === 'FINALIZED') {
      if (receipt.totalCostVnd === null || receipt.reviewedByAccountId === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['totalCostVnd'],
          message: 'A finalized receipt must include reviewer and total cost',
        });
      }
      receipt.lines.forEach((line, index) => {
        if (line.bagWeightsKg.length !== line.receivedUnits) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['lines', index, 'bagWeightsKg'],
            message: 'A finalized receipt requires one weight for each received bag',
          });
        }
        if (line.receivedUnits > 0 && line.pricePerKgVnd === null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['lines', index, 'pricePerKgVnd'],
            message: 'A finalized received line requires its price per kg',
          });
        }
      });
    }
  });
export type Receipt = z.infer<typeof ReceiptSchema>;

const DeclaredReceiptLinesSchema = z
  .array(DeclaredReceiptLineSchema)
  .min(1)
  .max(500)
  .refine(
    (lines) => new Set(lines.map((line) => line.productId)).size === lines.length,
    'A product may appear only once in a receipt',
  );

export const DeclareStoreReceiptRequestSchema = z
  .object({
    storeId: EntityIdSchema,
    allocationId: EntityIdSchema,
    lines: DeclaredReceiptLinesSchema,
    discrepancyNote: z.string().trim().min(3).max(1_000).nullable().default(null),
  })
  .strict()
  .superRefine((request, context) => {
    const hasShortage = request.lines.some((line) => line.receivedUnits < line.approvedUnits);
    if (hasShortage && request.discrepancyNote === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['discrepancyNote'],
        message: 'A shortage declaration requires a discrepancy note',
      });
    }
  });
export type DeclareStoreReceiptRequest = z.infer<typeof DeclareStoreReceiptRequestSchema>;

export const SubmitStoreReceiptRequestSchema = z
  .object({
    lines: DeclaredReceiptLinesSchema,
    discrepancyNote: z.string().trim().min(3).max(1_000).nullable().default(null),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.lines.some((line) => line.receivedUnits < line.approvedUnits) &&
      request.discrepancyNote === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['discrepancyNote'],
        message: 'A shortage declaration requires a discrepancy note',
      });
    }
  });
export type SubmitStoreReceiptRequest = z.infer<typeof SubmitStoreReceiptRequestSchema>;

export const FinalizeReceiptRequestSchema = z
  .object({
    lines: z
      .array(ReceiptLineSchema)
      .min(1)
      .max(500)
      .refine(
        (lines) => new Set(lines.map((line) => line.productId)).size === lines.length,
        'A product may appear only once in a receipt',
      ),
    freightVnd: MoneyVndSchema,
    handlingVnd: MoneyVndSchema,
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((request, context) => {
    request.lines.forEach((line, index) => {
      if (line.bagWeightsKg.length !== line.receivedUnits) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', index, 'bagWeightsKg'],
          message: 'Provide one weight for each received bag',
        });
      }
      if (line.receivedUnits > 0 && line.pricePerKgVnd === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', index, 'pricePerKgVnd'],
          message: 'Price per kg is required for each received product',
        });
      }
    });
  });
export type FinalizeReceiptRequest = z.infer<typeof FinalizeReceiptRequestSchema>;

export const ReturnReceiptForCorrectionRequestSchema = z
  .object({ reason: AuditReasonSchema, expectedVersion: z.number().int().nonnegative() })
  .strict();
export type ReturnReceiptForCorrectionRequest = z.infer<
  typeof ReturnReceiptForCorrectionRequestSchema
>;

export const ReceiptParamsSchema = z.object({ receiptId: EntityIdSchema }).strict();
export type ReceiptParams = z.infer<typeof ReceiptParamsSchema>;

export const ReceiptResponseSchema = z.object({ data: ReceiptSchema }).strict();
export type ReceiptResponse = z.infer<typeof ReceiptResponseSchema>;

export const ListReceiptsQuerySchema = PaginationQuerySchema.extend({
  storeId: EntityIdSchema.optional(),
  allocationId: EntityIdSchema.optional(),
  status: ReceiptStatusSchema.optional(),
}).strict();
export type ListReceiptsQuery = z.infer<typeof ListReceiptsQuerySchema>;

export const ListReceiptsResponseSchema = z
  .object({ data: z.array(ReceiptSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListReceiptsResponse = z.infer<typeof ListReceiptsResponseSchema>;
