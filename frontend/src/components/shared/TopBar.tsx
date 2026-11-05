'use client';

import * as React from 'react';
import Link from 'next/link';
import { LogOut, Users } from 'lucide-react';

import { cn } from '@/lib/utils';
import { ROLE_LABELS } from '@/lib/format';
import { useSession } from '@/lib/auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ThemeToggle } from '@/components/shared/ThemeToggle';
import { XpBadge } from '@/components/shared/XpBadge';

export interface TopBarProps {
  /**
   * Sahifa nomi. `AppShell` ichida u sahifa sarlavhasi (`<h1>`) sifatida kontentda
   * chiziladi; `TopBar` ni mustaqil ishlatganda shu yerda ko'rinadi.
   */
  title?: string;
  /** Sarlavha ostidagi kichik matn. */
  subtitle?: string;
  /** O'ngga qo'shimcha amallar. */
  actions?: React.ReactNode;
  /** Desktopdagi asosiy navigatsiya (AppShell beradi). Berilsa `title` bu yerda chizilmaydi. */
  nav?: React.ReactNode;
  className?: string;
}

/**
 * Yuqori navigatsiya — SHISHA (DESIGN_GLOW §2/§5): sahifadagi yagona doimiy blur qatlami.
 * Shu sababli mobil pastki menyu va modal pardasi blur ishlatmaydi.
 */
export function TopBar({ title, subtitle, actions, nav, className }: TopBarProps) {
  const { user, isLoading, logout } = useSession();

  return (
    <header
      className={cn(
        'glass sticky top-0 z-40 flex h-16 items-center gap-3 border-b border-border px-4 md:px-6',
        className,
      )}
    >
      <Link
        href="/"
        className="hit-44 flex shrink-0 items-center gap-2 rounded-lg px-1 py-1 text-sm font-semibold tracking-tight"
      >
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-fg">
          SC
        </span>
        <span className="hidden sm:inline">SyncClass</span>
      </Link>

      {nav ? (
        <div className="hidden min-w-0 flex-1 md:flex">{nav}</div>
      ) : title ? (
        <div className="min-w-0 flex-1 border-l border-border pl-3">
          <p className="truncate text-sm font-semibold text-fg">{title}</p>
          {subtitle ? <p className="truncate text-xs text-muted">{subtitle}</p> : null}
        </div>
      ) : null}
      {/* nav desktopda flex-1 oladi; mobilda (nav yashirin) bo'shliqni shu to'ldiradi */}
      <div className={cn('flex-1', nav ? 'md:hidden' : title ? 'hidden' : '')} />

      <div className="flex shrink-0 items-center gap-2">
        {actions}
        {user && user.role === 'STUDENT' ? (
          <XpBadge xp={user.xp_points} size="sm" className="hidden sm:inline-flex" />
        ) : null}
        <ThemeToggle />

        {isLoading ? (
          <Skeleton className="size-9 rounded-full" />
        ) : user ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="hit-44 rounded-full transition-opacity duration-150 hover:opacity-85"
                aria-label="Foydalanuvchi menyusi"
              >
                <UserAvatar fullName={user.full_name} avatarUrl={user.avatar_url} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuLabel>
                <span className="block truncate text-sm font-semibold normal-case tracking-normal text-fg">
                  {user.full_name}
                </span>
                <span className="block truncate text-xs font-normal normal-case tracking-normal text-muted">
                  {user.email}
                </span>
              </DropdownMenuLabel>
              <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2">
                <Badge variant="primary">{ROLE_LABELS[user.role]}</Badge>
                {user.groups.map((group) => (
                  <Badge key={group.id} variant="outline">
                    <Users aria-hidden />
                    {group.name}
                  </Badge>
                ))}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => void logout()}>
                <LogOut aria-hidden />
                Chiqish
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button asChild size="sm" variant="secondary">
            <Link href="/login">Kirish</Link>
          </Button>
        )}
      </div>
    </header>
  );
}
