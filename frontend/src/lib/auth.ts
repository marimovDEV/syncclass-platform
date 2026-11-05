'use client';

/**
 * Auth oqimi — CONTRACTS.md §4 (auth).
 *
 * Token saqlash `lib/tokens.ts` da (XSS eslatmasi ham shu yerda).
 * `useSession()` — `GET /auth/me` ni react-query bilan keshlaydi.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';

import type { GoogleLoginOut, UserOut, UserRole } from '@/types/api';
import { ApiError, apiFetch, isApiError } from '@/lib/api';
import {
  TOKENS_CHANGED_EVENT,
  clearTokens,
  getAccessToken,
  getRefreshToken,
  hasTokens,
  setTokens,
} from '@/lib/tokens';

export { getAccessToken, getRefreshToken, setTokens, clearTokens, hasTokens };

export const SESSION_QUERY_KEY = ['auth', 'me'] as const;

/* ------------------------------- REST chaqirувlar ------------------------- */

/** `GET /auth/google/login` → `{authorize_url}`. */
export function fetchGoogleAuthorizeUrl(): Promise<GoogleLoginOut> {
  return apiFetch<GoogleLoginOut>('/auth/google/login', { skipAuth: true });
}

/** `POST /auth/dev-login` — Faqat development uchun tezkor kirish. */
export async function devLogin(email: string): Promise<UserOut> {
  const tokens = await apiFetch<{ access_token: string; refresh_token: string }>('/auth/dev-login', {
    method: 'POST',
    body: { email },
    skipAuth: true,
  });
  setTokens(tokens.access_token, tokens.refresh_token);
  return fetchMe();
}

/** `GET /auth/me` → `UserOut`. */
export function fetchMe(): Promise<UserOut> {
  return apiFetch<UserOut>('/auth/me');
}

/** `POST /auth/logout` — refresh ni revoke qiladi. Xato bo'lsa ham lokal tozalanadi. */
export async function logoutRequest(): Promise<void> {
  const refresh_token = getRefreshToken();
  if (refresh_token) {
    try {
      await apiFetch<void>('/auth/logout', { method: 'POST', body: { refresh_token } });
    } catch {
      /* server javob bermasa ham lokal sessiyani yopamiz */
    }
  }
  clearTokens();
}

/**
 * OAuth callback hash ini o'qiydi: `#access=..&refresh=..`.
 * Topilsa tokenlarni saqlaydi va `true` qaytaradi.
 */
export function consumeAuthHash(hash: string): boolean {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return false;
  const params = new URLSearchParams(raw);
  const access = params.get('access');
  const refresh = params.get('refresh');
  if (!access || !refresh) return false;
  setTokens(access, refresh);
  return true;
}

/** Callback sahifasidagi xato: `#error=...`. */
export function readAuthHashError(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  return new URLSearchParams(raw).get('error');
}

/* -------------------------------- useSession ------------------------------ */

export interface Session {
  user: UserOut | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** Token bor, lekin `/auth/me` hali kelmagan — sahifa redirect qilmasin. */
  isPending: boolean;
  error: ApiError | null;
  role: UserRole | null;
  isTeacher: boolean;
  isStudent: boolean;
  isAdmin: boolean;
  refetch: UseQueryResult<UserOut, ApiError>['refetch'];
  logout: () => Promise<void>;
}

/**
 * Joriy sessiya. Token bo'lmasa so'rov yuborilmaydi (`enabled: false`).
 * Boshqa tab da logout bo'lsa — `TOKENS_CHANGED_EVENT` orqali kesh bo'shatiladi.
 */
export function useSession(): Session {
  const queryClient = useQueryClient();
  const router = useRouter();
  const tokenPresent = useHasToken();

  const query = useQuery<UserOut, ApiError>({
    queryKey: SESSION_QUERY_KEY,
    queryFn: fetchMe,
    enabled: tokenPresent,
    staleTime: 60_000,
    retry: (failureCount, error) => {
      if (isApiError(error) && (error.isAuthError || error.status === 403)) return false;
      return failureCount < 2;
    },
  });

  const logout = useCallback(async () => {
    await logoutRequest();
    queryClient.removeQueries({ queryKey: SESSION_QUERY_KEY });
    queryClient.clear();
    router.replace('/login');
  }, [queryClient, router]);

  const user = query.data ?? null;

  return useMemo<Session>(
    () => ({
      user,
      isLoading: tokenPresent && query.isPending,
      isAuthenticated: user !== null,
      isPending: tokenPresent && user === null && !query.isError,
      error: query.error ?? null,
      role: user?.role ?? null,
      isTeacher: user?.role === 'TEACHER',
      isStudent: user?.role === 'STUDENT',
      isAdmin: user?.role === 'ADMIN',
      refetch: query.refetch,
      logout,
    }),
    [user, tokenPresent, query.isPending, query.isError, query.error, query.refetch, logout],
  );
}

/**
 * `localStorage` da token bor-yo'qligini reaktiv kuzatadi.
 * Boshlang'ich qiymat `false` — SSR va birinchi render bir xil bo'lsin (hydration).
 */
function useHasToken(): boolean {
  const [present, setPresent] = useState(false);

  useEffect(() => {
    const sync = () => setPresent(getAccessToken() !== null);
    sync();
    window.addEventListener(TOKENS_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(TOKENS_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return present;
}

/* ------------------------------ rol yo'naltirish -------------------------- */

/** Rol bo'yicha asosiy sahifa (CONTRACT_CONFLICT izohi: `/teacher` — hisobotda). */
export function homePathForRole(role: UserRole): string {
  switch (role) {
    case 'TEACHER':
    case 'ADMIN':
      return '/teacher';
    case 'STUDENT':
      return '/dashboard';
  }
}

/** Onboarding tugamagan foydalanuvchini qayerga yuborish kerak. */
export function postLoginPath(user: UserOut): string {
  if (!user.is_onboarded) return '/onboarding';
  return homePathForRole(user.role);
}
