import { z } from 'zod';

import {
  EntityIdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
  PositiveUnitQuantitySchema,
  UnitQuantitySchema,
} from './common.js';

/**
 * Internal Reshare orders (RE-000001…): created by IDOSI when a store, the wholesale desk or an
 * assigned HTKD accepts an allocation result with new goods. Creating one issues those goods out
 * of the central warehouse. It is an IDOSI document copied onto Reshare by hand; it is never a
 * Reshare-side event. See docs/reshare-auto-orders.md.
 */

export const RESHARE_ORDER_CODE_REGEX = /^RE-\d{6}$/u;
export const ReshareOrderCodeSchema = z.string().regex(RESHARE_ORDER_CODE_REGEX);

/** Persisted Admin acknowledgement when set; otherwise the existing RE-derived default. */
export const ReshareOrderHistoryStatusSchema = z.enum(['ORDERED', 'NOT_ORDERED', 'CANCELLED']);
export type ReshareOrderHistoryStatus = z.infer<typeof ReshareOrderHistoryStatusSchema>;

export const UpdateReshareOrderStatusRequestSchema = z
  .object({
    status: z.enum(['ORDERED', 'NOT_ORDERED']),
    expectedStatus: z.enum(['ORDERED', 'NOT_ORDERED']),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export type UpdateReshareOrderStatusRequest = z.infer<typeof UpdateReshareOrderStatusRequestSchema>;

export const ReshareActorRoleSchema = z.enum(['STORE', 'WHOLESALE', 'HTKD', 'ADMIN']);
export type ReshareActorRole = z.infer<typeof ReshareActorRoleSchema>;

export const ReshareStatusControlSchema = z
  .object({
    version: z.number().int().nonnegative(),
    updatedAt: IsoDateTimeSchema.nullable(),
    updatedByName: z.string().nullable(),
    /** Only with includeStatusActor=true (older bundles validate the shape without it). */
    updatedByRole: ReshareActorRoleSchema.nullable().optional(),
  })
  .strict();

export const UpdateReshareOrderStatusResponseSchema = z
  .object({
    data: z
      .object({
        decisionId: EntityIdSchema,
        status: z.enum(['ORDERED', 'NOT_ORDERED']),
        version: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type ReshareOrderStatusUpdate = z.infer<
  typeof UpdateReshareOrderStatusResponseSchema
>['data'];

export const ReshareOrderSummarySchema = z
  .object({
    id: EntityIdSchema,
    code: ReshareOrderCodeSchema,
    status: z.enum(['ORDERED', 'CANCELLED']),
    orderedAt: IsoDateTimeSchema,
    totalQuantity: PositiveUnitQuantitySchema,
  })
  .strict();
export type ReshareOrderSummary = z.infer<typeof ReshareOrderSummarySchema>;

export const ReshareOrderHistoryLineSchema = z
  .object({
    productId: EntityIdSchema,
    productName: z.string(),
    productSku: z.string(),
    quantity: PositiveUnitQuantitySchema,
  })
  .strict();

export const ReshareOrderHistoryRowSchema = z
  .object({
    decisionId: EntityIdSchema,
    decisionStatus: z.enum(['PENDING', 'ACCEPTED']),
    sessionId: EntityIdSchema,
    sessionCode: z.string(),
    businessDate: IsoDateSchema,
    runVersion: z.number().int().positive(),
    sessionOpenedAt: IsoDateTimeSchema.nullable(),
    allocationCompletedAt: IsoDateTimeSchema.nullable(),
    publishedAt: IsoDateTimeSchema,
    acceptedAt: IsoDateTimeSchema.nullable(),
    acceptedByName: z.string().nullable(),
    storeId: EntityIdSchema,
    storeName: z.string(),
    status: ReshareOrderHistoryStatusSchema,
    statusControl: ReshareStatusControlSchema.optional(),
    order: z
      .object({
        id: EntityIdSchema,
        code: ReshareOrderCodeSchema,
        orderedAt: IsoDateTimeSchema,
        origin: z.enum(['ACCEPTANCE', 'BACKFILL']),
        actorName: z.string().nullable(),
        actorRole: ReshareActorRoleSchema,
        cancelledAt: IsoDateTimeSchema.nullable(),
        cancelReason: z.string().nullable(),
      })
      .strict()
      .nullable(),
    lines: z.array(ReshareOrderHistoryLineSchema),
    /** Bags of the whole order, once (never multiplied by its lines). */
    totalQuantity: UnitQuantitySchema,
    /** Warehouse and delivery facts of the issued goods, kept apart from the order status. */
    delivery: z
      .object({
        issuedQuantity: UnitQuantitySchema,
        receivedQuantity: UnitQuantitySchema,
        shortageQuantity: UnitQuantitySchema,
        awaitingReceiptQuantity: UnitQuantitySchema,
        onShipmentQuantity: UnitQuantitySchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ReshareOrderHistoryRow = z.infer<typeof ReshareOrderHistoryRowSchema>;

export const ListReshareOrdersQuerySchema = PaginationQuerySchema.extend({
  includeStatusControl: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  /** Adds statusControl.updatedByRole (requires includeStatusControl). */
  includeStatusActor: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  sessionId: EntityIdSchema.optional(),
  storeId: EntityIdSchema.optional(),
  productId: EntityIdSchema.optional(),
  status: ReshareOrderHistoryStatusSchema.optional(),
  /** Inclusive lower bound on the order time (or publication time when not ordered). */
  from: IsoDateTimeSchema.optional(),
  /** Exclusive upper bound. */
  to: IsoDateTimeSchema.optional(),
  code: z
    .string()
    .trim()
    .max(20)
    .transform((value) => value.toUpperCase())
    .optional(),
  decisionId: EntityIdSchema.optional(),
})
  .strict()
  .superRefine((query, context) => {
    if (query.from && query.to && Date.parse(query.from) >= Date.parse(query.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'Thời điểm kết thúc phải sau thời điểm bắt đầu',
      });
    }
  });
export type ListReshareOrdersQuery = z.infer<typeof ListReshareOrdersQuerySchema>;

export const ListReshareOrdersResponseSchema = z
  .object({
    data: z.array(ReshareOrderHistoryRowSchema),
    pagination: PaginationMetaSchema,
    /** True when the caller only sees the stores in its scope. */
    scoped: z.boolean(),
  })
  .strict();
export type ListReshareOrdersResponse = z.infer<typeof ListReshareOrdersResponseSchema>;

/**
 * Per-result status history ("Lịch sử thay đổi"): RE creation and every Admin/HTKD
 * acknowledgement change, from immutable audit rows. Legacy events may lack the status
 * snapshots or the actor name recorded at that time; they are returned as null, never guessed.
 */
export const ReshareStatusHistoryQuerySchema = PaginationQuerySchema.strict();
export type ReshareStatusHistoryQuery = z.infer<typeof ReshareStatusHistoryQuerySchema>;

export const ReshareStatusHistoryEventSchema = z
  .object({
    id: EntityIdSchema,
    occurredAt: IsoDateTimeSchema,
    kind: z.enum(['CREATED', 'STATUS_CHANGED']),
    source: z.enum(['ACCEPTANCE', 'BACKFILL', 'MANUAL']),
    statusBefore: ReshareOrderHistoryStatusSchema.nullable(),
    statusAfter: ReshareOrderHistoryStatusSchema.nullable(),
    version: z.number().int().nonnegative().nullable(),
    orderCode: ReshareOrderCodeSchema.nullable(),
    actor: z
      .object({
        accountId: EntityIdSchema.nullable(),
        role: ReshareActorRoleSchema.nullable(),
        /** Name recorded with the event; null for events stored before name snapshots. */
        nameAtEvent: z.string().nullable(),
        /** Current account name, only sent when nameAtEvent is missing. */
        currentName: z.string().nullable(),
      })
      .strict(),
    requestId: z.string().nullable(),
  })
  .strict();
export type ReshareStatusHistoryEvent = z.infer<typeof ReshareStatusHistoryEventSchema>;

export const ReshareStatusHistoryResponseSchema = z
  .object({
    data: z.array(ReshareStatusHistoryEventSchema),
    pagination: PaginationMetaSchema,
    decision: z
      .object({
        id: EntityIdSchema,
        storeId: EntityIdSchema,
        publishedAt: IsoDateTimeSchema,
      })
      .strict(),
  })
  .strict();
export type ReshareStatusHistoryResponse = z.infer<typeof ReshareStatusHistoryResponseSchema>;

/** Store filter of the Reshare module: every store for Admin/HTKD, own stores otherwise. */
export const ReshareStoreOptionSchema = z
  .object({
    id: EntityIdSchema,
    code: z.string(),
    name: z.string(),
    isActive: z.boolean(),
  })
  .strict();
export type ReshareStoreOption = z.infer<typeof ReshareStoreOptionSchema>;

export const ListReshareStoresResponseSchema = z
  .object({ data: z.array(ReshareStoreOptionSchema), scoped: z.boolean() })
  .strict();
export type ListReshareStoresResponse = z.infer<typeof ListReshareStoresResponseSchema>;
