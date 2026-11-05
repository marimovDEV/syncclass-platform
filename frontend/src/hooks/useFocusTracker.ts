'use client';

/**
 * Focus tracker — AUDIT.md §F (Anti-cheat da'volari) va CONTRACTS.md §5 `FOCUS_CHANGE`.
 *
 * ⚠️ **Yashirin kuzatuv QILINMAYDI.** Bu hook faqat `onChange` ni chaqiradi; o'quvchi
 * ekranida ochiq ko'rinadigan eslatma (`FocusNotice`) majburiy. Ma'lumot bahoga ta'sir
 * qilmaydi — faqat o'qituvchiga tavsiya xarakterida ko'rsatiladi.
 *
 * Mantiq:
 * 1. `visibilitychange` (tab almashdi) yoki `blur` (oyna fokusni yo'qotdi) → **grace** boshlanadi.
 * 2. Grace `FOCUS_GRACE_MS` (10 s) ichida qaytsa — serverga **hech narsa yuborilmaydi**
 *    (bildirishnoma, qisqa chalg'ish yolg'on-pozitiv bermasin).
 * 3. Grace tugasa — `onChange(false)`.
 * 4. Qaytganda — agar `false` yuborilgan bo'lsa — **darhol** `onChange(true)`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { FOCUS_GRACE_MS } from '@/types/api';

export interface UseFocusTrackerOptions {
  /** O'quvchi xonada va WS ulangan bo'lsa `true`. */
  enabled: boolean;
  /** `FOCUS_CHANGE` yuborish. `false` qaytarsa (yuborilmasa) holat baribir saqlanadi. */
  onChange: (isFocused: boolean) => void;
  /** Sinov uchun qisqartirish mumkin; default — `FOCUS_GRACE_MS`. */
  graceMs?: number;
}

export interface FocusTrackerState {
  /** Hozir oyna/tab fokusda-mi (grace hisobga olinmagan, xom holat). */
  isVisible: boolean;
  /** Serverga `is_focused:false` yuborilgan holat (grace o'tgan). */
  reportedAway: boolean;
  /** Fokus yo'qolganidan beri o'tgan soniya — UI dagi sanoq uchun. */
  awaySeconds: number;
}

function documentVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function useFocusTracker({
  enabled,
  onChange,
  graceMs = FOCUS_GRACE_MS,
}: UseFocusTrackerOptions): FocusTrackerState {
  // SSR va birinchi render bir xil bo'lishi uchun boshlang'ich qiymat `true` (AUDIT.md §G6).
  const [isVisible, setIsVisible] = useState(true);
  const [reportedAway, setReportedAway] = useState(false);
  const [awaySeconds, setAwaySeconds] = useState(0);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const reportedRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (graceTimer.current !== null) {
      clearTimeout(graceTimer.current);
      graceTimer.current = null;
    }
    if (tickTimer.current !== null) {
      clearInterval(tickTimer.current);
      tickTimer.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      clearTimers();
      // Kuzatuv o'chirilganda "ketgan" holatda qolib ketmasin.
      if (reportedRef.current) {
        reportedRef.current = false;
        setReportedAway(false);
        onChangeRef.current(true);
      }
      setAwaySeconds(0);
      return;
    }

    const handleAway = (): void => {
      if (documentVisible()) return;
      setIsVisible(false);
      if (graceTimer.current !== null || reportedRef.current) return;

      const awaySince = Date.now();
      tickTimer.current = setInterval(() => {
        setAwaySeconds(Math.floor((Date.now() - awaySince) / 1000));
      }, 1000);

      graceTimer.current = setTimeout(() => {
        graceTimer.current = null;
        if (documentVisible()) return;
        reportedRef.current = true;
        setReportedAway(true);
        onChangeRef.current(false);
      }, graceMs);
    };

    const handleBack = (): void => {
      if (!documentVisible()) return;
      setIsVisible(true);
      clearTimers();
      setAwaySeconds(0);
      if (reportedRef.current) {
        reportedRef.current = false;
        setReportedAway(false);
        onChangeRef.current(true);
      }
    };

    const handleVisibility = (): void => {
      if (document.visibilityState === 'visible') handleBack();
      else handleAway();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('blur', handleAway);
    window.addEventListener('focus', handleBack);

    // Mount paytidagi haqiqiy holat (masalan sahifa fon tabda ochilgan).
    setIsVisible(documentVisible());
    if (!documentVisible()) handleAway();

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('blur', handleAway);
      window.removeEventListener('focus', handleBack);
      clearTimers();
    };
  }, [enabled, graceMs, clearTimers]);

  return { isVisible, reportedAway, awaySeconds };
}
