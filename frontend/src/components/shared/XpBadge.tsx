'use client';

import * as React from 'react';
import { Zap } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatNumber } from '@/lib/format';
import { Badge } from '@/components/ui/badge';

export interface XpBadgeProps {
  xp: number;
  /** `sm` — ro'yxatlar uchun, `lg` — dashboard kartasi uchun. */
  size?: 'sm' | 'md' | 'lg';
  /** Oldingi qiymatdan o'sish bo'lsa qisqa "pop" animatsiyasi. */
  animateOnChange?: boolean;
  className?: string;
}

const SIZE_CLASS: Record<NonNullable<XpBadgeProps['size']>, string> = {
  sm: 'text-xs px-2 py-0.5',
  md: 'text-sm px-2.5 py-1',
  lg: 'text-base px-3 py-1.5 font-semibold',
};

/** XP ko'rsatkichi (CONTRACTS.md §6 — XP serverda hisoblanadi). */
export function XpBadge({ xp, size = 'md', animateOnChange = false, className }: XpBadgeProps) {
  const previous = React.useRef(xp);
  const [bump, setBump] = React.useState(false);

  React.useEffect(() => {
    if (!animateOnChange) return;
    if (xp > previous.current) {
      setBump(true);
      const id = window.setTimeout(() => setBump(false), 260);
      previous.current = xp;
      return () => window.clearTimeout(id);
    }
    previous.current = xp;
  }, [xp, animateOnChange]);

  return (
    <Badge
      variant="accent"
      className={cn(
        'tabular-nums transition-transform duration-slow',
        SIZE_CLASS[size],
        bump && 'motion-safe:animate-pop-in',
        className,
      )}
      aria-label={`${xp} XP`}
    >
      <Zap aria-hidden />
      {formatNumber(xp)} XP
    </Badge>
  );
}
