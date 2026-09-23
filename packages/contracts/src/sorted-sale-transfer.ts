import { z } from 'zod';

import {
  BagWeightsKgSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  PositiveKilogramsDecimalSchema,
  PositiveUnitQuantitySchema,
} from './common.js';

export const SortedSaleTransferSchema = z
  .object({
    id: EntityIdSchema,
    transferNumber: z.string().min(1),
    sourceStockId: EntityIdSchema,
    sourceStoreId: EntityIdSchema,
    destinationStoreId: EntityIdSchema,
    productId: EntityIdSchema,
    bagQuantity: PositiveUnitQuantitySchema,
    weightKg: PositiveKilogramsDecimalSchema,
    enteredWeightKg: PositiveKilogramsDecimalSchema.nullable(),
    /** Per-bag weights in bag order; empty for transfers created before bags were weighed. */
    bagWeightsKg: z.array(PositiveKilogramsDecimalSchema),
    status: z.enum(['IN_TRANSIT', 'RECEIVED']),
    version: z.number().int().nonnegative(),
    note: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
    receivedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();
export type SortedSaleTransfer = z.infer<typeof SortedSaleTransferSchema>;

/**
 * A transfer takes weight from the product's whole Sale pool at the source store,
 * oldest sorted lots first. The total of the bag weights must fit that pool.
 */
export const CreateSortedSaleTransferRequestSchema = z
  .object({
    sourceStoreId: EntityIdSchema,
    destinationStoreId: EntityIdSchema,
    productId: EntityIdSchema,
    bagWeightsKg: BagWeightsKgSchema,
    note: z.string().trim().max(500).nullable(),
  })
  .strict()
  .refine((value) => value.sourceStoreId !== value.destinationStoreId, {
    path: ['destinationStoreId'],
    message: 'Stores must differ',
  });
export type CreateSortedSaleTransferRequest = z.infer<typeof CreateSortedSaleTransferRequestSchema>;

export const ReceiveSortedSaleTransferRequestSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export type ReceiveSortedSaleTransferRequest = z.infer<
  typeof ReceiveSortedSaleTransferRequestSchema
>;

export const SortedSaleTransferParamsSchema = z.object({ transferId: EntityIdSchema }).strict();
export const SortedSaleTransferResponseSchema = z
  .object({ data: SortedSaleTransferSchema })
  .strict();
export const SortedSaleTransfersResponseSchema = z
  .object({ data: z.array(SortedSaleTransferSchema) })
  .strict();
