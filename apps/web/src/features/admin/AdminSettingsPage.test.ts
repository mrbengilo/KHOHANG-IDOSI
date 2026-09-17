import type { OperationalSettingsVersion } from '@idosi/contracts';
import { describe, expect, it } from 'vitest';

import { settingsDraftFromVersion, settingsUpdateFromDraft } from './AdminSettingsPage';

const current: OperationalSettingsVersion = {
  id: '11111111-1111-4111-8111-111111111111',
  version: 4,
  timezone: 'Asia/Ho_Chi_Minh',
  snapshotTime: '08:00',
  cutoffTime: '09:00',
  maxRequestsPerStore: 2,
  policyVersion: 'ALLOC-v1.2',
  idosiSyncIntervalMinutes: 15,
  createdByAccountId: null,
  requestId: 'settings-request-4',
  createdAt: '2026-09-17T00:00:00.000Z',
};

describe('admin operational settings UI helpers', () => {
  it('maps the immutable current version into an editable draft', () => {
    expect(settingsDraftFromVersion(current)).toEqual({
      timezone: 'Asia/Ho_Chi_Minh',
      snapshotTime: '08:00',
      cutoffTime: '09:00',
      maxRequestsPerStore: '2',
      policyVersion: 'ALLOC-v1.2',
      idosiSyncIntervalMinutes: 15,
    });
  });

  it('builds a complete optimistic update and trims the policy version', () => {
    const result = settingsUpdateFromDraft(
      {
        ...settingsDraftFromVersion(current),
        maxRequestsPerStore: '3',
        policyVersion: '  ALLOC-v1.3  ',
        idosiSyncIntervalMinutes: 30,
      },
      current.version,
    );
    expect(result.error).toBeNull();
    expect(result.input).toEqual({
      expectedVersion: 4,
      timezone: 'Asia/Ho_Chi_Minh',
      snapshotTime: '08:00',
      cutoffTime: '09:00',
      maxRequestsPerStore: 3,
      policyVersion: 'ALLOC-v1.3',
      idosiSyncIntervalMinutes: 30,
    });
    expect(result.input).not.toHaveProperty('integrationSecret');
  });

  it('blocks invalid order windows and non-integer request limits before fetch', () => {
    expect(
      settingsUpdateFromDraft(
        { ...settingsDraftFromVersion(current), cutoffTime: '08:00' },
        current.version,
      ).error,
    ).toContain('sau giờ snapshot');
    expect(
      settingsUpdateFromDraft(
        { ...settingsDraftFromVersion(current), maxRequestsPerStore: '2.5' },
        current.version,
      ).error,
    ).toContain('số nguyên');
  });
});
