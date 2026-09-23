import { z } from 'zod';

import {
  AuditReasonSchema,
  EntityIdSchema,
  GramsSchema,
  IsoDateTimeSchema,
  MoneyVndSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
  PositiveGramsSchema,
  PositiveKilogramsDecimalSchema,
} from './common.js';
import {
  kilogramsToGramsForRefinement,
  safeIntegerToBigIntForRefinement,
  sumRefinementValues,
} from './refinement-values.js';
import { InventoryAmountSchema, PositiveInventoryAmountSchema } from './warehouse.js';
import type { InventoryAmount } from './warehouse.js';

function amountValue(amount: InventoryAmount): bigint | null {
  return amount.kind === 'UNIT'
    ? safeIntegerToBigIntForRefinement(amount.quantity)
    : kilogramsToGramsForRefinement(amount.value);
}

export const OutboundOrderStatusSchema = z.enum([
  'DRAFT',
  'CONFIRMED',
  'DISPATCHED',
  'RECEIPT_DECLARED',
  'CANCELLED',
]);
export type OutboundOrderStatus = z.infer<typeof OutboundOrderStatusSchema>;

export const OutboundBagPickSchema = z
  .object({
    sourceReceiptBagId: EntityIdSchema,
    weightGrams: PositiveGramsSchema,
  })
  .strict();
export type OutboundBagPick = z.infer<typeof OutboundBagPickSchema>;

const OutboundBagPicksSchema = z
  .array(OutboundBagPickSchema)
  .max(2_000)
  .refine(
    (picks) => new Set(picks.map((pick) => pick.sourceReceiptBagId)).size === picks.length,
    'A source bag may appear only once per outbound line',
  );

export const CreateOutboundLineSchema = z
  .object({
    allocationLineId: EntityIdSchema,
    productId: EntityIdSchema,
    amount: PositiveInventoryAmountSchema,
    bagPicks: OutboundBagPicksSchema.default([]),
  })
  .strict()
  .superRefine((line, context) => {
    if (line.amount.kind === 'UNIT' && line.bagPicks.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bagPicks'],
        message: 'Unit-counted products cannot have weight bag picks',
      });
    }
    if (line.amount.kind === 'WEIGHT') {
      const pickedGrams = sumRefinementValues(
        line.bagPicks.map((pick) => safeIntegerToBigIntForRefinement(pick.weightGrams)),
      );
      const requestedGrams = kilogramsToGramsForRefinement(line.amount.value);
      if (pickedGrams !== null && requestedGrams !== null && pickedGrams !== requestedGrams) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bagPicks'],
          message: 'Bag pick grams must equal the outbound weight',
        });
      }
    }
  });
export type CreateOutboundLine = z.infer<typeof CreateOutboundLineSchema>;

export const OutboundLineSchema = z
  .object({
    id: EntityIdSchema,
    allocationLineId: EntityIdSchema,
    productId: EntityIdSchema,
    amount: PositiveInventoryAmountSchema,
    bagPicks: OutboundBagPicksSchema,
  })
  .strict()
  .superRefine((line, context) => {
    if (line.amount.kind === 'UNIT' && line.bagPicks.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bagPicks'],
        message: 'Unit-counted products cannot have weight bag picks',
      });
    }
    if (line.amount.kind === 'WEIGHT') {
      const pickedGrams = sumRefinementValues(
        line.bagPicks.map((pick) => safeIntegerToBigIntForRefinement(pick.weightGrams)),
      );
      const requestedGrams = kilogramsToGramsForRefinement(line.amount.value);
      if (pickedGrams !== null && requestedGrams !== null && pickedGrams !== requestedGrams) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bagPicks'],
          message: 'Bag pick grams must equal the outbound weight',
        });
      }
    }
  });
export type OutboundLine = z.infer<typeof OutboundLineSchema>;

export const OutboundReceiptDeclarationTypeSchema = z.enum(['FULL', 'SHORT']);
export type OutboundReceiptDeclarationType = z.infer<typeof OutboundReceiptDeclarationTypeSchema>;

