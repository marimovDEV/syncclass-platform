'use client';

import * as React from 'react';
import { AlertTriangle, Inbox, Loader2, RefreshCw, WifiOff } from 'lucide-react';

import { cn } from '@/lib/utils';
import { ApiError, isApiError } from '@/lib/api';
import { errorText } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/* -------------------------------- LoadingState ---------------------------- */

export interface LoadingStateProps {
  /** Matn (default: "Yuklanmoqda…"). */
  label?: string;
  /** `skeleton` — plita, `spinner` — aylanuvchi ikonka. */
  variant?: 'spinner' | 'skeleton';
  /** `skeleton` uchun plitalar soni. */
  rows?: number;
  className?: string;
}

export function LoadingState({
  label = 'Yuklanmoqda…',
  variant = 'spinner',
  rows = 3,
  className,
}: LoadingStateProps) {
  if (variant === 'skeleton') {
    return (
      <div className={cn('flex flex-col gap-3', className)} role="status" aria-label={label}>
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn('flex flex-col items-center justify-center gap-3 px-6 py-14', className)}
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-6 animate-spin text-primary" aria-hidden />
      <p className="text-sm text-muted">{label}</p>
    </div>
  );
}

/* --------------------------------- EmptyState ----------------------------- */

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Lucide ikonkasi yoki ixtiyoriy nod. */
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-surface/60 px-6 py-14 text-center',
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-muted [&_svg]:size-6">
        {icon ?? <Inbox aria-hidden />}
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold text-fg">{title}</p>
        {description ? <p className="max-w-sm text-sm text-muted">{description}</p> : null}
      </div>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/* --------------------------------- ErrorState ----------------------------- */

export interface ErrorStateProps {
  /** `ApiError` bo'lsa kod bo'yicha o'zbekcha matn tanlanadi. */
  error?: unknown;
  title?: string;
  description?: string;
  onRetry?: () => void;
  className?: string;
}

/** Xato obyektidan foydalanuvchiga ko'rsatiladigan matnni chiqaradi. */
export function describeError(error: unknown): { title: string; description: string; offline: boolean } {
  if (isApiError(error)) {
    const apiError: ApiError = error;
    if (apiError.isNetworkError) {
      return {
        title: 'Serverga ulana olmadik',
        description: errorText(apiError.code, apiError.message),
        offline: true,
      };
    }
    return {
      title: 'Xatolik yuz berdi',
      description: errorText(apiError.code, apiError.message),
      offline: false,
    };
  }
  if (error instanceof Error && error.message.length > 0) {
    return { title: 'Xatolik yuz berdi', description: error.message, offline: false };
  }
  return {
    title: 'Xatolik yuz berdi',
    description: 'Noma’lum xato. Sahifani yangilab ko’ring.',
    offline: false,
  };
}

export function ErrorState({ error, title, description, onRetry, className }: ErrorStateProps) {
  const described = describeError(error);
  const finalTitle = title ?? described.title;
  const finalDescription = description ?? described.description;

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-2xl border border-danger/30 bg-danger/[0.06] px-6 py-12 text-center',
        className,
      )}
      role="alert"
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-danger/15 text-danger [&_svg]:size-6">
        {described.offline ? <WifiOff aria-hidden /> : <AlertTriangle aria-hidden />}
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold text-fg">{finalTitle}</p>
        <p className="max-w-md text-sm text-muted">{finalDescription}</p>
      </div>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry} className="mt-2">
          <RefreshCw aria-hidden />
          Qayta urinish
        </Button>
      ) : null}
    </div>
  );
}
