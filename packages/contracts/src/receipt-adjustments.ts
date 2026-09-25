import { z } from 'zod';

import {
  EntityIdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  KilogramsDecimalSchema,
  MoneyVndSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
  PositiveKilogramsDecimalSchema,
  SignedMoneyVndSchema,
} from './common.js';
import { StoreInventoryBagStatusSchema } from './store-inventory.js';

/**
 * Post-finalization discrepancy, before confirming opening for sale. Physical inspection is
 * distinct from the system's sale-opening command. The finalized receipt is never
 * reopened: an adjustment document records the verified reality and, once an admin applies
 * it, the effective receipt values are the original plus every applied delta.
 */
export const ReceiptAdjustmentStatusSchema = z.enum([
  'PENDING_HTKD',
  'NEEDS_INFO',
  'PENDING_ADMIN',
  'APPLIED',
  'REJECTED',
  'CANCELLED',
]);
export type ReceiptAdjustmentStatus = z.infer<typeof ReceiptAdjustmentStatusSchema>;

export const ReceiptAdjustmentDispositionSchema = z.enum(['KEEP', 'RETURN']);
export type ReceiptAdjustmentDisposition = z.infer<typeof ReceiptAdjustmentDispositionSchema>;

export const ReceiptAdjustmentCauseSchema = z.enum([
  'SOURCE_MISCLASSIFICATION',
  'WAREHOUSE_MISPICK',
]);
export type ReceiptAdjustmentCause = z.infer<typeof ReceiptAdjustmentCauseSchema>;

export const ReceiptAdjustmentBlockerSchema = z.enum([
  'BAG_ALREADY_OPENED',
  'BAG_NOT_HELD',
  'BAG_STATE_CHANGED',
  'BAG_PARTIALLY_CONSUMED',
  'BAG_DEPLETED',
  'BAG_TRANSFERRED',
  'BAG_SORTED',
  'BAG_SOLD',
  'BAG_PENDING_OUTBOUND',
  'BAG_PENDING_TRANSFER',
  'BAG_RETURNED_OR_LOST',
]);
export type ReceiptAdjustmentBlocker = z.infer<typeof ReceiptAdjustmentBlockerSchema>;

const StoreBagStatusSchema = StoreInventoryBagStatusSchema;

/** Money of a receipt at one point; VAT null means never captured (legacy), never zero. */
export const ReceiptMoneySchema = z
  .object({
    goodsVnd: MoneyVndSchema,
    freightVnd: MoneyVndSchema,
    handlingVnd: MoneyVndSchema,
    costVnd: MoneyVndSchema,
    vatVnd: MoneyVndSchema.nullable(),
    totalVnd: MoneyVndSchema.nullable(),
  })
  .strict();
export type ReceiptMoney = z.infer<typeof ReceiptMoneySchema>;

export const ReceiptAdjustmentSummarySchema = z
  .object({
    appliedCount: z.number().int().nonnegative(),
    openCount: z.number().int().nonnegative(),
    original: ReceiptMoneySchema,
    effective: ReceiptMoneySchema,
  })
  .strict();
export type ReceiptAdjustmentSummary = z.infer<typeof ReceiptAdjustmentSummarySchema>;

export const ReceiptReturnStatusSchema = z.enum([
  'PENDING_HANDOVER',
  'IN_TRANSIT',
  'RECEIVED',
  'DISPUTED',
  'LOST',
  'CANCELLED',
]);
export type ReceiptReturnStatus = z.infer<typeof ReceiptReturnStatusSchema>;

