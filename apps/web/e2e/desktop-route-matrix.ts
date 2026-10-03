import { canAccessRoute, routeAccessPolicies } from '../src/lib/access';
import type { Role, StoreKind } from '../src/lib/types';

// Route × role manifest derived from apps/web/src/lib/access.ts; denied routes are tested separately.
export const desktopViewports = [
  [1366, 768],
  [1440, 900],
  [1920, 1080],
  [2560, 1440],
] as const;

/** The four principals the mock build can impersonate (the WHOLESALE desk runs in e2e-live). */
const mockPrincipals: Record<string, readonly [Role, StoreKind | null]> = {
  ADMIN: ['ADMIN', null],
  HTKD: ['HTKD', null],
  STORE_RETAIL: ['STORE', 'RETAIL'],
  STORE_WHOLESALE: ['STORE', 'WHOLESALE'],
};

// Derived, not hand-written: a hand-kept list silently dropped HTKD /open-bag, /sales, /sorting
// and retail /partner-inbound. Includes screens reachable by direct link but hidden from the menu.
export const routesByRole: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(mockPrincipals).map(([mode, [role, storeKind]]) => [
    mode,
    Object.keys(routeAccessPolicies).filter((route) => canAccessRoute(route, role, storeKind)),
  ]),
);
