import { z } from 'zod';

import {
  AuditReasonSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  MoneyVndSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
  PositiveKilogramsDecimalSchema,
} from './common.js';
import { StoreSchema } from './stores.js';

export const StoreTransferStatusSchema = z.enum(['DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED']);
export type StoreTransferStatus = z.infer<typeof StoreTransferStatusSchema>;

/**
 * A single-bag store transfer. Keeping one source bag per transfer preserves
 * physical provenance and makes proportional cost movement deterministic.
 */
export const StoreTransferSchema = z
  .object({
    id: EntityIdSchema,
    transferNumber: z.string().trim().min(1).max(100),
    sourceStoreId: EntityIdSchema,
    destinationStoreId: EntityIdSchema,
    sourceInventoryBagId: EntityIdSchema,
    destinationInventoryBagId: EntityIdSchema.nullable(),
    productId: EntityIdSchema,
    weightKg: PositiveKilogramsDecimalSchema,
    /** Cost moved with the stock; null until dispatch fixes the allocation. */
    costVnd: MoneyVndSchema.nullable(),
    status: StoreTransferStatusSchema,
    note: z.string().trim().min(1).max(500).nullable(),
    cancellationReason: AuditReasonSchema.nullable(),
    version: z.number().int().nonnegative(),
    createdByAccountId: EntityIdSchema,
    createdByDisplayName: z.string().nullable().optional(),
    dispatchedByAccountId: EntityIdSchema.nullable(),
    receivedByAccountId: EntityIdSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    dispatchedAt: IsoDateTimeSchema.nullable(),
    receivedAt: IsoDateTimeSchema.nullable(),
    cancelledAt: IsoDateTimeSchema.nullable(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((transfer, context) => {
    if (transfer.sourceStoreId === transfer.destinationStoreId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destinationStoreId'],
        message: 'Source and destination stores must differ',
      });
    }
    if (transfer.status === 'DRAFT' && transfer.costVnd !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['costVnd'],
        message: 'Draft transfer cost is fixed only when dispatched',
      });
    }
    if (
      (transfer.status === 'IN_TRANSIT' || transfer.status === 'RECEIVED') &&
      (transfer.costVnd === null || transfer.dispatchedAt === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dispatchedAt'],
        message: 'Dispatched transfers require a fixed cost and dispatch timestamp',
      });
    }
    if (
      transfer.status === 'RECEIVED' &&
      (transfer.destinationInventoryBagId === null ||
        transfer.receivedByAccountId === null ||
        transfer.receivedAt === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destinationInventoryBagId'],
        message: 'Received transfers require destination provenance and receiver details',
      });
    }
    if (transfer.status === 'CANCELLED' && transfer.cancellationReason === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cancellationReason'],
        message: 'Cancelled transfers require a reason',
      });
    }
  });
export type StoreTransfer = z.infer<typeof StoreTransferSchema>;

export const CreateStoreTransferRequestSchema = z
  .object({
    sourceStoreId: EntityIdSchema,
    destinationStoreId: EntityIdSchema,
    sourceInventoryBagId: EntityIdSchema,
    weightKg: PositiveKilogramsDecimalSchema,
    expectedSourceBagVersion: z.number().int().nonnegative(),
    note: z.string().trim().min(1).max(500).nullable().default(null),
  })
  .strict()
  .refine((input) => input.sourceStoreId !== input.destinationStoreId, {
    path: ['destinationStoreId'],
    message: 'Source and destination stores must differ',
  });
export type CreateStoreTransferRequest = z.infer<typeof CreateStoreTransferRequestSchema>;

export const DispatchStoreTransferRequestSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    expectedSourceBagVersion: z.number().int().nonnegative(),
  })
  .strict();
export type DispatchStoreTransferRequest = z.infer<typeof DispatchStoreTransferRequestSchema>;

export const ReceiveStoreTransferRequestSchema = z
  .object({ expectedVersion: z.number().int().nonnegative() })
  .strict();
export type ReceiveStoreTransferRequest = z.infer<typeof ReceiveStoreTransferRequestSchema>;

export const CancelStoreTransferRequestSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    reason: AuditReasonSchema,
  })
  .strict();
export type CancelStoreTransferRequest = z.infer<typeof CancelStoreTransferRequestSchema>;

export const StoreTransferParamsSchema = z.object({ transferId: EntityIdSchema }).strict();
export type StoreTransferParams = z.infer<typeof StoreTransferParamsSchema>;

export const ListStoreTransfersQuerySchema = PaginationQuerySchema.extend({
  storeId: EntityIdSchema.optional(),
  sourceStoreId: EntityIdSchema.optional(),
  destinationStoreId: EntityIdSchema.optional(),
  productId: EntityIdSchema.optional(),
  status: StoreTransferStatusSchema.optional(),
}).strict();
export type ListStoreTransfersQuery = z.infer<typeof ListStoreTransfersQuerySchema>;

export const StoreTransferResponseSchema = z.object({ data: StoreTransferSchema }).strict();
export type StoreTransferResponse = z.infer<typeof StoreTransferResponseSchema>;

export const ListStoreTransfersResponseSchema = z
  .object({ data: z.array(StoreTransferSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListStoreTransfersResponse = z.infer<typeof ListStoreTransfersResponseSchema>;

export const ListStoreTransferDestinationsResponseSchema = z
  .object({ data: z.array(StoreSchema) })
  .strict();
export type ListStoreTransferDestinationsResponse = z.infer<
  typeof ListStoreTransferDestinationsResponseSchema
>;
