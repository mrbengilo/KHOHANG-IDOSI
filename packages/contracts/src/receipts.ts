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
import { ReceiptAdjustmentSummarySchema } from './receipt-adjustments.js';

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
    weightKg: PositiveKilogramsDecimalSchema.nullable(),
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

export const InboundVatSchema = z
  .object({
    amountVnd: MoneyVndSchema,
    ratePercent: z.literal(8),
  })
  .strict();

export const ReceiptCostConfirmationSchema = z
  .object({
    productCosts: z.array(ReceiptProductCostSchema),
    transportationFeeVnd: MoneyVndSchema,
    handlingFeeVnd: MoneyVndSchema,
    /** Legacy only: VAT is no longer entered on warehouse receipts, only on store receipts. */
    vatAmountVnd: MoneyVndSchema.nullish(),
    goodsCostVnd: MoneyVndSchema,
    /** Nullable only for responses of older API versions that waited for warehouse VAT. */
    totalCostVnd: MoneyVndSchema.nullable(),
    confirmedByAccountId: EntityIdSchema,
    confirmedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((cost, context) => {
    const expectedTotal = sumRefinementValues([
      safeIntegerToBigIntForRefinement(cost.goodsCostVnd),
      safeIntegerToBigIntForRefinement(cost.transportationFeeVnd),
      safeIntegerToBigIntForRefinement(cost.handlingFeeVnd),
      safeIntegerToBigIntForRefinement(cost.vatAmountVnd ?? 0),
    ]);
    const declaredTotal =
      cost.totalCostVnd === null ? null : safeIntegerToBigIntForRefinement(cost.totalCostVnd);
    if (expectedTotal !== null && declaredTotal !== null && declaredTotal !== expectedTotal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalCostVnd'],
        message: 'Total cost must equal goods, transportation, handling and legacy VAT costs',
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
    /** Legacy only: VAT recorded on warehouse receipts before it moved to store receipts. */
    vat: InboundVatSchema.nullish(),
    status: InboundReceiptStatusSchema,
    bags: z.array(InboundReceiptBagSchema).min(1),
    totalWeightKg: PositiveKilogramsDecimalSchema.nullable(),
    cost: ReceiptCostConfirmationSchema.nullable(),
    version: z.number().int().nonnegative(),
    receivedByAccountId: EntityIdSchema,
    /** Current display name of the receiver, not a historical snapshot. */
    receivedByDisplayName: z.string().nullable().optional(),
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
    if (receipt.bags.some((bag) => bag.weightKg === null) !== (receipt.totalWeightKg === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalWeightKg'],
        message: 'Total weight is unknown exactly when any bag weight is unknown',
      });
    }
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
    weightKg: PositiveKilogramsDecimalSchema.nullable().default(null),
  })
  .strict();
export type CreateInboundReceiptBag = z.infer<typeof CreateInboundReceiptBagSchema>;

export const CreateInboundReceiptRequestSchema = z
  .object({
    referenceCode: z.string().trim().min(1).max(100).optional(),
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

/** Server-owned sequence; Vietnam calendar date, independent of server timezone. */
export function formatInboundReceiptNumber(sequence: string, now: Date): string {
  if (!/^[1-9]\d*$/.test(sequence)) throw new Error('Invalid receipt sequence');
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(now);
  return `PN${sequence.padStart(5, '0')}-${date}`;
}

export const ConfirmReceiptCostsRequestSchema = z
  .object({
    invoiceGoodsCostVnd: MoneyVndSchema.optional(),
    productCosts: z
      .array(ReceiptProductCostSchema)
      .max(500)
      .refine(
        (costs) => new Set(costs.map((cost) => cost.productId)).size === costs.length,
        'A product may appear only once in receipt costs',
      )
      .default([]),
    transportationFeeVnd: MoneyVndSchema,
    handlingFeeVnd: MoneyVndSchema,
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (input) =>
      input.invoiceGoodsCostVnd === undefined
        ? input.productCosts.length > 0
        : input.productCosts.length === 0,
    'Choose either invoice goods amount or per-product kg prices',
  );
export type ConfirmReceiptCostsRequest = z.infer<typeof ConfirmReceiptCostsRequestSchema>;

export const CancelInboundReceiptRequestSchema = z
  .object({
    reason: AuditReasonSchema,
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
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

/**
 * Excess goods: a product that was not dispatched, or extra bags of a dispatched product
 * whose line was received in full. A short line cannot also carry extra bags.
 */
function hasExcessOnShortLine(
  lines: readonly { productId: string; approvedUnits: number; receivedUnits: number }[],
  unexpectedItems: readonly { productId: string }[] | undefined,
): boolean {
  return (unexpectedItems ?? []).some((item) =>
    lines.some(
      (line) => line.productId === item.productId && line.receivedUnits < line.approvedUnits,
    ),
  );
}

export const UnexpectedReceiptItemSchema = z
  .object({
    productId: EntityIdSchema,
    quantity: z.number().int().positive().safe(),
  })
  .strict();
export type UnexpectedReceiptItem = z.infer<typeof UnexpectedReceiptItemSchema>;
const UnexpectedReceiptItemsSchema = z
  .array(UnexpectedReceiptItemSchema)
  .max(500)
  .refine(
    (items) => new Set(items.map((item) => item.productId)).size === items.length,
    'An unexpected product may appear only once',
  );

/** Unexpected goods as shown on a receipt; weights and price exist once HTKD booked them. */
export const ReceiptUnexpectedItemSchema = UnexpectedReceiptItemSchema.extend({
  bagWeightsKg: z.array(PositiveKilogramsDecimalSchema).max(2_000).optional(),
  pricePerKgVnd: MoneyVndSchema.nullable().optional(),
}).strict();
export type ReceiptUnexpectedItem = z.infer<typeof ReceiptUnexpectedItemSchema>;

/** HTKD weighs every excess bag and prices it when finalizing; the declaration fixes the count. */
export const FinalizeUnexpectedItemSchema = z
  .object({
    productId: EntityIdSchema,
    bagWeightsKg: z.array(PositiveKilogramsDecimalSchema).min(1).max(2_000),
    pricePerKgVnd: MoneyVndSchema,
  })
  .strict();
export type FinalizeUnexpectedItem = z.infer<typeof FinalizeUnexpectedItemSchema>;

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
    receiptNumber: z.string().trim().min(1).max(100),
    outboundRequestNumber: z.string().trim().min(1).max(10).optional(),
    storeId: EntityIdSchema,
    outboundRequestId: EntityIdSchema,
    declaredByAccountId: EntityIdSchema.nullable(),
    lines: z.array(ReceiptLineSchema).min(1).max(500),
    unexpectedItems: z.array(ReceiptUnexpectedItemSchema).max(500).optional(),
    discrepancyNote: z.string().trim().min(3).max(1_000).nullable(),
    status: ReceiptStatusSchema,
    freightVnd: MoneyVndSchema,
    handlingVnd: MoneyVndSchema,
    /** VAT from the actual delivery note, entered by HTKD; null until finalized or legacy. */
    vat: InboundVatSchema.nullable().optional(),
    /** Landed cost: goods + freight + handling. Deductible VAT is tracked separately. */
    totalCostVnd: MoneyVndSchema.nullable(),
    /** Receipt total payable: landed cost + entered VAT; null until both are known. */
    totalAmountVnd: MoneyVndSchema.nullable().optional(),
    reviewedByAccountId: EntityIdSchema.nullable(),
    reviewNote: z.string().trim().min(3).max(500).nullable(),
    /**
     * Post-finalization adjustments: the finalized values above never change; effective values
     * are original + applied deltas. Present only for finalized receipts.
     */
    adjustmentSummary: ReceiptAdjustmentSummarySchema.optional(),
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
    if (receipt.totalAmountVnd != null) {
      const expected =
        receipt.totalCostVnd === null || receipt.vat == null
          ? null
          : sumRefinementValues([
              safeIntegerToBigIntForRefinement(receipt.totalCostVnd),
              safeIntegerToBigIntForRefinement(receipt.vat.amountVnd),
            ]);
      if (
        expected === null ||
        expected !== safeIntegerToBigIntForRefinement(receipt.totalAmountVnd)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['totalAmountVnd'],
          message: 'Receipt total must equal landed cost plus VAT',
        });
      }
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
    outboundRequestId: EntityIdSchema,
    lines: DeclaredReceiptLinesSchema,
    unexpectedItems: UnexpectedReceiptItemsSchema.optional(),
    discrepancyNote: z.string().trim().min(3).max(1_000).nullable().default(null),
  })
  .strict()
  .superRefine((request, context) => {
    const hasShortage = request.lines.some((line) => line.receivedUnits < line.approvedUnits);
    if (
      (hasShortage || (request.unexpectedItems?.length ?? 0) > 0) &&
      request.discrepancyNote === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['discrepancyNote'],
        message: 'A shortage declaration requires a discrepancy note',
      });
    }
    if (hasExcessOnShortLine(request.lines, request.unexpectedItems)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unexpectedItems'],
        message: 'Extra bags of a dispatched product require that line to be received in full',
      });
    }
  });
