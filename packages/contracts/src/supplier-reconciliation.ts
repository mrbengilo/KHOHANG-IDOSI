import { z } from 'zod';

import {
  EntityIdSchema,
  IsoDateTimeSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
  PositiveUnitQuantitySchema,
  UnitQuantitySchema,
} from './common.js';

/**
 * Reshare (supplier warehouse B) stock reconciliation. C records the TOTAL orderable stock seen
 * at B; A derives free stock F = max(0, B_eff - U) and never adds the observation on top of its
 * own stock. See docs/supplier-stock-reconciliation.md.
 */

export const MAX_SUPPLIER_OBSERVED_BAGS = 1_000_000;

export const SupplierProductStatusSchema = z.enum([
  'PENDING_BASELINE',
  'ACTIVE',
  'NEEDS_RECONCILIATION',
]);
export type SupplierProductStatus = z.infer<typeof SupplierProductStatusSchema>;

export const SupplierReconciliationStateSchema = z.enum([
  'NO_BASELINE',
  'NEEDS_RECONCILIATION',
  'SHORTFALL',
  'RECONCILED',
]);
export type SupplierReconciliationState = z.infer<typeof SupplierReconciliationStateSchema>;

export const SupplierOrderStateSchema = z.enum([
  'UNKNOWN',
  'NOT_ORDERED',
  'PARTIALLY_ORDERED',
  'ORDERED',
  'CANCEL_PENDING',
  'CANCELLED_CONFIRMED',
]);
export type SupplierOrderState = z.infer<typeof SupplierOrderStateSchema>;

export const SupplierEventKindSchema = z.enum(['ORDER', 'ORDER_CANCEL', 'SOURCE_RETURN']);
export type SupplierEventKind = z.infer<typeof SupplierEventKindSchema>;

export const SupplierEventCoverageSchema = z.enum([
  'OPEN',
  'COVERED',
  'AMBIGUOUS',
  'NOT_APPLICABLE',
]);
export type SupplierEventCoverage = z.infer<typeof SupplierEventCoverageSchema>;

const SignedQuantitySchema = z.number().int().safe();
const SupplierRefSchema = z.string().trim().min(1).max(100);
const SupplierNoteSchema = z.string().trim().max(500);

// ---------------------------------------------------------------------------------------------
// Sources and SKU mapping
// ---------------------------------------------------------------------------------------------

export const SupplierSourceSchema = z
  .object({
    id: EntityIdSchema,
    code: z.string().min(2).max(40),
    name: z.string().min(1).max(200),
    isActive: z.boolean(),
    productCount: UnitQuantitySchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type SupplierSource = z.infer<typeof SupplierSourceSchema>;

export const ListSupplierSourcesResponseSchema = z
  .object({ data: z.array(SupplierSourceSchema) })
  .strict();
export type ListSupplierSourcesResponse = z.infer<typeof ListSupplierSourcesResponseSchema>;

export const CreateSupplierSourceRequestSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/u, 'Mã nguồn 2–40 ký tự: chữ in hoa, số, "-" hoặc "_"'),
    name: z.string().trim().min(1).max(200),
  })
  .strict();
export type CreateSupplierSourceRequest = z.infer<typeof CreateSupplierSourceRequestSchema>;

export const CreateSupplierSourceResponseSchema = z
  .object({ data: z.object({ id: EntityIdSchema }).strict() })
  .strict();

export const SupplierSourceParamsSchema = z.object({ sourceId: EntityIdSchema }).strict();

export const AddSupplierSourceProductsRequestSchema = z
  .object({ productIds: z.array(EntityIdSchema).min(1).max(500) })
  .strict();
export type AddSupplierSourceProductsRequest = z.infer<
  typeof AddSupplierSourceProductsRequestSchema
>;

export const AddSupplierSourceProductsResponseSchema = z
  .object({ data: z.object({ added: z.array(EntityIdSchema) }).strict() })
  .strict();

// ---------------------------------------------------------------------------------------------
// Positions and summary
// ---------------------------------------------------------------------------------------------