export const ReceiptReturnSchema = z
  .object({
    id: EntityIdSchema,
    code: z.string().min(1).max(20),
    adjustmentId: EntityIdSchema,
    adjustmentCode: z.string().min(1).max(20),
    adjustmentLineId: EntityIdSchema,
    receiptId: EntityIdSchema,
    storeId: EntityIdSchema,
    inventoryBagId: EntityIdSchema,
    bagDisplayCode: z.string().max(40),
    productId: EntityIdSchema,
    quantity: z.number().int().positive().safe(),
    weightKg: PositiveKilogramsDecimalSchema,
    costVnd: MoneyVndSchema,
    status: ReceiptReturnStatusSchema,
    version: z.number().int().nonnegative(),
    reason: z.string().min(1).max(1_000),
    createdByAccountId: EntityIdSchema,
    handedOverByAccountId: EntityIdSchema.nullable(),
    handedOverAt: IsoDateTimeSchema.nullable(),
    receivedByAccountId: EntityIdSchema.nullable(),
    receivedAt: IsoDateTimeSchema.nullable(),
    receivedQuantity: z.number().int().nonnegative().nullable(),
    receiveNote: z.string().nullable(),
    resolvedByAccountId: EntityIdSchema.nullable(),
    resolvedAt: IsoDateTimeSchema.nullable(),
    resolutionNote: z.string().nullable(),
    cancelledByAccountId: EntityIdSchema.nullable(),
    cancelledAt: IsoDateTimeSchema.nullable(),
    cancellationReason: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type ReceiptReturn = z.infer<typeof ReceiptReturnSchema>;

/** Progress of the P0B right for the approved SKU the store never got. */
export const ReceiptShortageEntitlementSchema = z
  .object({
    waitTicketId: EntityIdSchema,
    waitTicketCode: z.string().max(20),
    waitMode: z.enum(['CREATED', 'MERGED']),
    productId: EntityIdSchema,
    quantity: z.number().int().positive().safe(),
    waitStatus: z.enum(['ACTIVE', 'FULFILLED', 'CANCELLED', 'EXPIRED']),
    waitRemainingQuantity: z.number().int().nonnegative(),
    waitFulfilledQuantity: z.number().int().nonnegative(),
    hasOpenOffer: z.boolean(),
    heldQuantity: z.number().int().nonnegative(),
    shippingQuantity: z.number().int().nonnegative(),
    receivedQuantity: z.number().int().nonnegative(),
    grantedAt: IsoDateTimeSchema,
  })
  .strict();
export type ReceiptShortageEntitlement = z.infer<typeof ReceiptShortageEntitlementSchema>;

export const ReceiptAdjustmentLineSchema = z
  .object({
    id: EntityIdSchema,
    receiptBagId: EntityIdSchema,
    receiptBagNumber: z.number().int().nonnegative(),
    inventoryBagId: EntityIdSchema,
    bagDisplayCode: z.string().max(40),
    bagStatus: StoreBagStatusSchema,
    bagCurrentWeightKg: KilogramsDecimalSchema,
    approvedProductId: EntityIdSchema.nullable(),
    recordedProductId: EntityIdSchema,
    actualProductId: EntityIdSchema,
    disposition: ReceiptAdjustmentDispositionSchema,
    recordedWeightKg: PositiveKilogramsDecimalSchema,
    recordedPricePerKgVnd: MoneyVndSchema,
    recordedCostVnd: MoneyVndSchema,
    verifiedWeightKg: PositiveKilogramsDecimalSchema.nullable(),
    verifiedPricePerKgVnd: MoneyVndSchema.nullable(),
    verifiedCostVnd: MoneyVndSchema.nullable(),
    weightChangeNote: z.string().nullable(),
    shortageQuantity: z.number().int().min(0).max(1),
    holdState: z.enum(['NONE', 'HELD', 'RELEASED', 'RETURNING']),
    blockers: z.array(ReceiptAdjustmentBlockerSchema),
    entitlement: ReceiptShortageEntitlementSchema.nullable(),
    returns: z.array(ReceiptReturnSchema),
  })
  .strict();
export type ReceiptAdjustmentLine = z.infer<typeof ReceiptAdjustmentLineSchema>;

export const ReceiptAdjustmentActionSchema = z.enum([
  'RESUBMIT',
  'CANCEL',
  'VERIFY',
  'REQUEST_INFO',
  'RETURN_TO_VERIFIER',
  'REJECT',
  'APPLY',
]);
export type ReceiptAdjustmentAction = z.infer<typeof ReceiptAdjustmentActionSchema>;

/** An account named on a document; names are null when the account no longer exists. */
export const AdjustmentAccountSchema = z
  .object({
    accountId: EntityIdSchema,
    displayName: z.string().nullable(),
    username: z.string().nullable(),
  })
  .strict();
export type AdjustmentAccount = z.infer<typeof AdjustmentAccountSchema>;

export const ReceiptAdjustmentSchema = z
  .object({
    id: EntityIdSchema,
    code: z.string().min(1).max(20),
    receiptId: EntityIdSchema,
    receiptNumber: z.string().min(1).max(100),
    receiptFinalizedAt: IsoDateTimeSchema.nullable(),
    storeId: EntityIdSchema,
    status: ReceiptAdjustmentStatusSchema,
    version: z.number().int().nonnegative(),
    reason: z.string().min(1).max(1_000),
    evidenceNote: z.string().nullable(),
    discoveredAt: IsoDateTimeSchema,
    cause: ReceiptAdjustmentCauseSchema.nullable(),
    appliedSequence: z.number().int().positive().nullable(),
    delta: z
      .object({
        goodsVnd: SignedMoneyVndSchema,
        freightVnd: SignedMoneyVndSchema,
        handlingVnd: SignedMoneyVndSchema,
        vatVnd: SignedMoneyVndSchema,
      })
      .strict(),
    /** original = finalized receipt; before = effective before this document; after once verified. */
    money: z
      .object({
        original: ReceiptMoneySchema,
        before: ReceiptMoneySchema,
        after: ReceiptMoneySchema.nullable(),
      })
      .strict(),
    reportedByAccountId: EntityIdSchema,
    reportedBy: AdjustmentAccountSchema,
    reportedAt: IsoDateTimeSchema,
    verifiedByAccountId: EntityIdSchema.nullable(),
    verifiedBy: AdjustmentAccountSchema.nullable(),
    verifiedAt: IsoDateTimeSchema.nullable(),
    verificationNote: z.string().nullable(),
    infoRequestNote: z.string().nullable(),
    decidedByAccountId: EntityIdSchema.nullable(),
    decidedBy: AdjustmentAccountSchema.nullable(),
    decidedAt: IsoDateTimeSchema.nullable(),
    decisionNote: z.string().nullable(),
    appliedAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    /** Actions the requesting account may take now; the server re-checks every command. */
    allowedActions: z.array(ReceiptAdjustmentActionSchema),
    lines: z.array(ReceiptAdjustmentLineSchema).min(1).max(50),
  })
  .strict();
export type ReceiptAdjustment = z.infer<typeof ReceiptAdjustmentSchema>;

export const ReceiptAdjustmentListItemSchema = z
  .object({
    id: EntityIdSchema,
    code: z.string().min(1).max(20),
    receiptId: EntityIdSchema,
    receiptNumber: z.string().min(1).max(100),
    storeId: EntityIdSchema,
    /** Null only when the store row can no longer be read; the document stays listed. */
    storeCode: z.string().nullable(),
    storeName: z.string().nullable(),
    status: ReceiptAdjustmentStatusSchema,
    version: z.number().int().nonnegative(),
    reason: z.string().min(1).max(1_000),
    cause: ReceiptAdjustmentCauseSchema.nullable(),
    lineCount: z.number().int().positive(),
    shortageQuantity: z.number().int().nonnegative(),
    /** Verified goods delta; effective only once the status is APPLIED. */
    goodsDeltaVnd: SignedMoneyVndSchema,
    reportedBy: AdjustmentAccountSchema,
    reportedAt: IsoDateTimeSchema,
    /** HTKD/admin who verified the current version and sent it to the admin. */
    verifiedBy: AdjustmentAccountSchema.nullable(),
    verifiedAt: IsoDateTimeSchema.nullable(),
    /** Who closed the document: applied, rejected or cancelled. */
    decidedBy: AdjustmentAccountSchema.nullable(),
    decidedAt: IsoDateTimeSchema.nullable(),
    decisionNote: z.string().nullable(),
    appliedAt: IsoDateTimeSchema.nullable(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type ReceiptAdjustmentListItem = z.infer<typeof ReceiptAdjustmentListItemSchema>;

export const ReceiptAdjustmentContextBagSchema = z
  .object({
    receiptBagId: EntityIdSchema,
    bagNumber: z.number().int().positive(),
    inventoryBagId: EntityIdSchema.nullable(),
    bagDisplayCode: z.string().max(40).nullable(),
    bagStatus: StoreBagStatusSchema.nullable(),
    currentWeightKg: KilogramsDecimalSchema.nullable(),
    approvedProductId: EntityIdSchema.nullable(),
    effectiveProductId: EntityIdSchema,
    effectiveWeightKg: PositiveKilogramsDecimalSchema,
    effectivePricePerKgVnd: MoneyVndSchema,
    effectiveCostVnd: MoneyVndSchema,
    shortageGranted: z.boolean(),
    openAdjustmentId: EntityIdSchema.nullable(),
    openReturnId: EntityIdSchema.nullable(),
    dependencies: z.array(ReceiptAdjustmentBlockerSchema),
    openedAt: IsoDateTimeSchema.nullable(),
    canReportDiscrepancy: z.boolean(),
    reportBlockers: z.array(ReceiptAdjustmentBlockerSchema),
  })
  .strict();
export type ReceiptAdjustmentContextBag = z.infer<typeof ReceiptAdjustmentContextBagSchema>;

export const ReceiptAdjustmentContextSchema = z
  .object({
    receiptId: EntityIdSchema,
    receiptNumber: z.string().min(1).max(100),
    storeId: EntityIdSchema,
    finalizedAt: IsoDateTimeSchema.nullable(),
    summary: ReceiptAdjustmentSummarySchema,
    bags: z.array(ReceiptAdjustmentContextBagSchema),
    /** The most recent adjustments of the receipt (at most one page). */
    adjustments: z.array(ReceiptAdjustmentListItemSchema),
    /** Exact number of adjustments of the receipt; more than listed means page the list API. */
    adjustmentCount: z.number().int().nonnegative(),
  })
  .strict();
export type ReceiptAdjustmentContext = z.infer<typeof ReceiptAdjustmentContextSchema>;

const ReportedLineSchema = z
  .object({
    receiptBagId: EntityIdSchema,
    actualProductId: EntityIdSchema,
    disposition: ReceiptAdjustmentDispositionSchema,
  })
  .strict();

const ReportedLinesSchema = z
  .array(ReportedLineSchema)
  .min(1)
  .max(50)
  .refine(
    (lines) => new Set(lines.map((line) => line.receiptBagId)).size === lines.length,
    'Mỗi bao chỉ chọn một lần',
  );

export const CreateReceiptAdjustmentRequestSchema = z
  .object({
    receiptId: EntityIdSchema,
    reason: z.string().trim().min(3).max(1_000),
    evidenceNote: z.string().trim().max(2_000).nullable().default(null),
    discoveredAt: IsoDateTimeSchema,
    lines: ReportedLinesSchema,
  })
  .strict();
export type CreateReceiptAdjustmentRequest = z.infer<typeof CreateReceiptAdjustmentRequestSchema>;

const Note = z.string().trim().min(3).max(1_000);

export const ReceiptAdjustmentActionRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('RESUBMIT'),
      expectedVersion: z.number().int().nonnegative(),
      reason: Note,
      evidenceNote: z.string().trim().max(2_000).nullable().default(null),
      discoveredAt: IsoDateTimeSchema,
      lines: ReportedLinesSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('VERIFY'),
      expectedVersion: z.number().int().nonnegative(),
      cause: ReceiptAdjustmentCauseSchema,
      note: Note,
      lines: z
        .array(
          z
            .object({
              receiptBagId: EntityIdSchema,
              actualProductId: EntityIdSchema,
              weightKg: PositiveKilogramsDecimalSchema,
              pricePerKgVnd: MoneyVndSchema,
              weightChangeNote: z.string().trim().max(500).nullable().default(null),
            })
            .strict(),
        )
        .min(1)
        .max(50),
      freightDeltaVnd: SignedMoneyVndSchema.default(0),
      handlingDeltaVnd: SignedMoneyVndSchema.default(0),
      vatDeltaVnd: SignedMoneyVndSchema.default(0),
    })
    .strict(),
  z
    .object({
      action: z.enum(['CANCEL', 'REQUEST_INFO', 'RETURN_TO_VERIFIER', 'REJECT']),
      expectedVersion: z.number().int().nonnegative(),
      note: Note,
    })
    .strict(),
  z
    .object({
      action: z.literal('APPLY'),
      expectedVersion: z.number().int().nonnegative(),
      note: z.string().trim().max(1_000).nullable().default(null),
    })
    .strict(),
]);
export type ReceiptAdjustmentActionRequest = z.infer<typeof ReceiptAdjustmentActionRequestSchema>;

/** Which moment a date filter applies to: when the store reported, or when it was closed. */
export const ReceiptAdjustmentDateFieldSchema = z.enum(['REPORTED', 'DECIDED']);
export type ReceiptAdjustmentDateField = z.infer<typeof ReceiptAdjustmentDateFieldSchema>;

export const ListReceiptAdjustmentsQuerySchema = PaginationQuerySchema.extend({
  storeId: EntityIdSchema.optional(),
  receiptId: EntityIdSchema.optional(),
  status: ReceiptAdjustmentStatusSchema.optional(),
  /** PSL code or source receipt number, partial and case-insensitive. */
  q: z.string().trim().min(1).max(40).optional(),
  dateField: ReceiptAdjustmentDateFieldSchema.default('REPORTED'),
  /** Business dates in Asia/Ho_Chi_Minh, both inclusive. */
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
})
  .strict()
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc',
    path: ['to'],
  });
