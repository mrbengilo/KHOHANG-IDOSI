import { z } from 'zod';

import { AllocationPrioritySchema } from './allocation-policy.js';
import {
  AuditReasonSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  IsoDateSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
} from './common.js';
import {
  kilogramsToGramsForRefinement,
  safeIntegerToBigIntForRefinement,
} from './refinement-values.js';
import { AccountRoleSchema } from './identity.js';
import { InventoryAmountSchema, PositiveInventoryAmountSchema } from './warehouse.js';
import type { InventoryAmount } from './warehouse.js';

function amountValue(amount: InventoryAmount): bigint | null {
  if (amount.kind === 'UNIT') {
    return safeIntegerToBigIntForRefinement(amount.quantity);
  }
  return kilogramsToGramsForRefinement(amount.value);
}

export const WaitTicketStatusSchema = z.enum([
  'WAITING',
  'OFFERED',
  'PARTIALLY_FULFILLED',
  'FULFILLED',
  'CANCELLED',
  'EXPIRED',
]);
export type WaitTicketStatus = z.infer<typeof WaitTicketStatusSchema>;

/**
 * Why the priority wait policy cancelled a ticket: by the store, by an Admin, or because the
 * store declined / did not answer an offer covering everything it waited for. Declining or
 * missing a partial offer never cancels a ticket and therefore has no kind.
 */
export const WaitTicketCancellationKindSchema = z.enum([
  'STORE_CANCELLED',
  'ADMIN_CANCELLED',
  'HTKD_CANCELLED',
  'FULL_OFFER_DECLINED',
  'FULL_OFFER_TIMEOUT',
]);
export type WaitTicketCancellationKind = z.infer<typeof WaitTicketCancellationKindSchema>;

/** Three labels for HTKD, store and wholesale lists; details stay available separately. */
export const WaitTicketDisplayStatusSchema = z.enum(['UNPROCESSED', 'PROCESSED', 'CANCELLED']);
export type WaitTicketDisplayStatus = z.infer<typeof WaitTicketDisplayStatusSchema>;

export const WaitTicketDisplayDetailSchema = z.enum([
  'WAITING',
  'OFFERED',
  'PARTIALLY_FULFILLED',
  'PENDING_DECISION',
  'PROCESSED',
  'CANCELLED',
  'EXPIRED_LEGACY',
]);
export type WaitTicketDisplayDetail = z.infer<typeof WaitTicketDisplayDetailSchema>;

/** One recorded contribution to a ticket's demand (append-only lineage, 0044). */
export const WaitTicketSourceSchema = z
  .object({
    id: EntityIdSchema,
    kind: z.enum(['ORDER_REMAINDER', 'RESULT_WAITLISTED', 'RESULT_RESTORED']),
    quantity: z.number().int().positive().safe(),
    createdAt: IsoDateTimeSchema,
    sessionId: EntityIdSchema.nullable(),
    sessionCode: z.string().nullable(),
    allocationDecisionId: EntityIdSchema.nullable(),
    allocationLineId: EntityIdSchema.nullable(),
    sourceWaitTicketId: EntityIdSchema.nullable(),
    sourceWaitTicketCode: z.string().nullable(),
    actorName: z.string().nullable(),
  })
  .strict();
export type WaitTicketSource = z.infer<typeof WaitTicketSourceSchema>;

/** A session the ticket's demand came from; ORIGIN is the order that opened the ticket. */
export const WaitTicketSessionSchema = z
  .object({
    sessionId: EntityIdSchema,
    sessionCode: z.string(),
    businessDate: IsoDateSchema,
    sessionAt: IsoDateTimeSchema.nullable(),
    origin: z.boolean(),
    quantity: z.number().int().nonnegative().safe().nullable(),
  })
  .strict();
export type WaitTicketSession = z.infer<typeof WaitTicketSessionSchema>;

/** Present only with includeLineage=true so bundles that validate the older shape keep working. */
export const WaitTicketLineageSchema = z
  .object({
    displayStatus: WaitTicketDisplayStatusSchema,
    displayDetail: WaitTicketDisplayDetailSchema,
    waitingSince: IsoDateTimeSchema,
    /** Bags granted from the ticket in results still awaiting an answer. */
    pendingDecisionQuantity: z.number().int().nonnegative().safe(),
    /** Bags of the ticket revoked from results (cancellation) or moved back to waiting. */
    revokedQuantity: z.number().int().nonnegative().safe(),
    sessions: z.array(WaitTicketSessionSchema),
    sources: z.array(WaitTicketSourceSchema),
    /** Demand from before lineage was recorded (migration 0044): needs reconciliation. */
    legacyUnsourcedQuantity: z.number().int().nonnegative().safe(),
    /** Server-computed for the current account: a cancellation can still change something. */
    canCancel: z.boolean(),
  })
  .strict();
