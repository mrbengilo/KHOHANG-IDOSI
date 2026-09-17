import { useQuery } from '@tanstack/react-query';
import { getSession, mockModeEnabled } from './api';

export const sessionQueryKey = ['session'] as const;

export function useSession() {
  return useQuery({
    enabled: !mockModeEnabled,
    queryFn: getSession,
    queryKey: sessionQueryKey,
    retry: false,
    staleTime: 60_000,
  });
}
