'use client';

/**
 * Quiz modali — CONTRACTS.md §5 (`QUIZ_START` / `QUIZ_ANSWER` / `QUIZ_PROGRESS` /
 * `QUIZ_RESULTS`), §6 (XP formulasi serverda).
 *
 * AUDIT.md §G3 (majburiy qaror): taymer **serverning `ends_at`** iga asoslanadi; klientdagi
 * sanoq faqat **ko'rsatish** uchun. Yuborilgan `time_ms` ham faqat telemetriya — XP ni
 * server `now - started_at` dan hisoblaydi. Shuning uchun soatni o'zgartirib XP olish mumkin emas.
 */

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Crown, Hourglass, Timer, Trophy, X } from 'lucide-react';

import type { ActiveQuiz, QuizProgressData, QuizResultsData, UserRole } from '@/types/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { UserAvatar } from '@/components/ui/avatar';
import { TimerRing } from '@/components/live/TimerRing';
import { useServerCountdown } from '@/hooks/useServerCountdown';

const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

/* ========================================================================== */
/* Natija taqsimoti + leaderboard                                             */
/* ========================================================================== */

function ResultsView({
  results,
  options,
  selectedOption,
  role,
}: {
  results: QuizResultsData;
  options: string[];
  selectedOption: number | null;
  role: UserRole;
}) {
  const total = results.distribution.reduce((sum, value) => sum + value, 0);
  const myAnswerCorrect = selectedOption !== null && selectedOption === results.correct_option;

  return (
    <div className="flex flex-col gap-4">
      {role === 'STUDENT' && selectedOption !== null ? (
        <div
          className={cn(
            'flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium',
            myAnswerCorrect ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger',
          )}
        >
          {myAnswerCorrect ? <Check className="size-4" aria-hidden /> : <X className="size-4" aria-hidden />}
          {myAnswerCorrect ? "To'g'ri javob! XP qo'shildi." : "Bu safar xato — keyingi savolda urinib ko'ring."}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {options.map((option, index) => {
          const count = results.distribution[index] ?? 0;
          const percent = total === 0 ? 0 : Math.round((count / total) * 100);
          const correct = index === results.correct_option;
          const mine = index === selectedOption;

          return (
            <div key={index} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className={cn('flex min-w-0 items-center gap-2', correct ? 'font-semibold text-success' : 'text-fg')}>
                  <span className="shrink-0 font-mono text-xs text-muted">
                    {OPTION_LETTERS[index] ?? index + 1}
                  </span>
                  <span className="truncate">{option}</span>
                  {correct ? <Check className="size-4 shrink-0 text-success" aria-hidden /> : null}
                  {mine ? (
                    <Badge variant="outline" className="shrink-0">
                      siz
                    </Badge>
                  ) : null}
                </span>
                <span className="shrink-0 tabular-nums text-muted">
                  {count} · {percent}%
                </span>
              </div>
              <Progress value={percent} tone={correct ? 'success' : 'primary'} />
            </div>
          );
        })}
      </div>

      {results.leaderboard.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <Trophy className="size-4 text-primary" aria-hidden />
            Eng tez javob berganlar
          </p>
          <ol className="flex flex-col gap-1.5">
            {results.leaderboard.slice(0, 5).map((row, index) => (
              <li
                key={row.student_id}
                className="flex items-center gap-2.5 rounded-xl bg-surface-2 px-2.5 py-1.5"
              >
                <span className="w-4 shrink-0 text-center text-sm font-semibold tabular-nums text-muted">
                  {index === 0 ? <Crown className="size-4 text-primary" aria-hidden /> : index + 1}
                </span>
                <UserAvatar fullName={row.full_name} avatarUrl={null} className="size-7" />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{row.full_name}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted">
                  {(row.answer_ms / 1000).toFixed(1)} s
                </span>
                <Badge variant="primary" className="shrink-0 tabular-nums">
                  +{row.xp} XP
                </Badge>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

/* ========================================================================== */
/* Asosiy modal                                                               */
/* ========================================================================== */

export interface QuizModalProps {
  role: UserRole;
  quiz: ActiveQuiz | null;
  results: QuizResultsData | null;
  progress: QuizProgressData | null;
  /** Shu klient javob bergan quiz `quiz_id` si. */
  answeredQuizId: string | null;
  selectedOption: number | null;
  /** O'quvchi javobi — `QUIZ_ANSWER{quiz_id, selected_index, time_ms}`. */
  onAnswer: (quizId: string, selectedIndex: number, timeMs: number) => void;
  /** O'qituvchi quizni yopadi — `QUIZ_END{quiz_id}`. */
  onEnd: (quizId: string) => void;
  /** Natija oynasini yopish. */
  onCloseResults: () => void;
  /** Xonadagi o'quvchilar soni — progress uchun zaxira. */
  participantCount: number;
}

export function QuizModal({
  role,
  quiz,
  results,
  progress,
  answeredQuizId,
  selectedOption,
  onAnswer,
  onEnd,
  onCloseResults,
  participantCount,
}: QuizModalProps) {
  const isTeacher = role === 'TEACHER' || role === 'ADMIN';
  const open = quiz !== null || results !== null;

  const { remainingMs, ratio, elapsedMs } = useServerCountdown(
    quiz?.ends_at ?? null,
    quiz?.duration_sec ?? 1,
  );

  const answered = quiz !== null && answeredQuizId === quiz.quiz_id;
  const timeUp = quiz !== null && remainingMs <= 0;

  // Konfetti — faqat natija kelganda va faqat bir marta.
  const confettiForRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (results === null) return;
    if (confettiForRef.current === results.quiz_id) return;
    confettiForRef.current = results.quiz_id;

    const topThree = results.leaderboard.slice(0, 3).length > 0;
    const correctForMe = selectedOption !== null && selectedOption === results.correct_option;
    if (!topThree && !(isTeacher || correctForMe)) return;

    let cancelled = false;
    void import('canvas-confetti').then((module) => {
      if (cancelled) return;
      void module.default({
        particleCount: 90,
        spread: 70,
        startVelocity: 38,
        origin: { y: 0.3 },
        disableForReducedMotion: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [results, selectedOption, isTeacher]);

  const answerOption = (index: number): void => {
    if (quiz === null || answered || timeUp) return;
    onAnswer(quiz.quiz_id, index, Math.round(elapsedMs));
  };

  const answeredCount = progress?.answered ?? 0;
  const totalCount = progress?.total ?? participantCount;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Quiz ketayotganda yopib bo'lmaydi; natijani esa × bilan ham yopish mumkin.
        if (!next && results !== null) onCloseResults();
      }}
    >
      <DialogContent
        hideClose={results === null}
        className="max-w-2xl"
        // Quiz davomida tasodifan yopilmasin; natijani o'qituvchi/o'quvchi o'zi yopadi.
        onEscapeKeyDown={(event) => {
          if (results === null) event.preventDefault();
          else onCloseResults();
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        {quiz !== null ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <TimerRing ratio={ratio} remainingMs={remainingMs} />
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-xl leading-snug">{quiz.question}</DialogTitle>
                <DialogDescription className="mt-1 flex flex-wrap items-center gap-2">
                  <Badge variant="primary">
                    <Timer aria-hidden />
                    {quiz.duration_sec} s
                  </Badge>
                  {isTeacher ? (
                    <span className="tabular-nums">
                      Javob berdi: {answeredCount} / {totalCount}
                    </span>
                  ) : (
                    <span>Tezroq javob bergan ko&apos;proq XP oladi</span>
                  )}
                </DialogDescription>
              </div>
            </div>

            {isTeacher ? <Progress value={totalCount === 0 ? 0 : (answeredCount / totalCount) * 100} /> : null}

            <div className="grid gap-2 sm:grid-cols-2">
              {quiz.options.map((option, index) => {
                const chosen = selectedOption === index;
                return (
                  <button
                    key={index}
                    type="button"
                    disabled={isTeacher || answered || timeUp}
                    onClick={() => answerOption(index)}
                    aria-pressed={chosen}
                    className={cn(
                      'flex items-center gap-3 rounded-xl border p-3 text-left text-sm transition-colors duration-fast',
                      chosen
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-surface text-fg',
                      !isTeacher && !answered && !timeUp
                        ? 'hover:border-primary/60 hover:bg-primary/5'
                        : 'cursor-default',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-7 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-semibold',
                        chosen ? 'bg-primary text-primary-fg' : 'bg-fg/5 text-muted',
                      )}
                    >
                      {OPTION_LETTERS[index] ?? index + 1}
                    </span>
                    <span className="min-w-0">{option}</span>
                  </button>
                );
              })}
            </div>

            <AnimatePresence>
              {answered ? (
                <motion.p
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="flex items-center gap-2 rounded-xl bg-success/10 px-3 py-2 text-sm text-success"
                >
                  <Hourglass className="size-4" aria-hidden />
                  Javobingiz qabul qilindi. Natijani kutamiz…
                </motion.p>
              ) : null}
              {!answered && timeUp && !isTeacher ? (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger"
                >
                  Vaqt tugadi — bu savolga javob berilmadi.
                </motion.p>
              ) : null}
            </AnimatePresence>

            {isTeacher ? (
              <Button variant="primary" size="lg" block onClick={() => onEnd(quiz.quiz_id)}>
                Natijani ko&apos;rsatish
              </Button>
            ) : null}
          </div>
        ) : results !== null ? (
          <div className="flex flex-col gap-4">
            <DialogTitle className="text-xl">Quiz natijasi</DialogTitle>
            <DialogDescription className="sr-only">
              Variantlar bo&apos;yicha javob taqsimoti va eng tez javob berganlar ro&apos;yxati.
            </DialogDescription>
            <ResultsView
              results={results}
              options={results.options}
              selectedOption={selectedOption}
              role={role}
            />
            <Button variant="secondary" block onClick={onCloseResults}>
              Yopish
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
