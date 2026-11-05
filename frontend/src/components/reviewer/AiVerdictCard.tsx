'use client';

import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  Info,
  Loader2,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';

import type { SubmissionOut } from '@/types/api';
import { AI_RED_FLAG_THRESHOLD } from '@/types/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { hasAiFlag, isAiRedFlag } from '@/components/reviewer/AiVerdictBadge';

/** AUDIT.md §E2 — bu matn AI bloki ko'rinadigan HAR BIR joyda bo'lishi shart. */
export const AI_DISCLAIMER =
  'Bu — ehtimollik, isbot emas. Ball kamaytirishdan oldin o’quvchi bilan gaplashing.';

export interface AiVerdictCardProps {
  submission: SubmissionOut;
  /** Dalilga bosilganda muharrirda o'sha qatorga sakrash. */
  onJumpToEvidence?: (file: string, lineStart: number, lineEnd: number) => void;
  className?: string;
}

/**
 * AI oldindan tekshiruvi kartochkasi — AUDIT.md §E2 qizil chiziqlari bilan:
 *  - eslatma har doim ko'rinadi;
 *  - `ai_evidence` bo'sh → flag umuman ko'rsatilmaydi;
 *  - ishonch `< 70%` → sariq "ko'rib chiqish tavsiya etiladi", qizil bayroq emas;
 *  - `AI_FAILED` / `PENDING_AI` da ham baholash bloklanmaydi (faqat ma'lumot beriladi).
 */
