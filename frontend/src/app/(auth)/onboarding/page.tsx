'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { homePathForRole, useSession } from '@/lib/auth';
import { ErrorState, LoadingState } from '@/components/shared/states';
import { OnboardingModal } from '@/app/(auth)/onboarding/OnboardingModal';

/**
 * Onboarding sahifasi — modal har doim ochiq (yopib ketolmaydi).
 * Allaqachon `is_onboarded` bo'lsa darhol kabinetga yo'naltiriladi.
 */
export default function OnboardingPage() {
  const router = useRouter();
  const { user, isLoading, isPending, error } = useSession();

  React.useEffect(() => {
    if (!isLoading && !isPending && !user) {
      router.replace('/login');
      return;
    }
    if (user?.is_onboarded) {
      router.replace(homePathForRole(user.role));
    }
  }, [user, isLoading, isPending, router]);

  if (error) {
    return (
      <div className="mx-auto flex min-h-dvh-screen max-w-md items-center justify-center px-4">
        <ErrorState className="w-full" error={error} />
      </div>
    );
  }

  if (isLoading || isPending || !user || user.is_onboarded) {
    return <LoadingState label="Yuklanmoqda…" className="min-h-dvh-screen" />;
  }

  return (
    // Statik aurora ustida shisha modal — sahifadagi yagona blur qatlami (DESIGN_GLOW §5).
    <div className="aurora min-h-dvh-screen">
      <OnboardingModal user={user} />
    </div>
  );
}
