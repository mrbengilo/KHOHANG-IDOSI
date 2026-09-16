import { z } from 'zod';

import {
  AuditReasonSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  KilogramsDecimalSchema,
  MoneyVndSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
  PositiveKilogramsDecimalSchema,
} from './common.js';

function kilogramsToGrams(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000n + BigInt(fraction.padEnd(3, '0'));
}

export const StoreInventoryBagStatusSchema = z.enum([
  'IN_TRANSIT',
  'AVAILABLE',
  'OPEN',
  'EMPTY',
  'QUARANTINED',
]);
export type StoreInventoryBagStatus = z.infer<typeof StoreInventoryBagStatusSchema>;

export const StoreInventoryBagSchema = z
  .object({
    id: EntityIdSchema,
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    sourceReceiptBagId: EntityIdSchema,
    outboundOrderId: EntityIdSchema,
    bagCode: z.string().trim().min(1).max(100),
    originalWeightKg: PositiveKilogramsDecimalSchema,
    receivedWeightKg: KilogramsDecimalSchema,
    remainingWeightKg: KilogramsDecimalSchema,
    status: StoreInventoryBagStatusSchema,
    version: z.number().int().nonnegative(),
    receivedAt: IsoDateTimeSchema.nullable(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((bag, context) => {
    const isEmpty = /^0(?:\.0{1,3})?$/.test(bag.remainingWeightKg);
    if (bag.status === 'EMPTY' && !isEmpty) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remainingWeightKg'],
        message: 'An empty bag must have zero remaining weight',
      });
    }
    if ((bag.status === 'AVAILABLE' || bag.status === 'OPEN') && isEmpty) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remainingWeightKg'],
        message: 'An available or open bag must have remaining weight',
      });
    }
    const original = kilogramsToGrams(bag.originalWeightKg);
    const received = kilogramsToGrams(bag.receivedWeightKg);
    const remaining = kilogramsToGrams(bag.remainingWeightKg);
    if (received > original) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receivedWeightKg'],
        message: 'Received weight cannot exceed original outbound weight',
      });
    }
    if (remaining > received) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remainingWeightKg'],
        message: 'Remaining weight cannot exceed received weight',
      });
    }
  });
export type StoreInventoryBag = z.infer<typeof StoreInventoryBagSchema>;

export const StoreInventoryBagParamsSchema = z.object({ bagId: EntityIdSchema }).strict();
export type StoreInventoryBagParams = z.infer<typeof StoreInventoryBagParamsSchema>;

export const AdjustStoreInventoryBagRequestSchema = z
  .object({
    actualRemainingWeightKg: KilogramsDecimalSchema,
    expectedVersion: z.number().int().nonnegative(),
    reason: AuditReasonSchema,
  })
  .strict();
export type AdjustStoreInventoryBagRequest = z.infer<typeof AdjustStoreInventoryBagRequestSchema>;

export const ConsumeStoreInventoryBagRequestSchema = z
  .object({
    consumedWeightKg: PositiveKilogramsDecimalSchema,
    expectedVersion: z.number().int().nonnegative(),
    reference: z.string().trim().min(1).max(200),
  })
  .strict();
export type ConsumeStoreInventoryBagRequest = z.infer<typeof ConsumeStoreInventoryBagRequestSchema>;

export const StoreInventoryBagLedgerEntrySchema = z
  .object({
    id: EntityIdSchema,
    bagId: EntityIdSchema,
    operation: z.enum(['RECEIVE', 'CONSUME', 'ADJUST', 'QUARANTINE', 'RELEASE']),
    beforeWeightKg: KilogramsDecimalSchema,
    afterWeightKg: KilogramsDecimalSchema,
    reason: z.string().trim().min(1).max(500),
    actorAccountId: EntityIdSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type StoreInventoryBagLedgerEntry = z.infer<typeof StoreInventoryBagLedgerEntrySchema>;

export const StoreInventoryBagResponseSchema = z.object({ data: StoreInventoryBagSchema }).strict();
export type StoreInventoryBagResponse = z.infer<typeof StoreInventoryBagResponseSchema>;

export const ListStoreInventoryBagsQuerySchema = PaginationQuerySchema.extend({
  storeId: EntityIdSchema.optional(),
  productId: EntityIdSchema.optional(),
  status: StoreInventoryBagStatusSchema.optional(),
  bagCode: z.string().trim().min(1).max(100).optional(),
}).strict();
export type ListStoreInventoryBagsQuery = z.infer<typeof ListStoreInventoryBagsQuerySchema>;

export const ListStoreInventoryBagsResponseSchema = z
  .object({ data: z.array(StoreInventoryBagSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListStoreInventoryBagsResponse = z.infer<typeof ListStoreInventoryBagsResponseSchema>;

export const ListStoreInventoryBagLedgerResponseSchema = z
  .object({ data: z.array(StoreInventoryBagLedgerEntrySchema), pagination: PaginationMetaSchema })
  .strict();
export type ListStoreInventoryBagLedgerResponse = z.infer<
  typeof ListStoreInventoryBagLedgerResponseSchema
>;

export const InventoryLotStatusSchema = z.enum(['AVAILABLE', 'QUARANTINED', 'DEPLETED']);
export type InventoryLotStatus = z.infer<typeof InventoryLotStatusSchema>;

/** One finalized receipt bag tracked as an independently auditable store lot. */
export const InventoryLotSchema = z
  .object({
    id: EntityIdSchema,
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    receiptId: EntityIdSchema,
    initialWeightKg: PositiveKilogramsDecimalSchema,
    remainingWeightKg: KilogramsDecimalSchema,
    costVnd: MoneyVndSchema,
    status: InventoryLotStatusSchema,
    version: z.number().int().nonnegative(),
    receivedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((lot, context) => {
    const initial = kilogramsToGrams(lot.initialWeightKg);
    const remaining = kilogramsToGrams(lot.remainingWeightKg);
    if (remaining > initial) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remainingWeightKg'],
        message: 'Remaining weight cannot exceed initial weight',
      });
    }
    if (lot.status === 'DEPLETED' && remaining !== 0n) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remainingWeightKg'],
        message: 'A depleted lot must have zero remaining weight',
      });
    }
    if (lot.status === 'AVAILABLE' && remaining === 0n) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remainingWeightKg'],
        message: 'An available lot must have remaining weight',
      });
    }
  });
export type InventoryLot = z.infer<typeof InventoryLotSchema>;

export const InventoryLotParamsSchema = z.object({ inventoryLotId: EntityIdSchema }).strict();
export type InventoryLotParams = z.infer<typeof InventoryLotParamsSchema>;

export const InventoryLotResponseSchema = z.object({ data: InventoryLotSchema }).strict();
export type InventoryLotResponse = z.infer<typeof InventoryLotResponseSchema>;

export const ListInventoryLotsQuerySchema = PaginationQuerySchema.extend({
  storeId: EntityIdSchema.optional(),
  productId: EntityIdSchema.optional(),
  receiptId: EntityIdSchema.optional(),
  status: InventoryLotStatusSchema.optional(),
}).strict();
export type ListInventoryLotsQuery = z.infer<typeof ListInventoryLotsQuerySchema>;

export const ListInventoryLotsResponseSchema = z
  .object({ data: z.array(InventoryLotSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListInventoryLotsResponse = z.infer<typeof ListInventoryLotsResponseSchema>;
