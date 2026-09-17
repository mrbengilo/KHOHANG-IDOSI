import type { Store, StoreGroup } from '@idosi/contracts';
import { describe, expect, it } from 'vitest';

import {
  createStoreGroupInputFromDraft,
  createStoreInputFromDraft,
  storeGroupQueryFromFilters,
  storeQueryFromFilters,
  updateStoreGroupInputFromDraft,
  updateStoreInputFromDraft,
} from './AdminStoresPage';

const group: StoreGroup = {
  code: 'MIEN_NAM',
  createdAt: '2026-09-17T00:00:00.000Z',
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Miền Nam',
  status: 'ACTIVE',
  updatedAt: '2026-09-17T00:00:00.000Z',
  version: 3,
};

const store: Store = {
  address: 'Quận 1',
  code: 'DS_Q1',
  createdAt: '2026-09-17T00:00:00.000Z',
  groupId: group.id,
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'RETAIL',
  name: 'DS Quận 1',
  status: 'ACTIVE',
  updatedAt: '2026-09-17T00:00:00.000Z',
  version: 7,
};

describe('admin store lifecycle UI helpers', () => {
  it('builds trimmed server-side group and store filters', () => {
    expect(storeGroupQueryFromFilters({ search: '  %_Nam  ', status: 'ACTIVE' }, 2)).toEqual({
      page: 2,
      pageSize: 20,
      search: '%_Nam',
      status: 'ACTIVE',
    });
    expect(
      storeQueryFromFilters(
        { groupId: group.id, kind: 'RETAIL', search: '  DS  ', status: 'INACTIVE' },
        4,
      ),
    ).toEqual({
      groupId: group.id,
      kind: 'RETAIL',
      page: 4,
      pageSize: 20,
      search: 'DS',
      status: 'INACTIVE',
    });
  });

  it('normalizes create payloads before they reach the API client', () => {
    expect(
      createStoreGroupInputFromDraft({ code: '  TEST  ', name: '  Nhóm test  ', status: 'ACTIVE' })
        .input,
    ).toEqual({ code: 'TEST', name: 'Nhóm test' });
    expect(
      createStoreInputFromDraft({
        address: '   ',
        code: '  DS_TEST ',
        groupId: group.id,
        kind: 'RETAIL',
        name: '  DS Test  ',
        status: 'ACTIVE',
      }).input,
    ).toEqual({
      address: null,
      code: 'DS_TEST',
      groupId: group.id,
      kind: 'RETAIL',
      name: 'DS Test',
    });
  });

  it('includes exact optimistic versions and only changed fields', () => {
    expect(
      updateStoreGroupInputFromDraft(group, {
        code: group.code,
        name: 'Miền Nam mới',
        status: 'INACTIVE',
      }).input,
    ).toEqual({ expectedVersion: 3, name: 'Miền Nam mới', status: 'INACTIVE' });
    expect(
      updateStoreInputFromDraft(store, {
        address: '',
        code: store.code,
        groupId: store.groupId,
        kind: 'WHOLESALE',
        name: store.name,
        status: store.status,
      }).input,
    ).toEqual({ address: null, expectedVersion: 7, kind: 'WHOLESALE' });
  });

  it('blocks no-op updates before creating an idempotent mutation', () => {
    expect(
      updateStoreGroupInputFromDraft(group, {
        code: group.code,
        name: group.name,
        status: group.status,
      }).error,
    ).toContain('Chưa có thay đổi');
    expect(
      updateStoreInputFromDraft(store, {
        address: store.address ?? '',
        code: store.code,
        groupId: store.groupId,
        kind: store.kind,
        name: store.name,
        status: store.status,
      }).error,
    ).toContain('Chưa có thay đổi');
  });
});
