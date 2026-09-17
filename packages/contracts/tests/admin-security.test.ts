import { describe, expect, it } from 'vitest';

import {
  AdminAuditLogSchema,
  ListAuditLogsQuerySchema,
  ResetPasswordRequestSchema,
  UpdateAccountRequestSchema,
} from '../src/index.js';

describe('admin security contracts', () => {
  it('requires optimistic versioning for password resets', () => {
    expect(
      ResetPasswordRequestSchema.safeParse({
        newPassword: 'a-new-strong-password',
        expectedSessionVersion: 2,
      }).success,
    ).toBe(true);
    expect(
      ResetPasswordRequestSchema.safeParse({ newPassword: 'a-new-strong-password' }).success,
    ).toBe(false);
  });

  it('does not accept a version-only account patch', () => {
    expect(UpdateAccountRequestSchema.safeParse({ expectedSessionVersion: 1 }).success).toBe(false);
    expect(UpdateAccountRequestSchema.safeParse({ status: 'LOCKED' }).success).toBe(false);
    expect(
      UpdateAccountRequestSchema.safeParse({
        status: 'LOCKED',
        expectedSessionVersion: 1,
      }).success,
    ).toBe(true);
  });

  it('validates ordered audit time filters', () => {
    expect(
      ListAuditLogsQuerySchema.safeParse({
        createdFrom: '2026-09-18T00:00:00.000Z',
        createdTo: '2026-09-17T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('keeps audit responses strict and secret-free at the schema boundary', () => {
    const event = {
      id: '11111111-1111-4111-8111-111111111111',
      requestId: 'request-1',
      actorAccountId: '22222222-2222-4222-8222-222222222222',
      actorRole: 'ADMIN',
      actorStoreId: null,
      action: 'ACCOUNT_PASSWORD_RESET',
      entityType: 'user',
      entityId: '33333333-3333-4333-8333-333333333333',
      before: { sessionVersion: 0 },
      after: { sessionVersion: 1 },
      metadata: { sessionsRevoked: 2 },
      createdAt: '2026-09-17T00:00:00.000Z',
    };
    expect(AdminAuditLogSchema.safeParse(event).success).toBe(true);
    expect(
      AdminAuditLogSchema.safeParse({ ...event, passwordHash: 'never-return-this' }).success,
    ).toBe(false);
  });
});