export const OutboundReceiptDeclarationLineSchema = z
  .object({
    outboundLineId: EntityIdSchema,
    expected: PositiveInventoryAmountSchema,
    actual: InventoryAmountSchema,
    declaration: OutboundReceiptDeclarationTypeSchema,
    shortageReason: AuditReasonSchema.optional(),
  })
  .strict()
  .superRefine((line, context) => {
    if (line.expected.kind !== line.actual.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actual', 'kind'],
        message: 'Expected and actual amounts must use the same measurement',
      });
      return;
    }

    const expected = amountValue(line.expected);
    const actual = amountValue(line.actual);
    if (expected === null || actual === null) {
      return;
    }
    if (line.declaration === 'FULL' && actual !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actual'],
        message: 'A full receipt must declare the expected amount',
      });
    }
    if (line.declaration === 'SHORT' && actual >= expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actual'],
        message: 'A short receipt must declare less than the expected amount',
      });
    }
    if (line.declaration === 'SHORT' && line.shortageReason === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shortageReason'],
        message: 'A shortage reason is required for a short receipt',
      });
    }
  });
export type OutboundReceiptDeclarationLine = z.infer<typeof OutboundReceiptDeclarationLineSchema>;

export const OutboundReceiptDeclarationSchema = z
  .object({
    id: EntityIdSchema,
    outboundOrderId: EntityIdSchema,
    lines: z.array(OutboundReceiptDeclarationLineSchema).min(1),
    declaredByAccountId: EntityIdSchema,
    declaredAt: IsoDateTimeSchema,
  })
  .strict();
export type OutboundReceiptDeclaration = z.infer<typeof OutboundReceiptDeclarationSchema>;

export const OutboundOrderSchema = z
  .object({
    id: EntityIdSchema,
    code: z.string().trim().min(1).max(100),
    allocationBatchId: EntityIdSchema,
    storeId: EntityIdSchema,
    status: OutboundOrderStatusSchema,
    lines: z.array(OutboundLineSchema).min(1),
    version: z.number().int().nonnegative(),
    confirmedAt: IsoDateTimeSchema.nullable(),
    dispatchedAt: IsoDateTimeSchema.nullable(),
    receiptDeclaration: OutboundReceiptDeclarationSchema.nullable(),
    createdByAccountId: EntityIdSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((order, context) => {
    if (order.status === 'RECEIPT_DECLARED' && order.receiptDeclaration === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receiptDeclaration'],
        message: 'A receipt-declared outbound order must include its declaration',
      });
    }
  });
export type OutboundOrder = z.infer<typeof OutboundOrderSchema>;

export const CreateOutboundOrderRequestSchema = z
  .object({
    allocationBatchId: EntityIdSchema,
    storeId: EntityIdSchema,
    lines: z
      .array(CreateOutboundLineSchema)
      .min(1)
      .max(500)
      .refine(
        (lines) => new Set(lines.map((line) => line.allocationLineId)).size === lines.length,
        'An allocation line may appear only once in an outbound order',
      ),
  })
  .strict();
export type CreateOutboundOrderRequest = z.infer<typeof CreateOutboundOrderRequestSchema>;

export const OutboundOrderParamsSchema = z.object({ outboundOrderId: EntityIdSchema }).strict();
export type OutboundOrderParams = z.infer<typeof OutboundOrderParamsSchema>;

export const ConfirmOutboundOrderRequestSchema = z
  .object({ expectedVersion: z.number().int().nonnegative() })
  .strict();
export type ConfirmOutboundOrderRequest = z.infer<typeof ConfirmOutboundOrderRequestSchema>;

export const DispatchOutboundOrderRequestSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    dispatchNote: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type DispatchOutboundOrderRequest = z.infer<typeof DispatchOutboundOrderRequestSchema>;

export const DeclareOutboundReceiptRequestSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    lines: z
      .array(OutboundReceiptDeclarationLineSchema)
      .min(1)
      .max(500)
      .refine(
        (lines) => new Set(lines.map((line) => line.outboundLineId)).size === lines.length,
        'An outbound line may be declared only once',
      ),
  })
  .strict();
export type DeclareOutboundReceiptRequest = z.infer<typeof DeclareOutboundReceiptRequestSchema>;

export const CancelOutboundOrderRequestSchema = z.object({ reason: AuditReasonSchema }).strict();
export type CancelOutboundOrderRequest = z.infer<typeof CancelOutboundOrderRequestSchema>;

export const OutboundOrderResponseSchema = z.object({ data: OutboundOrderSchema }).strict();
export type OutboundOrderResponse = z.infer<typeof OutboundOrderResponseSchema>;

