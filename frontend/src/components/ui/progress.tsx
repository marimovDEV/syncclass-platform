'use client';

import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';

import { cn } from '@/lib/utils';
import { clamp } from '@/lib/utils';

export interface ProgressProps
  extends React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> {
  /** 0..100 */
  value?: number;
  /** Indikator rangi. */
  tone?: 'primary' | 'accent' | 'danger' | 'success';
  /**
   * Indikator nuri — FAQAT taymer kabi "jonli" holat uchun (DESIGN_GLOW §2).
   * Default `false`: ma'lumot ko'rsatkichlari (AI ishonchi, yuklash) porlamaydi.
   */
  glow?: boolean;
}

const GLOW_CLASS: Record<NonNullable<ProgressProps['tone']>, string> = {
  primary: 'shadow-glow-primary',
  accent: 'shadow-glow-accent',
  danger: '',
  success: '',
};

const TONE_CLASS: Record<NonNullable<ProgressProps['tone']>, string> = {
  primary: 'bg-primary',
  accent: 'bg-accent',
  danger: 'bg-danger',
  success: 'bg-success',
};

export const Progress = React.forwardRef<
  React.ComponentRef<typeof ProgressPrimitive.Root>,
  ProgressProps
>(function Progress({ className, value = 0, tone = 'primary', glow = false, ...props }, ref) {
  const safe = clamp(value, 0, 100);
  return (
    <ProgressPrimitive.Root
      ref={ref}
      value={safe}
      className={cn(
        'relative h-2 w-full rounded-full bg-surface-2',
        // Nur kesilmasin: glow yoqilganda `overflow-hidden` olinadi.
        glow ? 'overflow-visible' : 'overflow-hidden',
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          'h-full w-full rounded-full transition-transform duration-slow ease-out',
          TONE_CLASS[tone],
          glow && GLOW_CLASS[tone],
        )}
        style={{ transform: `translateX(-${100 - safe}%)` }}
      />
    </ProgressPrimitive.Root>
  );
});