export type ListReceiptAdjustmentsQuery = z.infer<typeof ListReceiptAdjustmentsQuerySchema>;

export const ListReceiptAdjustmentsResponseSchema = z
  .object({ data: z.array(ReceiptAdjustmentListItemSchema), pagination: PaginationMetaSchema })
  .strict();

export const ReceiptAdjustmentHistoryEventTypeSchema = z.enum([
  'REPORTED',
  'RESUBMITTED',
  'VERIFIED',
  'INFO_REQUESTED',
  'RETURNED_TO_VERIFIER',
  'REJECTED',
  'CANCELLED',
  'APPLIED',
  'RETURN_CREATED',
  'RETURN_HANDED_OVER',
  'RETURN_RECEIVED',
  'RETURN_DISPUTED',
  'RETURN_RECEIVED_AFTER_RECONCILIATION',
  'RETURN_LOST',
  'RETURN_CANCELLED',
  /** An audit action this version does not know; `action` carries the raw name. */
  'OTHER',
]);
export type ReceiptAdjustmentHistoryEventType = z.infer<
  typeof ReceiptAdjustmentHistoryEventTypeSchema
>;

export const AuditActorRoleSchema = z.enum(['ADMIN', 'HTKD', 'STORE', 'WHOLESALE']);
export type AuditActorRole = z.infer<typeof AuditActorRoleSchema>;