export const SupplierPositionSchema = z
  .object({
    state: SupplierReconciliationStateSchema,
    baselineQuantity: UnitQuantitySchema.nullable(),
    /** Sum of B events not reflected in the baseline (orders negative, returns positive). */
    pendingDelta: SignedQuantitySchema,
    ambiguousEventCount: UnitQuantitySchema,
    /** B_eff; null before the first baseline. May be negative when orders exceed S. */
    effectiveSupplierQuantity: SignedQuantitySchema.nullable(),
    offerHoldQuantity: UnitQuantitySchema,
    unorderedReservedQuantity: UnitQuantitySchema,
    orderedReservedQuantity: UnitQuantitySchema,
    /** U. */
    unorderedCommitmentQuantity: UnitQuantitySchema,
    /** F. */
    freeQuantity: UnitQuantitySchema,
    /** D. */
    shortfallQuantity: UnitQuantitySchema,
    ledgerOnHand: UnitQuantitySchema,
    ledgerReserved: UnitQuantitySchema,
    ledgerAvailable: SignedQuantitySchema,
    targetOnHand: UnitQuantitySchema.nullable(),
    projectionMismatch: z.boolean(),
    allocatableQuantity: UnitQuantitySchema,
  })
  .strict();
export type SupplierPosition = z.infer<typeof SupplierPositionSchema>;

export const SupplierReconciliationFilterSchema = z.enum([
  'ALL',
  'COMMITTED',
  'UNORDERED',
  'SHORTFALL',
  'NEEDS_RECONCILIATION',
]);
export type SupplierReconciliationFilter = z.infer<typeof SupplierReconciliationFilterSchema>;

export const SupplierReconciliationQuerySchema = PaginationQuerySchema.extend({
  sourceId: EntityIdSchema.optional(),
  search: z.string().trim().max(120).optional(),
  filter: SupplierReconciliationFilterSchema.default('ALL'),
}).strict();
export type SupplierReconciliationQuery = z.infer<typeof SupplierReconciliationQuerySchema>;

const SupplierBaselineSchema = z
  .object({ observedQuantity: UnitQuantitySchema, observedAt: IsoDateTimeSchema })
  .strict();

export const SupplierReconciliationRowSchema = z
  .object({
    productId: EntityIdSchema,
    sku: z.string(),
    productName: z.string(),
    productActive: z.boolean(),
    sourceId: EntityIdSchema,
    sourceCode: z.string(),
    status: SupplierProductStatusSchema,
    blockReason: z.string().nullable(),
    baseline: SupplierBaselineSchema.nullable(),
    position: SupplierPositionSchema,
    integrityIssueCount: UnitQuantitySchema,
  })
  .strict();
export type SupplierReconciliationRow = z.infer<typeof SupplierReconciliationRowSchema>;

export const SupplierReconciliationResponseSchema = z
  .object({
    data: z.array(SupplierReconciliationRowSchema),
    pagination: PaginationMetaSchema,
    /** Moves with any change that could alter these numbers; detail pages carry the same. */
    revision: z.string().min(1).max(64),
    generatedAt: IsoDateTimeSchema,
  })
  .strict();
export type SupplierReconciliationResponse = z.infer<typeof SupplierReconciliationResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Observation preview / confirm
// ---------------------------------------------------------------------------------------------

