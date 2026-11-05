'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, RotateCcw, Save, ShieldAlert, Undo2, X } from 'lucide-react';

import type { GradeIn, SubmissionOut, SubmissionStatus } from '@/types/api';
import { isApiError } from '@/lib/api';
import { errorText, formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import { gradeSubmission } from '@/lib/resources';
import { clamp, cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { AI_DISCLAIMER } from '@/components/reviewer/AiVerdictCard';
import { hasAiFlag } from '@/components/reviewer/AiVerdictBadge';

export interface GradePanelProps {
  submission: SubmissionOut;
  /** `homeworks.max_score`. */
  maxScore: number;
  /** `homeworks.ai_penalty_points` — `AI Jarima` tugmasining qiymati. */
  aiPenaltyPoints: number;
  /** Deadline dan keyin topshirilgan — ma'lumot uchun, ball avtomatik tushmaydi. */
  isLate?: boolean;
  onGraded?: (submission: SubmissionOut) => void;
  className?: string;
}

/** Tezkor tugmalar — `max_score` ga nisbatan 100% / 90% / 80%. */
function quickScores(maxScore: number): number[] {
  const unique = new Set<number>([
    maxScore,
    Math.round(maxScore * 0.9),
    Math.round(maxScore * 0.8),
  ]);
  return [...unique].sort((a, b) => b - a);
}

/**
 * Baholash paneli.
 *
 * AUDIT.md §E2 / §E3 qizil chiziqlari:
 *  - `AI Jarima` — ALOHIDA tugma va IKKI QADAMLI tasdiqlash (bir klikda ball kamaymaydi);
 *  - jarima qo'llanganda izoh majburiy (o'quvchiga sabab ko'rinishi uchun);
 *  - `PENDING_AI` / `AI_FAILED` statusida ham baholash ishlaydi — hech qachon bloklanmaydi.
 */
export function GradePanel({
  submission,
  maxScore,
  aiPenaltyPoints,
  isLate = false,
  onGraded,
  className,
}: GradePanelProps) {
  const queryClient = useQueryClient();

  const [scoreText, setScoreText] = React.useState<string>(() =>
    submission.final_score !== null ? String(submission.final_score) : '',
  );
  const [penalty, setPenalty] = React.useState<number>(submission.penalty_applied);
  const [comment, setComment] = React.useState<string>(submission.teacher_comment ?? '');
  // Ikki qadamli tasdiqlash: tugma bosilgach "armed" bo'ladi, jarima faqat tasdiqdan keyin.
  const [penaltyArmed, setPenaltyArmed] = React.useState(false);

  // Boshqa submissionga o'tilganda forma qayta to'ldiriladi (render paytida tuzatish —
  // React tavsiya qilgan "derive state from props" naqshi, qo'shimcha effekt kerak emas).
  const [syncedId, setSyncedId] = React.useState(submission.id);
  if (syncedId !== submission.id) {
    setSyncedId(submission.id);
    setScoreText(submission.final_score !== null ? String(submission.final_score) : '');
    setPenalty(submission.penalty_applied);
    setComment(submission.teacher_comment ?? '');
    setPenaltyArmed(false);
  }

  const rawScore = Number.parseInt(scoreText, 10);
  const scoreValid = Number.isFinite(rawScore) && rawScore >= 0 && rawScore <= maxScore;
  const baseScore = scoreValid ? rawScore : 0;
  const finalScore = clamp(baseScore - penalty, 0, maxScore);
  const commentRequired = penalty > 0;
  const commentMissing = commentRequired && comment.trim().length === 0;

  const grade = useMutation({
    mutationFn: (body: GradeIn) => gradeSubmission(submission.id, body),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.submission(updated.id), updated);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.homeworkSubmissions(updated.homework_id),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.submission(updated.id) });
      toast.success(
        updated.status === 'RESUBMIT_REQUIRED'
          ? 'Qayta topshirish talab qilindi'
          : `Baho saqlandi · ${updated.final_score ?? 0} ball`,
      );
      onGraded?.(updated);
    },
    onError: (caught) => {
      toast.error('Bahoni saqlab bo’lmadi', {
        description: isApiError(caught)
          ? errorText(caught.code, caught.message)
          : 'Qayta urinib ko’ring.',
      });
    },
  });

  const submit = (status: SubmissionStatus): void => {
    if (!scoreValid) {
      toast.error(`Ball 0 va ${maxScore} orasida bo’lishi kerak`);
      return;
    }
    if (commentMissing) {
      toast.error('Jarima qo’llanganda izoh majburiy', {
        description: 'O’quvchi ball nega kamayganini bilishi kerak.',
      });
      return;
    }
    grade.mutate({
      final_score: finalScore,
      penalty_applied: penalty,
      teacher_comment: comment.trim(),
      status,
    });
  };

  const flagged = hasAiFlag(submission);

  return (
    <section
      className={cn('flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4', className)}
      aria-label="Baholash paneli"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-fg">Baholash</h2>
        <span className="text-xs text-muted">
          Maksimal: <span className="font-semibold tabular-nums text-fg">{maxScore}</span>
        </span>
      </header>

      {isLate ? (
        <p className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent/[0.08] px-3 py-2 text-xs text-fg">
          <Badge variant="accent">Kechikdi</Badge>
          Ish muddatdan keyin topshirilgan. Bu — ma’lumot, jazo emas: ball avtomatik tushmaydi.
        </p>
      ) : null}

      {submission.status === 'GRADED' && submission.graded_at ? (
        <p className="text-xs text-muted">
          Avval baholangan: {formatDateTime(submission.graded_at)} ·{' '}
          <span className="font-semibold tabular-nums text-fg">{submission.final_score}</span> ball.
          Qayta saqlasangiz o’zgarish audit jurnaliga yoziladi (AUDIT §D7).
        </p>
      ) : null}

      {/* Tezkor tugmalar */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="grade-score">Ball</Label>
        <div className="flex flex-wrap items-center gap-2">
          {quickScores(maxScore).map((value) => (
            <Button
              key={value}
              type="button"
              variant={scoreText === String(value) ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setScoreText(String(value))}
            >
              {value}
            </Button>
          ))}
          <Input
            id="grade-score"
            type="number"
            inputMode="numeric"
            min={0}
            max={maxScore}
            value={scoreText}
            invalid={scoreText.length > 0 && !scoreValid}
            onChange={(event) => setScoreText(event.target.value)}
            placeholder="Qo’lda"
            className="h-9 w-24 tabular-nums"
            aria-label="Ballni qo’lda kiritish"
          />
          {submission.suggested_score !== null ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setScoreText(String(submission.suggested_score))}
            >
              AI taklifi: {submission.suggested_score}
            </Button>
          ) : null}
        </div>
        {scoreText.length > 0 && !scoreValid ? (
          <p role="alert" className="text-xs text-danger">
            Ball 0 va {maxScore} orasidagi butun son bo’lishi kerak.
          </p>
        ) : null}
      </div>

      <Separator />

      {/* AI jarima — ikki qadamli tasdiqlash (AUDIT §E2) */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">AI jarimasi</p>
          {penalty > 0 ? (
            <Badge variant="danger">−{penalty} ball qo’llangan</Badge>
          ) : (
            <Badge variant="outline">qo’llanmagan</Badge>
          )}
        </div>

        <p className="text-xs text-muted">{AI_DISCLAIMER}</p>

        {penalty > 0 ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() => {
              setPenalty(0);
              setPenaltyArmed(false);
            }}
          >
            <Undo2 aria-hidden />
            Jarimani bekor qilish
          </Button>
        ) : penaltyArmed ? (
          <div className="flex flex-col gap-2 rounded-xl border border-danger/40 bg-danger/[0.07] p-3">
            <p className="flex items-start gap-2 text-sm text-danger">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                <span className="font-semibold">Tasdiqlaysizmi?</span> Ball{' '}
                <span className="font-semibold tabular-nums">−{aiPenaltyPoints}</span> ga kamayadi.
                O’quvchi bilan gaplashdingizmi?
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => {
                  setPenalty(aiPenaltyPoints);
                  setPenaltyArmed(false);
                }}
              >
                <Check aria-hidden />
                Ha, jarimani qo’llash
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPenaltyArmed(false)}
              >
                <X aria-hidden />
                Bekor qilish
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => setPenaltyArmed(true)}
            >
              <ShieldAlert aria-hidden />
              AI Jarima: −{aiPenaltyPoints}
            </Button>
            {!flagged ? (
              <p className="text-xs text-muted">
                Bu ishda dalilli AI bayrog’i yo’q — jarima tavsiya etilmaydi.
              </p>
            ) : null}
          </div>
        )}
      </div>

      <Separator />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="grade-comment" required={commentRequired}>
          O’qituvchi izohi
        </Label>
        <Textarea
          id="grade-comment"
          rows={4}
          value={comment}
          invalid={commentMissing}
          onChange={(event) => setComment(event.target.value)}
          placeholder="O’quvchiga ko’rinadigan izoh: nima yaxshi, nima tuzatiladi…"
        />
        {commentMissing ? (
          <p role="alert" className="text-xs text-danger">
            Jarima qo’llanganda izoh majburiy.
          </p>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2">
        <span className="text-xs text-muted">Yakuniy ball</span>
        <span className="text-lg font-bold tabular-nums text-fg">
          {finalScore}
          {penalty > 0 ? (
            <span className="ml-1 text-xs font-medium text-danger">(−{penalty})</span>
          ) : null}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={() => submit('GRADED')}
          loading={grade.isPending}
          disabled={!scoreValid || commentMissing}
        >
          <Save aria-hidden />
          Bahoni saqlash
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => submit('RESUBMIT_REQUIRED')}
          loading={grade.isPending}
          disabled={!scoreValid || commentMissing}
        >
          <RotateCcw aria-hidden />
          Qayta topshirish talab qilinadi
        </Button>
      </div>
    </section>
  );
}