export type WaitTicketLineage = z.infer<typeof WaitTicketLineageSchema>;

export const WaitTicketSchema = z
  .object({
    id: EntityIdSchema,
    code: z
      .string()
      .regex(/^PC-[0-9]{7}$/)
      .optional(),
    sessionId: EntityIdSchema,
    mergedOrderId: EntityIdSchema.nullable(),
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    priority: AllocationPrioritySchema,
    storeName: z.string().nullable().optional(),
    productName: z.string().nullable().optional(),
    sku: z.string().nullable().optional(),
    latestOffer: z
      .object({
        id: EntityIdSchema,
        code: z.string(),
        status: z.string(),
        sessionId: EntityIdSchema.nullable(),
        sessionCode: z.string().nullable(),
        deadline: IsoDateTimeSchema,
      })
      .strict()
      .nullable()
      .optional(),
    cancellationActor: z
      .object({
        accountId: EntityIdSchema.nullable(),
        role: AccountRoleSchema.nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    requested: PositiveInventoryAmountSchema,
    fulfilled: InventoryAmountSchema,
    remaining: InventoryAmountSchema,
    status: WaitTicketStatusSchema,
    cancellationKind: WaitTicketCancellationKindSchema.nullable().optional(),
    resolutionReason: z.string().max(1000).nullable().optional(),
    resolvedAt: IsoDateTimeSchema.nullable().optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    lineage: WaitTicketLineageSchema.optional(),
  })
  .strict()
  .superRefine((ticket, context) => {
    if (ticket.cancellationKind && ticket.status !== 'CANCELLED') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cancellationKind'],
        message: 'Only a cancelled wait ticket can record a cancellation kind',
      });
    }
    if (new Set([ticket.requested.kind, ticket.fulfilled.kind, ticket.remaining.kind]).size !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remaining', 'kind'],
        message: 'Requested, fulfilled, and remaining amounts must use the same measurement',
      });
      return;
    }
    const fulfilled = amountValue(ticket.fulfilled);
    const remaining = amountValue(ticket.remaining);
    const requested = amountValue(ticket.requested);
    if (
      fulfilled !== null &&
      remaining !== null &&
      requested !== null &&
      fulfilled + remaining !== requested
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remaining'],
        message: 'Fulfilled and remaining amounts must equal the requested amount',
      });
    }
    if (remaining !== null && ticket.status === 'FULFILLED' && remaining !== 0n) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remaining'],
        message: 'A fulfilled wait ticket cannot have a remaining amount',
      });
    }
    if (fulfilled !== null && ticket.status === 'PARTIALLY_FULFILLED' && fulfilled === 0n) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fulfilled'],
        message: 'A partially fulfilled wait ticket must have a fulfilled amount',
      });
    }
  });
export type WaitTicket = z.infer<typeof WaitTicketSchema>;

export const WaitTicketParamsSchema = z.object({ waitTicketId: EntityIdSchema }).strict();
export type WaitTicketParams = z.infer<typeof WaitTicketParamsSchema>;

/**
 * expectedFingerprint is the preview the account confirmed. When the cancellation also revokes
 * allocation goods it is required, and a changed preview is refused (409) instead of silently
 * cancelling a different scope.
 */
