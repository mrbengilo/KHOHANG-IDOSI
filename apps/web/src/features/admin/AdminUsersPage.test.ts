import type { Account } from '@idosi/contracts';
import { describe, expect, it } from 'vitest';

import {
  accountQueryFromFilters,
  accountStatusRequest,
  createAccountInputFromDraft,
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
});
