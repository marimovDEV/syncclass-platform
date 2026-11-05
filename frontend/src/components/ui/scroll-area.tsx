'use client';

import * as React from 'react';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';

import { cn } from '@/lib/utils';

/**
 * Scroll maydoni (Radix). Ildizni istalgan usulda o'lchang: `h-*`, `max-h-*` yoki
 * flex ota ichida `min-h-0 flex-1` — uchala holatda ham kontent SCROLL bo'ladi.
 *
 * ⚠️ TARIX (qayta kiritmang): avval ildiz `overflow-hidden`, viewport `size-full`
 * (`height: 100%`) edi. Foiz balandlik FAQAT ota balandligi aniq (`height`) bo'lsa
 * hisoblanadi; ildiz `max-h-*` bilan o'lchanganda `100%` → `auto` bo'lib, viewport
 * kontent balandligini olardi va ildiz uni SCROLLSIZ QIRQARDI (60 sahifali PDF
 * importidan keyin ro'yxat pastiga yetib bo'lmasdi — frontend-reviewer topgan).
 *
 * Tuzatish foizga umuman tayanmaydi: ildiz — ustunli flex konteyner, viewport —
 * `min-h-0 flex-1`. Flex o'zi viewportni ildiz chegarasigacha qisqartiradi
 * (`max-h` da ham, `h` da ham, flex ota ichida ham). Radix scrollbar va burchak
 * `position: absolute` — flex oqimida joy egallamaydi.
 */
export const ScrollArea = React.forwardRef<
  React.ComponentRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(function ScrollArea({ className, children, ...props }, ref) {
  return (
    <ScrollAreaPrimitive.Root
      ref={ref}
      className={cn('relative flex flex-col overflow-hidden', className)}
      {...props}
    >
      {/* `size-full` / `h-full` bu yerga QAYTARILMASIN — yuqoridagi izohga qarang. */}
      <ScrollAreaPrimitive.Viewport className="min-h-0 w-full flex-1 rounded-[inherit]">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollBar orientation="horizontal" />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
});

export const ScrollBar = React.forwardRef<
  React.ComponentRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(function ScrollBar({ className, orientation = 'vertical', ...props }, ref) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      ref={ref}
      orientation={orientation}
      className={cn(
        'flex touch-none select-none transition-colors duration-150',
        orientation === 'vertical' && 'h-full w-2 border-l border-l-transparent p-0.5',
        orientation === 'horizontal' && 'h-2 flex-col border-t border-t-transparent p-0.5',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
});
