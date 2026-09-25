import { z } from 'zod';

import {
  BagWeightsKgSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  PositiveKilogramsDecimalSchema,
  PositiveUnitQuantitySchema,
  PaginationQuerySchema,
} from './common.js';

export const SortedSaleTransferLineSchema = z
  .object({
    productId: EntityIdSchema,
    sourceStockId: EntityIdSchema,
    bagQuantity: PositiveUnitQuantitySchema,
    weightKg: PositiveKilogramsDecimalSchema,
    enteredWeightKg: PositiveKilogramsDecimalSchema.nullable(),
    bagWeightsKg: z.array(PositiveKilogramsDecimalSchema),
    sourceLots: z
      .array(
        z.object({ stockId: EntityIdSchema, weightKg: PositiveKilogramsDecimalSchema }).strict(),
      )
      .optional(),
  })
  .strict();
export type SortedSaleTransferLine = z.infer<typeof SortedSaleTransferLineSchema>;

export const SortedSaleTransferSchema = z
  .object({
    id: EntityIdSchema,
    transferNumber: z.string().min(1),
    lines: z.array(SortedSaleTransferLineSchema).min(1).optional(),
    createdByAccountId: EntityIdSchema.optional(),
    createdByDisplayName: z.string().nullable().optional(),
    sourceStockId: EntityIdSchema,
    sourceStoreId: EntityIdSchema,
    destinationStoreId: EntityIdSchema,
    productId: EntityIdSchema,
    bagQuantity: PositiveUnitQuantitySchema,
    weightKg: PositiveKilogramsDecimalSchema,
    enteredWeightKg: PositiveKilogramsDecimalSchema.nullable(),
    /** Per-bag weights in bag order; empty for transfers created before bags were weighed. */
    bagWeightsKg: z.array(PositiveKilogramsDecimalSchema),
    status: z.enum(['IN_TRANSIT', 'RECEIVED', 'CANCELLED']),
    version: z.number().int().nonnegative(),
    note: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
    receivedAt: IsoDateTimeSchema.nullable(),
    cancelledAt: IsoDateTimeSchema.nullable().optional(),
    cancellationReason: z.string().nullable().optional(),
  })
  .strict();
export type SortedSaleTransfer = z.infer<typeof SortedSaleTransferSchema>;

/**
 * A transfer takes weight from the product's whole Sale pool at the source store,
 * oldest sorted lots first. The total of the bag weights must fit that pool.
 */
const transferLineInput = z
  .object({ productId: EntityIdSchema, bagWeightsKg: BagWeightsKgSchema })
  .strict();
const transferHeaderInput = {
  sourceStoreId: EntityIdSchema,
  destinationStoreId: EntityIdSchema,
  note: z.string().trim().max(500).nullable(),
};
export const CreateSortedSaleTransferRequestSchema = z
  .union([
    z
      .object({ ...transferHeaderInput, lines: z.array(transferLineInput).min(1).max(100) })
      .strict(),
    z
      .object({
        ...transferHeaderInput,
        productId: EntityIdSchema,
        bagWeightsKg: BagWeightsKgSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.sourceStoreId === value.destinationStoreId)
      context.addIssue({
        code: 'custom',
        path: ['destinationStoreId'],
        message: 'Stores must differ',
      });
    if (
      'lines' in value &&
      new Set(value.lines.map((line) => line.productId)).size !== value.lines.length
    )
      context.addIssue({
        code: 'custom',
        path: ['lines'],
        message: 'Mỗi mặt hàng chỉ được chọn một lần.',
      });
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

/** The sending store calls back a transfer the destination has not received yet. */
export const CancelSortedSaleTransferRequestSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type CancelSortedSaleTransferRequest = z.infer<typeof CancelSortedSaleTransferRequestSchema>;

export const SortedSaleTransferParamsSchema = z.object({ transferId: EntityIdSchema }).strict();
export const SortedSaleTransferResponseSchema = z
  .object({ data: SortedSaleTransferSchema })
  .strict();
export const ListSortedSaleTransfersQuerySchema = PaginationQuerySchema;
export const SortedSaleTransfersResponseSchema = z
  .object({ data: z.array(SortedSaleTransferSchema), hasMore: z.boolean().optional() })
  .strict();