export type DeclareStoreReceiptRequest = z.infer<typeof DeclareStoreReceiptRequestSchema>;

export const SubmitStoreReceiptRequestSchema = z
  .object({
    lines: DeclaredReceiptLinesSchema,
    unexpectedItems: UnexpectedReceiptItemsSchema.optional(),
    discrepancyNote: z.string().trim().min(3).max(1_000).nullable().default(null),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      (request.lines.some((line) => line.receivedUnits < line.approvedUnits) ||
        (request.unexpectedItems?.length ?? 0) > 0) &&
      request.discrepancyNote === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['discrepancyNote'],
        message: 'A shortage declaration requires a discrepancy note',
      });
    }
    if (hasExcessOnShortLine(request.lines, request.unexpectedItems)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unexpectedItems'],
        message: 'Extra bags of a dispatched product require that line to be received in full',
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
    unexpectedItems: z
      .array(FinalizeUnexpectedItemSchema)
      .max(500)
      .refine(
        (items) => new Set(items.map((item) => item.productId)).size === items.length,
        'An unexpected product may appear only once',
      )
      .optional(),
    freightVnd: MoneyVndSchema,
    handlingVnd: MoneyVndSchema,
    /** Entered amount from the delivery note; 0 when the note carries no VAT. */
    vat: InboundVatSchema,
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
  outboundRequestId: EntityIdSchema.optional(),
  status: ReceiptStatusSchema.optional(),
  /**
   * Leaves out finalized receipts created before this instant. Receipts still in progress are
   * always listed, however old, because someone still has to act on them.
   */
  openOrCreatedFrom: IsoDateTimeSchema.optional(),
}).strict();
export type ListReceiptsQuery = z.infer<typeof ListReceiptsQuerySchema>;

