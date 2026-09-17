import { z } from 'zod';

import { EntityIdSchema, IsoDateTimeSchema } from './common.js';

const BUSINESS_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export const BusinessTimeSchema = z
  .string()
  .regex(BUSINESS_TIME_PATTERN, 'Expected a 24-hour time in HH:mm format');
export type BusinessTime = z.infer<typeof BusinessTimeSchema>;

export const OperationalTimezoneSchema = z.literal('Asia/Ho_Chi_Minh');
export type OperationalTimezone = z.infer<typeof OperationalTimezoneSchema>;

export const IdosiSyncIntervalMinutesSchema = z.union([z.literal(15), z.literal(30)]);
export type IdosiSyncIntervalMinutes = z.infer<typeof IdosiSyncIntervalMinutesSchema>;

export const OperationalSettingsVersionSchema = z
  .object({
    id: EntityIdSchema,
    version: z.number().int().positive(),
    timezone: OperationalTimezoneSchema,
    snapshotTime: BusinessTimeSchema,
    cutoffTime: BusinessTimeSchema,
    maxRequestsPerStore: z.number().int().min(1).max(10),
    policyVersion: z.string().trim().min(3).max(64),
    idosiSyncIntervalMinutes: IdosiSyncIntervalMinutesSchema,
    createdByAccountId: EntityIdSchema.nullable(),
    requestId: z.string().trim().min(1).max(128),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type OperationalSettingsVersion = z.infer<typeof OperationalSettingsVersionSchema>;

export const IdosiIntegrationStatusSchema = z
  .object({
    endpoint: z.string().url().max(2_048),
    status: z.enum(['CONFIGURED', 'NOT_CONFIGURED']),
  })
  .strict();
export type IdosiIntegrationStatus = z.infer<typeof IdosiIntegrationStatusSchema>;

export const OperationalSettingsOverviewSchema = z
  .object({
    current: OperationalSettingsVersionSchema,
    history: z.array(OperationalSettingsVersionSchema),
    integration: IdosiIntegrationStatusSchema,
  })
  .strict();
export type OperationalSettingsOverview = z.infer<typeof OperationalSettingsOverviewSchema>;

export const GetOperationalSettingsQuerySchema = z
  .object({
    historyLimit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();
export type GetOperationalSettingsQuery = z.infer<typeof GetOperationalSettingsQuerySchema>;

export const UpdateOperationalSettingsRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    timezone: OperationalTimezoneSchema,
    snapshotTime: BusinessTimeSchema,
    cutoffTime: BusinessTimeSchema,
    maxRequestsPerStore: z.number().int().min(1).max(10),
    policyVersion: z.string().trim().min(3).max(64),
    idosiSyncIntervalMinutes: IdosiSyncIntervalMinutesSchema,
  })
  .strict()
  .refine((settings) => settings.cutoffTime > settings.snapshotTime, {
    path: ['cutoffTime'],
    message: 'Cutoff time must be after snapshot time',
  });
export type UpdateOperationalSettingsRequest = z.infer<
  typeof UpdateOperationalSettingsRequestSchema
>;

export const OperationalSettingsOverviewResponseSchema = z
  .object({ data: OperationalSettingsOverviewSchema })
  .strict();
export type OperationalSettingsOverviewResponse = z.infer<
  typeof OperationalSettingsOverviewResponseSchema
>;
