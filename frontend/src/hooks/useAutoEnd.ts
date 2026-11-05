'use client';

/**
 * Taymer tugaganda POLL/OPEN ni avtomatik yakunlash — CONTRACTS.md §16.5.
 *
 * Server avtomatik yakunlovchi taymer ISHLATMAYDI: muddat faqat ovoz/javob kelganda
 * tekshiriladi. Yakunni o'qituvchi klienti yuboradi — aks holda o'qituvchi unutsa,
 * o'quvchilar natijasiz qoladi.
 *
 * - `end` — `createEndOnce()` nusxasi (idempotent): "Yakunlash" tugmasi bilan BIR XIL,
 *   shuning uchun ikkalasi ishga tushsa ham `*_END` bir marta ketadi.
 * - `enabled` (WS ochiq) qayta `true` bo'lganda effekt qayta qo'yiladi: muddat WS uzilgan
 *   paytda o'tgan bo'lsa, ulanish tiklanishi bilan yakunlanadi (`send` muvaffaqiyatsiz bo'lsa
 *   `createEndOnce` `id` ni belgilamaydi).
 * - `AUTO_END_GRACE_MS` — oxirgi soniyadagi ovozlar yo'lda qolib ketmasin.
 */

import { useEffect, useRef } from 'react';

import { AUTO_END_GRACE_MS } from '@/components/live/interactive';

export interface UseAutoEndOptions {
  /** Faol poll/open identifikatori; yo'q bo'lsa `null`. */
  id: string | null;
  /** Server bergan `ends_at` (ISO). */
  endsAt: string | null;
  /** WS ochiq va foydalanuvchi o'qituvchi. */
  enabled: boolean;
  /** Idempotent yakunlovchi (`createEndOnce`). */
  end: (id: string) => boolean;
}

export function useAutoEnd({ id, endsAt, enabled, end }: UseAutoEndOptions): void {
  const endRef = useRef(end);
  endRef.current = end;

  useEffect(() => {
    if (!enabled || id === null || endsAt === null) return;
    const endsAtMs = Date.parse(endsAt);
    if (Number.isNaN(endsAtMs)) return;

    const delay = Math.max(0, endsAtMs - Date.now()) + AUTO_END_GRACE_MS;
    const timer = setTimeout(() => {
      endRef.current(id);
    }, delay);
    return () => clearTimeout(timer);
  }, [id, endsAt, enabled]);
}
