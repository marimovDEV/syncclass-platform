'use client';

import * as React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'framer-motion';

import { makeQueryClient } from '@/lib/query';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * React Query + Tooltip + Motion provider.
 *
 * `MotionConfig reducedMotion="user"`: framer-motion animatsiyalari JS da ishlaydi,
 * shuning uchun `globals.css` dagi `prefers-reduced-motion` qoidasi ularga TA'SIR
 * QILMAYDI. Bu sozlama butun ilovada (jonli dars ham) transform animatsiyalarini
 * foydalanuvchi tanloviga bo'ysundiradi (DESIGN_GLOW §5).
 * `QueryClient` `useState` ichida yaratiladi — har render da yangisi yasalmaydi
 * va SSR da klientlar orasida kesh aralashmaydi.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(() => makeQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
      </MotionConfig>
    </QueryClientProvider>
  );
}
