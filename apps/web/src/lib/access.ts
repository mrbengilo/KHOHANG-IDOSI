import type { Role, StoreKind } from './types';

export interface RouteAccessPolicy {
  readonly roles: readonly Role[];
  readonly storeKinds?: readonly StoreKind[];
}

/**
 * WHOLESALE is the "Cửa hàng sỉ" desk. It orders and receives for the wholesale stores and
 * follows its slips and allocation results, so it gets those four routes and nothing else:
 * opening bags, retail sales, sorting and store transfers are retail-floor work.
 */
export const routeAccessPolicies = {
  '/': { roles: ['ADMIN', 'HTKD', 'STORE', 'WHOLESALE'] },
  '/allocations': { roles: ['ADMIN', 'HTKD', 'STORE', 'WHOLESALE'] },
  '/requests': { roles: ['ADMIN', 'HTKD', 'STORE', 'WHOLESALE'] },
  '/warehouse-inbound': { roles: ['ADMIN', 'HTKD'] },
  '/receive': {
    roles: ['ADMIN', 'HTKD', 'STORE', 'WHOLESALE'],
    storeKinds: ['RETAIL'],
  },
  // Partner goods land in the retail floor's own stock, so only its own account records
  // them; admins and HTKD read store stock through the reports, not by writing to it.
  '/partner-inbound': {
    roles: ['STORE'],
    storeKinds: ['RETAIL'],
  },
  '/inventory': {
    roles: ['ADMIN', 'HTKD', 'STORE'],
    storeKinds: ['RETAIL'],
  },
  '/open-bag': {
    roles: ['ADMIN', 'HTKD', 'STORE'],
    storeKinds: ['RETAIL'],
  },
  '/sales': {
    roles: ['ADMIN', 'HTKD', 'STORE'],
    storeKinds: ['RETAIL'],
  },
  '/sorting': {
    roles: ['ADMIN', 'HTKD', 'STORE'],
    storeKinds: ['RETAIL'],
  },
  '/transfers': {
    roles: ['ADMIN', 'HTKD', 'STORE'],
    storeKinds: ['RETAIL'],
  },
  '/catalog': { roles: ['ADMIN', 'HTKD'] },
  '/costs': { roles: ['ADMIN', 'HTKD'] },
  '/reports': { roles: ['ADMIN', 'HTKD'] },
  '/stores': { roles: ['ADMIN'] },
  '/users': { roles: ['ADMIN'] },
  '/audit': { roles: ['ADMIN'] },
  '/settings': { roles: ['ADMIN'] },
} as const satisfies Record<string, RouteAccessPolicy>;

function normalizePath(pathname: string): string {
  if (pathname === '/') return pathname;
  return pathname.replace(/\/+$/, '');
}

export function canShowNavigation(
  pathname: string,
  role: Role,
  storeKind: StoreKind | null,
): boolean {
  if (role === 'ADMIN' && ['/requests', '/receive', '/open-bag'].includes(normalizePath(pathname)))
    return false;
  return canAccessRoute(pathname, role, storeKind);
}

export function canAccessRoute(pathname: string, role: Role, storeKind: StoreKind | null): boolean {
  const policy: RouteAccessPolicy | undefined =
    routeAccessPolicies[normalizePath(pathname) as keyof typeof routeAccessPolicies];
  if (!policy || !policy.roles.includes(role)) return false;
  if (role !== 'STORE' || policy.storeKinds === undefined) return true;
  return storeKind !== null && policy.storeKinds.includes(storeKind);
}
