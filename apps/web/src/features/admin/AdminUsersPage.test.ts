import type { Account } from '@idosi/contracts';
import { describe, expect, it } from 'vitest';

import {
  accountQueryFromFilters,
  accountStatusRequest,
  createAccountInputFromDraft,
  htkdAssignmentRequestFromDraft,
  sameStoreSelection,
  updateStorePageSelection,
  validatePasswordReset,
} from './AdminUsersPage';

const account: Account = {
  createdAt: '2026-09-17T00:00:00.000Z',
  displayName: 'Cửa hàng test',
  id: '11111111-1111-4111-8111-111111111111',
  role: 'STORE',
  sessionVersion: 7,
  status: 'ACTIVE',
  storeId: '22222222-2222-4222-8222-222222222222',
  updatedAt: '2026-09-17T00:00:00.000Z',
  username: 'store.test',
};

describe('admin account UI helpers', () => {
  it('builds trimmed server-side filters and fixed pagination', () => {
    expect(
      accountQueryFromFilters({ role: 'STORE', search: '  test  ', status: 'ACTIVE' }, 3),
    ).toEqual({ page: 3, pageSize: 20, role: 'STORE', search: 'test', status: 'ACTIVE' });
  });

  it('requires a store and matching strong passwords before account creation', () => {
    expect(
      createAccountInputFromDraft({
        confirmPassword: 'secure-password',
        displayName: 'Cửa hàng mới',
        password: 'secure-password',
        role: 'STORE',
        storeId: '',
        username: 'store.new',
      }).error,
    ).toContain('chọn cửa hàng');
    expect(validatePasswordReset('secure-password', 'different-password')).toContain('trùng khớp');
  });

  it('never sends password confirmation and includes the current session version', () => {
    const parsed = createAccountInputFromDraft({
      confirmPassword: 'secure-password',
      displayName: '  HTKD mới  ',
      password: 'secure-password',
      role: 'HTKD',
      storeId: '',
      username: '  htkd.new  ',
    });
    expect(parsed.input).toEqual({
      displayName: 'HTKD mới',
      password: 'secure-password',
      role: 'HTKD',
      storeId: null,
      username: 'htkd.new',
    });
    expect(parsed.input).not.toHaveProperty('confirmPassword');
    expect(accountStatusRequest(account, 'LOCKED')).toEqual({
      expectedSessionVersion: 7,
      status: 'LOCKED',
    });
  });

  it('builds an audited HTKD replacement and allows revoking every store', () => {
    expect(htkdAssignmentRequestFromDraft([], '  Thu hồi toàn bộ địa bàn  ', 4)).toEqual({
      error: null,
      input: {
        expectedSessionVersion: 4,
        reason: 'Thu hồi toàn bộ địa bàn',
        storeIds: [],
      },
    });
    expect(htkdAssignmentRequestFromDraft([], 'x', 4).error).toContain('ít nhất 3');
  });

  it('compares assignment selections independent of order and duplicate UI values', () => {
    const firstStoreId = '22222222-2222-4222-8222-222222222222';
    const secondStoreId = '33333333-3333-4333-8333-333333333333';
    expect(
      sameStoreSelection(
        [firstStoreId, secondStoreId],
        [secondStoreId, firstStoreId, secondStoreId],
      ),
    ).toBe(true);
    expect(sameStoreSelection([firstStoreId], [secondStoreId])).toBe(false);
  });

  it('updates one visible store page without losing selections from other pages', () => {
    const firstStoreId = '22222222-2222-4222-8222-222222222222';
    const secondStoreId = '33333333-3333-4333-8333-333333333333';
    const offPageStoreId = '44444444-4444-4444-8444-444444444444';
    const selected = updateStorePageSelection(
      new Set([offPageStoreId]),
      [firstStoreId, secondStoreId],
      true,
    );
    expect([...selected].toSorted()).toEqual(
      [firstStoreId, secondStoreId, offPageStoreId].toSorted(),
    );
    expect(
      [...updateStorePageSelection(selected, [firstStoreId, secondStoreId], false)].toSorted(),
    ).toEqual([offPageStoreId]);
  });
});
