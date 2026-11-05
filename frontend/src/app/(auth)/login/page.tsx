'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { ApiError } from '@/lib/api';
import { devLogin, fetchGoogleAuthorizeUrl, postLoginPath, useSession } from '@/lib/auth';
import { errorText } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/shared/states';
import { ThemeToggle } from '@/components/shared/ThemeToggle';

/**
 * Google logotipi (SVG inline — tashqi rasm so'rovi yo'q).
 * ISTISNO (hardcoded rang): Google brend yo'riqnomasi logotip ranglarini o'zgartirishni
 * taqiqlaydi — bu tokenlarga bog'lanmaydi va mavzuga qarab o'zgarmaydi.
 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden className="size-5">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59A14.5 14.5 0 0 1 9.77 24c0-1.6.27-3.14.76-4.59l-7.98-6.19A23.94 23.94 0 0 0 0 24c0 3.88.93 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.46-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/**
 * Kirish sahifasi — CONTRACTS.md §4: `GET /auth/google/login` → `{authorize_url}`.
 * OTP/parol yo'q (DoD #1: <= 3 klik).
 *
 * `useSearchParams` statik prerender uchun `Suspense` chegarasini talab qiladi.
 */
export default function LoginPage() {
  return (
    <React.Suspense fallback={<LoadingState className="min-h-dvh-screen" />}>
      <LoginView />
    </React.Suspense>
  );
}

function LoginView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isLoading, isPending } = useSession();

  const [pendingRedirect, setPendingRedirect] = React.useState(false);
  const [devLoadingEmail, setDevLoadingEmail] = React.useState<string | null>(null);
  const [error, setError] = React.useState<unknown>(null);

  const nextPath = searchParams.get('next');
  const callbackError = searchParams.get('error');

  React.useEffect(() => {
    if (!user) return;
    router.replace(nextPath && nextPath.startsWith('/') ? nextPath : postLoginPath(user));
  }, [user, nextPath, router]);

  const handleDevLogin = React.useCallback(
    async (email: string) => {
      setError(null);
      setDevLoadingEmail(email);
      try {
        const u = await devLogin(email);
        router.replace(nextPath && nextPath.startsWith('/') ? nextPath : postLoginPath(u));
      } catch (caught) {
        setError(caught);
      } finally {
        setDevLoadingEmail(null);
      }
    },
    [nextPath, router],
  );

  const startGoogleLogin = React.useCallback(async () => {
    setError(null);
    setPendingRedirect(true);
    try {
      const { authorize_url } = await fetchGoogleAuthorizeUrl();
      if (!authorize_url) {
        throw new ApiError(502, {
          code: 'BAD_GATEWAY',
          message: 'Server Google manzilini qaytarmadi.',
        });
      }
      // Tashqi OAuth manziliga to'liq navigatsiya (SPA router emas).
      window.location.assign(authorize_url);
    } catch (caught) {
      setPendingRedirect(false);
      setError(caught);
    }
  }, []);

  if (isLoading || isPending || user) {
    return <LoadingState label="Tekshirilmoqda…" className="min-h-dvh-screen" />;
  }

  return (
    // Statik aurora (DESIGN_GLOW §5) — animatsiyasiz; kartochka QATTIQ yuza (shisha emas).
    <div className="aurora flex min-h-dvh-screen flex-col">
      <div className="flex h-16 items-center justify-end px-4">
        <ThemeToggle />
      </div>

      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-sm">
          <Card className="shadow-lifted">
            <CardContent className="flex flex-col items-center gap-6 p-7 pt-7">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-primary text-base font-bold text-primary-fg">
                SC
              </span>

              <div className="flex flex-col items-center gap-1.5 text-center">
                <h1 className="text-xl font-semibold tracking-tight text-fg">SyncClass ga kirish</h1>
                <p className="text-sm text-muted">
                  Google akkauntingiz bilan davom etasiz. SMS kod yoki parol kerak emas.
                </p>
              </div>

              {callbackError ? (
                <div
                  role="alert"
                  className="w-full rounded-xl border border-danger/30 bg-danger/[0.06] px-3 py-2 text-sm text-danger"
                >
                  {errorText(callbackError, 'Kirish amalga oshmadi. Qayta urinib ko’ring.')}
                </div>
              ) : null}

              {error ? (
                <ErrorState
                  className="w-full px-4 py-6"
                  error={error}
                  onRetry={() => void startGoogleLogin()}
                />
              ) : null}

              <Button
                size="xl"
                block
                loading={pendingRedirect}
                onClick={() => void startGoogleLogin()}
              >
                {pendingRedirect ? null : <GoogleMark />}
                Google orqali davom etish
              </Button>

              <div className="flex w-full items-center gap-2">
                <div className="h-px flex-1 bg-border/60" />
                <span className="text-xs uppercase tracking-wider text-muted font-medium">Tezkor kirish (Dev)</span>
                <div className="h-px flex-1 bg-border/60" />
              </div>

              <div className="flex w-full flex-col gap-2">
                <Button
                  variant="outline"
                  size="md"
                  block
                  loading={devLoadingEmail === 'teacher@syncclass.local'}
                  disabled={devLoadingEmail !== null || pendingRedirect}
                  onClick={() => void handleDevLogin('teacher@syncclass.local')}
                  className="justify-center border-primary/30 hover:border-primary hover:bg-primary/[0.05]"
                >
                  👨‍🏫 O’qituvchi sifatida kirish
                </Button>
                <Button
                  variant="outline"
                  size="md"
                  block
                  loading={devLoadingEmail === 'student01@syncclass.local'}
                  disabled={devLoadingEmail !== null || pendingRedirect}
                  onClick={() => void handleDevLogin('student01@syncclass.local')}
                  className="justify-center"
                >
                  🧑‍🎓 O’quvchi sifatida kirish (student01)
                </Button>
              </div>

              <p className="text-center text-xs text-muted">
                Yangi foydalanuvchi har doim <span className="font-medium text-fg">o’quvchi</span>{' '}
                sifatida qo’shiladi. O’qituvchi huquqini administrator beradi.
              </p>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
