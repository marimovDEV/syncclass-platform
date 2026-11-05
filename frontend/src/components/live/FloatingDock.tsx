'use client';

/**
 * macOS uslubidagi shisha boshqaruv paneli (o'qituvchi studiyasi).
 * Har tugma yonida klaviatura yorlig'i ko'rsatiladi (AUDIT.md §G1 — yorliqlar
 * input/Monaco ichida ishlamaydi, buni `useHotkeys` kafolatlaydi).
 */

import * as React from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Code2,
  HelpCircle,
  Maximize,
  MonitorUp,
  PhoneOff,
  Pointer,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';

interface DockButtonProps {
  label: string;
  hotkey?: string;
  active?: boolean;
  disabled?: boolean;
  tone?: 'default' | 'danger';
  onClick: () => void;
  children: React.ReactNode;
}

function DockButton({
  label,
  hotkey,
  active = false,
  disabled = false,
  tone = 'default',
  onClick,
  children,
}: DockButtonProps) {
  return (
    <SimpleTooltip content={hotkey === undefined ? label : `${label} · ${hotkey}`}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          // Faqat rang va `transform` (active:scale) — `box-shadow` animatsiyalanmaydi (DESIGN_GLOW §5).
          'flex size-11 items-center justify-center rounded-xl transition-[color,background-color,transform] duration-fast',
          'disabled:cursor-not-allowed disabled:opacity-40',
          active
            ? 'bg-primary text-primary-fg shadow-soft'
            : tone === 'danger'
              ? 'text-danger hover:bg-danger/10'
              : 'text-fg hover:bg-surface-2 active:scale-95',
          '[&_svg]:size-5',
        )}
      >
        {children}
      </button>
    </SimpleTooltip>
  );
}

export interface FloatingDockProps {
  slideIndex: number;
  totalSlides: number;
  laserActive: boolean;
  codeActive: boolean;
  isSharing: boolean;
  /** Joriy slayd `CODE` turidami (jonli kod shunda ma'noga ega). */
  canCode: boolean;
  /** Joriy slayd interaktivmi (`QUIZ` / `POLL` / `OPEN`). */
  canQuiz: boolean;
  /** Joriy slaydning interaktivi allaqachon ketayotgan bo'lsa tugma o'chadi. */
  quizRunning: boolean;
  /** Ekran ulashish mavjudmi (LiveKit). */
  canShare: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToggleLaser: () => void;
  onToggleCode: () => void;
  onStartQuiz: () => void;
  onToggleShare: () => void;
  onFullscreen: () => void;
  onEnd: () => void;
  /** WS yopiq bo'lsa boshqaruv ishlamaydi. */
  disabled?: boolean;
  /**
   * DESIGN_GLOW §5: LiveShell ichida bir vaqtda BITTA blur qatlami. Modal (o'zi `.glass`)
   * ochiq bo'lsa dock shishadan voz kechib qattiq `bg-surface` ga o'tadi — ikki
   * `backdrop-filter` bir-birining ustida 8 GB kompyuter va telefonni sekinlashtiradi.
   */
  solid?: boolean;
  className?: string;
}

export function FloatingDock({
  slideIndex,
  totalSlides,
  laserActive,
  codeActive,
  isSharing,
  canCode,
  canQuiz,
  quizRunning,
  canShare,
  onPrev,
  onNext,
  onToggleLaser,
  onToggleCode,
  onStartQuiz,
  onToggleShare,
  onFullscreen,
  onEnd,
  disabled = false,
  solid = false,
  className,
}: FloatingDockProps) {
  return (
    <div
      className={cn(
        'pointer-events-auto flex items-center gap-1 rounded-2xl border border-border p-1.5 shadow-lifted',
        solid ? 'bg-surface' : 'glass',
        className,
      )}
      role="toolbar"
      aria-label="Dars boshqaruvi"
    >
      <DockButton
        label="Oldingi slayd"
        hotkey="←"
        disabled={disabled || slideIndex <= 0}
        onClick={onPrev}
      >
        <ChevronLeft aria-hidden />
      </DockButton>

      <span className="min-w-14 px-1 text-center text-sm font-medium tabular-nums text-fg">
        {totalSlides === 0 ? '—' : `${slideIndex + 1}/${totalSlides}`}
      </span>

      <DockButton
        label="Keyingi slayd"
        hotkey="→ / Space"
        disabled={disabled || slideIndex >= totalSlides - 1}
        onClick={onNext}
      >
        <ChevronRight aria-hidden />
      </DockButton>

      <span className="mx-1 h-7 w-px shrink-0 bg-border" aria-hidden />

      <DockButton
        label="Lazer ko'rsatkich"
        hotkey="L"
        active={laserActive}
        disabled={disabled}
        onClick={onToggleLaser}
      >
        <Pointer aria-hidden />
      </DockButton>

      <DockButton
        label={codeActive ? 'Jonli koddan chiqish' : 'Jonli kod'}
        hotkey="C / Esc"
        active={codeActive}
        disabled={disabled || !canCode}
        onClick={onToggleCode}
      >
        <Code2 aria-hidden />
      </DockButton>

      <DockButton
        label="Savolni boshlash (quiz, so'rovnoma, ochiq savol)"
        hotkey="Q"
        disabled={disabled || !canQuiz || quizRunning}
        onClick={onStartQuiz}
      >
        <HelpCircle aria-hidden />
      </DockButton>

      <DockButton
        label={isSharing ? "Ekran ulashishni to'xtatish" : 'Ekranni ulashish'}
        active={isSharing}
        disabled={disabled || !canShare}
        onClick={onToggleShare}
      >
        <MonitorUp aria-hidden />
      </DockButton>

      <DockButton label="To'liq ekran" hotkey="F" onClick={onFullscreen}>
        <Maximize aria-hidden />
      </DockButton>

      <span className="mx-1 h-7 w-px shrink-0 bg-border" aria-hidden />

      <SimpleTooltip content="Darsni tugatish">
        <Button variant="danger" size="sm" onClick={onEnd} className="shrink-0">
          <PhoneOff aria-hidden />
          Tugatish
        </Button>
      </SimpleTooltip>
    </div>
  );
}
