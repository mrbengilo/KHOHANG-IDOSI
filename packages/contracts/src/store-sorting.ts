import { z } from 'zod';

import {
  EntityIdSchema,
  IsoDateTimeSchema,
  KilogramsDecimalSchema,
  PositiveKilogramsDecimalSchema,
  PositiveUnitQuantitySchema,
} from './common.js';

export const StoreSortingReasonSchema = z.enum(['SALE', 'CHARITY', 'CANCEL']);
export type StoreSortingReason = z.infer<typeof StoreSortingReasonSchema>;

export const StoreSortedStockSchema = z
  .object({
    id: EntityIdSchema,
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    inventoryLotId: EntityIdSchema,
    bagCode: z.string().min(1),
    saleWeightKg: KilogramsDecimalSchema,
    bagQuantity: z.number().int().nonnegative().safe(),
    charityWeightKg: KilogramsDecimalSchema,
    version: z.number().int().nonnegative(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type StoreSortedStock = z.infer<typeof StoreSortedStockSchema>;

export const ListStoreSortedStocksQuerySchema = z
  .object({ storeId: EntityIdSchema.optional() })
  .strict();
export type ListStoreSortedStocksQuery = z.infer<typeof ListStoreSortedStocksQuerySchema>;
export const ListStoreSortedStocksResponseSchema = z
  .object({ data: z.array(StoreSortedStockSchema) })
  .strict();

export const CreateStoreSortingRequestSchema = z
  .object({
    storeId: EntityIdSchema,
    inventoryLotId: EntityIdSchema,
    expectedInventoryVersion: z.number().int().nonnegative(),
    reason: StoreSortingReasonSchema,
    weightKg: PositiveKilogramsDecimalSchema,
    bagQuantity: PositiveUnitQuantitySchema.nullable(),
  })
  .strict()
  .refine((value) => value.reason !== 'SALE' || value.bagQuantity !== null, {
    path: ['bagQuantity'],
    message: 'Sorting into Sale requires a bag quantity',
  });
export type CreateStoreSortingRequest = z.infer<typeof CreateStoreSortingRequestSchema>;

export const StoreSortingResultSchema = z
  .object({
    stockId: EntityIdSchema.nullable(),
    inventoryLotId: EntityIdSchema,
    inventoryVersion: z.number().int().nonnegative(),
  })
  .strict();
export type StoreSortingResult = z.infer<typeof StoreSortingResultSchema>;

export const StoreSortedStockParamsSchema = z.object({ stockId: EntityIdSchema }).strict();
export const MoveCharityToSaleRequestSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    weightKg: PositiveKilogramsDecimalSchema,
    bagQuantity: PositiveUnitQuantitySchema,
  })
  .strict();
export type MoveCharityToSaleRequest = z.infer<typeof MoveCharityToSaleRequestSchema>;
export const ExportCharityRequestSchema = MoveCharityToSaleRequestSchema.omit({
  bagQuantity: true,
});
export type ExportCharityRequest = z.infer<typeof ExportCharityRequestSchema>;
export const StoreSortedStockResponseSchema = z.object({ data: StoreSortedStockSchema }).strict();
export const StoreSortingResultResponseSchema = z
  .object({ data: StoreSortingResultSchema })
  .strict();
