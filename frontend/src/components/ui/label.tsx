'use client';

import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';

import { cn } from '@/lib/utils';

export interface LabelProps extends React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> {
  /** Yulduzcha bilan majburiy maydonni belgilaydi. */
  required?: boolean;
}

export const Label = React.forwardRef<React.ComponentRef<typeof LabelPrimitive.Root>, LabelProps>(
  function Label({ className, required, children, ...props }, ref) {
    return (
      <LabelPrimitive.Root
        ref={ref}
        className={cn(
          'text-sm font-medium leading-none text-fg peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
          className,
        )}
        {...props}
      >
        {children}
        {required === true ? (
          <span className="ml-0.5 text-danger" aria-hidden>
            *
          </span>
        ) : null}
      </LabelPrimitive.Root>
    );
  },
);
