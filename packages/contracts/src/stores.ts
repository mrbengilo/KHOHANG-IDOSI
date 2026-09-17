import { z } from 'zod';

import {
  AuditReasonSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
} from './common.js';

export const StoreStatusSchema = z.enum(['ACTIVE', 'INACTIVE']);
export type StoreStatus = z.infer<typeof StoreStatusSchema>;

export const StoreKindSchema = z.enum(['RETAIL', 'WHOLESALE']);
export type StoreKind = z.infer<typeof StoreKindSchema>;

export const StoreGroupStatusSchema = z.enum(['ACTIVE', 'INACTIVE']);
export type StoreGroupStatus = z.infer<typeof StoreGroupStatusSchema>;

export const StoreGroupSchema = z
  .object({
    id: EntityIdSchema,
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(120),
    status: StoreGroupStatusSchema,
    version: z.number().int().nonnegative().safe(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type StoreGroup = z.infer<typeof StoreGroupSchema>;

export const StoreSchema = z
  .object({
    id: EntityIdSchema,
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(160),
    groupId: EntityIdSchema,
    kind: StoreKindSchema,
    status: StoreStatusSchema,
    address: z.string().trim().min(1).max(500).nullable(),
    version: z.number().int().nonnegative().safe(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type Store = z.infer<typeof StoreSchema>;

export const StoreParamsSchema = z.object({ storeId: EntityIdSchema }).strict();
export type StoreParams = z.infer<typeof StoreParamsSchema>;

export const StoreGroupParamsSchema = z.object({ groupId: EntityIdSchema }).strict();
export type StoreGroupParams = z.infer<typeof StoreGroupParamsSchema>;

export const CreateStoreRequestSchema = z
  .object({
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(160),
    groupId: EntityIdSchema,
    kind: StoreKindSchema,
    address: z.string().trim().min(1).max(500).nullable().default(null),
  })
  .strict();
export type CreateStoreRequest = z.infer<typeof CreateStoreRequestSchema>;

export const UpdateStoreRequestSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative().safe(),
    name: z.string().trim().min(1).max(160).optional(),
    groupId: EntityIdSchema.optional(),
    kind: StoreKindSchema.optional(),
    status: StoreStatusSchema.optional(),
    address: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .strict()
  .refine(
    (request) =>
      request.name !== undefined ||
      request.groupId !== undefined ||
      request.kind !== undefined ||
      request.status !== undefined ||
      request.address !== undefined,
    'At least one mutable field is required',
  );
export type UpdateStoreRequest = z.infer<typeof UpdateStoreRequestSchema>;

export const StoreResponseSchema = z.object({ data: StoreSchema }).strict();
export type StoreResponse = z.infer<typeof StoreResponseSchema>;

export const ListStoresQuerySchema = PaginationQuerySchema.extend({
  groupId: EntityIdSchema.optional(),
  kind: StoreKindSchema.optional(),
  status: StoreStatusSchema.optional(),
  search: z.string().trim().min(1).max(160).optional(),
}).strict();
export type ListStoresQuery = z.infer<typeof ListStoresQuerySchema>;

export const ListStoresResponseSchema = z
  .object({ data: z.array(StoreSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListStoresResponse = z.infer<typeof ListStoresResponseSchema>;

export const CreateStoreGroupRequestSchema = z
  .object({
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(120),
  })
  .strict();
export type CreateStoreGroupRequest = z.infer<typeof CreateStoreGroupRequestSchema>;

export const UpdateStoreGroupRequestSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative().safe(),
    name: z.string().trim().min(1).max(120).optional(),
    status: StoreGroupStatusSchema.optional(),
  })
  .strict()
  .refine(
    (request) => request.name !== undefined || request.status !== undefined,
    'At least one mutable field is required',
  );
export type UpdateStoreGroupRequest = z.infer<typeof UpdateStoreGroupRequestSchema>;

export const StoreGroupResponseSchema = z.object({ data: StoreGroupSchema }).strict();
export type StoreGroupResponse = z.infer<typeof StoreGroupResponseSchema>;

export const ListStoreGroupsQuerySchema = PaginationQuerySchema.extend({
  status: StoreGroupStatusSchema.optional(),
  search: z.string().trim().min(1).max(120).optional(),
}).strict();
export type ListStoreGroupsQuery = z.infer<typeof ListStoreGroupsQuerySchema>;

export const ListStoreGroupsResponseSchema = z
  .object({ data: z.array(StoreGroupSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListStoreGroupsResponse = z.infer<typeof ListStoreGroupsResponseSchema>;

export const HtkdAssignmentSchema = z
  .object({
    id: EntityIdSchema,
    htkdAccountId: EntityIdSchema,
    storeId: EntityIdSchema,
    assignedAt: IsoDateTimeSchema,
    assignedByAccountId: EntityIdSchema.nullable(),
    revokedAt: IsoDateTimeSchema.nullable(),
    revokedByAccountId: EntityIdSchema.nullable(),
  })
  .strict();
export type HtkdAssignment = z.infer<typeof HtkdAssignmentSchema>;

const UniqueStoreIdsSchema = z
  .array(EntityIdSchema)
  .max(500)
  .refine((storeIds) => new Set(storeIds).size === storeIds.length, 'Store IDs must be unique');

/** Replaces the active store scope for one HTKD account atomically. */
export const ReplaceHtkdAssignmentsRequestSchema = z
  .object({
    storeIds: UniqueStoreIdsSchema,
    reason: AuditReasonSchema,
    expectedSessionVersion: z.number().int().nonnegative(),
  })
  .strict();
export type ReplaceHtkdAssignmentsRequest = z.infer<typeof ReplaceHtkdAssignmentsRequestSchema>;

export const HtkdAssignmentParamsSchema = z.object({ htkdAccountId: EntityIdSchema }).strict();
export type HtkdAssignmentParams = z.infer<typeof HtkdAssignmentParamsSchema>;

export const HtkdAssignmentsResponseSchema = z
  .object({
    data: z
      .object({
        htkdAccountId: EntityIdSchema,
        sessionVersion: z.number().int().nonnegative(),
        assignments: z.array(HtkdAssignmentSchema),
      })
      .strict(),
  })
  .strict();
export type HtkdAssignmentsResponse = z.infer<typeof HtkdAssignmentsResponseSchema>;
