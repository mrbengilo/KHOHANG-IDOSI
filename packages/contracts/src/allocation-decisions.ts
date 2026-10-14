import { z } from 'zod';

import { AllocationPrioritySchema } from './allocation-policy.js';
import {
  EntityIdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
} from './common.js';
import { WarehouseOutboundRequestStatusSchema } from './outbound.js';
import { ReceiptStatusSchema } from './receipts.js';
import { ReshareOrderSummarySchema } from './reshare-orders.js';

/**
 * A store's answer to one published allocation result (one run for one store). Independent of
 * the allocation algorithm status and of shipping/receipt progress. WAITLISTED and CANCELLED are
 * returned only to clients that ask with includeWaitlist=true; older bundles read them as
 * REJECTED (final, goods back in the warehouse), the closest status they know.
 */
export const AllocationDecisionStatusSchema = z.enum([
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'WAITLISTED',
  'CANCELLED',
  'NOT_REQUIRED',
  'LEGACY',
]);
export type AllocationDecisionStatus = z.infer<typeof AllocationDecisionStatusSchema>;

/** "Xác nhận phân bổ" (ACCEPT) and "Chuyển phiếu chờ" (WAITLIST). */
export const AllocationDecisionActionSchema = z.enum(['ACCEPT', 'WAITLIST']);
export type AllocationDecisionAction = z.infer<typeof AllocationDecisionActionSchema>;

/**
 * REJECT ("Từ chối") was retired by migration 0044: it dropped the demand. It is still parsed so
 * an older bundle gets a structured 409 ALLOCATION_DECISION_ACTION_RETIRED instead of a 400.
 */
export const RespondAllocationDecisionActionSchema = z.enum(['ACCEPT', 'WAITLIST', 'REJECT']);
export type RespondAllocationDecisionAction = z.infer<typeof RespondAllocationDecisionActionSchema>;

export const ReservationStatusSchema = z.enum([
  'ACTIVE',
  'CONSUMED',
  'RELEASED',
  'EXPIRED',
  'CANCELLED',
  /** Issued with an RE order: out of the central warehouse, still owed to the store. */
  'ISSUED',
]);
export type ReservationStatus = z.infer<typeof ReservationStatusSchema>;

const QuantitySchema = z.number().int().nonnegative().safe();

export const AllocationDecisionLineSchema = z
  .object({
    productId: EntityIdSchema,
    requestedQuantity: QuantitySchema,
    allocatedQuantity: QuantitySchema,
    waitlistedQuantity: QuantitySchema,
  })
  .strict();
export type AllocationDecisionLine = z.infer<typeof AllocationDecisionLineSchema>;

/** Goods of an earlier result that ride (or rode) this result's shipment, with provenance. */
export const AllocationDecisionCarriedSchema = z
  .object({
    reservationId: EntityIdSchema,
    allocationLineId: EntityIdSchema,
    allocationRunId: EntityIdSchema,
    sessionId: EntityIdSchema,
    productId: EntityIdSchema,
    quantity: z.number().int().positive().safe(),
    reservationStatus: ReservationStatusSchema,
    waitTicketId: EntityIdSchema.nullable(),
    sourceDecisionStatus: AllocationDecisionStatusSchema.nullable(),
  })
  .strict();
export type AllocationDecisionCarried = z.infer<typeof AllocationDecisionCarriedSchema>;

export const AllocationDecisionShipmentSchema = z
  .object({
    outboundRequestId: EntityIdSchema,
    requestNumber: z.string().min(1),
    status: WarehouseOutboundRequestStatusSchema,
    dispatchedAt: IsoDateTimeSchema.nullable(),
    receiptId: EntityIdSchema.nullable(),
    receiptNumber: z.string().min(1).nullable(),
    receiptStatus: ReceiptStatusSchema.nullable(),
  })
  .strict();
export type AllocationDecisionShipment = z.infer<typeof AllocationDecisionShipmentSchema>;

/** Per product: the immutable grant snapshot and what is still answerable. */
export const AllocationDecisionActionableLineSchema = z
  .object({
    productId: EntityIdSchema,
    grantedQuantity: QuantitySchema,
    revokedQuantity: QuantitySchema,
    actionableQuantity: QuantitySchema,
  })
  .strict();
export type AllocationDecisionActionableLine = z.infer<
  typeof AllocationDecisionActionableLineSchema
>;

