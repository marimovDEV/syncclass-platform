'use client';

/**
 * So'rovnoma (POLL) — CONTRACTS.md §16.3. BAHOLANMAYDI: to'g'ri javob ham, XP ham yo'q.
 *
 * - **O'qituvchi:** boshlash, jonli diagramma (`POLL_PROGRESS`, reconnect da
 *   `ROOM_STATE_SYNC.poll_progress`), "Yakunlash". Taymer tugaganda `*_END` ni
 *   `TeacherStudio` avtomatik yuboradi (§16.5) — bu panel faqat ko'rsatadi.
 * - **O'quvchi:** bitta tanlov → "Ovoz berildi". Natija FAQAT `POLL_RESULTS` da
 *   (jonli taqsimot o'quvchiga umuman kelmaydi — olomonga ergashmaslik uchun).
 * - Taymer FAQAT server `ends_at` dan (AUDIT.md §G3).
 * - Foiz hech qachon 100% dan oshmaydi, 0 ga bo'linmaydi, "2/0" ko'rsatilmaydi (`interactive.ts`).
 * - Bosish maydonlari >= 44px (mobil), `prefers-reduced-motion` hurmat qilinadi.
 * - Faqat dizayn tokenlari.
 */

import * as React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { BarChart3, CheckCircle2, Play, Square, Vote } from 'lucide-react';

import type {
  ActivePoll,
  PollProgressData,
  PollResultsData,
  PollSlide,
  UserRole,
} from '@/types/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TimerRing } from '@/components/live/TimerRing';
import { formatTurnout, shareOf } from '@/components/live/interactive';
import { useServerCountdown } from '@/hooks/useServerCountdown';

const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

/* ========================================================================== */
/* Diagramma                                                                  */
/* ========================================================================== */

