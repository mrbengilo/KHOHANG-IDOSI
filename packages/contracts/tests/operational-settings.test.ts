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
  policyVersion: 'idosi-round-robin-p0a-p3-v1',
  idosiSyncIntervalMinutes: 15,
  vatRatePercent: 8,
} as const;

describe('operational settings contracts', () => {
  it('rejects unknown policies before they can become the default for future sessions', () => {
    for (const policyVersion of ['idosi-round-robin-p0a-p3-v3', 'ALLOC-v1.2']) {
      expect(
        UpdateOperationalSettingsRequestSchema.safeParse({ ...validUpdate, policyVersion }).success,
      ).toBe(false);
    }
  });
  it('accepts integer VAT 0 through 100 and rejects fractions and non-finite values', () => {
    for (const vatRatePercent of [0, 8, 10, 100])
      expect(
        UpdateOperationalSettingsRequestSchema.safeParse({ ...validUpdate, vatRatePercent })
          .success,
      ).toBe(true);
    for (const vatRatePercent of [-1, 101, 8.5, NaN, Infinity, undefined])
      expect(
        UpdateOperationalSettingsRequestSchema.safeParse({ ...validUpdate, vatRatePercent })
          .success,
      ).toBe(false);
  });
  it('accepts the supported operational schedule and sync intervals', () => {
    expect(UpdateOperationalSettingsRequestSchema.safeParse(validUpdate).success).toBe(true);
    expect(
      UpdateOperationalSettingsRequestSchema.safeParse({
        ...validUpdate,
        idosiSyncIntervalMinutes: 30,
        vatRatePercent: 8,
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
      vatRatePercent: 8,
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
