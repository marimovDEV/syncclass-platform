'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        'flex min-h-24 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg transition-[border-color,box-shadow] duration-150',
        'placeholder:text-muted',
        // `outline` global qoidadan (DESIGN_GLOW §5); glow — qo'shimcha.
        'focus-visible:border-primary/60 focus-visible:shadow-glow-soft',
        'disabled:cursor-not-allowed disabled:opacity-50',
        invalid === true && 'border-danger focus-visible:border-danger',
        className,
      )}
      {...props}
    />
  );
});
