import { z } from 'zod';
import {
  EntityIdSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
  UnitQuantitySchema,
} from './common.js';

export const WarehouseInventoryQuerySchema = PaginationQuerySchema.extend({
  search: z.string().trim().max(120).optional(),
  /** One product's row, e.g. the stock check when a product is picked for an order. */
  productId: EntityIdSchema.optional(),
  projection: z.literal('waiting-demand-v2').optional(),
}).strict();
export type WarehouseInventoryQuery = z.infer<typeof WarehouseInventoryQuerySchema>;
export const WarehouseInventoryRowSchema = z
  .object({
    productId: EntityIdSchema,
    productName: z.string(),
    sku: z.string(),
    onHandBags: UnitQuantitySchema,
    reservedBags: UnitQuantitySchema,
    /**
     * Split of reservedBags: physical bags held for priority offers of wait tickets
     * and bags held for granted allocation lines that wait for the store's answer or its next
     * ordinary shipment ("Đang giữ chờ giao chung"). The two always add up to reservedBags.
     */
    waitTicketHoldBags: UnitQuantitySchema,
    /** Unallocated live wait-ticket demand across stores; independent of physical stock. */
    waitingDemandBags: UnitQuantitySchema,
    sharedDeliveryHoldBags: UnitQuantitySchema,
    /** Free to allocate: onHandBags − reservedBags. */
    availableBags: UnitQuantitySchema,
    /** Cumulative bags booked out of the central warehouse (ledger outbound entries). */
    dispatchedBags: UnitQuantitySchema,
    /** Optimistic version of the balance row; 0 before the product's first movement. */
    balanceVersion: z.number().int().nonnegative(),
    productActive: z.boolean(),
    /**
     * The product follows the Reshare stock reconciliation: its stock is matched by updating the
     * Reshare total, never by a manual warehouse adjustment.
     */
    reshareReconciled: z.boolean(),
  })
  .strict();
export type WarehouseInventoryRow = z.infer<typeof WarehouseInventoryRowSchema>;
export const WarehouseInventoryResponseSchema = z
  .object({
    data: z.array(WarehouseInventoryRowSchema),
    pagination: PaginationMetaSchema,
  })
  .strict();
export type WarehouseInventoryResponse = z.infer<typeof WarehouseInventoryResponseSchema>;
