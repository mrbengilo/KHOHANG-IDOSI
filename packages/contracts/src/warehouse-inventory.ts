import { z } from 'zod';
import {
  EntityIdSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
  UnitQuantitySchema,
} from './common.js';

export const WarehouseInventoryQuerySchema = PaginationQuerySchema.extend({
  search: z.string().trim().max(120).optional(),
}).strict();
export type WarehouseInventoryQuery = z.infer<typeof WarehouseInventoryQuerySchema>;
export const WarehouseInventoryRowSchema = z
  .object({
    productId: EntityIdSchema,
    productName: z.string(),
    sku: z.string(),
    onHandBags: UnitQuantitySchema,
    reservedBags: UnitQuantitySchema,
    availableBags: UnitQuantitySchema,
    dispatchedBags: UnitQuantitySchema,
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
