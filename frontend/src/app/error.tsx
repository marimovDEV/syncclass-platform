'use client';

import * as React from 'react';
import Link from 'next/link';
import { Home, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/shared/states';

/** Route darajasidagi xato chegarasi (App Router). */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    // Diagnostika uchun konsolga yozamiz; foydalanuvchiga texnik matn ko'rsatilmaydi.
    console.error('[SyncClass] route error:', error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-dvh-screen max-w-xl flex-col items-center justify-center gap-5 px-4">
      <ErrorState
        error={error}
        title="Sahifani ko’rsatib bo’lmadi"
        description="Kutilmagan xatolik yuz berdi. Qayta urinib ko’ring yoki bosh sahifaga qaytingiz."
      />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button onClick={reset}>
          <RefreshCw aria-hidden />
          Qayta urinish
        </Button>
        <Button asChild variant="secondary">
          <Link href="/">
            <Home aria-hidden />
            Bosh sahifa
          </Link>
        </Button>
      </div>
    </div>
  );
}
