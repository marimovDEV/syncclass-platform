'use client';

/**
 * `SlideRenderer` — `Slide` discriminated union bo'yicha render (CONTRACTS.md §3).
 *
 * - `AnimatePresence` + `layoutId` bilan 200 ms fade/slide (CONTRACTS.md §9: 150–220 ms).
 * - `prefers-reduced-motion` global CSS da hurmat qilinadi (`globals.css`).
 * - `CODE` slayd **har doim** read-only Shiki ko'rinishi (AUDIT.md §G2). Monaco ni faqat
 *   o'qituvchi studiyasi alohida ko'rsatadi.
 */

import * as React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check, HelpCircle, Timer } from 'lucide-react';

import type { CodeCursor, Slide } from '@/types/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { MarkdownSlide } from '@/components/live/MarkdownSlide';
import { LiveCodeView } from '@/components/live/LiveCodeView';
import { ImageSlideView } from '@/components/live/ImageSlideView';

const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

export interface SlideRendererProps {
  slide: Slide | null;
  /** `CODE` slayd uchun serverdagi jonli kod. Bo'sh bo'lsa `starter_code` ko'rsatiladi. */
  liveCode?: string;
  /** O'qituvchi kursori (`LIVE_CODE_PATCH.cursor`). */
  cursor?: CodeCursor | null;
  /** Jonli kod uzatilayotganini bildirish. */
  liveCodeActive?: boolean;
  /** `QUIZ` slaydda to'g'ri javobni ko'rsatish — faqat o'qituvchi ekranida. */
  revealQuizAnswer?: boolean;
  /** Mobil companion — kichikroq tipografiya. */
  compact?: boolean;
  /** O'qituvchi ekranida nusxalash to'siqlari kerak emas. */
  allowSelect?: boolean;
  /**
   * `POLL`/`OPEN` slaydlarining jonli paneli (`PollPanel`/`OpenPanel`). Panel rol va WS ga
   * bog'liq, shuning uchun uni xona komponenti quradi; bu yerda faqat joylashtiriladi.
   */
  interactive?: React.ReactNode;
  /**
   * Faol slayd ramkasi nuri (DESIGN_GLOW §1/§2 — "faol slayd ramkasi" yagona yorqin joylardan biri).
   * - `'accent'` — slaydda interaktiv HOZIR ketyapti (quiz/so'rovnoma/ochiq savol javob kutyapti).
   *   Firuza — LIVE nishoni va taymer halqasi bilan bir xil "hozir sodir bo'lyapti" rangi.
   * - `'primary'` — oddiy faol slayd (markdown, kod, rasm, boshlanmagan savol). Binafsha —
   *   fokus va asosiy harakat rangi: "e'tibor shu yerda", lekin shoshilinch emas.
   * - `'none'` — prevyu va h.k.
   * Nur FAQAT ramkada: ichidagi matn, markdown va kod blokiga glow/text-shadow qo'yilmaydi.
   */
  frame?: 'primary' | 'accent' | 'none';
  className?: string;
}

const FRAME_CLASS: Record<NonNullable<SlideRendererProps['frame']>, string> = {
  primary: 'rounded-2xl border border-primary/30 bg-surface shadow-glow-primary',
  accent: 'rounded-2xl border border-accent/40 bg-surface shadow-glow-accent',
  none: '',
};

export function SlideRenderer({
  slide,
  liveCode,
  cursor = null,
  liveCodeActive = false,
  revealQuizAnswer = false,
  compact = false,
  allowSelect = false,
  interactive,
  frame = 'none',
  className,
}: SlideRendererProps) {
  const reduceMotion = useReducedMotion() === true;

  const body = (current: Slide): React.ReactNode => {
    switch (current.type) {
      case 'MARKDOWN':
        return <MarkdownSlide slide={current} compact={compact} />;
      case 'CODE':
        return (
          <div className={cn('flex min-h-0 flex-1 flex-col', compact ? 'p-3' : 'p-4 studio:p-6')}>
            <LiveCodeView
              code={
                typeof liveCode === 'string' && liveCode.length > 0 ? liveCode : current.starter_code
              }
              lang={current.code_lang}
              cursor={cursor}
              title={current.title ?? 'Kod'}
              live={liveCodeActive}
              allowSelect={allowSelect}
              className="min-h-48 flex-1"
            />
          </div>
        );
      case 'QUIZ':
        return <QuizSlidePreview slide={current} reveal={revealQuizAnswer} compact={compact} />;
      case 'IMAGE':
        return <ImageSlideView slide={current} compact={compact} />;
      case 'POLL':
      case 'OPEN':
        return interactive ?? <InteractiveFallback question={current.question} compact={compact} />;
      default: {
        // Yangi slayd turi qo'shilib, `case` yozilmasa — kompilyatsiya xatosi.
        const unhandled: never = current;
        return unhandled;
      }
    }
  };

  return (
    // Ramka nuri tashqariga ~48px tarqaladi: tashqi `padding` uni kesilishdan saqlaydi,
    // ichki qatlam esa `overflow-hidden` bilan kontentni ramka burchaklariga sig'diradi.
    <div className={cn('relative flex min-h-0 flex-1 flex-col', frame !== 'none' && 'p-3 studio:p-4', className)}>
      <div className={cn('relative flex min-h-0 flex-1 flex-col overflow-hidden', FRAME_CLASS[frame])}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={slide === null ? 'empty' : `${slide.index}-${slide.type}`}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -24 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="flex h-full min-h-0 flex-col overflow-auto scrollbar-thin"
        >
          {slide === null ? <EmptySlide compact={compact} /> : body(slide)}
        </motion.div>
      </AnimatePresence>
      </div>
    </div>
  );
}

