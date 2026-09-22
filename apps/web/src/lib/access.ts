import type { Role, StoreKind } from './types';

export interface RouteAccessPolicy {
  readonly roles: readonly Role[];
  readonly storeKinds?: readonly StoreKind[];
}

export const routeAccessPolicies = {
  '/': { roles: ['ADMIN', 'HTKD', 'STORE', 'WHOLESALE_ACCOUNT'] },
  '/allocations': { roles: ['ADMIN', 'HTKD', 'STORE', 'WHOLESALE_ACCOUNT'] },
  '/requests': { roles: ['ADMIN', 'HTKD', 'STORE', 'WHOLESALE_ACCOUNT'] },
  '/warehouse-inbound': { roles: ['ADMIN', 'HTKD'] },
  '/receive': {
    roles: ['ADMIN', 'HTKD', 'STORE', 'WHOLESALE_ACCOUNT'],
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
  if (role === 'WHOLESALE_ACCOUNT' && ['/open-bag'].includes(normalizePath(pathname)))
    return false;
  return canAccessRoute(pathname, role, storeKind);
}

export function canAccessRoute(pathname: string, role: Role, storeKind: StoreKind | null): boolean {
  const policy: RouteAccessPolicy | undefined =
    routeAccessPolicies[normalizePath(pathname) as keyof typeof routeAccessPolicies];
  if (!policy || !policy.roles.includes(role)) return false;
  // WHOLESALE_ACCOUNT and non-STORE roles don't need storeKind check
  if (role !== 'STORE' || policy.storeKinds === undefined) return true;
  return storeKind !== null && policy.storeKinds.includes(storeKind);
}
