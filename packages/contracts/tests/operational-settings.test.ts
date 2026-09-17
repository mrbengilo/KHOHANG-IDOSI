import { describe, expect, it } from 'vitest';

import {
  OperationalSettingsOverviewSchema,
  UpdateOperationalSettingsRequestSchema,
} from '../src/index.js';

const validUpdate = {
  expectedVersion: 1,
  timezone: 'Asia/Ho_Chi_Minh',
  snapshotTime: '08:00',
  cutoffTime: '09:00',
  maxRequestsPerStore: 2,
  policyVersion: 'ALLOC-v1.2',
  idosiSyncIntervalMinutes: 15,
} as const;

describe('operational settings contracts', () => {
  it('accepts the supported operational schedule and sync intervals', () => {
    expect(UpdateOperationalSettingsRequestSchema.safeParse(validUpdate).success).toBe(true);
    expect(
      UpdateOperationalSettingsRequestSchema.safeParse({
        ...validUpdate,
        idosiSyncIntervalMinutes: 30,
      }).success,
    ).toBe(true);
  });

  it('requires cutoff after snapshot and rejects unsupported configuration', () => {
    expect(
      UpdateOperationalSettingsRequestSchema.safeParse({
        ...validUpdate,
        cutoffTime: '08:00',
      }).success,
    ).toBe(false);
    expect(
      UpdateOperationalSettingsRequestSchema.safeParse({
        ...validUpdate,
        timezone: 'UTC',
      }).success,
    ).toBe(false);
    expect(
      UpdateOperationalSettingsRequestSchema.safeParse({
        ...validUpdate,
        idosiSyncIntervalMinutes: 10,
      }).success,
    ).toBe(false);
  });

  it('strictly rejects secret input and secret output fields', () => {
    expect(
      UpdateOperationalSettingsRequestSchema.safeParse({
        ...validUpdate,
        integrationSecret: 'must-never-be-accepted',
      }).success,
    ).toBe(false);

    const version = {
      id: '11111111-1111-4111-8111-111111111111',
      version: 1,
      timezone: 'Asia/Ho_Chi_Minh',
      snapshotTime: '08:00',
      cutoffTime: '09:00',
      maxRequestsPerStore: 2,
      policyVersion: 'ALLOC-v1.2',
      idosiSyncIntervalMinutes: 15,
      createdByAccountId: null,
      requestId: 'migration:0003',
      createdAt: '2026-09-17T00:00:00.000Z',
    };
    expect(
      OperationalSettingsOverviewSchema.safeParse({
        current: version,
        history: [version],
        integration: {
          endpoint: 'https://idosi.io.vn/api/integrations/warehouse/v1/order-statistics',
          status: 'CONFIGURED',
        },
      }).success,
    ).toBe(true);
    expect(
      OperationalSettingsOverviewSchema.safeParse({
        current: version,
        history: [version],
        integration: {
          endpoint: 'https://idosi.io.vn/api/integrations/warehouse/v1/order-statistics',
          status: 'CONFIGURED',
          secret: 'must-never-be-returned',
        },
      }).success,
    ).toBe(false);
  });
});
