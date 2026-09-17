import { z } from 'zod';

import {
  EntityIdSchema,
  IsoDateTimeSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
} from './common.js';
import { AccountRoleSchema } from './identity.js';

const AuditSnapshotSchema = z.record(z.string(), z.unknown());

export const AdminAuditLogSchema = z
  .object({
    id: EntityIdSchema,
    requestId: z.string().trim().min(1).max(128).nullable(),
    actorAccountId: EntityIdSchema.nullable(),
    actorRole: AccountRoleSchema.nullable(),
    actorStoreId: EntityIdSchema.nullable(),
    action: z.string().trim().min(1).max(160),
    entityType: z.string().trim().min(1).max(160),
    entityId: EntityIdSchema.nullable(),
    before: AuditSnapshotSchema.nullable(),
    after: AuditSnapshotSchema.nullable(),
    metadata: AuditSnapshotSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type AdminAuditLog = z.infer<typeof AdminAuditLogSchema>;

export const ListAuditLogsQuerySchema = PaginationQuerySchema.extend({
  actorAccountId: EntityIdSchema.optional(),
  action: z.string().trim().min(1).max(160).optional(),
  entityType: z.string().trim().min(1).max(160).optional(),
  entityId: EntityIdSchema.optional(),
  requestId: z.string().trim().min(1).max(128).optional(),
  createdFrom: IsoDateTimeSchema.optional(),
  createdTo: IsoDateTimeSchema.optional(),
})
  .strict()
  .refine(
    (query) =>
      query.createdFrom === undefined ||
      query.createdTo === undefined ||
      query.createdFrom <= query.createdTo,
    { path: ['createdTo'], message: 'createdTo must not be before createdFrom' },
  );
export type ListAuditLogsQuery = z.infer<typeof ListAuditLogsQuerySchema>;

export const ListAuditLogsResponseSchema = z
  .object({
    data: z.array(AdminAuditLogSchema),
    pagination: PaginationMetaSchema,
  })
  .strict();
export type ListAuditLogsResponse = z.infer<typeof ListAuditLogsResponseSchema>;
