import { z } from 'zod';
import { AllocationResultSchema, ListAllocationsQuerySchema } from './allocations.js';
import { EntityIdSchema, IsoDateTimeSchema, PaginationMetaSchema } from './common.js';

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
export const ListSessionDocumentsQuerySchema = ListAllocationsQuerySchema;
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
