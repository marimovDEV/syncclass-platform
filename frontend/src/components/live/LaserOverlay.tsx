'use client';

/**
 * Lazer ko'rsatkich — AUDIT.md §G4.
 *
 * - **O'qituvchi:** `rAF` ichida `LASER_THROTTLE_MS` (25 ms) throttle → ≤40 xabar/s.
 *   Koordinatalar overlay o'lchamiga nisbatan 0..1 ga normalizatsiya qilinadi (CONTRACTS.md §5).
 * - **O'quvchi:** store dan **imperativ** (`useLiveRoom.subscribe`) o'qiladi va `rAF` da
 *   `lerp` bilan interpolyatsiya qilinadi → ekranda 60 FPS silliq, trafik 2.5× kam.
 *   React render siklida qatnashmaydi: sekundiga 40 marta render bo'lmaydi.
 */

import * as React from 'react';

import type { LaserMoveData } from '@/types/api';
import { LASER_THROTTLE_MS } from '@/types/api';
import { cn } from '@/lib/utils';
import { useLiveRoom } from '@/store/useLiveRoom';

/** Shu vaqtdan keyin lazer "o'ladi" (o'qituvchi sichqonchani qo'yib yubordi). */
const LASER_IDLE_MS = 1_600;
/** Interpolyatsiya tezligi (0..1): har kadrda maqsadga shuncha yaqinlashadi. */
const LERP_FACTOR = 0.28;

export interface LaserOverlayProps {
  mode: 'teacher' | 'student';
  /** O'qituvchi: lazer rejimi yoniqmi. O'chiq bo'lsa overlay hodisalarni o'tkazib yuboradi. */
  active?: boolean;
  /** O'qituvchi: `LASER_MOVE` yuborish. */
  onMove?: (data: LaserMoveData) => void;
  className?: string;
}

export function LaserOverlay({ mode, active = false, onMove, className }: LaserOverlayProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const dotRef = React.useRef<HTMLDivElement | null>(null);

  const onMoveRef = React.useRef(onMove);
  onMoveRef.current = onMove;

  // Maqsad (server yoki sichqoncha) va joriy (ekranda) holat.
  const target = React.useRef<{ x: number; y: number; drawing: boolean; ts: number } | null>(null);
  const current = React.useRef<{ x: number; y: number } | null>(null);
  const lastSentAt = React.useRef(0);
  const dirty = React.useRef(false);

  /* ----------------------- O'quvchi: store ga obuna ----------------------- */

  React.useEffect(() => {
    if (mode !== 'student') return;
    const apply = (laser: { x: number; y: number; drawing: boolean; ts: number } | null): void => {
      target.current = laser;
    };
    apply(useLiveRoom.getState().laser);
    return useLiveRoom.subscribe((state) => apply(state.laser));
  }, [mode]);

  /* ------------------------- rAF: chizish + yuborish ---------------------- */

  // Overlay o'lchami — kadrda `getBoundingClientRect` chaqirmaslik uchun keshlanadi.
  const sizeRef = React.useRef({ width: 0, height: 0 });

  React.useEffect(() => {
    const node = containerRef.current;
    if (node === null) return;
    const measure = (): void => {
      sizeRef.current = { width: node.clientWidth, height: node.clientHeight };
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    let raf = 0;

    const frame = (): void => {
      raf = requestAnimationFrame(frame);

      const dot = dotRef.current;
      if (dot === null) return;

      const goal = target.current;
      const now = Date.now();

      if (goal === null || now - goal.ts > LASER_IDLE_MS) {
        dot.style.opacity = '0';
        current.current = null;
        return;
      }

      // Birinchi kadr — sakrab bormasin, to'g'ridan-to'g'ri qo'yiladi.
      const from = current.current ?? { x: goal.x, y: goal.y };
      const next =
        mode === 'teacher'
          ? { x: goal.x, y: goal.y }
          : {
              x: from.x + (goal.x - from.x) * LERP_FACTOR,
              y: from.y + (goal.y - from.y) * LERP_FACTOR,
            };
      current.current = next;

      // 20px nuqta markazi koordinataga tushishi uchun 10px chapga/yuqoriga.
      const { width, height } = sizeRef.current;
      const px = next.x * width - 10;
      const py = next.y * height - 10;

      dot.style.opacity = '1';
      dot.style.transform = `translate3d(${px.toFixed(2)}px, ${py.toFixed(2)}px, 0) scale(${
        goal.drawing ? 1.35 : 1
      })`;

      // O'qituvchi: throttle bilan yuborish.
      if (mode === 'teacher' && dirty.current && now - lastSentAt.current >= LASER_THROTTLE_MS) {
        dirty.current = false;
        lastSentAt.current = now;
        onMoveRef.current?.({ x: goal.x, y: goal.y, drawing: goal.drawing });
      }
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  /* --------------------------- O'qituvchi: pointer ------------------------- */

  const handlePointer = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (mode !== 'teacher' || !active) return;
      const box = containerRef.current?.getBoundingClientRect();
      if (box === undefined || box.width === 0 || box.height === 0) return;
      const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      const y = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
      target.current = { x, y, drawing: event.buttons > 0, ts: Date.now() };
      dirty.current = true;
    },
    [mode, active],
  );

  const handleLeave = React.useCallback(() => {
    if (mode !== 'teacher') return;
    // Oxirgi holatni `drawing:false` bilan yuboramiz, keyin lazer o'z-o'zidan o'chadi.
    const goal = target.current;
    if (goal !== null) onMoveRef.current?.({ x: goal.x, y: goal.y, drawing: false });
    target.current = null;
    dirty.current = false;
  }, [mode]);

  const interactive = mode === 'teacher' && active;

  return (
    <div
      ref={containerRef}
      aria-hidden
      className={cn(
        'absolute inset-0 z-20 overflow-hidden',
        interactive ? 'cursor-crosshair' : 'pointer-events-none',
        className,
      )}
      onPointerMove={interactive ? handlePointer : undefined}
      onPointerDown={interactive ? handlePointer : undefined}
      onPointerUp={interactive ? handlePointer : undefined}
      onPointerLeave={interactive ? handleLeave : undefined}
    >
      {/*
        Nuqta — faqat `--danger` tokeni (qattiq rgba yo'q): yumshoq halqa + qattiq yadro.
        Glow tokeni ATAYLAB ishlatilmaydi — nur LIVE momentiga saqlangan (DESIGN_GLOW §1).
        Harakat imperativ `transform`, ko'rinish `opacity` (rAF) — boshqa xususiyat animatsiyalanmaydi.
      */}
      <div
        ref={dotRef}
        className="absolute left-0 top-0 flex size-5 items-center justify-center rounded-full bg-danger/25 opacity-0 transition-opacity duration-fast will-change-transform"
      >
        <span className="size-2.5 rounded-full bg-danger ring-2 ring-danger/40" />
      </div>
    </div>
  );
}
