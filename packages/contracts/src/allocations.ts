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

/** Persisted result state from `allocation_lines`, exposed as a read-only projection. */
export const AllocationResultStatusSchema = z.enum([
  'ALLOCATED',
  'PARTIAL',
  'WAITLISTED',
  'SKIPPED',
]);
export type AllocationResultStatus = z.infer<typeof AllocationResultStatusSchema>;

export const AllocationResultRoundSchema = z
  .object({
    roundNumber: z.number().int().positive().safe(),
    allocatedQuantity: z.number().int().positive().safe(),
  })
  .strict();
export type AllocationResultRound = z.infer<typeof AllocationResultRoundSchema>;

export const AllocationResultSchema = z
  .object({
    id: EntityIdSchema,
    allocationRunId: EntityIdSchema,
    sessionId: EntityIdSchema,
    mergedOrderId: EntityIdSchema.nullable(),
    storeId: EntityIdSchema,
    productId: EntityIdSchema,
    priority: AllocationPrioritySchema,
    roundNumber: z
      .number()
      .int()
      .positive()
      .safe()
      .describe('Deprecated persistence coordinate; use rounds for policy-round audit data.'),
    sequenceInRound: z
      .number()
      .int()
      .positive()
      .safe()
      .describe('Deprecated persistence coordinate; use rounds for policy-round audit data.'),
    rounds: z
      .array(AllocationResultRoundSchema)
      .describe(
        'Authoritative allocated quantity grouped by planner round; empty for zero-grant or legacy rows without complete round metadata.',
      ),
    requestedQuantity: z.number().int().positive().safe(),
    allocatedQuantity: z.number().int().nonnegative().safe(),
    waitlistedQuantity: z.number().int().nonnegative().safe(),
    status: AllocationResultStatusSchema,
    reasonCode: z.string().trim().min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.allocatedQuantity + result.waitlistedQuantity > result.requestedQuantity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allocatedQuantity'],
        message: 'Allocated and waitlisted quantities cannot exceed the requested quantity',
      });
    }
    const roundNumbers = result.rounds.map((round) => round.roundNumber);
    if (roundNumbers.some((round, index) => index > 0 && round <= roundNumbers[index - 1]!)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rounds'],
        message: 'Allocation rounds must be unique and ordered by round number',
      });
    }
    const roundAllocatedQuantity = result.rounds.reduce(
      (total, round) => total + round.allocatedQuantity,
      0,
    );
    if (result.rounds.length > 0 && roundAllocatedQuantity !== result.allocatedQuantity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rounds'],
        message: 'Allocation round quantities must equal the allocated quantity',
      });
    }
    if (result.allocatedQuantity === 0 && result.rounds.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rounds'],
        message: 'Zero-grant allocation results cannot contain planner rounds',
      });
    }
  });
export type AllocationResult = z.infer<typeof AllocationResultSchema>;

export const ListAllocationsQuerySchema = PaginationQuerySchema.extend({
  sessionId: EntityIdSchema.optional(),
  storeId: EntityIdSchema.optional(),
  productId: EntityIdSchema.optional(),
  status: AllocationResultStatusSchema.optional(),
  priority: AllocationPrioritySchema.optional(),
})
  .strict()
  .superRefine((query, context) => {
    if (!Number.isSafeInteger((query.page - 1) * query.pageSize)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['page'],
        message: 'Pagination offset exceeds the safe integer range',
      });
    }
  });
export type ListAllocationsQuery = z.infer<typeof ListAllocationsQuerySchema>;

export const ListAllocationsResponseSchema = z
  .object({ data: z.array(AllocationResultSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListAllocationsResponse = z.infer<typeof ListAllocationsResponseSchema>;
