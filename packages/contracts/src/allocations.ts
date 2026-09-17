import { z } from 'zod';

import { AllocationPrioritySchema, AllocationReasonCodeSchema } from './allocation-policy.js';
import {
  AuditReasonSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
} from './common.js';
import {
  kilogramsToGramsForRefinement,
  safeIntegerToBigIntForRefinement,
} from './refinement-values.js';
import { InventoryAmountSchema, PositiveInventoryAmountSchema } from './warehouse.js';
import type { InventoryAmount } from './warehouse.js';

function amountValue(amount: InventoryAmount): bigint | null {
  if (amount.kind === 'UNIT') {
    return safeIntegerToBigIntForRefinement(amount.quantity);
  }
  return kilogramsToGramsForRefinement(amount.value);
}

export const AllocationBatchStatusSchema = z.enum(['DRAFT', 'COMMITTED', 'CANCELLED']);
export type AllocationBatchStatus = z.infer<typeof AllocationBatchStatusSchema>;

export const AllocationLineStatusSchema = z.enum([
  'RESERVED',
  'RELEASED',
  'OUTBOUND',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
]);
export type AllocationLineStatus = z.infer<typeof AllocationLineStatusSchema>;

export const AllocationLineSchema = z
  .object({
    id: EntityIdSchema,
    mergedOrderId: EntityIdSchema,
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    priority: AllocationPrioritySchema,
    reasonCode: AllocationReasonCodeSchema,
    round: z.number().int().positive(),
    requested: PositiveInventoryAmountSchema,
    allocated: InventoryAmountSchema,
    unfulfilled: InventoryAmountSchema,
    status: AllocationLineStatusSchema,
  })
  .strict()
  .superRefine((line, context) => {
    if (new Set([line.requested.kind, line.allocated.kind, line.unfulfilled.kind]).size !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allocated', 'kind'],
        message: 'Requested, allocated, and unfulfilled amounts must use the same measurement',
      });
      return;
    }
    const allocated = amountValue(line.allocated);
    const unfulfilled = amountValue(line.unfulfilled);
    const requested = amountValue(line.requested);
    if (
      allocated !== null &&
      unfulfilled !== null &&
      requested !== null &&
      allocated + unfulfilled !== requested
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allocated'],
        message: 'Allocated and unfulfilled amounts must equal the requested amount',
      });
    }
  });
export type AllocationLine = z.infer<typeof AllocationLineSchema>;

export const AllocationBatchSchema = z
  .object({
    id: EntityIdSchema,
    sessionId: EntityIdSchema,
    status: AllocationBatchStatusSchema,
    policyVersion: z.string().trim().min(1).max(80),
    inventorySnapshotAt: IsoDateTimeSchema,
    lines: z.array(AllocationLineSchema),
    createdByAccountId: EntityIdSchema,
    createdAt: IsoDateTimeSchema,
    committedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();
export type AllocationBatch = z.infer<typeof AllocationBatchSchema>;

export const RunAllocationRequestSchema = z
  .object({
    sessionId: EntityIdSchema,
    policyVersion: z.string().trim().min(1).max(80),
    expectedSessionVersion: z.number().int().nonnegative(),
  })
  .strict();
export type RunAllocationRequest = z.infer<typeof RunAllocationRequestSchema>;

export const AllocationBatchParamsSchema = z.object({ allocationBatchId: EntityIdSchema }).strict();
export type AllocationBatchParams = z.infer<typeof AllocationBatchParamsSchema>;

export const CommitAllocationRequestSchema = z
  .object({ expectedSessionVersion: z.number().int().nonnegative() })
  .strict();
export type CommitAllocationRequest = z.infer<typeof CommitAllocationRequestSchema>;

export const CancelAllocationRequestSchema = z.object({ reason: AuditReasonSchema }).strict();
export type CancelAllocationRequest = z.infer<typeof CancelAllocationRequestSchema>;

export const AllocationBatchResponseSchema = z.object({ data: AllocationBatchSchema }).strict();
export type AllocationBatchResponse = z.infer<typeof AllocationBatchResponseSchema>;

export const ListAllocationsQuerySchema = PaginationQuerySchema.extend({
  sessionId: EntityIdSchema.optional(),
  storeId: EntityIdSchema.optional(),
  productId: EntityIdSchema.optional(),
  status: AllocationLineStatusSchema.optional(),
  priority: AllocationPrioritySchema.optional(),
}).strict();
export type ListAllocationsQuery = z.infer<typeof ListAllocationsQuerySchema>;

export const ListAllocationsResponseSchema = z
  .object({ data: z.array(AllocationLineSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListAllocationsResponse = z.infer<typeof ListAllocationsResponseSchema>;