export const ListReceiptsResponseSchema = z
  .object({ data: z.array(ReceiptSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListReceiptsResponse = z.infer<typeof ListReceiptsResponseSchema>;

/**
 * A dispatched outbound request that can still be declared as received by its store.
 * This deliberately carries only the immutable dispatch facts needed to start the workflow.
 */
export const StoreReceiptSourceLineSchema = z
  .object({
    productId: EntityIdSchema,
    approvedUnits: z.number().int().nonnegative().safe(),
    dispatchedUnits: z.number().int().positive().safe(),
  })
  .strict()
  .refine((line) => line.dispatchedUnits <= line.approvedUnits, {
    path: ['dispatchedUnits'],
    message: 'Dispatched units cannot exceed approved units',
  });
export type StoreReceiptSourceLine = z.infer<typeof StoreReceiptSourceLineSchema>;

export const StoreReceiptSourceSchema = z
  .object({
    id: EntityIdSchema,
    requestNumber: z.string().trim().min(1).max(100),
    storeId: EntityIdSchema,
    dispatchedAt: IsoDateTimeSchema,
    lines: z.array(StoreReceiptSourceLineSchema).min(1).max(500),
  })
  .strict()
  .refine(
    (source) => new Set(source.lines.map((line) => line.productId)).size === source.lines.length,
    { path: ['lines'], message: 'A product may appear only once in a receipt source' },
  );
export type StoreReceiptSource = z.infer<typeof StoreReceiptSourceSchema>;

export const ListStoreReceiptSourcesQuerySchema = PaginationQuerySchema.extend({
  storeId: EntityIdSchema.optional(),
}).strict();
export type ListStoreReceiptSourcesQuery = z.infer<typeof ListStoreReceiptSourcesQuerySchema>;

export const ListStoreReceiptSourcesResponseSchema = z
  .object({ data: z.array(StoreReceiptSourceSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListStoreReceiptSourcesResponse = z.infer<typeof ListStoreReceiptSourcesResponseSchema>;

/**
 * Priority goods already allocated and reserved in the central warehouse that have no shipment
 * yet. By rule they travel with the store's next ordinary order, so they are shown rather than
 * shipped on their own.
 */
export const HeldAllocationSchema = z
  .object({
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    heldUnits: z.number().int().positive().safe(),
    heldSince: IsoDateTimeSchema,
  })
  .strict();
export type HeldAllocation = z.infer<typeof HeldAllocationSchema>;

export const ListHeldAllocationsQuerySchema = z
  .object({ storeId: EntityIdSchema.optional() })
  .strict();
export type ListHeldAllocationsQuery = z.infer<typeof ListHeldAllocationsQuerySchema>;

export const ListHeldAllocationsResponseSchema = z
  .object({ data: z.array(HeldAllocationSchema).max(10_000) })
  .strict()
  .refine(
    (response) =>
      new Set(response.data.map((row) => `${row.storeId}:${row.productId}`)).size ===
      response.data.length,
    { path: ['data'], message: 'A store and product may appear only once' },
  );
export type ListHeldAllocationsResponse = z.infer<typeof ListHeldAllocationsResponseSchema>;
