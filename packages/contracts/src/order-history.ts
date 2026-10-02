import { z } from 'zod';

import {
  EntityIdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
  PositiveUnitQuantitySchema,
} from './common.js';
import {
  OrderSessionKindSchema,
  OrderSessionStatusSchema,
  RequestSequenceSchema,
  StoreOrderRequestStatusSchema,
} from './orders.js';

/**
 * Every original order request a store submitted, as it was submitted. Quantities are the
 * requested ones; allocation results live in the session documents and are only linked.
 */
export const OrderHistoryStatusSchema = z.enum([
  'SUBMITTED',
  'MERGED',
  'ALLOCATED',
  'PARTIALLY_ALLOCATED',
  'WAITLISTED',
  'CANCELLED',
]);
export type OrderHistoryStatus = z.infer<typeof OrderHistoryStatusSchema>;

export const ProductUnitSchema = z.enum(['ITEM', 'BAG', 'KILOGRAM']);
export type ProductUnit = z.infer<typeof ProductUnitSchema>;

export const ListOrderHistoryQuerySchema = PaginationQuerySchema.extend({
  storeId: EntityIdSchema.optional(),
  sessionId: EntityIdSchema.optional(),
  /** SUBMITTED: waiting for allocation; MERGED: merged into a session document; CANCELLED. */
  status: StoreOrderRequestStatusSchema.optional(),
  productId: EntityIdSchema.optional(),
  /** Inclusive submission dates in Asia/Ho_Chi_Minh, independent of the session business date. */
  submittedFrom: IsoDateSchema.optional(),
  submittedTo: IsoDateSchema.optional(),
  /** Request code, e.g. PDT-000123. */
  code: z.string().trim().min(1).max(20).optional(),
})
  .strict()
  .superRefine((query, context) => {
    if (query.submittedFrom && query.submittedTo && query.submittedFrom > query.submittedTo) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['submittedTo'],
        message: 'submittedTo must not precede submittedFrom',
      });
    }
  });
export type ListOrderHistoryQuery = z.infer<typeof ListOrderHistoryQuerySchema>;

export const OrderHistorySessionSchema = z
  .object({
    id: EntityIdSchema,
    code: z.string().min(1),
    kind: OrderSessionKindSchema,
    businessDate: IsoDateSchema,
    status: OrderSessionStatusSchema,
    requestOpensAt: IsoDateTimeSchema,
    requestClosesAt: IsoDateTimeSchema,
    allocationStartsAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();
export type OrderHistorySession = z.infer<typeof OrderHistorySessionSchema>;

export const OrderHistoryLineSchema = z
  .object({
    id: EntityIdSchema,
    productId: EntityIdSchema,
    sku: z.string().min(1),
    productName: z.string().min(1),
    unit: ProductUnitSchema,
    requestedQuantity: PositiveUnitQuantitySchema,
    /** True when the line matches the product filter; the whole request is always returned. */
    matchesFilter: z.boolean(),
  })
  .strict();
export type OrderHistoryLine = z.infer<typeof OrderHistoryLineSchema>;

export const OrderHistoryEntrySchema = z
  .object({
    id: EntityIdSchema,
    code: z.string().min(1),
    requestSequence: RequestSequenceSchema,
    status: OrderHistoryStatusSchema,
    storeId: EntityIdSchema,
    storeCode: z.string().min(1),
    storeName: z.string().min(1),
    session: OrderHistorySessionSchema,
    submittedAt: IsoDateTimeSchema,
    submittedBy: z
      .object({ accountId: EntityIdSchema, displayName: z.string().min(1) })
      .strict()
      .nullable(),
    cancelledAt: IsoDateTimeSchema.nullable(),
    cancellationReason: z.string().nullable(),
    /** The session document (same session, same store) the request was merged into. */
    mergedDocument: z
      .object({
        sessionId: EntityIdSchema,
        storeId: EntityIdSchema,
        mergedOrderId: EntityIdSchema,
        version: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    lines: z.array(OrderHistoryLineSchema).min(1),
  })
  .strict();
export type OrderHistoryEntry = z.infer<typeof OrderHistoryEntrySchema>;

export const ListOrderHistoryResponseSchema = z
  .object({ data: z.array(OrderHistoryEntrySchema), pagination: PaginationMetaSchema })
  .strict();
export type ListOrderHistoryResponse = z.infer<typeof ListOrderHistoryResponseSchema>;
