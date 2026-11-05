import * as React from 'react';

import { cn } from '@/lib/utils';

/** Yuklanish paytidagi "shimmer" plitasi. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn(
        'relative overflow-hidden rounded-xl bg-surface-2',
        // Shimmer faqat `motion-safe:` — reduced-motion da statik plita.
        'after:absolute after:inset-0 after:-translate-x-full motion-safe:after:animate-shimmer',
        'after:bg-gradient-to-r after:from-transparent after:via-fg/[0.05] after:to-transparent',
        className,
      )}
      {...props}
    />
  );
}
