import { describe, expect, it } from 'vitest';
import { canAccessRoute } from './access';

describe('route access policy', () => {
  it('keeps admin-only screens unavailable to stores', () => {
    expect(canAccessRoute('/users', 'STORE', 'RETAIL')).toBe(false);
    expect(canAccessRoute('/stores', 'HTKD', null)).toBe(false);
    expect(canAccessRoute('/stores', 'ADMIN', null)).toBe(true);
    expect(canAccessRoute('/audit', 'HTKD', null)).toBe(false);
    expect(canAccessRoute('/catalog', 'HTKD', null)).toBe(true);
  });

  it('separates wholesale and retail store operations', () => {
    expect(canAccessRoute('/requests', 'STORE', 'WHOLESALE')).toBe(true);
    expect(canAccessRoute('/receive', 'STORE', 'WHOLESALE')).toBe(false);
    expect(canAccessRoute('/receive', 'STORE', 'RETAIL')).toBe(true);
  });

  it('fails closed for unknown routes', () => {
    expect(canAccessRoute('/unregistered', 'ADMIN', null)).toBe(false);
  });
});
