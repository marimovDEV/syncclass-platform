'use client';

import { Toaster as SonnerToaster, toast } from 'sonner';

/**
 * Toast — `sonner`. Dizayn tokenlari CSS o'zgaruvchilari orqali uzatiladi,
 * shuning uchun dark mode avtomatik ishlaydi (`:root[data-theme="dark"]`).
 */
export function Toaster() {
  return (
    <SonnerToaster
      position="top-center"
      duration={4000}
      gap={8}
      offset={16}
      toastOptions={{
        classNames: {
          toast:
            'rounded-xl border border-border bg-surface-2 text-fg shadow-lifted text-sm font-sans',
          description: 'text-muted',
          actionButton: 'rounded-lg bg-primary text-primary-fg',
          cancelButton: 'rounded-lg bg-surface text-fg',
          error: 'border-danger/40',
          success: 'border-success/40',
        },
      }}
    />
  );
}

export { toast };