/** `POLL`/`OPEN` uchun panel uzatilmagan holat (masalan, prevyu) — faqat savol matni. */
function InteractiveFallback({ question, compact }: { question: string; compact: boolean }) {
  return (
    <div className={cn('mx-auto flex w-full max-w-3xl flex-col gap-2', compact ? 'px-3 py-4' : 'px-6 py-8')}>
      <h2 className={cn('break-words font-semibold text-fg', compact ? 'text-lg' : 'text-2xl')}>
        {question}
      </h2>
      <p className="text-sm text-muted">Interaktiv savol — dars boshlanganda faollashadi.</p>
    </div>
  );
}

function EmptySlide({ compact }: { compact: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className={cn('font-semibold text-fg', compact ? 'text-base' : 'text-lg')}>
        Slayd topilmadi
      </p>
      <p className="max-w-sm text-sm text-muted">
        Prezentatsiyada bu tartib raqamidagi slayd yo&apos;q. O&apos;qituvchi keyingi slaydga
        o&apos;tganda ekran yangilanadi.
      </p>
    </div>
  );
}

/**
 * `QUIZ` slayd — savol boshlanmaguncha ko'rinadigan holat.
 * Haqiqiy javob berish `QuizModal` da (`QUIZ_START` kelganda).
 */
function QuizSlidePreview({
  slide,
  reveal,
  compact,
}: {
  slide: Extract<Slide, { type: 'QUIZ' }>;
  reveal: boolean;
  compact: boolean;
}) {
  return (
    <article
      className={cn(
        'mx-auto flex w-full max-w-3xl flex-col gap-4',
        compact ? 'px-3 py-4' : 'px-6 py-8',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="neutral">
          <HelpCircle aria-hidden />
          Quiz
        </Badge>
        <Badge variant="outline">
          <Timer aria-hidden />
          {slide.duration_sec} s
        </Badge>
        <Badge variant="outline">{slide.points} ball</Badge>
      </div>

      {typeof slide.title === 'string' && slide.title.length > 0 ? (
        <p className="text-xs font-semibold uppercase tracking-wider text-primary">{slide.title}</p>
      ) : null}

      <h2
        className={cn(
          'font-semibold leading-snug tracking-tight text-fg',
          compact ? 'text-xl' : 'text-2xl studio:text-3xl',
        )}
      >
        {slide.question}
      </h2>

      <ul className="grid gap-2 sm:grid-cols-2">
        {slide.options.map((option, index) => {
          const correct = reveal && index === slide.correct_option;
          return (
            <li
              key={index}
              className={cn(
                'flex items-center gap-3 rounded-xl border p-3 text-sm',
                correct ? 'border-success bg-success/10 text-success' : 'border-border bg-surface text-fg',
              )}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-fg/5 font-mono text-xs font-semibold text-muted">
                {OPTION_LETTERS[index] ?? index + 1}
              </span>
              <span className="min-w-0">{option}</span>
              {correct ? <Check className="ml-auto size-4 shrink-0" aria-hidden /> : null}
            </li>
          );
        })}
      </ul>

      <p className="text-sm text-muted">
        {reveal
          ? "Savolni boshlash uchun pastdagi «Quiz» tugmasini bosing (yoki Q)."
          : "O'qituvchi savolni boshlaganda taymer bilan oyna ochiladi."}
      </p>
    </article>
  );
}
