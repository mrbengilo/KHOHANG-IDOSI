import { z } from 'zod';

import { NewOrderPrioritySchema } from './allocation-policy.js';
import {
  AuditReasonSchema,
  EntityIdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
} from './common.js';
import { InventoryAmountSchema, PositiveInventoryAmountSchema } from './warehouse.js';

export const OrderSessionStatusSchema = z.enum([
  'SCHEDULED',
  'OPEN',
  'CLOSED',
  'ALLOCATING',
  'ALLOCATED',
  'CANCELLED',
]);
export type OrderSessionStatus = z.infer<typeof OrderSessionStatusSchema>;

export const OrderSessionSchema = z
  .object({
    id: EntityIdSchema,
    businessDate: IsoDateSchema,
    status: OrderSessionStatusSchema,
    requestOpensAt: IsoDateTimeSchema,
    requestClosesAt: IsoDateTimeSchema,
    allocationStartsAt: IsoDateTimeSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((session, context) => {
    if (Date.parse(session.requestOpensAt) >= Date.parse(session.requestClosesAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestClosesAt'],
        message: 'Request close time must be after request open time',
      });
    }
    if (Date.parse(session.requestClosesAt) > Date.parse(session.allocationStartsAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allocationStartsAt'],
        message: 'Allocation cannot start before the request window closes',
      });
    }
  });
export type OrderSession = z.infer<typeof OrderSessionSchema>;

export const OrderSessionParamsSchema = z.object({ sessionId: EntityIdSchema }).strict();
export type OrderSessionParams = z.infer<typeof OrderSessionParamsSchema>;

export const CreateOrderSessionRequestSchema = z
  .object({
    businessDate: IsoDateSchema,
    requestOpensAt: IsoDateTimeSchema,
    requestClosesAt: IsoDateTimeSchema,
    allocationStartsAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (Date.parse(request.requestOpensAt) >= Date.parse(request.requestClosesAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestClosesAt'],
        message: 'Request close time must be after request open time',
      });
    }
    if (Date.parse(request.requestClosesAt) > Date.parse(request.allocationStartsAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allocationStartsAt'],
        message: 'Allocation cannot start before the request window closes',
      });
    }
  });
export type CreateOrderSessionRequest = z.infer<typeof CreateOrderSessionRequestSchema>;

export const TransitionOrderSessionRequestSchema = z
  .object({
    status: z.enum(['OPEN', 'CLOSED', 'CANCELLED']),
    reason: AuditReasonSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.status === 'CANCELLED' && request.reason === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'A cancellation reason is required',
      });
    }
  });
export type TransitionOrderSessionRequest = z.infer<typeof TransitionOrderSessionRequestSchema>;

export const OrderSessionResponseSchema = z.object({ data: OrderSessionSchema }).strict();
export type OrderSessionResponse = z.infer<typeof OrderSessionResponseSchema>;

export const ListOrderSessionsQuerySchema = PaginationQuerySchema.extend({
  status: OrderSessionStatusSchema.optional(),
  dateFrom: IsoDateSchema.optional(),
  dateTo: IsoDateSchema.optional(),
}).strict();
export type ListOrderSessionsQuery = z.infer<typeof ListOrderSessionsQuerySchema>;

