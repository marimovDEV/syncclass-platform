'use client';

/**
 * 🐢 "Tushunmadim" tugmasi — CONTRACTS.md §5 `CONFUSED_PING` (STUDENT, anonim).
 * `CONFUSED_COOLDOWN_MS` (30 s) cooldown klientda ham ushlanadi: server baribir
 * cheklaydi, lekin o'quvchi qancha vaqt qolganini **ko'rib turishi** kerak.
 */

import * as React from 'react';

import { CONFUSED_COOLDOWN_MS } from '@/types/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export interface ConfusedButtonProps {
  /** `send('CONFUSED_PING', {})` — yuborilgani (`true`) cooldown ni boshlaydi. */
  onPing: () => boolean;
  /** WS yopiq bo'lsa yoki sessiya tugagan bo'lsa. */
  disabled?: boolean;
  /** Mobil companion dagi katta tugma. */
  size?: 'md' | 'xl';
  className?: string;
}

export function ConfusedButton({
  onPing,
  disabled = false,
  size = 'md',
  className,
}: ConfusedButtonProps) {
  const [until, setUntil] = React.useState<number | null>(null);
  const [remaining, setRemaining] = React.useState(0);

  React.useEffect(() => {
    if (until === null) return;
    const tick = (): void => {
      const left = until - Date.now();
      if (left <= 0) {
        setUntil(null);
        setRemaining(0);
        return;
      }
      setRemaining(left);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [until]);

  const cooling = until !== null;

  const handleClick = (): void => {
    if (cooling || disabled) return;
    if (onPing()) setUntil(Date.now() + CONFUSED_COOLDOWN_MS);
  };

  const seconds = Math.ceil(remaining / 1000);

  return (
    <Button
      type="button"
      variant="secondary"
      size={size === 'xl' ? 'xl' : 'md'}
      block={size === 'xl'}
      disabled={disabled || cooling}
      onClick={handleClick}
      aria-label={
        cooling
          ? `Tushunmadim — ${seconds} soniyadan keyin qayta bosish mumkin`
          : "Tushunmadim (o'qituvchiga anonim yuboriladi)"
      }
      className={cn('tabular-nums', className)}
    >
      <span aria-hidden className={size === 'xl' ? 'text-xl' : 'text-base'}>
        🐢
      </span>
      {cooling ? `${seconds} s` : 'Tushunmadim'}
    </Button>
  );
}
