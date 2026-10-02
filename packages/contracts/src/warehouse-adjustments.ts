import { z } from 'zod';

import {
  AuditReasonSchema,
  EntityIdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
  PositiveUnitQuantitySchema,
  UnitQuantitySchema,
} from './common.js';
import {
  WarehouseAdjustmentDirectionSchema,
  WarehouseAdjustmentReasonSchema,
} from './warehouse.js';

/** Largest single correction of central-warehouse bags; anything larger is a data-entry error. */
export const MAX_WAREHOUSE_ADJUSTMENT_BAGS = 100_000;

/**
 * One product per command: the central warehouse counts whole bags, and each balance row has its
 * own optimistic version. The multi-line `CreateWarehouseAdjustmentRequestSchema` (kg or units)
 * describes a different, weight-based document and is not used for central stock.
 */
export const CreateWarehouseStockAdjustmentRequestSchema = z
  .object({
    productId: EntityIdSchema,
    direction: WarehouseAdjustmentDirectionSchema,
    quantity: PositiveUnitQuantitySchema.max(MAX_WAREHOUSE_ADJUSTMENT_BAGS),
    reasonCode: WarehouseAdjustmentReasonSchema,
    reason: AuditReasonSchema,
    /** Balance version the Admin looked at; a newer balance is a conflict, never overwritten. */
    expectedVersion: z.number().int().nonnegative().safe(),
    /** Earlier adjustment this one corrects. The earlier document itself never changes. */
    compensatesAdjustmentId: EntityIdSchema.optional(),
  })
  .strict();
export type CreateWarehouseStockAdjustmentRequest = z.infer<
  typeof CreateWarehouseStockAdjustmentRequestSchema
>;

export const WarehouseStockPositionSchema = z
  .object({
    onHand: UnitQuantitySchema,
    reserved: UnitQuantitySchema,
    available: UnitQuantitySchema,
  })
  .strict();
export type WarehouseStockPosition = z.infer<typeof WarehouseStockPositionSchema>;

export const WarehouseStockAdjustmentSchema = z
  .object({
    id: EntityIdSchema,
    code: z.string().regex(/^DCK-[0-9]{6}$/u),
    productId: EntityIdSchema,
    sku: z.string().min(1),
    productName: z.string().min(1),
    direction: WarehouseAdjustmentDirectionSchema,
    quantity: PositiveUnitQuantitySchema,
    /** Signed change of on-hand bags: positive for INCREASE, negative for DECREASE. */
    delta: z.number().int().safe(),
    reasonCode: WarehouseAdjustmentReasonSchema,
    reason: AuditReasonSchema,
    before: WarehouseStockPositionSchema,
    after: WarehouseStockPositionSchema,
    balanceVersionBefore: z.number().int().nonnegative(),
    balanceVersionAfter: z.number().int().positive(),
    ledgerEntryId: EntityIdSchema,
    compensatesAdjustmentId: EntityIdSchema.nullable(),
    createdBy: z.object({ accountId: EntityIdSchema, displayName: z.string().min(1) }).strict(),
    requestId: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type WarehouseStockAdjustment = z.infer<typeof WarehouseStockAdjustmentSchema>;

export const WarehouseStockAdjustmentResponseSchema = z
  .object({ data: WarehouseStockAdjustmentSchema })
  .strict();

export const WarehouseStockAdjustmentParamsSchema = z
  .object({ adjustmentId: EntityIdSchema })
  .strict();

export const ListWarehouseStockAdjustmentsQuerySchema = PaginationQuerySchema.extend({
  productId: EntityIdSchema.optional(),
  createdByAccountId: EntityIdSchema.optional(),
  direction: WarehouseAdjustmentDirectionSchema.optional(),
  /** Inclusive dates in Asia/Ho_Chi_Minh. */
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
})
  .strict()
  .superRefine((query, context) => {
    if (query.from && query.to && query.from > query.to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'to must not precede from',
      });
    }
  });
export type ListWarehouseStockAdjustmentsQuery = z.infer<
  typeof ListWarehouseStockAdjustmentsQuerySchema
>;

export const ListWarehouseStockAdjustmentsResponseSchema = z
  .object({ data: z.array(WarehouseStockAdjustmentSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListWarehouseStockAdjustmentsResponse = z.infer<
  typeof ListWarehouseStockAdjustmentsResponseSchema
>;

/** Pure preview shown before confirmation; the server recomputes it under the balance lock. */
export function previewWarehouseStockAdjustment(
  current: WarehouseStockPosition,
  direction: z.infer<typeof WarehouseAdjustmentDirectionSchema>,
  quantity: number,
):
  | { readonly ok: true; readonly delta: number; readonly after: WarehouseStockPosition }
  | { readonly ok: false; readonly reason: 'INVALID_QUANTITY' | 'BELOW_RESERVED' } {
  if (
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    quantity > MAX_WAREHOUSE_ADJUSTMENT_BAGS
  ) {
    return { ok: false, reason: 'INVALID_QUANTITY' };
  }
  const delta = direction === 'INCREASE' ? quantity : -quantity;
  const onHand = current.onHand + delta;
  // Reserved bags belong to priority holds, allocations and pending dispatch; a decrease may
  // only take bags that are still available.
  if (onHand < current.reserved || onHand < 0) return { ok: false, reason: 'BELOW_RESERVED' };
  return {
    ok: true,
    delta,
    after: { onHand, reserved: current.reserved, available: onHand - current.reserved },
  };
}
