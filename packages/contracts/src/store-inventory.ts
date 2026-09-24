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
import { kilogramsToGramsForRefinement } from './refinement-values.js';

export const StoreInventoryBagStatusSchema = z.enum([
  'IN_TRANSIT',
  'AVAILABLE',
  'OPEN',
  'EMPTY',
  'QUARANTINED',
  'RETURNED',
  'LOST',
]);
export type StoreInventoryBagStatus = z.infer<typeof StoreInventoryBagStatusSchema>;

export const StoreInventoryBagSchema = z
  .object({
    id: EntityIdSchema,
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    sourceReceiptBagId: EntityIdSchema.nullable(),
    outboundOrderId: EntityIdSchema.nullable(),
    sourceTransferId: EntityIdSchema.nullable().default(null),
    sourceInventoryBagId: EntityIdSchema.nullable().default(null),
    /**
     * Set only for stock a store received directly from a partner. Optional rather than
     * defaulted so snapshots written before partner inbound existed still parse unchanged.
     */
    sourcePartnerInboundBagId: EntityIdSchema.nullable().optional(),
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
    // Stock arrives from the warehouse, from another store, or from a partner. Exactly one
    // of those has to be recorded, or the bag cannot be traced back to what it came from.
    const provenanceSources = [
      bag.sourceReceiptBagId,
      bag.sourceTransferId,
      bag.sourcePartnerInboundBagId ?? null,
    ].filter((source) => source !== null).length;
    if (provenanceSources !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceTransferId'],
        message:
          'Inventory bag must have exactly one receipt, transfer or partner provenance source',
      });
    }
    if (bag.sourceTransferId !== null && bag.sourceInventoryBagId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceInventoryBagId'],
        message: 'Transfer inventory must retain its physical parent bag',
      });
    }
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
    const original = kilogramsToGramsForRefinement(bag.originalWeightKg);
    const received = kilogramsToGramsForRefinement(bag.receivedWeightKg);
    const remaining = kilogramsToGramsForRefinement(bag.remainingWeightKg);
    if (original === null || received === null || remaining === null) {
      return;
    }
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

/** Opens one physical bag for retail use without changing its recorded weight. */
export const OpenStoreInventoryBagRequestSchema = z
  .object({ expectedVersion: z.number().int().nonnegative() })
  .strict();
export type OpenStoreInventoryBagRequest = z.infer<typeof OpenStoreInventoryBagRequestSchema>;

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
    /** Null for movements the IDOSI regular-sale sync records on its own. */
    actorAccountId: EntityIdSchema.nullable(),
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

export const ListStoreInventoryBagLedgerQuerySchema = PaginationQuerySchema.extend({
  storeId: EntityIdSchema.optional(),
  productId: EntityIdSchema.optional(),
}).strict();
export type ListStoreInventoryBagLedgerQuery = z.infer<
  typeof ListStoreInventoryBagLedgerQuerySchema
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
    const initial = kilogramsToGramsForRefinement(lot.initialWeightKg);
    const remaining = kilogramsToGramsForRefinement(lot.remainingWeightKg);
    if (initial === null || remaining === null) {
      return;
    }
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

/**
 * Regular-price (NORMAL) IDOSI sales that no opened bag could absorb yet. They are taken from the
 * next bag of the product the store opens, so the store sees why an opened bag starts lighter.
 */
export const StoreNormalSalePendingSchema = z
  .object({
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    pendingWeightKg: KilogramsDecimalSchema,
  })
  .strict();
export type StoreNormalSalePending = z.infer<typeof StoreNormalSalePendingSchema>;

export const ListStoreNormalSalePendingQuerySchema = z
  .object({ storeId: EntityIdSchema.optional() })
  .strict();
export type ListStoreNormalSalePendingQuery = z.infer<typeof ListStoreNormalSalePendingQuerySchema>;

export const ListStoreNormalSalePendingResponseSchema = z
  .object({ data: z.array(StoreNormalSalePendingSchema) })
  .strict();