/**
 * One immutable audit event of an adjustment or of a return raised from it. Every field the
 * audit row did not record is null ("Chưa ghi nhận"), never guessed. Request/session/IP data
 * of the audit row is never exposed.
 */
export const ReceiptAdjustmentHistoryEventSchema = z
  .object({
    id: EntityIdSchema,
    occurredAt: IsoDateTimeSchema,
    type: ReceiptAdjustmentHistoryEventTypeSchema,
    action: z.string().min(1).max(120),
    subject: z.enum(['ADJUSTMENT', 'RETURN']),
    returnCode: z.string().max(20).nullable(),
    actor: z
      .object({
        accountId: EntityIdSchema.nullable(),
        /** Current name of the account; null when it no longer exists. */
        displayName: z.string().nullable(),
        username: z.string().nullable(),
        /** Role recorded on the audit row at the time of the action. */
        role: AuditActorRoleSchema.nullable(),
      })
      .strict(),
    store: z
      .object({
        storeId: EntityIdSchema.nullable(),
        code: z.string().nullable(),
        name: z.string().nullable(),
      })
      .strict(),
    statusBefore: z.union([ReceiptAdjustmentStatusSchema, ReceiptReturnStatusSchema]).nullable(),
    statusAfter: z.union([ReceiptAdjustmentStatusSchema, ReceiptReturnStatusSchema]).nullable(),
    note: z.string().nullable(),
    changes: z
      .object({
        reason: z.string().nullable(),
        evidenceNote: z.string().nullable(),
        cause: ReceiptAdjustmentCauseSchema.nullable(),
        lineCount: z.number().int().nonnegative().nullable(),
        goodsDeltaVnd: SignedMoneyVndSchema.nullable(),
        freightDeltaVnd: SignedMoneyVndSchema.nullable(),
        handlingDeltaVnd: SignedMoneyVndSchema.nullable(),
        vatDeltaVnd: SignedMoneyVndSchema.nullable(),
        totalBeforeVnd: MoneyVndSchema.nullable(),
        totalAfterVnd: MoneyVndSchema.nullable(),
        costBeforeVnd: MoneyVndSchema.nullable(),
        costAfterVnd: MoneyVndSchema.nullable(),
        appliedSequence: z.number().int().positive().nullable(),
        releasedBagCount: z.number().int().nonnegative().nullable(),
        returnCount: z.number().int().nonnegative().nullable(),
        entitlementCount: z.number().int().nonnegative().nullable(),
      })
      .strict(),
  })
  .strict();