export function AiVerdictCard({ submission, onJumpToEvidence, className }: AiVerdictCardProps) {
  const flagged = hasAiFlag(submission);
  const red = isAiRedFlag(submission);
  const pending = submission.status === 'PENDING_AI';
  const failed = submission.status === 'AI_FAILED';
  // CONTRACTS.md §12.1 — yagona manba `SubmissionOut`; prop orqali uzatish yo'q,
  // shuning uchun "kuchli tomonlar" blokini ulashni unutish mumkin emas.
  // (`?? []` — tipda `NOT NULL`, lekin eski/keshlangan javob kelsa sahifa yiqilmasin.)
  const strengths = submission.ai_strengths ?? [];
  const issues = submission.ai_issues ?? [];

  return (
    <section
      className={cn('flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4', className)}
      aria-label="AI oldindan tekshiruvi"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <Sparkles className="size-4 text-primary" aria-hidden />
          AI oldindan tekshiruvi
        </h2>
        {pending ? (
          <Badge variant="neutral">
            <Loader2 className="animate-spin" aria-hidden />
            Tekshirilmoqda
          </Badge>
        ) : failed ? (
          <Badge variant="outline">
            <TriangleAlert aria-hidden />
            AI xulosasi yo’q
          </Badge>
        ) : flagged ? (
          <Badge variant={red ? 'danger' : 'accent'}>
            {red ? <AlertTriangle aria-hidden /> : <Eye aria-hidden />}
            {red ? 'Gumon bor' : 'Ko’rib chiqish tavsiya etiladi'}
          </Badge>
        ) : (
          <Badge variant="success">
            <CheckCircle2 aria-hidden />
            Gumon yo’q
          </Badge>
        )}
      </header>

      {/* AUDIT §E2 — majburiy, har doim ko'rinadigan eslatma. */}
      <p className="rounded-xl border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
        <Info className="mr-1 inline size-3.5 align-[-2px] text-muted" aria-hidden />
        <span className="font-medium text-fg">{AI_DISCLAIMER}</span> AI xulosasi hech qachon
        avtomatik ball kamaytirmaydi — jarima faqat sizning qaroringiz bilan qo’llanadi.
      </p>

      {pending ? (
        <p className="text-sm text-muted">
          AI tekshiruvi hali tugamagan. Kutish shart emas — ishni hoziroq o’zingiz baholashingiz
          mumkin.
        </p>
      ) : null}

      {failed ? (
        <p className="text-sm text-muted">
          <span className="font-medium text-fg">AI tahlili bajarilmadi — qo’lda baholang.</span>{' '}
          Bu baholashni to’smaydi (AUDIT §E3): kodni chapdagi muharrirda ko’rib, ball qo’yishingiz
          mumkin.
        </p>
      ) : null}

      {submission.ai_injection_suspected ? (
        <div
          className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/[0.07] p-3 text-sm text-danger"
          role="alert"
        >
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">Kodda promptni buzishga urinish aniqlandi.</span> Fayl
            ichida tekshiruv tizimiga ko’rsatma berishga harakat qilingan — bu alohida ko’rib
            chiqiladigan holat (AUDIT §E1).
          </span>
        </div>
      ) : null}

      {submission.ai_review_summary ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Xulosa</p>
          <p className="whitespace-pre-line text-sm text-fg">{submission.ai_review_summary}</p>
        </div>
      ) : null}

      {strengths.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            Kuchli tomonlar
          </p>
          <ul className="flex flex-col gap-1">
            {strengths.map((item, index) => (
              <li key={`strength-${index}`} className="flex items-start gap-1.5 text-sm text-fg">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {issues.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Muammolar</p>
          <ul className="flex flex-col gap-1">
            {issues.map((item, index) => (
              <li key={`issue-${index}`} className="flex items-start gap-1.5 text-sm text-fg">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {flagged ? (
        <>
          <Separator />
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                AI ishonch darajasi
              </p>
              <span
                className={cn(
                  'text-sm font-semibold tabular-nums',
                  red ? 'text-danger' : 'text-accent',
                )}
              >
                {submission.ai_confidence_percent}%
              </span>
            </div>
            <Progress
              value={submission.ai_confidence_percent}
              tone={red ? 'danger' : 'accent'}
              className="h-1.5"
              aria-label="AI ishonch darajasi"
            />
            <p className="text-xs text-muted">
              {red
                ? `Ishonch ${AI_RED_FLAG_THRESHOLD}% dan yuqori. Baribir bu — dalil, hukm emas.`
                : `Ishonch ${AI_RED_FLAG_THRESHOLD}% dan past — qizil bayroq qo’yilmaydi, faqat ko’rib chiqish tavsiya etiladi.`}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              Dalillar · {submission.ai_evidence.length}
            </p>
            <ul className="flex flex-col gap-1.5">
              {submission.ai_evidence.map((item, index) => (
                <li key={`${item.file}:${item.line_start}:${index}`}>
                  <button
                    type="button"
                    onClick={() => onJumpToEvidence?.(item.file, item.line_start, item.line_end)}
                    disabled={onJumpToEvidence === undefined}
                    className={cn(
                      'flex w-full flex-col gap-0.5 rounded-xl border border-border bg-surface-2 px-2.5 py-2 text-left transition-colors duration-150',
                      onJumpToEvidence
                        ? 'hover:border-primary/40 hover:bg-primary/[0.06]'
                        : 'cursor-default',
                    )}
                  >
                    <span className="font-mono text-xs text-primary">
                      {item.file}:{item.line_start}
                      {item.line_end !== item.line_start ? `–${item.line_end}` : ''}
                    </span>
                    <span className="text-xs text-muted">{item.reason}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : submission.ai_suspected ? (
        <p className="rounded-xl border border-border bg-surface-2 p-3 text-xs text-muted">
          AI gumon qilgan, lekin <span className="font-medium text-fg">dalil keltirmagan</span> —
          shuning uchun bayroq ko’rsatilmaydi (AUDIT §E2: dalilsiz ayblash yo’q).
        </p>
      ) : null}

      {submission.suggested_score !== null ? (
        <p className="text-xs text-muted">
          AI taklif qilgan ball:{' '}
          <span className="font-semibold tabular-nums text-fg">{submission.suggested_score}</span> —
          tavsiya, avtomatik qo’llanmaydi.
        </p>
      ) : null}
    </section>
  );
}
