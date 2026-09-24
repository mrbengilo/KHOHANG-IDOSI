import { z } from 'zod';

import {
  AuditReasonSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
} from './common.js';

/**
 * Units a store reported missing stay reserved in the warehouse until an admin confirms
 * whether they are still on the shelf or were lost in transit.
 */
export const WarehouseShortageCheckStatusSchema = z.enum(['PENDING', 'RETURNED_TO_STOCK', 'LOST']);
export type WarehouseShortageCheckStatus = z.infer<typeof WarehouseShortageCheckStatusSchema>;

export const WarehouseShortageCheckSchema = z
  .object({
    id: EntityIdSchema,
    storeReceiptId: EntityIdSchema,
    receiptNumber: z.string().min(1),
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    quantity: z.number().int().positive().safe(),
    status: WarehouseShortageCheckStatusSchema,
    shortageReason: z.string().nullable(),
    resolutionReason: z.string().nullable(),
    resolvedByAccountId: EntityIdSchema.nullable(),
    resolvedAt: IsoDateTimeSchema.nullable(),
    version: z.number().int().nonnegative(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type WarehouseShortageCheck = z.infer<typeof WarehouseShortageCheckSchema>;

export const ListWarehouseShortageChecksQuerySchema = PaginationQuerySchema.extend({
  status: WarehouseShortageCheckStatusSchema.optional(),
}).strict();
export type ListWarehouseShortageChecksQuery = z.infer<
  typeof ListWarehouseShortageChecksQuerySchema
>;

export const ListWarehouseShortageChecksResponseSchema = z
  .object({ data: z.array(WarehouseShortageCheckSchema), pagination: PaginationMetaSchema })
  .strict();

export const WarehouseShortageCheckParamsSchema = z.object({ checkId: EntityIdSchema }).strict();

export const ResolveWarehouseShortageCheckRequestSchema = z
  .object({
    decision: z.enum(['RETURNED_TO_STOCK', 'LOST']),
    reason: AuditReasonSchema,
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export type ResolveWarehouseShortageCheckRequest = z.infer<
  typeof ResolveWarehouseShortageCheckRequestSchema
>;

export const WarehouseShortageCheckResponseSchema = z
  .object({ data: WarehouseShortageCheckSchema })
  .strict();