/** A granted source taken out of the result: by a wait-ticket cancellation or by the move. */
export const AllocationDecisionRevocationSchema = z
  .object({
    allocationLineId: EntityIdSchema,
    productId: EntityIdSchema,
    quantity: z.number().int().positive().safe(),
    kind: z.enum(['WAIT_TICKET_CANCELLED', 'WAITLISTED']),
    waitTicketId: EntityIdSchema.nullable(),
    waitTicketCode: z.string().nullable(),
    actorName: z.string().nullable(),
    actorRole: z.enum(['STORE', 'WHOLESALE', 'HTKD', 'ADMIN']).nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type AllocationDecisionRevocation = z.infer<typeof AllocationDecisionRevocationSchema>;

/** Wait tickets that received the bags of a waitlisted result (created or merged into). */
export const AllocationDecisionRequeueSchema = z
  .object({
    waitTicketId: EntityIdSchema,
    waitTicketCode: z.string(),
    productId: EntityIdSchema,
    quantity: z.number().int().positive().safe(),
    mode: z.enum(['RESTORE_SOURCE', 'ADD_DEMAND']),
    createdTicket: z.boolean(),
  })
  .strict();
export type AllocationDecisionRequeue = z.infer<typeof AllocationDecisionRequeueSchema>;

export const AllocationDecisionSchema = z
  .object({
    id: EntityIdSchema,
    allocationRunId: EntityIdSchema,
    /** Algorithm run number of the result; never the command version below. */
    runVersion: z.number().int().positive(),
    sessionId: EntityIdSchema,
    sessionCode: z.string().min(1),
    businessDate: IsoDateSchema,
    storeId: EntityIdSchema,
    status: AllocationDecisionStatusSchema,
    /** Command version for expectedVersion; increments with the store's answer. */
    version: z.number().int().positive(),
    grantedQuantity: QuantitySchema,
    origin: z.enum(['ALLOCATION_RUN', 'LEGACY_BACKFILL']),
    /** Server-computed: the current account may answer this result now (any action). */
    canRespond: z.boolean(),
    /**
     * Server-computed actions the current account may take (an assigned HTKD may only accept).
     * Present only when requested with includeReshare=true, so older bundles keep parsing.
     */
    allowedActions: z.array(AllocationDecisionActionSchema).optional(),
    /** Only with includeWaitlist=true: granted minus revoked bags, still answerable or confirmed. */
    actionableQuantity: QuantitySchema.optional(),
    revokedQuantity: QuantitySchema.optional(),
    actionableLines: z.array(AllocationDecisionActionableLineSchema).optional(),
    revocations: z.array(AllocationDecisionRevocationSchema).optional(),
    requeued: z.array(AllocationDecisionRequeueSchema).optional(),
    /** The RE order created by the acceptance (null when none); only with includeReshare=true. */
    reshareOrder: ReshareOrderSummarySchema.nullable().optional(),
    respondedAt: IsoDateTimeSchema.nullable(),
    respondedByAccountId: EntityIdSchema.nullable(),
    respondedByName: z.string().nullable(),
    reason: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    lines: z.array(AllocationDecisionLineSchema),
    carried: z.array(AllocationDecisionCarriedSchema),
    heldQuantity: QuantitySchema,
    releasedQuantity: QuantitySchema,
    shipment: AllocationDecisionShipmentSchema.nullable(),
  })
  .strict();
export type AllocationDecision = z.infer<typeof AllocationDecisionSchema>;

export const AllocationDecisionSourceSchema = z
  .object({
    allocationLineId: EntityIdSchema,
    productId: EntityIdSchema,
    priority: AllocationPrioritySchema,
    requestedQuantity: QuantitySchema,
    allocatedQuantity: QuantitySchema,
    waitlistedQuantity: QuantitySchema,
    orderRequestId: EntityIdSchema.nullable(),
    orderRequestCode: z.string().nullable(),
    waitTicketId: EntityIdSchema.nullable(),
    priorityOfferId: EntityIdSchema.nullable(),
  })
  .strict();
export type AllocationDecisionSource = z.infer<typeof AllocationDecisionSourceSchema>;

export const AllocationDecisionDetailSchema = AllocationDecisionSchema.extend({
  sources: z.array(AllocationDecisionSourceSchema),
}).strict();
export type AllocationDecisionDetail = z.infer<typeof AllocationDecisionDetailSchema>;

export const ListAllocationDecisionsQuerySchema = PaginationQuerySchema.extend({
  status: AllocationDecisionStatusSchema.optional(),
  storeId: EntityIdSchema.optional(),
  sessionId: EntityIdSchema.optional(),
  outboundRequestId: EntityIdSchema.optional(),
  includeReshare: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  /** Opt-in for WAITLISTED/CANCELLED, WAITLIST actions and revocation details (0044). */
  includeWaitlist: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
}).strict();
export type ListAllocationDecisionsQuery = z.infer<typeof ListAllocationDecisionsQuerySchema>;

export const ListAllocationDecisionsResponseSchema = z
  .object({ data: z.array(AllocationDecisionSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListAllocationDecisionsResponse = z.infer<typeof ListAllocationDecisionsResponseSchema>;

export const AllocationDecisionParamsSchema = z.object({ decisionId: EntityIdSchema }).strict();

/** Opt-in for the RE fields on the detail and respond endpoints. */
export const AllocationDecisionViewQuerySchema = z
  .object({
    includeReshare: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    includeWaitlist: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict();
export type AllocationDecisionViewQuery = z.infer<typeof AllocationDecisionViewQuerySchema>;
export type AllocationDecisionParams = z.infer<typeof AllocationDecisionParamsSchema>;

export const AllocationDecisionResponseSchema = z
  .object({ data: AllocationDecisionDetailSchema })
  .strict();
export type AllocationDecisionResponse = z.infer<typeof AllocationDecisionResponseSchema>;

/**
 * The client names only the action and the version it saw. Quantities, store and sources are
 * never taken from the request: the server answers for exactly the published result.
 */
export const RespondAllocationDecisionRequestSchema = z
  .object({
    action: RespondAllocationDecisionActionSchema,
    expectedVersion: z.number().int().positive().safe(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.action !== 'REJECT' && input.reason !== undefined && input.reason.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'Only the retired rejection could carry a reason',
      });
    }
  });
export type RespondAllocationDecisionRequest = z.infer<
  typeof RespondAllocationDecisionRequestSchema
>;

export const RespondAllocationDecisionResponseSchema = AllocationDecisionResponseSchema;
export type RespondAllocationDecisionResponse = AllocationDecisionResponse;
