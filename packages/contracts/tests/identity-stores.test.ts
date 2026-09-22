import { describe, expect, it } from 'vitest';

import {
  AuthenticatedPrincipalSchema,
  CreateAccountRequestSchema,
  CreateStoreRequestSchema,
  ListStoreGroupsQuerySchema,
  ListStoresQuerySchema,
  ReplaceHtkdAssignmentsRequestSchema,
  UpdateAccountRequestSchema,
  UpdateStoreGroupRequestSchema,
  UpdateStoreRequestSchema,
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

  it('keeps the wholesale desk free of a single store and scoped by assignment', () => {
    expect(
      CreateAccountRequestSchema.safeParse({
        username: 'wholesale.desk',
        displayName: 'Cửa hàng sỉ',
        password: 'a-strong-password',
        role: 'WHOLESALE',
      }).success,
    ).toBe(true);
    expect(
      CreateAccountRequestSchema.safeParse({
        username: 'wholesale.desk',
        displayName: 'Cửa hàng sỉ',
        password: 'a-strong-password',
        role: 'WHOLESALE',
        storeId: STORE_ID,
      }).success,
    ).toBe(false);

    const desk = {
      accountId: ACCOUNT_ID,
      username: 'wholesale.desk',
      displayName: 'Cửa hàng sỉ',
      role: 'WHOLESALE',
      status: 'ACTIVE',
      storeId: null,
      assignedStoreIds: [STORE_ID, OTHER_STORE_ID],
    };
    expect(AuthenticatedPrincipalSchema.safeParse(desk).success).toBe(true);
    expect(AuthenticatedPrincipalSchema.safeParse({ ...desk, storeId: STORE_ID }).success).toBe(
      false,
    );
  });

  it('rejects empty account patches', () => {
    expect(UpdateAccountRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateAccountRequestSchema.safeParse({ status: 'LOCKED' }).success).toBe(false);
    expect(
      UpdateAccountRequestSchema.safeParse({
        status: 'LOCKED',
        expectedSessionVersion: 0,
      }).success,
    ).toBe(true);
  });

  it('rejects duplicate stores in an HTKD assignment replacement', () => {
    expect(
      ReplaceHtkdAssignmentsRequestSchema.safeParse({
        storeIds: [STORE_ID, OTHER_STORE_ID],
        reason: 'Territory rotation',
        expectedSessionVersion: 0,
      }).success,
    ).toBe(true);
    expect(
      ReplaceHtkdAssignmentsRequestSchema.safeParse({
        storeIds: [STORE_ID, STORE_ID],
        reason: 'Territory rotation',
        expectedSessionVersion: 0,
      }).success,
    ).toBe(false);
  });

  it('allows an explicit empty HTKD scope to revoke every store assignment', () => {
    expect(
      ReplaceHtkdAssignmentsRequestSchema.parse({
        storeIds: [],
        reason: 'Thu hồi toàn bộ phạm vi phụ trách',
        expectedSessionVersion: 3,
      }),
    ).toEqual({
      storeIds: [],
      reason: 'Thu hồi toàn bộ phạm vi phụ trách',
      expectedSessionVersion: 3,
    });
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

  it('requires optimistic versions and mutable fields for store lifecycle patches', () => {
    expect(UpdateStoreRequestSchema.safeParse({ status: 'INACTIVE' }).success).toBe(false);
    expect(UpdateStoreRequestSchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
    expect(
      UpdateStoreRequestSchema.safeParse({ expectedVersion: 0, status: 'INACTIVE' }).success,
    ).toBe(true);

    expect(UpdateStoreGroupRequestSchema.safeParse({ name: 'Miền Nam' }).success).toBe(false);
    expect(UpdateStoreGroupRequestSchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
    expect(
      UpdateStoreGroupRequestSchema.safeParse({ expectedVersion: 0, name: 'Miền Nam' }).success,
    ).toBe(true);
  });

  it('supports paginated store-group lifecycle filters', () => {
    expect(ListStoreGroupsQuerySchema.parse({ status: 'INACTIVE', search: 'miền' })).toMatchObject({
      page: 1,
      pageSize: 20,
      status: 'INACTIVE',
      search: 'miền',
    });
    expect(ListStoreGroupsQuerySchema.safeParse({ status: 'ARCHIVED' }).success).toBe(false);
  });
});
