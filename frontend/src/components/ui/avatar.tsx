'use client';

import * as React from 'react';
import * as AvatarPrimitive from '@radix-ui/react-avatar';

import { cn } from '@/lib/utils';
import { initials } from '@/lib/utils';

export const Avatar = React.forwardRef<
  React.ComponentRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(function Avatar({ className, ...props }, ref) {
  return (
    <AvatarPrimitive.Root
      ref={ref}
      className={cn(
        'relative flex size-9 shrink-0 overflow-hidden rounded-full border border-border bg-surface-2',
        className,
      )}
      {...props}
    />
  );
});

export const AvatarImage = React.forwardRef<
  React.ComponentRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(function AvatarImage({ className, ...props }, ref) {
  return (
    <AvatarPrimitive.Image
      ref={ref}
      className={cn('aspect-square size-full object-cover', className)}
      {...props}
    />
  );
});

export const AvatarFallback = React.forwardRef<
  React.ComponentRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(function AvatarFallback({ className, ...props }, ref) {
  return (
    <AvatarPrimitive.Fallback
      ref={ref}
      className={cn(
        'flex size-full items-center justify-center bg-primary/15 text-xs font-semibold text-primary',
        className,
      )}
      {...props}
    />
  );
});

export interface UserAvatarProps extends React.ComponentPropsWithoutRef<typeof Avatar> {
  fullName: string;
  avatarUrl?: string | null;
}

/** Ism + rasm bo'yicha tayyor avatar (rasm yuklanmasa initsiallar). */
export function UserAvatar({ fullName, avatarUrl, className, ...props }: UserAvatarProps) {
  return (
    <Avatar className={className} {...props}>
      {avatarUrl ? <AvatarImage src={avatarUrl} alt={fullName} /> : null}
      <AvatarFallback>{initials(fullName)}</AvatarFallback>
    </Avatar>
  );
}
