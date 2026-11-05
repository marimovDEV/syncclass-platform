'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, MonitorPlay, ScanLine, Sparkles } from 'lucide-react';

import { postLoginPath, useSession } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/shared/ThemeToggle';
import { LoadingState } from '@/components/shared/states';

const FEATURES = [
  {
    Icon: MonitorPlay,
    title: 'Bitta ekran, bitta sur’at',
    text: 'O’qituvchi slaydni o’tkazsa — barcha ekranda bir vaqtda o’zgaradi.',
  },
  {
    Icon: ScanLine,
    title: '6 xonali PIN',
    text: 'Darsga qo’shilish uchun PIN kiritish yoki QR kodni skanerlash yetarli.',
  },
  {
    Icon: Sparkles,
    title: 'Jonli kod va quiz',
    text: 'O’qituvchi yozgan kod real vaqtda ko’rinadi, quiz XP beradi.',
  },
] as const;

/**
 * Landing. Agar foydalanuvchi allaqachon kirgan bo'lsa — roli bo'yicha yo'naltiradi
 * (`is_onboarded=false` bo'lsa onboarding ga).
 */
export default function LandingPage() {
  const router = useRouter();
  const { user, isLoading, isPending } = useSession();

  React.useEffect(() => {
    if (user) router.replace(postLoginPath(user));
  }, [user, router]);

  if (isLoading || isPending || user) {
    return <LoadingState label="Yo'naltirilmoqda…" className="min-h-dvh-screen" />;
  }

  return (
    // Statik aurora — DESIGN_GLOW §5 (animatsiyasiz). Matn aurora ustida emas, `--bg` ga
    // yaqin tinch zonada; hisoblangan juftlik fg/bg bo'yicha o'qiladi.
    <div className="aurora min-h-dvh-screen">
      <header className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 md:px-8">
        <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-fg">
            SC
          </span>
          SyncClass
        </span>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button asChild size="sm" variant="secondary">
            <Link href="/login">Kirish</Link>
          </Button>
        </div>
      </header>

      {/* Kirish animatsiyalari ATAYLAB yo'q (DESIGN_GLOW §7: har bo'limda fade-slide-up — "AI tell"). */}
      <main className="mx-auto flex max-w-5xl flex-col px-4 pb-20 pt-12 md:px-8 md:pt-24">
        <h1 className="max-w-3xl text-balance text-4xl font-bold leading-[1.05] tracking-tight text-fg md:text-6xl">
          Jonli dars — hamma bir ekranda
        </h1>

        <p className="mt-5 max-w-xl text-pretty text-base text-muted md:text-lg">
          Slayd, jonli kod, quiz va davomat — bitta joyda. Ro&apos;yxatdan o&apos;tish uchun faqat
          Google akkaunti kerak, SMS kod yo&apos;q.
        </p>

        <div className="mt-9 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
          {/* Sahifadagi yagona porlovchi element — asosiy harakat (§2). */}
          <Button asChild size="xl" className="w-full sm:w-auto">
            <Link href="/login">
              Google orqali davom etish
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        </div>

        {/* Bosilmaydigan ma'lumot — kartochka/nur emas, tinch ro'yxat. */}
        <dl className="mt-20 grid gap-8 border-t border-border pt-8 sm:grid-cols-3">
          {FEATURES.map(({ Icon, title, text }) => (
            <div key={title} className="flex flex-col gap-2">
              <dt className="flex items-center gap-2 text-sm font-semibold text-fg">
                <Icon className="size-4 text-primary" aria-hidden />
                {title}
              </dt>
              <dd className="text-sm text-muted">{text}</dd>
            </div>
          ))}
        </dl>
      </main>
    </div>
  );
}
