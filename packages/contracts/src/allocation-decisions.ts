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

/**
 * A store's answer to one published allocation result (one run for one store). Independent of
 * the allocation algorithm status and of shipping/receipt progress.
 */
export const AllocationDecisionStatusSchema = z.enum([
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'NOT_REQUIRED',
  'LEGACY',
]);
export type AllocationDecisionStatus = z.infer<typeof AllocationDecisionStatusSchema>;

export const AllocationDecisionActionSchema = z.enum(['ACCEPT', 'REJECT']);
export type AllocationDecisionAction = z.infer<typeof AllocationDecisionActionSchema>;

export const ReservationStatusSchema = z.enum([
  'ACTIVE',
  'CONSUMED',
  'RELEASED',
  'EXPIRED',
  'CANCELLED',
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
    /** Server-computed: the current account may answer this result now. */
    canRespond: z.boolean(),
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
}).strict();
export type ListAllocationDecisionsQuery = z.infer<typeof ListAllocationDecisionsQuerySchema>;

export const ListAllocationDecisionsResponseSchema = z
  .object({ data: z.array(AllocationDecisionSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListAllocationDecisionsResponse = z.infer<typeof ListAllocationDecisionsResponseSchema>;

export const AllocationDecisionParamsSchema = z.object({ decisionId: EntityIdSchema }).strict();
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
    action: AllocationDecisionActionSchema,
    expectedVersion: z.number().int().positive().safe(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.action === 'ACCEPT' && input.reason !== undefined && input.reason.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'Only a rejection can carry a reason',
      });
    }
  });
export type RespondAllocationDecisionRequest = z.infer<
  typeof RespondAllocationDecisionRequestSchema
>;

export const RespondAllocationDecisionResponseSchema = AllocationDecisionResponseSchema;
export type RespondAllocationDecisionResponse = AllocationDecisionResponse;
