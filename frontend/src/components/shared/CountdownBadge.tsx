'use client';

import * as React from 'react';
import { Clock, TimerOff } from 'lucide-react';

import { cn } from '@/lib/utils';
import { timeLeft, type TimeLeft } from '@/lib/format';
import { Badge } from '@/components/ui/badge';

export interface CountdownBadgeProps {
  /** Deadline — ISO (UTC). */
  deadline: string | null | undefined;
  /** Yangilanish davri (ms). Sekundlar ko'rinsa 1000, aks holda 30000. */
  tickMs?: number;
  className?: string;
  /** Prefiks matn, masalan "Muddat:". */
  prefix?: string;
}

/**
 * Deadline gacha qolgan vaqtni ko'rsatadi (Asia/Tashkent bazasida hisoblangan `timeLeft`).
 * SSR da ham bir xil ko'rinsin uchun birinchi render serverda hisoblanadi,
 * keyin `useEffect` da har `tickMs` da yangilanadi.
 */
export function CountdownBadge({
  deadline,
  tickMs = 30_000,
  className,
  prefix,
}: CountdownBadgeProps) {
  const [left, setLeft] = React.useState<TimeLeft>(() => timeLeft(deadline));

  React.useEffect(() => {
    setLeft(timeLeft(deadline));
    if (deadline === null || deadline === undefined) return;
    const id = window.setInterval(() => setLeft(timeLeft(deadline)), tickMs);
    return () => window.clearInterval(id);
  }, [deadline, tickMs]);

  const variant = left.expired ? 'danger' : left.urgent ? 'accent' : 'neutral';

  return (
    <Badge variant={variant} className={cn('tabular-nums', className)}>
      {left.expired ? <TimerOff aria-hidden /> : <Clock aria-hidden />}
      {prefix ? <span className="text-muted">{prefix}</span> : null}
      {left.text}
    </Badge>
  );
}
