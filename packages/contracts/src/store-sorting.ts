import { z } from 'zod';

import {
  BagWeightsKgSchema,
  EntityIdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  KilogramsDecimalSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
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
    /** Deprecated: sorted Sale is tracked by weight only. Accepted and ignored for old clients. */
    bagQuantity: PositiveUnitQuantitySchema.nullable().optional(),
  })
  .strict();
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
    /** Deprecated: accepted and ignored for old clients. */
    bagQuantity: PositiveUnitQuantitySchema.nullable().optional(),
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

/** Product-level charity actions take weight from the oldest sorted lots first. */
export const MoveProductCharityToSaleRequestSchema = z
  .object({
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    weightKg: PositiveKilogramsDecimalSchema,
  })
  .strict();
export type MoveProductCharityToSaleRequest = z.infer<typeof MoveProductCharityToSaleRequestSchema>;

export const ProductCharityBalanceSchema = z
  .object({
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    charityWeightKg: KilogramsDecimalSchema,
    saleWeightKg: KilogramsDecimalSchema,
  })
  .strict();
export type ProductCharityBalance = z.infer<typeof ProductCharityBalanceSchema>;
export const ProductCharityBalanceResponseSchema = z
  .object({ data: ProductCharityBalanceSchema })
  .strict();

export const CreateCharityExportRequestSchema = z
  .object({
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    bagWeightsKg: BagWeightsKgSchema,
    note: z.string().trim().max(500).nullable(),
  })
  .strict();
export type CreateCharityExportRequest = z.infer<typeof CreateCharityExportRequestSchema>;

export const CharityExportSchema = z
  .object({
    id: EntityIdSchema,
    exportNumber: z.string().min(1),
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    bagQuantity: PositiveUnitQuantitySchema,
    weightKg: PositiveKilogramsDecimalSchema,
    bagWeightsKg: z.array(PositiveKilogramsDecimalSchema).min(1),
    note: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type CharityExport = z.infer<typeof CharityExportSchema>;

export const ListCharityExportsQuerySchema = z
  .object({ storeId: EntityIdSchema.optional() })
  .strict();
export type ListCharityExportsQuery = z.infer<typeof ListCharityExportsQuerySchema>;
export const CharityExportResponseSchema = z.object({ data: CharityExportSchema }).strict();
export const CharityExportsResponseSchema = z
  .object({ data: z.array(CharityExportSchema) })
  .strict();

/** What one sorting-page action did with the weight, in the order a store performs them. */
export const StoreSortingHistoryActionSchema = z.enum([
  'SORT_SALE',
  'SORT_CHARITY',
  'SORT_CANCEL',
  'CHARITY_TO_SALE',
  'CHARITY_EXPORT',
]);
export type StoreSortingHistoryAction = z.infer<typeof StoreSortingHistoryActionSchema>;

export const StoreSortingHistoryEntrySchema = z
  .object({
    id: EntityIdSchema,
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    inventoryLotId: EntityIdSchema.nullable(),
    bagCode: z.string().nullable(),
    action: StoreSortingHistoryActionSchema,
    weightKg: PositiveKilogramsDecimalSchema,
    actorDisplayName: z.string().nullable(),
    occurredAt: IsoDateTimeSchema,
  })
  .strict();
export type StoreSortingHistoryEntry = z.infer<typeof StoreSortingHistoryEntrySchema>;

/** `date` is a calendar day in Asia/Ho_Chi_Minh; omitted means every day, newest first. */
export const ListStoreSortingHistoryQuerySchema = PaginationQuerySchema.extend({
  storeId: EntityIdSchema.optional(),
  date: IsoDateSchema.optional(),
}).strict();
export type ListStoreSortingHistoryQuery = z.infer<typeof ListStoreSortingHistoryQuerySchema>;

export const ListStoreSortingHistoryResponseSchema = z
  .object({ data: z.array(StoreSortingHistoryEntrySchema), pagination: PaginationMetaSchema })
  .strict();
export type ListStoreSortingHistoryResponse = z.infer<typeof ListStoreSortingHistoryResponseSchema>;
