const SESSION_EXPIRED_EVENT = 'idosi:session-expired';
const unauthenticatedEndpoints = new Set(['/auth/login']);

/**
 * A 401 from a protected endpoint invalidates every cached, principal-scoped projection.
 * Login is excluded because 401 is its normal invalid-credentials result. Session probes may
 * originate from an already-rendered protected screen, so they must still revoke scoped state.
 */
export function reportUnauthorizedResponse(status: number, path: string): void {
  if (status !== 401 || unauthenticatedEndpoints.has(path.split('?', 1)[0] ?? path)) return;
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

export function onSessionExpired(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(SESSION_EXPIRED_EVENT, listener);
  return () => window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
}