export const CancelWaitTicketRequestSchema = z
  .object({
    reason: AuditReasonSchema,
    expectedFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();
export type CancelWaitTicketRequest = z.infer<typeof CancelWaitTicketRequestSchema>;

export const CancelWaitTicketResponseSchema = z.object({ data: WaitTicketSchema }).strict();
export type CancelWaitTicketResponse = z.infer<typeof CancelWaitTicketResponseSchema>;

export const WaitTicketResponseSchema = z.object({ data: WaitTicketSchema }).strict();
export type WaitTicketResponse = z.infer<typeof WaitTicketResponseSchema>;

export const ListWaitTicketsQuerySchema = PaginationQuerySchema.extend({
  displayStatus: WaitTicketDisplayStatusSchema.optional(),
  includeLineage: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  sessionId: EntityIdSchema.optional(),
  storeId: EntityIdSchema.optional(),
  productId: EntityIdSchema.optional(),
  priority: AllocationPrioritySchema.optional(),
  status: WaitTicketStatusSchema.optional(),
  q: z.string().trim().max(80).optional(),
  projection: z.literal('TABLE').optional(),
  createdFrom: IsoDateSchema.optional(),
  createdTo: IsoDateSchema.optional(),
})
  .strict()
  .refine(
    (query) => !query.createdFrom || !query.createdTo || query.createdFrom <= query.createdTo,
    {
      path: ['createdTo'],
      message: 'Ngày kết thúc phải từ ngày bắt đầu trở đi',
    },
  );
export type ListWaitTicketsQuery = z.infer<typeof ListWaitTicketsQuerySchema>;

export const ListWaitTicketsResponseSchema = z
  .object({ data: z.array(WaitTicketSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListWaitTicketsResponse = z.infer<typeof ListWaitTicketsResponseSchema>;

export const PriorityOfferStatusSchema = z.enum([
  'PENDING',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
]);
export type PriorityOfferStatus = z.infer<typeof PriorityOfferStatusSchema>;

/**
 * FULL: the offer covers everything the ticket still waited for when it was created, so "Không
 * nhận" or no answer by the deadline cancels the ticket. PARTIAL: declining or missing it only
 * returns the offered quantity and the ticket keeps waiting. Legacy offers are PARTIAL.
 */
export const PriorityOfferCoverageSchema = z.enum(['FULL', 'PARTIAL']);
export type PriorityOfferCoverage = z.infer<typeof PriorityOfferCoverageSchema>;

export const PriorityOfferSchema = z
  .object({
    id: EntityIdSchema,
    code: z
      .string()
      .regex(/^PUT-[0-9]{6}$/)
      .optional(),
    waitTicketId: EntityIdSchema,
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    offered: PositiveInventoryAmountSchema,
    status: PriorityOfferStatusSchema,
    offeredAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    respondedAt: IsoDateTimeSchema.nullable(),
    accepted: InventoryAmountSchema.nullable(),
    coverage: PriorityOfferCoverageSchema.optional(),
    /** What the ticket still waited for when the offer was created; null on legacy offers. */
    waitingAtOffer: PositiveInventoryAmountSchema.nullable().optional(),
    sessionId: EntityIdSchema.nullable().optional(),
    sessionCode: z
      .string()
      .regex(/^PDH-[0-9]{6}$/)
      .nullable()
      .optional(),
    sessionKind: z.enum(['DEFAULT', 'MANUAL']).nullable().optional(),
  })
  .strict()
  .superRefine((offer, context) => {
    if (offer.waitingAtOffer && offer.waitingAtOffer.kind !== offer.offered.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['waitingAtOffer', 'kind'],
        message: 'Waiting and offered amounts must use the same measurement',
      });
    }
    if (Date.parse(offer.offeredAt) >= Date.parse(offer.expiresAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Offer expiry must be after the offer time',
      });
    }
    if (offer.status === 'ACCEPTED' && offer.accepted === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accepted'],
        message: 'An accepted offer must record its accepted amount',
      });
    }
    if (offer.status !== 'ACCEPTED' && offer.accepted !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accepted'],
        message: 'Only an accepted offer may record an accepted amount',
      });
    }
    if (offer.status === 'ACCEPTED' && offer.respondedAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['respondedAt'],
        message: 'An accepted offer must record when it was accepted',
      });
    }
    if (offer.status === 'PENDING' && offer.respondedAt !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['respondedAt'],
        message: 'A pending offer cannot have a response timestamp',
      });
    }
    if (offer.accepted !== null && offer.accepted.kind !== offer.offered.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accepted', 'kind'],
        message: 'Accepted and offered amounts must use the same measurement',
      });
    } else if (offer.accepted !== null) {
      const accepted = amountValue(offer.accepted);
      const offered = amountValue(offer.offered);
      if (
        offer.status === 'ACCEPTED' &&
        accepted !== null &&
        offered !== null &&
        accepted !== offered
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['accepted'],
          message: 'The accepted amount must equal the full offered amount',
        });
      }
    }
  });
export type PriorityOffer = z.infer<typeof PriorityOfferSchema>;

export const CreatePriorityOfferRequestSchema = z
  .object({
    waitTicketId: EntityIdSchema,
    offered: PositiveInventoryAmountSchema,
    expiresAt: IsoDateTimeSchema,
  })
  .strict();
export type CreatePriorityOfferRequest = z.infer<typeof CreatePriorityOfferRequestSchema>;

export const AcceptPriorityOfferRequestSchema = z
  .object({ action: z.literal('ACCEPT'), accepted: PositiveInventoryAmountSchema })
  .strict();
export type AcceptPriorityOfferRequest = z.infer<typeof AcceptPriorityOfferRequestSchema>;
export const DeclinePriorityOfferRequestSchema = z
  .object({ action: z.literal('DECLINE'), reason: AuditReasonSchema.optional() })
  .strict();
export type DeclinePriorityOfferRequest = z.infer<typeof DeclinePriorityOfferRequestSchema>;
export const RespondPriorityOfferRequestSchema = z.discriminatedUnion('action', [
  AcceptPriorityOfferRequestSchema,
  DeclinePriorityOfferRequestSchema,
]);
export type RespondPriorityOfferRequest = z.infer<typeof RespondPriorityOfferRequestSchema>;

export const PriorityOfferParamsSchema = z.object({ offerId: EntityIdSchema }).strict();
export type PriorityOfferParams = z.infer<typeof PriorityOfferParamsSchema>;