export type ReceiptAdjustmentHistoryEvent = z.infer<typeof ReceiptAdjustmentHistoryEventSchema>;

export const ReceiptAdjustmentHistoryQuerySchema = PaginationQuerySchema;
export type ReceiptAdjustmentHistoryQuery = z.infer<typeof ReceiptAdjustmentHistoryQuerySchema>;

export const ReceiptAdjustmentHistoryResponseSchema = z
  .object({
    data: z.array(ReceiptAdjustmentHistoryEventSchema),
    pagination: PaginationMetaSchema,
  })
  .strict();

export const ReceiptAdjustmentParamsSchema = z.object({ adjustmentId: EntityIdSchema }).strict();
export const ReceiptAdjustmentLineParamsSchema = z
  .object({ adjustmentId: EntityIdSchema, lineId: EntityIdSchema })
  .strict();

export const CreateReceiptReturnRequestSchema = z
  .object({ reason: z.string().trim().min(3).max(1_000) })
  .strict();
export type CreateReceiptReturnRequest = z.infer<typeof CreateReceiptReturnRequestSchema>;

export const ReceiptReturnActionRequestSchema = z
  .discriminatedUnion('action', [
    z
      .object({ action: z.literal('HANDOVER'), expectedVersion: z.number().int().nonnegative() })
      .strict(),
    z
      .object({
        action: z.literal('RECEIVE'),
        expectedVersion: z.number().int().nonnegative(),
        outcome: z.enum(['RECEIVED', 'NOT_RECEIVED', 'WRONG_ITEM']),
        note: z.string().trim().max(1_000).nullable().default(null),
      })
      .strict(),
    z
      .object({
        action: z.literal('RESOLVE'),
        expectedVersion: z.number().int().nonnegative(),
        outcome: z.enum(['RECEIVED', 'LOST']),
        note: Note,
      })
      .strict(),
    z
      .object({
        action: z.literal('CANCEL'),
        expectedVersion: z.number().int().nonnegative(),
        note: Note,
      })
      .strict(),
  ])
  .superRefine((input, context) => {
    if (
      input.action === 'RECEIVE' &&
      input.outcome !== 'RECEIVED' &&
      (input.note?.length ?? 0) < 3
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['note'],
        message: 'Kho nhận thiếu hoặc sai hàng cần ghi chú đối soát',
      });
    }
  });
export type ReceiptReturnActionRequest = z.infer<typeof ReceiptReturnActionRequestSchema>;

export const ListReceiptReturnsQuerySchema = PaginationQuerySchema.extend({
  storeId: EntityIdSchema.optional(),
  status: ReceiptReturnStatusSchema.optional(),
}).strict();
export type ListReceiptReturnsQuery = z.infer<typeof ListReceiptReturnsQuerySchema>;

export const ListReceiptReturnsResponseSchema = z
  .object({ data: z.array(ReceiptReturnSchema), pagination: PaginationMetaSchema })
  .strict();

export const ReceiptReturnParamsSchema = z.object({ returnId: EntityIdSchema }).strict();

export const ReceiptAdjustmentResponseSchema = z.object({ data: ReceiptAdjustmentSchema }).strict();
export const ReceiptAdjustmentContextResponseSchema = z
  .object({ data: ReceiptAdjustmentContextSchema })
  .strict();
export const ReceiptReturnResponseSchema = z.object({ data: ReceiptReturnSchema }).strict();
