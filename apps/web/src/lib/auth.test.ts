import { QueryClient } from '@tanstack/react-query';
import type { Session } from '@idosi/contracts';
import { describe, expect, it } from 'vitest';

import { clearAuthenticatedSession, installAuthenticatedSession, sessionQueryKey } from './auth';

const session: Session = {
  createdAt: '2026-09-17T00:00:00.000Z',
  expiresAt: '2026-09-18T00:00:00.000Z',
  id: '90000000-0000-4000-8000-000000000001',
  lastSeenAt: '2026-09-17T00:01:00.000Z',
  principal: {
    accountId: '10000000-0000-4000-8000-000000000001',
    assignedStoreIds: [],
    displayName: 'Admin',
    role: 'ADMIN',
    status: 'ACTIVE',
    storeId: null,
    username: 'admin@idosi.local',
  },
};

describe('authentication cache boundary', () => {
  it('removes all previous business data before installing the new principal', () => {
    const client = new QueryClient();
    client.setQueryData(['store-inventory-bags', 'old-store'], [{ secret: 'old-scope' }]);
    client.setQueryData(['reports', 'old-store'], { revenue: 1 });

    installAuthenticatedSession(client, session);

    expect(client.getQueryData(['store-inventory-bags', 'old-store'])).toBeUndefined();
    expect(client.getQueryData(['reports', 'old-store'])).toBeUndefined();
    expect(client.getQueryData(sessionQueryKey)).toEqual(session);
  });

  it('removes business data and leaves an explicit signed-out session', () => {
    const client = new QueryClient();
    client.setQueryData(sessionQueryKey, session);
    client.setQueryData(['stores', 'accessible'], [{ id: 'old-store' }]);

    clearAuthenticatedSession(client);

    expect(client.getQueryData(['stores', 'accessible'])).toBeUndefined();
    expect(client.getQueryData(sessionQueryKey)).toBeNull();
  });
});