export const PriorityOfferResponseSchema = z.object({ data: PriorityOfferSchema }).strict();
export type PriorityOfferResponse = z.infer<typeof PriorityOfferResponseSchema>;

export const RespondPriorityOfferResponseSchema = PriorityOfferResponseSchema;
export type RespondPriorityOfferResponse = z.infer<typeof RespondPriorityOfferResponseSchema>;

export const ListPriorityOffersQuerySchema = PaginationQuerySchema.extend({
  waitTicketId: EntityIdSchema.optional(),
  storeId: EntityIdSchema.optional(),
  status: PriorityOfferStatusSchema.optional(),
}).strict();
export type ListPriorityOffersQuery = z.infer<typeof ListPriorityOffersQuerySchema>;

export const ListPriorityOffersResponseSchema = z
  .object({ data: z.array(PriorityOfferSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListPriorityOffersResponse = z.infer<typeof ListPriorityOffersResponseSchema>;

export const WaitTicketHistoryQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(100) })
  .strict();
export type WaitTicketHistoryQuery = z.infer<typeof WaitTicketHistoryQuerySchema>;

const AuditSnapshotSchema = z.record(z.string(), z.unknown());

export const WaitTicketAuditEventSchema = z
  .object({
    id: EntityIdSchema,
    requestId: z.string().trim().min(1).max(128).nullable(),
    actorAccountId: EntityIdSchema.nullable(),
    actorRole: AccountRoleSchema.nullable(),
    actorStoreId: EntityIdSchema.nullable(),
    action: z.string().trim().min(1).max(120),
    entityType: z.enum(['WAIT_TICKET', 'PRIORITY_OFFER']),
    entityId: EntityIdSchema.nullable(),
    before: AuditSnapshotSchema.nullable(),
    after: AuditSnapshotSchema.nullable(),
    metadata: AuditSnapshotSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type WaitTicketAuditEvent = z.infer<typeof WaitTicketAuditEventSchema>;

export const WaitTicketHistorySchema = z
  .object({
    ticket: WaitTicketSchema,
    offers: z.array(PriorityOfferSchema),
    audit: z.array(WaitTicketAuditEventSchema),
  })
  .strict();
export type WaitTicketHistory = z.infer<typeof WaitTicketHistorySchema>;

export const WaitTicketHistoryResponseSchema = z.object({ data: WaitTicketHistorySchema }).strict();
export type WaitTicketHistoryResponse = z.infer<typeof WaitTicketHistoryResponseSchema>;

export const WaitTicketCancelPreviewRevocableSchema = z
  .object({
    allocationDecisionId: EntityIdSchema,
    allocationLineId: EntityIdSchema,
    sessionId: EntityIdSchema,
    sessionCode: z.string(),
    productId: EntityIdSchema,
    quantity: z.number().int().positive().safe(),
    shipmentNumber: z.string().nullable(),
    /** The result is closed (CANCELLED) when nothing else of it remains. */
    closesResult: z.boolean(),
  })
  .strict();

export const WaitTicketCancelPreviewProtectedSchema = z
  .object({
    allocationDecisionId: EntityIdSchema.nullable(),
    sessionCode: z.string().nullable(),
    quantity: z.number().int().positive().safe(),
    kind: z.enum(['RESHARE_ORDER', 'SHIPPED_OR_RECEIVED', 'ACCEPTED_LEGACY']),
    reshareOrderCode: z.string().nullable(),
  })
  .strict();

export const WaitTicketCancelPreviewSchema = z
  .object({
    waitTicketId: EntityIdSchema,
    code: z.string(),
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    cancellable: z.boolean(),
    refusal: z.enum(['ALREADY_CANCELLED', 'NOTHING_CANCELLABLE']).nullable(),
    waitingQuantity: z.number().int().nonnegative().safe(),
    offers: z.array(
      z
        .object({
          offerId: EntityIdSchema,
          code: z.string(),
          status: PriorityOfferStatusSchema,
          heldQuantity: z.number().int().nonnegative().safe(),
        })
        .strict(),
    ),
    revocable: z.array(WaitTicketCancelPreviewRevocableSchema),
    protected: z.array(WaitTicketCancelPreviewProtectedSchema),
    cancelledQuantity: z.number().int().nonnegative().safe(),
    /** Server fingerprint of exactly this scope; send it back as expectedFingerprint. */
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type WaitTicketCancelPreview = z.infer<typeof WaitTicketCancelPreviewSchema>;

export const WaitTicketCancelPreviewResponseSchema = z
  .object({ data: WaitTicketCancelPreviewSchema })
  .strict();
export type WaitTicketCancelPreviewResponse = z.infer<typeof WaitTicketCancelPreviewResponseSchema>;