export const SupplierObservationRequestSchema = z
  .object({
    sourceId: EntityIdSchema,
    observedAt: IsoDateTimeSchema,
    lines: z
      .array(
        z
          .object({
            productId: EntityIdSchema,
            observedQuantity: z.number().int().min(0).max(MAX_SUPPLIER_OBSERVED_BAGS),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    /** Per-event answer: is this B event already reflected in the number entered? */
    eventCoverage: z
      .array(z.object({ eventId: EntityIdSchema, included: z.boolean() }).strict())
      .max(2_000)
      .default([]),
    /** Cutover: holds that predate the baseline and have no recorded B order were not ordered. */
    attestUnlinkedAsNotOrdered: z.boolean().default(false),
    note: SupplierNoteSchema.optional(),
    evidenceRef: z.string().trim().max(200).optional(),
  })
  .strict();
export type SupplierObservationRequest = z.infer<typeof SupplierObservationRequestSchema>;

export const ConfirmSupplierObservationRequestSchema = SupplierObservationRequestSchema.extend({
  expectedRevision: z.string().min(1).max(64),
}).strict();
export type ConfirmSupplierObservationRequest = z.infer<
  typeof ConfirmSupplierObservationRequestSchema
>;

export const SupplierObservationEventSchema = z
  .object({
    id: EntityIdSchema,
    kind: SupplierEventKindSchema,
    quantity: PositiveUnitQuantitySchema,
    coverage: SupplierEventCoverageSchema,
    occurredAt: IsoDateTimeSchema,
    recordedAt: IsoDateTimeSchema,
    externalRef: z.string(),
    externalLineRef: z.string(),
    storeId: EntityIdSchema.nullable(),
    decision: z.enum(['COVERED', 'OPEN', 'UNDECIDED', 'AFTER_OBSERVATION']),
  })
  .strict();

export const SupplierObservationBlockingIssueSchema = z.enum([
  'EXTERNAL_EVENT_COVERAGE_AMBIGUOUS',
  'LEGACY_ATTESTATION_REQUIRED',
  'VERSION_CONFLICT',
]);

export const SupplierObservationPreviewSchema = z
  .object({
    revision: z.string().min(1).max(64),
    observedAt: IsoDateTimeSchema,
    blockingIssues: z.array(SupplierObservationBlockingIssueSchema),
    lines: z.array(
      z
        .object({
          productId: EntityIdSchema,
          sku: z.string(),
          productName: z.string(),
          observedQuantity: UnitQuantitySchema,
          statusBefore: SupplierProductStatusSchema,
          statusAfter: SupplierProductStatusSchema,
          baselineBefore: SupplierBaselineSchema.nullable(),
          before: SupplierPositionSchema,
          after: SupplierPositionSchema,
          events: z.array(SupplierObservationEventSchema),
          undecidedEventCount: UnitQuantitySchema,
          coveredEventCount: UnitQuantitySchema,
          unlinkedLegacyQuantity: UnitQuantitySchema,
          /** Change of A on-hand this confirmation writes (R unchanged). */
          onHandDelta: SignedQuantitySchema,
        })
        .strict(),
    ),
  })
  .strict();
export type SupplierObservationPreview = z.infer<typeof SupplierObservationPreviewSchema>;

export const SupplierObservationPreviewResponseSchema = z
  .object({ data: SupplierObservationPreviewSchema })
  .strict();

const ActorSchema = z.object({ accountId: EntityIdSchema, displayName: z.string() }).strict();

export const SupplierObservationLineSchema = z
  .object({
    productId: EntityIdSchema,
    sku: z.string(),
    productName: z.string(),
    observedQuantity: UnitQuantitySchema,
    coveredEventCount: UnitQuantitySchema,
    effectiveSupplierQuantity: SignedQuantitySchema,
    offerHoldQuantity: UnitQuantitySchema,
    unorderedReservedQuantity: UnitQuantitySchema,
    orderedReservedQuantity: UnitQuantitySchema,
    attestedUnlinkedQuantity: UnitQuantitySchema,
    unorderedCommitmentQuantity: UnitQuantitySchema,
    freeQuantity: UnitQuantitySchema,
    shortfallQuantity: UnitQuantitySchema,
    onHandBefore: UnitQuantitySchema,
    reservedBefore: UnitQuantitySchema,
    onHandAfter: UnitQuantitySchema,
    ledgerEntryId: EntityIdSchema.nullable(),
    statusBefore: SupplierProductStatusSchema,
  })
  .strict();

export const SupplierObservationSchema = z
  .object({
    id: EntityIdSchema,
    sourceId: EntityIdSchema,
    observedAt: IsoDateTimeSchema,
    recordedAt: IsoDateTimeSchema,
    note: z.string().nullable(),
    evidenceRef: z.string().nullable(),
    createdBy: ActorSchema,
    lines: z.array(SupplierObservationLineSchema),
  })
  .strict();
export type SupplierObservation = z.infer<typeof SupplierObservationSchema>;

export const SupplierObservationResponseSchema = z
  .object({ data: SupplierObservationSchema })
  .strict();

export const SupplierObservationHistoryQuerySchema = PaginationQuerySchema.extend({
  productId: EntityIdSchema.optional(),
  sourceId: EntityIdSchema.optional(),
}).strict();
export type SupplierObservationHistoryQuery = z.infer<typeof SupplierObservationHistoryQuerySchema>;

export const SupplierObservationHistoryRowSchema = z
  .object({
    lineId: EntityIdSchema,
    observationId: EntityIdSchema,
    productId: EntityIdSchema,
    sku: z.string(),
    productName: z.string(),
    observedAt: IsoDateTimeSchema,
    recordedAt: IsoDateTimeSchema,
    observedQuantity: UnitQuantitySchema,
    coveredEventCount: UnitQuantitySchema,
    effectiveSupplierQuantity: SignedQuantitySchema,
    unorderedCommitmentQuantity: UnitQuantitySchema,
    freeQuantity: UnitQuantitySchema,
    shortfallQuantity: UnitQuantitySchema,
    onHandBefore: UnitQuantitySchema,
    reservedBefore: UnitQuantitySchema,
    onHandAfter: UnitQuantitySchema,
    attestedUnlinkedQuantity: UnitQuantitySchema,
    statusBefore: SupplierProductStatusSchema,
    note: z.string().nullable(),
    evidenceRef: z.string().nullable(),
    createdByDisplayName: z.string(),
  })
  .strict();
export type SupplierObservationHistoryRow = z.infer<typeof SupplierObservationHistoryRowSchema>;

export const SupplierObservationHistoryResponseSchema = z
  .object({ data: z.array(SupplierObservationHistoryRowSchema), pagination: PaginationMetaSchema })
  .strict();

// ---------------------------------------------------------------------------------------------
// Commitments (what A holds and whether B recorded it)
// ---------------------------------------------------------------------------------------------

export const SupplierCommitmentFilterSchema = z.enum(['ALL', 'ORDERABLE', 'UNORDERED', 'ORDERED']);
export type SupplierCommitmentFilter = z.infer<typeof SupplierCommitmentFilterSchema>;

export const SupplierCommitmentsQuerySchema = PaginationQuerySchema.extend({
  productId: EntityIdSchema.optional(),
  sourceId: EntityIdSchema.optional(),
  storeId: EntityIdSchema.optional(),
  filter: SupplierCommitmentFilterSchema.default('ALL'),
}).strict();
export type SupplierCommitmentsQuery = z.infer<typeof SupplierCommitmentsQuerySchema>;

export const SupplierCommitmentSchema = z
  .object({
    kind: z.enum(['OFFER_HOLD', 'RESERVATION']),
    id: EntityIdSchema,
    commitmentKey: EntityIdSchema,
    productId: EntityIdSchema,
    sku: z.string(),
    productName: z.string(),
    storeId: EntityIdSchema,
    storeCode: z.string(),
    storeName: z.string(),
    orderSessionId: EntityIdSchema.nullable(),
    orderSessionCode: z.string().nullable(),
    businessDate: z.string().nullable(),
    allocationRunId: EntityIdSchema.nullable(),
    allocationLineId: EntityIdSchema.nullable(),
    priorityLevel: z.string().nullable(),
    decisionStatus: z.string().nullable(),
    outboundRequestNumber: z.string().nullable(),
    outboundStatus: z.string().nullable(),
    quantity: PositiveUnitQuantitySchema,
    orderedQuantity: UnitQuantitySchema,
    cancelledQuantity: UnitQuantitySchema,
    unorderedQuantity: UnitQuantitySchema,
    orderState: SupplierOrderStateSchema,
    orderable: z.boolean(),
    notOrderableReason: z
      .enum(['PRIORITY_OFFER', 'DECISION_PENDING', 'NO_BASELINE_SOURCE', 'FULLY_ORDERED'])
      .nullable(),
    heldSince: IsoDateTimeSchema,
    deadlineAt: IsoDateTimeSchema.nullable(),
    htkdNames: z.array(z.string()),
  })
  .strict();
export type SupplierCommitment = z.infer<typeof SupplierCommitmentSchema>;

export const SupplierCommitmentsResponseSchema = z
  .object({
    data: z.array(SupplierCommitmentSchema),
    pagination: PaginationMetaSchema,
    /** Over the whole filtered set (all pages), never just this page. */
    totals: z
      .object({
        quantity: UnitQuantitySchema,
        orderedQuantity: UnitQuantitySchema,
        unorderedQuantity: UnitQuantitySchema,
      })
      .strict(),
    /** True when the reader sees only its assigned stores, not every store. */
    scoped: z.boolean(),
  })
  .strict();
export type SupplierCommitmentsResponse = z.infer<typeof SupplierCommitmentsResponseSchema>;

// ---------------------------------------------------------------------------------------------
// B orders, cancellations and source returns
// ---------------------------------------------------------------------------------------------

export const RecordSupplierOrderRequestSchema = z
  .object({
    /** Optional: the server uses the source the SKUs are mapped to. */
    sourceId: EntityIdSchema.optional(),
    externalRef: SupplierRefSchema,
    occurredAt: IsoDateTimeSchema,
    note: SupplierNoteSchema.optional(),
    lines: z
      .array(
        z
          .object({
            reservationId: EntityIdSchema,
            quantity: PositiveUnitQuantitySchema.max(100_000),
            externalLineRef: SupplierRefSchema,
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type RecordSupplierOrderRequest = z.infer<typeof RecordSupplierOrderRequestSchema>;

export const SupplierOrderEventParamsSchema = z.object({ eventId: EntityIdSchema }).strict();

export const CancelSupplierOrderRequestSchema = z
  .object({
    quantity: PositiveUnitQuantitySchema.max(100_000),
    cancelRef: SupplierRefSchema,
    occurredAt: IsoDateTimeSchema,
    /** B confirmed the cancelled bags are orderable again. */
    sourceReturned: z.boolean(),
    note: SupplierNoteSchema.optional(),
  })
  .strict();
export type CancelSupplierOrderRequest = z.infer<typeof CancelSupplierOrderRequestSchema>;

export const RecordSupplierSourceReturnRequestSchema = z
  .object({
    sourceId: EntityIdSchema,
    productId: EntityIdSchema,
    quantity: PositiveUnitQuantitySchema.max(100_000),
    externalRef: SupplierRefSchema,
    occurredAt: IsoDateTimeSchema,
    note: z.string().trim().min(3).max(500),
  })
  .strict();
export type RecordSupplierSourceReturnRequest = z.infer<
  typeof RecordSupplierSourceReturnRequestSchema
>;

export const SupplierEventSchema = z
  .object({
    id: EntityIdSchema,
    productId: EntityIdSchema,
    sku: z.string(),
    productName: z.string(),
    kind: SupplierEventKindSchema,
    quantity: PositiveUnitQuantitySchema,
    externalRef: z.string(),
    externalLineRef: z.string(),
    coverage: SupplierEventCoverageSchema,
    reversesEventId: EntityIdSchema.nullable(),
    links: z.array(
      z
        .object({
          reservationId: EntityIdSchema,
          allocationLineId: EntityIdSchema.nullable(),
          storeId: EntityIdSchema,
          quantity: PositiveUnitQuantitySchema,
        })
        .strict(),
    ),
  })
  .strict();
export type SupplierEvent = z.infer<typeof SupplierEventSchema>;

export const SupplierBatchSchema = z
  .object({
    id: EntityIdSchema,
    sourceId: EntityIdSchema,
    kind: SupplierEventKindSchema,
    externalRef: z.string(),
    storeId: EntityIdSchema.nullable(),
    occurredAt: IsoDateTimeSchema,
    recordedAt: IsoDateTimeSchema,
    note: z.string().nullable(),
    createdBy: ActorSchema,
    events: z.array(SupplierEventSchema),
  })
  .strict();
export type SupplierBatch = z.infer<typeof SupplierBatchSchema>;

export const SupplierBatchResponseSchema = z.object({ data: SupplierBatchSchema }).strict();

export const ListSupplierOrdersQuerySchema = PaginationQuerySchema.extend({
  sourceId: EntityIdSchema.optional(),
  productId: EntityIdSchema.optional(),
  storeId: EntityIdSchema.optional(),
}).strict();
export type ListSupplierOrdersQuery = z.infer<typeof ListSupplierOrdersQuerySchema>;

export const ListSupplierOrdersResponseSchema = z
  .object({ data: z.array(SupplierBatchSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListSupplierOrdersResponse = z.infer<typeof ListSupplierOrdersResponseSchema>;
