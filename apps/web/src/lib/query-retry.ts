import { ApiClientError } from './api';

/** Statuses where the same read may succeed a moment later without the user changing anything. */
const transientStatuses = new Set([429, 502, 503, 504]);

/**
 * Default retry policy for queries: one retry, and only for failures a repeat can fix. Auth,
 * permission, validation, conflict and schema failures answer the same way every time, so a
 * retry only delays the permission-denied or error state. A statement that the server already
 * cancelled for running too long (SERVICE_BUSY) and a client-side deadline are not repeated
 * either: each would make the user wait the full timeout again.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1 || !(error instanceof ApiClientError)) return false;
  if (error.status === 0) return error.code === 'NETWORK_ERROR';
  return transientStatuses.has(error.status) && error.code !== 'SERVICE_BUSY';
}
