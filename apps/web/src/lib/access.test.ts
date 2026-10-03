import { describe, expect, it } from 'vitest';
import { canAccessRoute, canShowNavigation, routeAccessPolicies } from './access';
import type { Role, StoreKind } from './types';

describe('route access policy', () => {
  it('keeps store ordering, receiving and opening out of the admin workspace', () => {
    for (const route of ['/requests', '/receive', '/open-bag']) {
      expect(canShowNavigation(route, 'ADMIN', null)).toBe(false);
      expect(canAccessRoute(route, 'ADMIN', null)).toBe(true);
      expect(canAccessRoute(route, 'HTKD', null)).toBe(true);
      expect(canAccessRoute(route, 'STORE', 'RETAIL')).toBe(true);
    }
    expect(canAccessRoute('/costs', 'ADMIN', null)).toBe(true);
    expect(canShowNavigation('/costs', 'ADMIN', null)).toBe(true);
    expect(canShowNavigation('/costs', 'HTKD', null)).toBe(true);
    expect(canShowNavigation('/costs', 'STORE', 'RETAIL')).toBe(false);
  });
  it('keeps admin-only screens unavailable to stores', () => {
    expect(canAccessRoute('/users', 'STORE', 'RETAIL')).toBe(false);
    expect(canAccessRoute('/stores', 'HTKD', null)).toBe(false);
    expect(canAccessRoute('/stores', 'ADMIN', null)).toBe(true);
    expect(canAccessRoute('/warehouse-inbound', 'ADMIN', null)).toBe(true);
    expect(canAccessRoute('/warehouse-inbound', 'STORE', 'RETAIL')).toBe(false);
    expect(canAccessRoute('/warehouse-inbound', 'HTKD', null)).toBe(true);
    expect(canAccessRoute('/audit', 'HTKD', null)).toBe(false);
    expect(canAccessRoute('/catalog', 'HTKD', null)).toBe(true);
  });

  it('separates wholesale and retail store operations', () => {
    expect(canAccessRoute('/requests', 'STORE', 'WHOLESALE')).toBe(true);
    expect(canAccessRoute('/allocations', 'STORE', 'WHOLESALE')).toBe(true);
    expect(canAccessRoute('/receive', 'STORE', 'WHOLESALE')).toBe(false);
    expect(canAccessRoute('/receive', 'STORE', 'RETAIL')).toBe(true);
  });

  it('gives the wholesale desk ordering and receiving but no retail-floor screens', () => {
    for (const route of ['/', '/allocations', '/requests', '/receive']) {
      expect(canAccessRoute(route, 'WHOLESALE', null)).toBe(true);
      expect(canShowNavigation(route, 'WHOLESALE', null)).toBe(true);
    }
    for (const route of ['/inventory', '/open-bag', '/sales', '/sorting', '/transfers']) {
      expect(canAccessRoute(route, 'WHOLESALE', null)).toBe(false);
    }
    expect(canAccessRoute('/users', 'WHOLESALE', null)).toBe(false);
    expect(canAccessRoute('/warehouse-inbound', 'WHOLESALE', null)).toBe(false);
  });

  it('keeps partner inbound on retail store accounts and their assigned HTKD', () => {
    expect(canAccessRoute('/partner-inbound', 'STORE', 'RETAIL')).toBe(true);
    expect(canAccessRoute('/partner-inbound', 'STORE', 'WHOLESALE')).toBe(false);
    expect(canAccessRoute('/partner-inbound', 'HTKD', null)).toBe(true);
    expect(canAccessRoute('/partner-inbound', 'WHOLESALE', null)).toBe(false);
    expect(canAccessRoute('/partner-inbound', 'ADMIN', null)).toBe(false);
  });

  it('fails closed for unknown routes', () => {
    expect(canAccessRoute('/unregistered', 'ADMIN', null)).toBe(false);
  });

  it('matches the reviewed route × principal table exactly', () => {
    // Written from the business rules (AGENTS.md §3, docs) rather than derived from access.ts:
    // a policy edit must update this table on purpose, and a new route cannot ship unreviewed.
    // Columns: ADMIN, HTKD, STORE retail, STORE wholesale, WHOLESALE desk.
    const expected: Record<string, readonly [0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1]> = {
      '/': [1, 1, 1, 1, 1],
      '/allocations': [1, 1, 1, 1, 1],
      '/requests': [1, 1, 1, 1, 1],
      '/warehouse-inbound': [1, 1, 0, 0, 0],
      '/receive': [1, 1, 1, 0, 1],
      '/partner-inbound': [0, 1, 1, 0, 0],
      '/inventory': [1, 1, 1, 0, 0],
      '/open-bag': [1, 1, 1, 0, 0],
      '/sales': [1, 1, 1, 0, 0],
      '/sorting': [1, 1, 1, 0, 0],
      '/transfers': [1, 1, 1, 0, 0],
      '/catalog': [1, 1, 0, 0, 0],
      '/costs': [1, 1, 0, 0, 0],
      '/inbound-statistics': [1, 0, 0, 0, 0],
      '/reports': [1, 1, 0, 0, 0],
      '/stores': [1, 0, 0, 0, 0],
      '/users': [1, 0, 0, 0, 0],
      '/audit': [1, 0, 0, 0, 0],
      '/settings': [1, 0, 0, 0, 0],
    };
    const principals: readonly (readonly [Role, StoreKind | null])[] = [
      ['ADMIN', null],
      ['HTKD', null],
      ['STORE', 'RETAIL'],
      ['STORE', 'WHOLESALE'],
      ['WHOLESALE', null],
    ];
    expect(Object.keys(routeAccessPolicies).sort()).toEqual(Object.keys(expected).sort());
    for (const [route, row] of Object.entries(expected)) {
      principals.forEach(([role, storeKind], index) => {
        expect(canAccessRoute(route, role, storeKind), `${route} ${role}/${storeKind}`).toBe(
          row[index] === 1,
        );
      });
    }
    // A store account whose kind is unknown is locked out of every kind-scoped screen.
    for (const [route, policy] of Object.entries(routeAccessPolicies)) {
      if ('storeKinds' in policy) expect(canAccessRoute(route, 'STORE', null)).toBe(false);
    }
  });
});