export const ListOrderSessionsResponseSchema = z
  .object({ data: z.array(OrderSessionSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListOrderSessionsResponse = z.infer<typeof ListOrderSessionsResponseSchema>;

export const StoreOrderRequestStatusSchema = z.enum(['SUBMITTED', 'MERGED', 'CANCELLED']);
export type StoreOrderRequestStatus = z.infer<typeof StoreOrderRequestStatusSchema>;

export const RequestSequenceSchema = z.union([z.literal(1), z.literal(2)]);
export type RequestSequence = z.infer<typeof RequestSequenceSchema>;

export const StoreOrderRequestLineSchema = z
  .object({
    productId: EntityIdSchema,
    requested: PositiveInventoryAmountSchema,
    priority: NewOrderPrioritySchema,
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type StoreOrderRequestLine = z.infer<typeof StoreOrderRequestLineSchema>;

const StoreOrderRequestLinesSchema = z
  .array(StoreOrderRequestLineSchema)
  .min(1)
  .max(500)
  .refine(
    (lines) => new Set(lines.map((line) => line.productId)).size === lines.length,
    'A product may appear only once in an order request',
  );

export const StoreOrderRequestSchema = z
  .object({
    id: EntityIdSchema,
    sessionId: EntityIdSchema,
    storeId: EntityIdSchema,
    requestSequence: RequestSequenceSchema,
    status: StoreOrderRequestStatusSchema,
    lines: StoreOrderRequestLinesSchema,
    submittedByAccountId: EntityIdSchema,
    submittedAt: IsoDateTimeSchema,
    cancelledAt: IsoDateTimeSchema.nullable(),
  })
  .strict();
export type StoreOrderRequest = z.infer<typeof StoreOrderRequestSchema>;

export const CreateStoreOrderRequestSchema = z
  .object({
    sessionId: EntityIdSchema,
    storeId: EntityIdSchema,
    requestSequence: RequestSequenceSchema,
    lines: StoreOrderRequestLinesSchema,
  })
  .strict();
export type CreateStoreOrderRequest = z.infer<typeof CreateStoreOrderRequestSchema>;

export const StoreOrderRequestParamsSchema = z.object({ requestId: EntityIdSchema }).strict();
export type StoreOrderRequestParams = z.infer<typeof StoreOrderRequestParamsSchema>;

export const CancelStoreOrderRequestSchema = z.object({ reason: AuditReasonSchema }).strict();
export type CancelStoreOrderRequest = z.infer<typeof CancelStoreOrderRequestSchema>;

export const StoreOrderRequestResponseSchema = z.object({ data: StoreOrderRequestSchema }).strict();
export type StoreOrderRequestResponse = z.infer<typeof StoreOrderRequestResponseSchema>;

export const ListStoreOrderRequestsQuerySchema = PaginationQuerySchema.extend({
  sessionId: EntityIdSchema.optional(),
  storeId: EntityIdSchema.optional(),
  status: StoreOrderRequestStatusSchema.optional(),
}).strict();
export type ListStoreOrderRequestsQuery = z.infer<typeof ListStoreOrderRequestsQuerySchema>;

export const ListStoreOrderRequestsResponseSchema = z
  .object({ data: z.array(StoreOrderRequestSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListStoreOrderRequestsResponse = z.infer<typeof ListStoreOrderRequestsResponseSchema>;

export const MergedOrderStatusSchema = z.enum(['READY', 'ALLOCATED', 'CANCELLED']);
export type MergedOrderStatus = z.infer<typeof MergedOrderStatusSchema>;

export const MergedOrderLineSchema = z
  .object({
    productId: EntityIdSchema,
    totalRequested: PositiveInventoryAmountSchema,
    priority: NewOrderPrioritySchema,
    sourceLineCount: z.number().int().min(1).max(2),
  })
  .strict();
export type MergedOrderLine = z.infer<typeof MergedOrderLineSchema>;

export const MergedOrderSchema = z
  .object({
    id: EntityIdSchema,
    sessionId: EntityIdSchema,
    storeId: EntityIdSchema,
    status: MergedOrderStatusSchema,
    sourceRequestIds: z
      .array(EntityIdSchema)
      .min(1)
      .max(2)
      .refine((ids) => new Set(ids).size === ids.length, 'Source request IDs must be unique'),
    lines: z.array(MergedOrderLineSchema).min(1).max(500),
    mergedAt: IsoDateTimeSchema,
  })
  .strict();
export type MergedOrder = z.infer<typeof MergedOrderSchema>;

export const MergedOrderParamsSchema = z.object({ mergedOrderId: EntityIdSchema }).strict();
export type MergedOrderParams = z.infer<typeof MergedOrderParamsSchema>;

export const MergedOrderResponseSchema = z.object({ data: MergedOrderSchema }).strict();
export type MergedOrderResponse = z.infer<typeof MergedOrderResponseSchema>;

export const ListMergedOrdersQuerySchema = PaginationQuerySchema.extend({
  sessionId: EntityIdSchema.optional(),
  storeId: EntityIdSchema.optional(),
  status: MergedOrderStatusSchema.optional(),
}).strict();
export type ListMergedOrdersQuery = z.infer<typeof ListMergedOrdersQuerySchema>;

export const ListMergedOrdersResponseSchema = z
  .object({ data: z.array(MergedOrderSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListMergedOrdersResponse = z.infer<typeof ListMergedOrdersResponseSchema>;

/** Snapshot line retained by the session for deterministic allocation. */
export const SessionInventorySnapshotLineSchema = z
  .object({
    productId: EntityIdSchema,
    available: InventoryAmountSchema,
    warehouseBalanceVersion: z.number().int().nonnegative(),
  })
  .strict();
export type SessionInventorySnapshotLine = z.infer<typeof SessionInventorySnapshotLineSchema>;

export const SessionInventorySnapshotResponseSchema = z
  .object({
    data: z
      .object({
        sessionId: EntityIdSchema,
        capturedAt: IsoDateTimeSchema,
        lines: z.array(SessionInventorySnapshotLineSchema),
      })
      .strict(),
  })
  .strict();
export type SessionInventorySnapshotResponse = z.infer<
  typeof SessionInventorySnapshotResponseSchema
>;
