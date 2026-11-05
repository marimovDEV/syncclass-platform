'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { BookOpen, FileCheck2, LayoutDashboard, Presentation, Users } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { UserRole } from '@/types/api';
import { useSession } from '@/lib/auth';
import { TopBar, type TopBarProps } from '@/components/shared/TopBar';
import { LoadingState } from '@/components/shared/states';

interface NavItem {
  href: string;
  /** To'liq nom — desktop (lg+) va accessible name. */
  label: string;
  /**
   * Mobil pastki menyu uchun qisqa nom. 4 ta element 320px da har biri 64px katak oladi;
   * "Prezentatsiyalar" (11px da ~83–112px) sig'maydi. Eng uzun qisqa nom "Vazifalar" ~59px.
   */
  short: string;
  Icon: typeof LayoutDashboard;
}

const STUDENT_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Bosh sahifa', short: 'Asosiy', Icon: LayoutDashboard },
  { href: '/homeworks', label: 'Vazifalar', short: 'Vazifalar', Icon: BookOpen },
];

const TEACHER_NAV: NavItem[] = [
  { href: '/teacher', label: 'Bosh sahifa', short: 'Asosiy', Icon: LayoutDashboard },
  { href: '/teacher/presentations', label: 'Prezentatsiyalar', short: 'Slaydlar', Icon: Presentation },
  { href: '/teacher/homeworks', label: 'Vazifalar', short: 'Vazifalar', Icon: FileCheck2 },
  { href: '/teacher/groups', label: 'Guruhlar', short: 'Guruhlar', Icon: Users },
];

function navForRole(role: UserRole | null): NavItem[] {
  if (role === 'TEACHER' || role === 'ADMIN') return TEACHER_NAV;
  if (role === 'STUDENT') return STUDENT_NAV;
  return [];
}

export interface AppShellProps extends TopBarProps {
  children: React.ReactNode;
  /** Sessiya yo'q bo'lsa `/login` ga yo'naltirilsinmi (default: ha). */
  requireAuth?: boolean;
  /** Faqat shu rollarga ruxsat; mos kelmasa o'z bosh sahifasiga yuboriladi. */
  allowRoles?: UserRole[];
  /** Kontent kengligi. */
  width?: 'default' | 'wide' | 'full';
  /** Yon menyuni butunlay yashirish. */
  hideNav?: boolean;
}

const WIDTH_CLASS: Record<NonNullable<AppShellProps['width']>, string> = {
  default: 'max-w-5xl',
  wide: 'max-w-7xl',
  full: 'max-w-none',
};

/**
 * Sahifa qobig'i: TopBar + (desktopda) yon menyu + (mobilda) pastki panel.
 * Auth guard ham shu yerda — har sahifada takrorlanmaydi.
 */
