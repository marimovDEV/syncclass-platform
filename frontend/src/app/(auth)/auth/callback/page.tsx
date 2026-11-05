'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { ApiError, isApiError } from '@/lib/api';
import { consumeAuthHash, fetchMe, postLoginPath, readAuthHashError } from '@/lib/auth';
import { queryKeys } from '@/lib/query';
import { useQueryClient } from '@tanstack/react-query';
import { LoadingState, ErrorState } from '@/components/shared/states';
import { Button } from '@/components/ui/button';

/**
 * OAuth callback — CONTRACTS.md §4:
 * `GET /auth/google/callback` 302 → `FRONTEND_ORIGIN/auth/callback#access=..&refresh=..`
 *
 * Bu sahifa hash dan tokenlarni oladi, saqlaydi, hash ni URL dan tozalaydi,
 * so'ng `GET /auth/me` ni chaqirib `is_onboarded` bo'yicha yo'naltiradi.
 */
export default function AuthCallbackPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<unknown>(null);
  const started = React.useRef(false);

  React.useEffect(() => {
    if (started.current) return;
    started.current = true;

    const run = async (): Promise<void> => {
      const hash = window.location.hash;

      const hashError = readAuthHashError(hash);
      if (hashError) {
        router.replace(`/login?error=${encodeURIComponent(hashError)}`);
        return;
      }

      if (!consumeAuthHash(hash)) {
        router.replace('/login?error=MISSING_TOKENS');
        return;
      }

      // Token URL da qolmasin (brauzer tarixi / log leak — AUDIT.md §B3 ruhida).
      window.history.replaceState(null, '', window.location.pathname);

      try {
        const user = await fetchMe();
        queryClient.setQueryData(queryKeys.me, user);
        router.replace(postLoginPath(user));
      } catch (caught) {
        if (isApiError(caught) && caught.isAuthError) {
          router.replace('/login?error=UNAUTHORIZED');
          return;
        }
        setError(caught);
      }
    };

    void run();
  }, [router, queryClient]);

  if (error) {
    return (
      <div className="mx-auto flex min-h-dvh-screen max-w-md flex-col items-center justify-center gap-4 px-4">
        <ErrorState
          className="w-full"
          error={error}
          title="Kirishni yakunlay olmadik"
          description={
            isApiError(error)
              ? (error as ApiError).message
              : 'Server javob bermadi. Birozdan so’ng qayta urinib ko’ring.'
          }
        />
        <Button variant="secondary" onClick={() => router.replace('/login')}>
          Kirish sahifasiga qaytish
        </Button>
      </div>
    );
  }

  return <LoadingState label="Kirish yakunlanmoqda…" className="min-h-dvh-screen" />;
}
