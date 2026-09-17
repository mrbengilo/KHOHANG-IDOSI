import { z } from 'zod';

import { AllocationPrioritySchema } from './allocation-policy.js';
import {
  AuditReasonSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
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

export const WaitTicketSchema = z
  .object({
    id: EntityIdSchema,
    sessionId: EntityIdSchema,
    mergedOrderId: EntityIdSchema.nullable(),
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    priority: AllocationPrioritySchema,
    requested: PositiveInventoryAmountSchema,
    fulfilled: InventoryAmountSchema,
    remaining: InventoryAmountSchema,
    status: WaitTicketStatusSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((ticket, context) => {
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

export const CancelWaitTicketRequestSchema = z.object({ reason: AuditReasonSchema }).strict();
export type CancelWaitTicketRequest = z.infer<typeof CancelWaitTicketRequestSchema>;

export const CancelWaitTicketResponseSchema = z.object({ data: WaitTicketSchema }).strict();
export type CancelWaitTicketResponse = z.infer<typeof CancelWaitTicketResponseSchema>;

export const WaitTicketResponseSchema = z.object({ data: WaitTicketSchema }).strict();
export type WaitTicketResponse = z.infer<typeof WaitTicketResponseSchema>;

export const ListWaitTicketsQuerySchema = PaginationQuerySchema.extend({
  sessionId: EntityIdSchema.optional(),
  storeId: EntityIdSchema.optional(),
  productId: EntityIdSchema.optional(),
  priority: AllocationPrioritySchema.optional(),
  status: WaitTicketStatusSchema.optional(),
}).strict();
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

export const PriorityOfferSchema = z
  .object({
    id: EntityIdSchema,
    waitTicketId: EntityIdSchema,
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    offered: PositiveInventoryAmountSchema,
    status: PriorityOfferStatusSchema,
    offeredAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    respondedAt: IsoDateTimeSchema.nullable(),
    accepted: InventoryAmountSchema.nullable(),
  })
  .strict()
  .superRefine((offer, context) => {
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
