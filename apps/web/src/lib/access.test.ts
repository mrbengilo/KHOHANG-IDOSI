import { describe, expect, it } from 'vitest';
import { canAccessRoute, canShowNavigation } from './access';

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
    expect(canAccessRoute('/warehouse-inbound', 'HTKD', null)).toBe(false);
    expect(canAccessRoute('/audit', 'HTKD', null)).toBe(false);
    expect(canAccessRoute('/catalog', 'HTKD', null)).toBe(true);
  });

  it('separates wholesale and retail store operations', () => {
    expect(canAccessRoute('/requests', 'STORE', 'WHOLESALE')).toBe(true);
    expect(canAccessRoute('/allocations', 'STORE', 'WHOLESALE')).toBe(true);
    expect(canAccessRoute('/receive', 'STORE', 'WHOLESALE')).toBe(false);
    expect(canAccessRoute('/receive', 'STORE', 'RETAIL')).toBe(true);
  });

  it('fails closed for unknown routes', () => {
    expect(canAccessRoute('/unregistered', 'ADMIN', null)).toBe(false);
  });
});
