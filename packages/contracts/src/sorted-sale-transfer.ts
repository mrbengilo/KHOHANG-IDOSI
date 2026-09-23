import { z } from 'zod';

import {
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
    status: z.enum(['IN_TRANSIT', 'RECEIVED']),
    version: z.number().int().nonnegative(),
    note: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
    receivedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();
export type SortedSaleTransfer = z.infer<typeof SortedSaleTransferSchema>;

export const CreateSortedSaleTransferRequestSchema = z
  .object({
    sourceStockId: EntityIdSchema,
    sourceStoreId: EntityIdSchema,
    destinationStoreId: EntityIdSchema,
    expectedStockVersion: z.number().int().nonnegative(),
    bagQuantity: PositiveUnitQuantitySchema,
    weightKg: PositiveKilogramsDecimalSchema.nullable(),
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