function PollBars({
  options,
  distribution,
  highlight,
  compact,
}: {
  options: readonly string[];
  distribution: readonly number[];
  /** O'quvchining o'z tanlovi (natijada "siz" belgisi). */
  highlight: number | null;
  compact: boolean;
}) {
  const reduceMotion = useReducedMotion() === true;
  const top = Math.max(0, ...distribution);

  return (
    <ul className="flex flex-col gap-2.5" aria-label="Ovozlar taqsimoti">
      {options.map((option, index) => {
        const count = distribution[index] ?? 0;
        const percent = shareOf(count, distribution);
        const leading = top > 0 && count === top;
        return (
          <li key={index} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="flex min-w-0 items-center gap-2 text-fg">
                <span className="shrink-0 font-mono text-xs text-muted">
                  {OPTION_LETTERS[index] ?? index + 1}
                </span>
                <span className={cn('min-w-0 break-words', leading && 'font-semibold')}>
                  {option}
                </span>
                {highlight === index ? (
                  <Badge variant="outline" className="shrink-0">
                    siz
                  </Badge>
                ) : null}
              </span>
              <span className="shrink-0 tabular-nums text-muted">
                {count} · {percent}%
              </span>
            </div>
            <div
              className={cn('w-full overflow-hidden rounded-full bg-fg/10', compact ? 'h-2' : 'h-3')}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-label={`${option}: ${percent}%`}
            >
              <motion.div
                className={cn('h-full rounded-full', leading ? 'bg-primary' : 'bg-primary/50')}
                initial={false}
                animate={{ width: `${percent}%` }}
                transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: 'easeOut' }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ========================================================================== */
/* Panel                                                                      */
/* ========================================================================== */

export interface PollPanelProps {
  role: UserRole;
  slide: PollSlide;
  activePoll: ActivePoll | null;
  /** Faqat o'qituvchida keladi. */
  progress: PollProgressData | null;
  results: PollResultsData | null;
  /** Natija qaysi slaydga tegishli (`useLiveRoom.pollResultsSlide`). */
  resultsSlide: number | null;
  votedPollId: string | null;
  myVote: number | null;
  /** O'qituvchi: `POLL_START{slide_index}`. */
  onStart?: () => void;
  /** O'qituvchi: idempotent `POLL_END` (tugma va taymer bitta nusxani ishlatadi). */
  onEnd?: (pollId: string) => void;
  /** O'quvchi: `POLL_VOTE`. */
  onVote?: (pollId: string, selectedIndex: number) => void;
  /** WS yopiq. */
  disabled?: boolean;
  compact?: boolean;
}

export function PollPanel({
  role,
  slide,
  activePoll,
  progress,
  results,
  resultsSlide,
  votedPollId,
  myVote,
  onStart,
  onEnd,
  onVote,
  disabled = false,
  compact = false,
}: PollPanelProps) {
  const isTeacher = role === 'TEACHER' || role === 'ADMIN';

  // Faqat SHU slaydga tegishli poll/natija (boshqa slaydniki aralashmasin).
  const live = activePoll !== null && activePoll.slide_index === slide.index ? activePoll : null;
  const ownResults = live === null && results !== null && resultsSlide === slide.index ? results : null;

  const { remainingMs, ratio, expired } = useServerCountdown(
    live?.ends_at ?? null,
    live?.duration_sec ?? slide.duration_sec,
  );

  const voted = live !== null && votedPollId === live.poll_id;
  const liveProgress = live !== null && progress !== null && progress.poll_id === live.poll_id ? progress : null;
  const options = live?.options ?? ownResults?.options ?? slide.options;

  return (
    <section
      className={cn('mx-auto flex w-full max-w-3xl flex-col gap-4', compact ? 'px-3 py-4' : 'px-6 py-8')}
      aria-label="So'rovnoma"
    >
      {/* ------------------------------ sarlavha ------------------------------ */}
      <div className="flex items-start gap-3">
        {live !== null ? (
          <TimerRing ratio={ratio} remainingMs={remainingMs} size={compact ? 'sm' : 'md'} />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <Badge variant="neutral">
              <Vote aria-hidden />
              So&apos;rovnoma
            </Badge>
            <Badge variant="outline">Baholanmaydi</Badge>
            {live !== null && isTeacher ? (
              <Badge variant="neutral" className="tabular-nums">
                {formatTurnout(liveProgress?.voted ?? 0, liveProgress?.total ?? 0, 'ovoz')}
              </Badge>
            ) : null}
          </div>
          {typeof slide.title === 'string' && slide.title.length > 0 ? (
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">{slide.title}</p>
          ) : null}
          <h2
            className={cn(
              'break-words font-semibold leading-snug tracking-tight text-fg',
              compact ? 'text-lg' : 'text-2xl studio:text-3xl',
            )}
          >
            {live?.question ?? slide.question}
          </h2>
        </div>
      </div>

      {/* ------------------------------- tana --------------------------------- */}
      {isTeacher ? (
        live !== null ? (
          <>
            <PollBars
              options={options}
              distribution={liveProgress?.distribution ?? options.map(() => 0)}
              highlight={null}
              compact={compact}
            />
            <p className="text-xs text-muted">
              Jonli diagrammani faqat siz ko&apos;rasiz — o&apos;quvchilar natijani yakunda ko&apos;radi.
              {expired ? ' Vaqt tugadi — natija avtomatik yuboriladi.' : ''}
            </p>
            <Button
              variant="primary"
              size="lg"
              block
              disabled={disabled}
              onClick={() => onEnd?.(live.poll_id)}
            >
              <Square aria-hidden />
              Yakunlash va natijani ko&apos;rsatish
            </Button>
          </>
        ) : (
          <>
            {ownResults !== null ? (
              <ResultsBlock results={ownResults} highlight={null} compact={compact} />
            ) : (
              <OptionPreview options={slide.options} />
            )}
            <Button variant={ownResults !== null ? 'secondary' : 'primary'} size="lg" block disabled={disabled} onClick={onStart}>
              <Play aria-hidden />
              {ownResults !== null ? 'Qayta boshlash' : 'So’rovnomani boshlash'}
            </Button>
          </>
        )
      ) : live !== null ? (
        voted ? (
          <div className="flex flex-col gap-3">
            <p
              role="status"
              className="flex items-center gap-2 rounded-xl border border-success/40 bg-success/10 px-3 py-3 text-sm font-medium text-fg"
            >
              <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
              Ovoz berildi. Natija so&apos;rovnoma yakunida ko&apos;rsatiladi.
            </p>
            {myVote !== null && options[myVote] !== undefined ? (
              <p className="text-sm text-muted">
                Tanlovingiz: <span className="font-medium text-fg">{options[myVote]}</span>
              </p>
            ) : null}
          </div>
        ) : expired ? (
          <p className="rounded-xl border border-border bg-surface px-3 py-3 text-sm text-muted">
            Vaqt tugadi — bu so&apos;rovnomaga ovoz berilmadi. Natija tez orada ko&apos;rsatiladi.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {options.map((option, index) => (
              <button
                key={index}
                type="button"
                disabled={disabled}
                onClick={() => onVote?.(live.poll_id, index)}
                className={cn(
                  'flex min-h-12 items-center gap-3 rounded-xl border border-border bg-surface p-3 text-left text-sm text-fg',
                  'transition-colors duration-fast hover:border-primary/60 hover:bg-primary/5',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                )}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-fg/5 font-mono text-xs font-semibold text-muted">
                  {OPTION_LETTERS[index] ?? index + 1}
                </span>
                <span className="min-w-0 break-words">{option}</span>
              </button>
            ))}
          </div>
        )
      ) : ownResults !== null ? (
        <ResultsBlock results={ownResults} highlight={myVote} compact={compact} />
      ) : (
        <>
          <OptionPreview options={slide.options} />
          <p className="text-sm text-muted">
            O&apos;qituvchi so&apos;rovnomani boshlaganda variantlarni bosib ovoz berasiz.
          </p>
        </>
      )}
    </section>
  );
}

function ResultsBlock({
  results,
  highlight,
  compact,
}: {
  results: PollResultsData;
  highlight: number | null;
  compact: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-fg">
        <BarChart3 className="size-4 text-muted" aria-hidden />
        Natija
        <span className="font-normal tabular-nums text-muted">
          · {results.total > 0 ? `${results.total} ta ovoz` : "ovoz berilmadi"}
        </span>
      </p>
      <PollBars
        options={results.options}
        distribution={results.distribution}
        highlight={highlight}
        compact={compact}
      />
    </div>
  );
}

function OptionPreview({ options }: { options: readonly string[] }) {
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {options.map((option, index) => (
        <li
          key={index}
          className="flex min-h-12 items-center gap-3 rounded-xl border border-border bg-surface p-3 text-sm text-fg"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-fg/5 font-mono text-xs font-semibold text-muted">
            {OPTION_LETTERS[index] ?? index + 1}
          </span>
          <span className="min-w-0 break-words">{option}</span>
        </li>
      ))}
    </ul>
  );
}
