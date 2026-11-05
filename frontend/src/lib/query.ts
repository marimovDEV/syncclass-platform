/**
 * React Query sozlamalari.
 *
 * Provider komponenti `components/shared/QueryProvider.tsx` da (JSX kerak).
 * Bu fayl faqat `QueryClient` fabrikasi va umumiy query kalitlari.
 */

import { QueryClient } from '@tanstack/react-query';

import { isApiError } from '@/lib/api';

/**
 * Backend ko'tarilmagan bo'lsa ham UI ishlaydi: `retry` cheklangan,
 * auth/forbidden xatolarida qayta urinmaydi (ErrorState darhol ko'rinadi).
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (isApiError(error)) {
            if (error.isAuthError) return false;
            if (error.status === 403 || error.status === 404) return false;
          }
          return failureCount < 2;
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

/** Barcha query kalitlari bir joyda — invalidatsiya xatosini oldini oladi. */
export const queryKeys = {
  me: ['auth', 'me'] as const,
  groups: ['groups'] as const,
  openGroups: ['groups', 'open'] as const,
  groupMembers: (groupId: number) => ['groups', groupId, 'members'] as const,
  presentations: ['presentations'] as const,
  presentation: (id: string) => ['presentations', id] as const,
  homeworks: (groupId?: number) => ['homeworks', groupId ?? 'all'] as const,
  homework: (id: string) => ['homeworks', id] as const,
  homeworkSubmissions: (homeworkId: string) => ['homeworks', homeworkId, 'submissions'] as const,
  submission: (id: string) => ['submissions', id] as const,
  room: (pin: string) => ['rooms', pin] as const,
  roomReport: (pin: string) => ['rooms', pin, 'report'] as const,
} as const;