export function AppShell({
  children,
  requireAuth = true,
  allowRoles,
  width = 'default',
  hideNav = false,
  title,
  subtitle,
  actions,
}: AppShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isLoading, isPending, isAuthenticated, role } = useSession();

  const allowed = React.useMemo(() => {
    if (!allowRoles || !role) return true;
    return allowRoles.includes(role);
  }, [allowRoles, role]);

  React.useEffect(() => {
    if (!requireAuth) return;
    if (isLoading || isPending) return;

    if (!isAuthenticated) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    if (user && !user.is_onboarded) {
      router.replace('/onboarding');
      return;
    }
    if (!allowed) {
      router.replace(role === 'STUDENT' ? '/dashboard' : '/teacher');
    }
  }, [requireAuth, isLoading, isPending, isAuthenticated, user, allowed, role, router, pathname]);

  const items = hideNav ? [] : navForRole(role);
  const isActive = (href: string): boolean =>
    // `/teacher` faqat aniq mos kelganda faol (aks holda hamma o'qituvchi sahifasida yonadi).
    pathname === href || (href !== '/teacher' && pathname.startsWith(`${href}/`));

  if (requireAuth && (isLoading || isPending || !isAuthenticated || !allowed)) {
    return (
      <div className="flex min-h-dvh-screen flex-col bg-bg">
        <TopBar />
        <LoadingState label="Sessiya tekshirilmoqda…" className="flex-1" />
      </div>
    );
  }

  /*
   * Kenglik hisobi (o'qituvchi, 4 link): matnli nav bilan yuqori panel ~778px (tipik) /
   * ~887px (eng yomon) kerak — 768..~890px da SIG'MASDI. Shuning uchun:
   *   md..lg (768–1023): faqat ikonka (44px), nom `sr-only` + `title` → ~472px kerak;
   *   lg+   (>=1024)   : ikonka + nom → eng yomonda ~887px, 1024 ga sig'adi.
   */
  const desktopNav =
    items.length > 0 ? (
      <nav aria-label="Asosiy menyu" className="flex items-center gap-1">
        {items.map(({ href, label, Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              title={label}
              className={cn(
                'flex h-11 min-w-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors duration-150',
                // Faol havola — tinch: yuza + matn rangi. Nur YO'Q (glow harakat/fokus uchun).
                active ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2/60 hover:text-fg',
              )}
              aria-current={active ? 'page' : undefined}
            >
              <Icon className={cn('size-4 shrink-0', active && 'text-primary')} aria-hidden />
              <span className="sr-only whitespace-nowrap lg:not-sr-only">{label}</span>
            </Link>
          );
        })}
      </nav>
    ) : null;

  return (
    <div className="flex min-h-dvh-screen flex-col bg-bg">
      <TopBar nav={desktopNav} title={desktopNav ? undefined : title} subtitle={subtitle} />

      <main className="min-w-0 flex-1">
        <div
          className={cn(
            'mx-auto w-full px-4 py-6 md:px-6 md:py-8',
            items.length > 0 ? 'pb-28 md:pb-8' : '',
            WIDTH_CLASS[width],
          )}
        >
          {title || actions ? (
            <div
              className={cn(
                'flex flex-wrap items-end justify-between gap-3',
                width === 'full' ? 'mb-4' : 'mb-6',
              )}
            >
              {title ? (
                <div className="min-w-0">
                  {/* Shaxsiyat shriftdan emas — o'lcham va og'irlikdan (DESIGN_GLOW §6). */}
                  <h1
                    className={cn(
                      'font-semibold tracking-tight text-fg',
                      width === 'full' ? 'text-lg' : 'text-2xl md:text-3xl',
                    )}
                  >
                    {title}
                  </h1>
                  {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
                </div>
              ) : (
                <span />
              )}
              {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
            </div>
          ) : null}
          {children}
        </div>
      </main>

      {items.length > 0 ? (
        /*
         * Mobil pastki menyu — QATTIQ yuza, blur YO'Q: yuqori navigatsiya allaqachon
         * shisha, bir vaqtda ko'pi bilan bitta blur qatlami (DESIGN_GLOW §5).
         */
        <nav
          aria-label="Mobil menyu"
          className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-border bg-surface pb-safe pt-1 md:hidden"
        >
          {items.map(({ href, label, short, Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                aria-label={label}
                className={cn(
                  'flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-1 px-2 py-1.5 text-[11px] font-medium transition-colors duration-150',
                  active ? 'text-primary' : 'text-muted hover:text-fg',
                )}
                aria-current={active ? 'page' : undefined}
              >
                <Icon className="size-5" aria-hidden />
                {/* `truncate` — kutilmagan uzun nom bo'lsa ham qo'shni katakka tushmaydi. */}
                <span className="max-w-full truncate">{short}</span>
              </Link>
            );
          })}
        </nav>
      ) : null}
    </div>
  );
}

/**
 * Jonli dars uchun qisqa qobiq (menyusiz, to'liq ekran, 100dvh).
 * `frontend-live` agenti `src/app/live/**` da shu qobiqdan foydalanishi mumkin.
 */
export function LiveShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh-screen flex-col overflow-hidden bg-bg">
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
