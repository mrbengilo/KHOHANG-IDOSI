import { describe, expect, it } from 'vitest';

import {
  AuthenticatedPrincipalSchema,
  CreateAccountRequestSchema,
  CreateStoreRequestSchema,
  ListStoresQuerySchema,
  ReplaceHtkdAssignmentsRequestSchema,
  UpdateAccountRequestSchema,
} from '../src/index.js';

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_STORE_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const STORE_GROUP_ID = '44444444-4444-4444-8444-444444444444';

describe('identity and store-scope contracts', () => {
  it('requires store accounts to reference exactly one store', () => {
    expect(
      CreateAccountRequestSchema.safeParse({
        username: 'store.one',
        displayName: 'Store One',
        password: 'a-strong-password',
        role: 'STORE',
        storeId: STORE_ID,
      }).success,
    ).toBe(true);
    expect(
      CreateAccountRequestSchema.safeParse({
        username: 'store.one',
        displayName: 'Store One',
        password: 'a-strong-password',
        role: 'STORE',
      }).success,
    ).toBe(false);
    expect(
      CreateAccountRequestSchema.safeParse({
        username: 'admin.one',
        displayName: 'Admin One',
        password: 'a-strong-password',
        role: 'ADMIN',
        storeId: STORE_ID,
      }).success,
    ).toBe(false);
  });

  it('only represents active accounts as authenticated principals', () => {
    const principal = {
      accountId: ACCOUNT_ID,
      username: 'seller.one',
      displayName: 'Seller One',
      role: 'STORE',
      status: 'ACTIVE',
      storeId: STORE_ID,
      assignedStoreIds: [],
    };
    expect(AuthenticatedPrincipalSchema.safeParse(principal).success).toBe(true);
    expect(AuthenticatedPrincipalSchema.safeParse({ ...principal, status: 'LOCKED' }).success).toBe(
      false,
    );
    expect(
      AuthenticatedPrincipalSchema.safeParse({ ...principal, assignedStoreIds: [OTHER_STORE_ID] })
        .success,
    ).toBe(false);
  });

  it('rejects empty account patches', () => {
    expect(UpdateAccountRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateAccountRequestSchema.safeParse({ status: 'LOCKED' }).success).toBe(true);
  });

  it('rejects duplicate stores in an HTKD assignment replacement', () => {
    expect(
      ReplaceHtkdAssignmentsRequestSchema.safeParse({
        storeIds: [STORE_ID, OTHER_STORE_ID],
        reason: 'Territory rotation',
      }).success,
    ).toBe(true);
    expect(
      ReplaceHtkdAssignmentsRequestSchema.safeParse({
        storeIds: [STORE_ID, STORE_ID],
        reason: 'Territory rotation',
      }).success,
    ).toBe(false);
  });

  it('requires an explicit store kind and supports wholesale filtering', () => {
    expect(
      CreateStoreRequestSchema.parse({
        code: 'DS_TEST',
        groupId: STORE_GROUP_ID,
        kind: 'RETAIL',
        name: 'Test Store',
      }).kind,
    ).toBe('RETAIL');
    expect(
      CreateStoreRequestSchema.safeParse({ code: 'UNGROUPED', name: 'Ungrouped Store' }).success,
    ).toBe(false);
    expect(
      CreateStoreRequestSchema.safeParse({
        code: 'MISSING_KIND',
        groupId: STORE_GROUP_ID,
        name: 'Missing Kind',
      }).success,
    ).toBe(false);
    expect(ListStoresQuerySchema.parse({ kind: 'WHOLESALE' }).kind).toBe('WHOLESALE');
    expect(ListStoresQuerySchema.safeParse({ kind: 'FRANCHISE' }).success).toBe(false);
  });
});
