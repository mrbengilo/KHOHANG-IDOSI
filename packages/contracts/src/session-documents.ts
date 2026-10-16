import { z } from 'zod';
import {
  AllocationDecisionSchema,
  AllocationDecisionStatusSchema,
} from './allocation-decisions.js';
import { AllocationPrioritySchema } from './allocation-policy.js';
import { AllocationResultSchema, AllocationResultStatusSchema } from './allocations.js';
import {
  EntityIdSchema,
  IsoDateTimeSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
} from './common.js';

export const SessionDocumentSourceSchema = z
  .object({
    result: AllocationResultSchema,
    orderRequestId: EntityIdSchema.nullable(),
    orderRequestCode: z.string().nullable(),
    orderRequestItemId: EntityIdSchema.nullable(),
    submittedAt: IsoDateTimeSchema.nullable(),
    waitTicketId: EntityIdSchema.nullable(),
    priorityOfferId: EntityIdSchema.nullable(),
  })
  .strict();
const SessionWaitDocumentSnapshotSchema = z
  .object({
    id: EntityIdSchema,
    code: z.string(),
    /** Open bags per product at that moment: still waiting / granted awaiting the answer. */
    lines: z.array(
      z
        .object({
          productId: EntityIdSchema,
          quantity: z.number().int().positive().safe(),
          remainingQuantity: z.number().int().nonnegative().safe(),
          pendingQuantity: z.number().int().nonnegative().safe(),
        })
        .strict(),
    ),
  })
  .strict();
export type SessionWaitDocumentSnapshot = z.infer<typeof SessionWaitDocumentSnapshotSchema>;

/**
 * The store's wait document (PCT) just before and right after the document's allocation run.
 * `changed` is false when the run left the store's open demand unchanged (both are the same
 * document). Both are null when the store had no open demand, or for runs older than 0045.
 */
export const SessionWaitDocumentsSchema = z
  .object({
    before: SessionWaitDocumentSnapshotSchema.nullable(),
    after: SessionWaitDocumentSnapshotSchema.nullable(),
    changed: z.boolean(),
  })
  .strict();
export type SessionWaitDocuments = z.infer<typeof SessionWaitDocumentsSchema>;

export const SessionDocumentSchema = z
  .object({
    id: z.string().min(1),
    orderCode: z.string().min(1),
    resultCode: z.string().min(1),
    sessionId: EntityIdSchema,
    storeId: EntityIdSchema,
    allocationRunId: EntityIdSchema,
    version: z.number().int().positive(),
    createdAt: IsoDateTimeSchema,
    hasPrioritySource: z.boolean(),
    carriedAllocations: z.array(
      z
        .object({
          allocationLineId: EntityIdSchema,
          allocationRunId: EntityIdSchema,
          productId: EntityIdSchema,
          quantity: z.number().int().positive(),
          waitTicketId: EntityIdSchema.nullable(),
        })
        .strict(),
    ),
    sources: z.array(SessionDocumentSourceSchema),
    /**
     * The store's decision and shipping progress of this result. Present only when the client
     * asked for it (includeDecision=true), so bundles that validate the older shape keep working.
     */
    decision: AllocationDecisionSchema.nullable().optional(),
    /** Present only with includeWaitDocuments=true, so older bundles keep their shape. */
    waitDocuments: SessionWaitDocumentsSchema.nullable().optional(),
    lines: z.array(
      z
        .object({
          productId: EntityIdSchema,
          requestedQuantity: z.number().int().nonnegative().safe(),
          allocatedQuantity: z.number().int().nonnegative().safe(),
          waitlistedQuantity: z.number().int().nonnegative().safe(),
        })
        .strict(),
    ),
  })
  .strict();
export type SessionDocument = z.infer<typeof SessionDocumentSchema>;
export type SessionDocumentSource = z.infer<typeof SessionDocumentSourceSchema>;
export const ListSessionDocumentsQuerySchema = PaginationQuerySchema.extend({
  sessionId: EntityIdSchema.optional(),
  storeId: EntityIdSchema.optional(),
  productId: EntityIdSchema.optional(),
  status: AllocationResultStatusSchema.optional(),
  priority: AllocationPrioritySchema.optional(),
  decisionStatus: AllocationDecisionStatusSchema.optional(),
  includeDecision: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  /** Opt-in: attach the store wait documents before and after each document's run. */
  includeWaitDocuments: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  /** Opt-in for WAITLISTED/CANCELLED decision statuses (older bundles read them as REJECTED). */
  includeWaitlist: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
})
  .strict()
  .superRefine((query, context) => {
    if (!Number.isSafeInteger((query.page - 1) * query.pageSize)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['page'],
        message: 'Pagination offset exceeds the safe integer range',
      });
    }
  });
export type ListSessionDocumentsQuery = z.infer<typeof ListSessionDocumentsQuerySchema>;
export const ListSessionDocumentsResponseSchema = z
  .object({
    data: z.array(SessionDocumentSchema),
    pagination: PaginationMetaSchema,
  })
  .strict();

/** Aggregate only the complete persisted sources of a selected document, never a line page. */
export function sessionDocument(
  input: Omit<SessionDocument, 'lines' | 'hasPrioritySource'>,
): SessionDocument {
  const lines = new Map<string, SessionDocument['lines'][number]>();
  for (const { result } of input.sources) {
    const line = lines.get(result.productId) ?? {
      productId: result.productId,
      requestedQuantity: 0,
      allocatedQuantity: 0,
      waitlistedQuantity: 0,
    };
    line.requestedQuantity += result.requestedQuantity;
    line.allocatedQuantity += result.allocatedQuantity;
    line.waitlistedQuantity += result.waitlistedQuantity;
    lines.set(line.productId, line);
  }
  return SessionDocumentSchema.parse({
    ...input,
    hasPrioritySource:
      input.sources.some((source) => source.waitTicketId !== null) ||
      input.carriedAllocations.some((source) => source.waitTicketId !== null),
    lines: [...lines.values()].sort((a, b) => a.productId.localeCompare(b.productId)),
  });
}