export const ListOutboundOrdersQuerySchema = PaginationQuerySchema.extend({
  storeId: EntityIdSchema.optional(),
  status: OutboundOrderStatusSchema.optional(),
  dispatchedFrom: IsoDateTimeSchema.optional(),
  dispatchedTo: IsoDateTimeSchema.optional(),
}).strict();
export type ListOutboundOrdersQuery = z.infer<typeof ListOutboundOrdersQuerySchema>;

export const ListOutboundOrdersResponseSchema = z
  .object({ data: z.array(OutboundOrderSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListOutboundOrdersResponse = z.infer<typeof ListOutboundOrdersResponseSchema>;

/** Warehouse dispatch created from a committed allocation line. */
export const WarehouseOutboundRequestStatusSchema = z.enum([
  'RESERVED',
  'DISPATCHED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'COMPLETED',
  'CANCELLED',
]);
export type WarehouseOutboundRequestStatus = z.infer<typeof WarehouseOutboundRequestStatusSchema>;

export const WarehouseOutboundRequestLineSchema = z
  .object({
    id: EntityIdSchema,
    allocationLineId: EntityIdSchema,
    productId: EntityIdSchema,
    requestedUnits: z.number().int().positive().safe(),
    approvedUnits: z.number().int().positive().safe(),
    reservedUnits: z.number().int().positive().safe(),
    dispatchedUnits: z.number().int().nonnegative().safe(),
    receivedUnits: z.number().int().nonnegative().safe(),
  })
  .strict()
  .superRefine((line, context) => {
    if (line.approvedUnits > line.requestedUnits) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvedUnits'],
        message: 'Approved units cannot exceed requested units',
      });
    }
    if (line.reservedUnits > line.approvedUnits) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reservedUnits'],
        message: 'Reserved units cannot exceed approved units',
      });
    }
    if (line.dispatchedUnits > line.reservedUnits) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dispatchedUnits'],
        message: 'Dispatched units cannot exceed reserved units',
      });
    }
    if (line.receivedUnits > line.dispatchedUnits) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receivedUnits'],
        message: 'Received units cannot exceed dispatched units',
      });
    }
  });
export type WarehouseOutboundRequestLine = z.infer<typeof WarehouseOutboundRequestLineSchema>;

export const WarehouseOutboundRequestSchema = z
  .object({
    id: EntityIdSchema,
    requestNumber: z.string().trim().min(1).max(100),
    storeId: EntityIdSchema,
    orderSessionId: EntityIdSchema.nullable(),
    allocationRunId: EntityIdSchema.nullable(),
    status: WarehouseOutboundRequestStatusSchema,
    requestedByAccountId: EntityIdSchema,
    dispatchedByAccountId: EntityIdSchema.nullable(),
    lines: z.array(WarehouseOutboundRequestLineSchema).min(1).max(500),
    version: z.number().int().nonnegative(),
    notes: z.string().trim().min(1).max(1_000).nullable(),
    dispatchedAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const dispatched = request.status !== 'RESERVED' && request.status !== 'CANCELLED';
    if (dispatched !== (request.dispatchedAt !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dispatchedAt'],
        message: 'Dispatch timestamp must match the outbound request status',
      });
    }
    // A null dispatcher on a dispatched request means the system released it: the 09:00
    // allocation run dispatches its own shipments, so there is no account to name.
    if (!dispatched && request.dispatchedByAccountId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dispatchedByAccountId'],
        message: 'Only a dispatched outbound request can name a dispatcher',
      });
    }
    if (dispatched && request.lines.some((line) => line.dispatchedUnits !== line.approvedUnits)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines'],
        message: 'Every approved line must be fully dispatched',
      });
    }
  });
export type WarehouseOutboundRequest = z.infer<typeof WarehouseOutboundRequestSchema>;

export const WarehouseOutboundRequestParamsSchema = z
  .object({ outboundRequestId: EntityIdSchema })
  .strict();
export type WarehouseOutboundRequestParams = z.infer<typeof WarehouseOutboundRequestParamsSchema>;

export const DispatchWarehouseOutboundRequestSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    dispatchNote: z.string().trim().min(3).max(500).optional(),
  })
  .strict();
export type DispatchWarehouseOutboundRequest = z.infer<
  typeof DispatchWarehouseOutboundRequestSchema
>;

