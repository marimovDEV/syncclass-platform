'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

/*
 * DESIGN_GLOW §2: glow FAQAT `primary` da (harakat) va fokusda (klaviatura).
 * Boshqa variantlar tinch. Fokus `outline` i `globals.css` dagi global qoidadan keladi —
 * bu yerda `outline-none` ATAYLAB yo'q (§5: outline yo'qolmasin, glow qo'shimcha).
 * `hit-44` — vizual o'lcham o'zgarmagan holda tegish maydoni >= 44px (zich UI uchun ham).
 */
export const buttonVariants = cva(
  'hit-44 inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-[background-color,box-shadow,color,border-color] duration-150 focus-visible:shadow-glow-soft disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-fg shadow-glow-soft hover:bg-primary/90 hover:shadow-glow-primary focus-visible:shadow-glow-primary active:bg-primary/95',
        secondary: 'border border-border bg-surface-2 text-fg hover:border-primary/40 hover:bg-surface-2/80',
        outline: 'border border-border bg-transparent text-fg hover:border-primary/40 hover:bg-surface-2',
        ghost: 'bg-transparent text-fg hover:bg-surface-2',
        danger: 'bg-danger text-danger-fg hover:bg-danger/90',
        success: 'bg-success text-success-fg hover:bg-success/90',
        accent: 'bg-accent text-accent-fg hover:bg-accent/90',
        link: 'bg-transparent text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-9 px-3 text-xs',
        /** 44px — asosiy tegish o'lchami (DESIGN_GLOW §5). */
        md: 'h-11 px-4',
        lg: 'h-12 px-6 text-base',
        xl: 'h-14 px-8 text-base',
        icon: 'size-11',
        'icon-sm': 'size-9',
      },
      block: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
      block: false,
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Bola elementga stil beradi (masalan `<Link>`). */
  asChild?: boolean;
  /** Spinner ko'rsatadi va tugmani bloklaydi. */
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, block, asChild = false, loading = false, children, disabled, ...props },
  ref,
) {
  if (asChild) {
    return (
      <Slot
        className={cn(buttonVariants({ variant, size, block }), className)}
        ref={ref as React.Ref<HTMLElement>}
        {...props}
      >
        {children}
      </Slot>
    );
  }

  return (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size, block }), className)}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
});
