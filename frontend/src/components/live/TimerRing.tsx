'use client';

/**
 * Taymer halqasi — QUIZ, POLL va OPEN uchun umumiy.
 * Qiymatlar `useServerCountdown` dan (server `ends_at`, AUDIT.md §G3).
 *
 * Glow (DESIGN_GLOW §1/§2): taymer — "jonli moment"ning bir qismi, shuning uchun
 * `Progress glow tone="accent"` bilan bir xil mantiq: halqa `--accent` rangida va
 * atrofida `shadow-glow-accent` nur. Glow RAQAM ustiga emas — halqa tashqarisida.
 *
 * Oxirgi 5 soniya: ikkinchi nur qatlami qo'shiladi va uning FAQAT `opacity` si
 * pulsatsiyalanadi (`motion-safe:animate-pulse`). `prefers-reduced-motion` da u
 * statik ko'rinadi — glow saqlanadi, harakat yo'q (DESIGN_GLOW §5). Raqam qizil
 * (`text-danger`) — vaqt tugashining o'qiladigan belgisi, rang bilan birga matn ham.
 */

import { cn } from '@/lib/utils';
import { formatCountdown } from '@/lib/format';

/** Shundan kam qolganda taymer "shoshilinch" holatga o'tadi. */
const URGENT_MS = 5_000;

export interface TimerRingProps {
  /** 1 → 0 (qolgan ulush). */
  ratio: number;
  remainingMs: number;
  /** `sm` — mobil / yon panel uchun ixcham. */
  size?: 'sm' | 'md';
  className?: string;
}

export function TimerRing({ ratio, remainingMs, size = 'md', className }: TimerRingProps) {
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const urgent = remainingMs > 0 && remainingMs <= URGENT_MS;

  return (
    <div
      className={cn(
        'relative shrink-0 rounded-full shadow-glow-accent',
        size === 'sm' ? 'size-12' : 'size-16',
        className,
      )}
      role="timer"
      aria-live="off"
      aria-label={`Qolgan vaqt ${formatCountdown(remainingMs)}`}
    >
      {urgent ? (
        // Kuchaygan nur — faqat opacity animatsiyasi, faqat motion-safe.
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full shadow-glow-accent motion-safe:animate-pulse"
        />
      ) : null}

      <svg viewBox="0 0 64 64" className="relative size-full -rotate-90" aria-hidden>
        <circle cx="32" cy="32" r={radius} className="fill-none stroke-surface-2" strokeWidth="5" />
        <circle
          cx="32"
          cy="32"
          r={radius}
          strokeWidth="5"
          strokeLinecap="round"
          className="fill-none stroke-accent"
          // `stroke-dashoffset` ATAYLAB animatsiyasiz (DESIGN_GLOW §5: faqat transform/opacity).
          // Qiymat har 250 ms da yangilanadi — ko'zga silliq ko'rinadi.
          style={{
            strokeDasharray: circumference,
            strokeDashoffset: circumference * (1 - ratio),
          }}
        />
      </svg>
      <span
        className={cn(
          'absolute inset-0 flex items-center justify-center font-semibold tabular-nums',
          size === 'sm' ? 'text-xs' : 'text-sm',
          urgent ? 'text-danger' : 'text-fg',
        )}
      >
        {formatCountdown(remainingMs)}
      </span>
    </div>
  );
}
