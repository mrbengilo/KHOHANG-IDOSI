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

/** Order status shown in history: ordered (RE committed), not ordered, cancelled. */
export const ReshareOrderHistoryStatusSchema = z.enum(['ORDERED', 'NOT_ORDERED', 'CANCELLED']);
export type ReshareOrderHistoryStatus = z.infer<typeof ReshareOrderHistoryStatusSchema>;

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
    order: z
      .object({
        id: EntityIdSchema,
        code: ReshareOrderCodeSchema,
        orderedAt: IsoDateTimeSchema,
        origin: z.enum(['ACCEPTANCE', 'BACKFILL']),
        actorName: z.string().nullable(),
        actorRole: z.enum(['STORE', 'WHOLESALE', 'HTKD', 'ADMIN']),
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
