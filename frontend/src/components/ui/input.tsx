'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Xato holati — qizil chegara + `aria-invalid`. */
  invalid?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, type = 'text', ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      aria-invalid={invalid || undefined}
      className={cn(
        'flex h-11 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg transition-[border-color,box-shadow] duration-150',
        'placeholder:text-muted',
        // `outline` global qoidadan (DESIGN_GLOW §5); glow — qo'shimcha.
        'focus-visible:border-primary/60 focus-visible:shadow-glow-soft',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'file:mr-3 file:rounded-lg file:border-0 file:bg-surface-2 file:px-3 file:py-1 file:text-sm file:text-fg',
        invalid === true && 'border-danger focus-visible:border-danger',
        className,
      )}
      {...props}
    />
  );
});
