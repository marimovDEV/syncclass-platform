import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors duration-150 [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        neutral: 'border-border bg-surface-2 text-fg',
        /*
         * Fon tusi /10: 12px matn shu tus ustida ikkala rejimda >= 4.5:1 (eng pasti 4.67 —
         * yorug' accent). /15 da yorug' accent 4.34 va success 4.43 bo'lib, me'yordan YIQILARDI.
         */
        primary: 'border-transparent bg-primary/10 text-primary',
        accent: 'border-transparent bg-accent/10 text-accent',
        danger: 'border-transparent bg-danger/10 text-danger',
        success: 'border-transparent bg-success/10 text-success',
        outline: 'border-border bg-transparent text-muted',
        solid: 'border-transparent bg-primary text-primary-fg',
        /**
         * Jonli dars holati — DESIGN_GLOW §1 dagi YAGONA "yorqin" moment.
         * Faqat haqiqatan LIVE bo'lgan narsa uchun; boshqa joyda ishlatilmasin.
         */
        live: 'border-accent/50 bg-accent/10 font-semibold uppercase tracking-wide text-accent shadow-glow-accent',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export interface LiveBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Ko'rinadigan matn (default "Jonli"). */
  label?: string;
}

/**
 * LIVE nishoni: nur (`--glow-accent`) + pulsatsiyalanuvchi nuqta.
 * Pulsatsiya FAQAT `motion-safe:` — `prefers-reduced-motion` da nuqta statik,
 * glow esa saqlanadi (DESIGN_GLOW §5). Animatsiya faqat `transform`/`opacity`.
 */
export function LiveBadge({ label = 'Jonli', className, ...props }: LiveBadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant: 'live' }), 'gap-1.5', className)} {...props}>
      <span className="relative flex size-2" aria-hidden>
        <span className="absolute inline-flex size-full rounded-full bg-accent motion-safe:animate-live-pulse" />
        <span className="relative inline-flex size-2 rounded-full bg-accent" />
      </span>
      {label}
    </span>
  );
}
