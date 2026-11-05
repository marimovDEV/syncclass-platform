'use client';

/**
 * Server `ends_at` ga asoslangan sanoq — AUDIT.md §G3 (majburiy qaror).
 *
 * Klient taymeri FAQAT ko'rsatish uchun: muddatni server belgilaydi va ovoz/javobni
 * `ends_at` + grace bilan o'zi tekshiradi. QUIZ, POLL va OPEN bir xil qoidani ishlatadi.
 */

import { useEffect, useMemo, useState } from 'react';

export interface ServerCountdown {
  /** Qolgan vaqt (ms), 0 dan kichik bo'lmaydi. */
  remainingMs: number;
  /** 1 → 0 gacha (taymer halqasi uchun). */
  ratio: number;
  /** Boshlanganidan beri o'tgan vaqt (ms) — faqat telemetriya. */
  elapsedMs: number;
  /** Vaqt tugadimi. `endsAt` yo'q bo'lsa `false`. */
  expired: boolean;
}

export function useServerCountdown(endsAt: string | null, durationSec: number): ServerCountdown {
  const endsAtMs = useMemo(() => (endsAt === null ? null : Date.parse(endsAt)), [endsAt]);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (endsAtMs === null || Number.isNaN(endsAtMs)) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [endsAtMs]);

  if (endsAtMs === null || Number.isNaN(endsAtMs)) {
    return { remainingMs: 0, ratio: 0, elapsedMs: 0, expired: false };
  }

  const totalMs = Math.max(1, durationSec * 1000);
  const remainingMs = Math.max(0, endsAtMs - now);
  return {
    remainingMs,
    ratio: Math.min(1, Math.max(0, remainingMs / totalMs)),
    elapsedMs: Math.max(0, totalMs - remainingMs),
    expired: remainingMs <= 0,
  };
}
