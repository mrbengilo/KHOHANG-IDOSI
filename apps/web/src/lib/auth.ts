import { type QueryClient, useQuery } from '@tanstack/react-query';
import type { Session } from '@idosi/contracts';
import { getSession, mockModeEnabled } from './api';

export const sessionQueryKey = ['session'] as const;

/**
 * Authentication is a cache security boundary. Business queries are deliberately removed
 * before installing a new principal so scoped data from the previous account cannot flash or
 * be reused after a login transition.
 */
export function installAuthenticatedSession(queryClient: QueryClient, session: Session): void {
  queryClient.clear();
  queryClient.setQueryData(sessionQueryKey, session);
}

export function clearAuthenticatedSession(queryClient: QueryClient): void {
  queryClient.clear();
  queryClient.setQueryData(sessionQueryKey, null);
}

export function useSession() {
  return useQuery({
    enabled: !mockModeEnabled,
    queryFn: getSession,
    queryKey: sessionQueryKey,
    retry: false,
    staleTime: 60_000,
  });
}