export const ListWarehouseOutboundRequestsQuerySchema = PaginationQuerySchema.extend({
  storeId: EntityIdSchema.optional(),
  status: WarehouseOutboundRequestStatusSchema.optional(),
  allocationRunId: EntityIdSchema.optional(),
}).strict();
export type ListWarehouseOutboundRequestsQuery = z.infer<
  typeof ListWarehouseOutboundRequestsQuerySchema
>;

export const WarehouseOutboundRequestResponseSchema = z
  .object({ data: WarehouseOutboundRequestSchema })
  .strict();
export type WarehouseOutboundRequestResponse = z.infer<
  typeof WarehouseOutboundRequestResponseSchema
>;

export const ListWarehouseOutboundRequestsResponseSchema = z
  .object({
    data: z.array(WarehouseOutboundRequestSchema),
    pagination: PaginationMetaSchema,
  })
  .strict();
export type ListWarehouseOutboundRequestsResponse = z.infer<
  typeof ListWarehouseOutboundRequestsResponseSchema
>;

/** Lightweight aggregate for reconciliation endpoints. */
export const OutboundReceiptTotalsSchema = z
  .object({ expectedGrams: GramsSchema, actualGrams: GramsSchema, shortageGrams: GramsSchema })
  .strict();
export type OutboundReceiptTotals = z.infer<typeof OutboundReceiptTotalsSchema>;

export const OutboundReasonSchema = z.enum([
  'DISCOUNT_SALE',
  'CHARITY',
  'TORN',
  'DEFECTIVE',
  'DIRTY',
  'OTHER',
]);
export type OutboundReason = z.infer<typeof OutboundReasonSchema>;

export const StoreOutboundStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED']);
export type StoreOutboundStatus = z.infer<typeof StoreOutboundStatusSchema>;

/** Store-side stock removal from one inventory bag/lot. */
export const StoreOutboundSchema = z
  .object({
    id: EntityIdSchema,
    storeId: EntityIdSchema,
    inventoryLotId: EntityIdSchema,
    weightKg: PositiveKilogramsDecimalSchema,
    reason: OutboundReasonSchema,
    revenueVnd: MoneyVndSchema.nullable(),
    status: StoreOutboundStatusSchema,
    createdByAccountId: EntityIdSchema,
    reviewedByAccountId: EntityIdSchema.nullable(),
    reviewNote: z.string().trim().min(3).max(500).nullable(),
    version: z.number().int().nonnegative(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((outbound, context) => {
    if (outbound.status !== 'PENDING' && outbound.reviewedByAccountId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewedByAccountId'],
        message: 'A reviewed outbound must record its reviewer',
      });
    }
  });
export type StoreOutbound = z.infer<typeof StoreOutboundSchema>;

export const CreateStoreOutboundRequestSchema = z
  .object({
    storeId: EntityIdSchema,
    inventoryLotId: EntityIdSchema,
    expectedInventoryVersion: z.number().int().nonnegative(),
    weightKg: PositiveKilogramsDecimalSchema,
    reason: OutboundReasonSchema,
    revenueVnd: MoneyVndSchema.nullable().default(null),
  })
  .strict();
export type CreateStoreOutboundRequest = z.infer<typeof CreateStoreOutboundRequestSchema>;

export const ReviewStoreOutboundRequestSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: z.string().trim().min(3).max(500).nullable().default(null),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export type ReviewStoreOutboundRequest = z.infer<typeof ReviewStoreOutboundRequestSchema>;

export const StoreOutboundParamsSchema = z.object({ outboundId: EntityIdSchema }).strict();
export type StoreOutboundParams = z.infer<typeof StoreOutboundParamsSchema>;

export const StoreOutboundResponseSchema = z.object({ data: StoreOutboundSchema }).strict();
export type StoreOutboundResponse = z.infer<typeof StoreOutboundResponseSchema>;

export const ListStoreOutboundsQuerySchema = PaginationQuerySchema.extend({
  storeId: EntityIdSchema.optional(),
  inventoryLotId: EntityIdSchema.optional(),
  status: StoreOutboundStatusSchema.optional(),
  reason: OutboundReasonSchema.optional(),
}).strict();
export type ListStoreOutboundsQuery = z.infer<typeof ListStoreOutboundsQuerySchema>;

export const ListStoreOutboundsResponseSchema = z
  .object({ data: z.array(StoreOutboundSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListStoreOutboundsResponse = z.infer<typeof ListStoreOutboundsResponseSchema>;

export const OutboundSchema = StoreOutboundSchema;
export type Outbound = z.infer<typeof OutboundSchema>;
