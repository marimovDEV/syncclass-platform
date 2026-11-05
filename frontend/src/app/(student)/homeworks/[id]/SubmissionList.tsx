'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ChevronDown,
  Clock3,
  Download,
  Info,
  ListChecks,
  MessageSquareWarning,
  ShieldAlert,
  ThumbsUp,
} from 'lucide-react';

import type { SubmissionOut, SubmissionWithStudent } from '@/types/api';
import { AI_RED_FLAG_THRESHOLD } from '@/types/api';
import { isApiError } from '@/lib/api';
import { errorText, formatBytes, formatDateTime, SUBMISSION_STATUS_LABELS } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import { appealSubmission, getSubmission, getSubmissionDownloadUrl } from '@/lib/resources';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { ErrorState } from '@/components/shared/states';

/* ------------------------------- AI xulosasi ------------------------------ */

/**
 * O'quvchiga ko'rinadigan AI bloki — AUDIT.md §E2:
 *  - dalil (`ai_evidence`) bo'lmasa flag KO'RSATILMAYDI;
 *  - `< 70%` ishonch → sariq "ko'rib chiqish tavsiya etiladi", qizil bayroq emas;
 *  - sabab ko'rsatiladi va e'tiroz yuborish tugmasi beriladi.
 */
function AiNotice({ submission }: { submission: SubmissionOut }) {
  const hasEvidence = submission.ai_evidence.length > 0;
  const showFlag = submission.ai_suspected && hasEvidence;
  const highConfidence = submission.ai_confidence_percent >= AI_RED_FLAG_THRESHOLD;
  const strengths = submission.ai_strengths;
  const issues = submission.ai_issues;

  if (
    !showFlag &&
    submission.ai_review_summary === null &&
    strengths.length === 0 &&
    issues.length === 0
  ) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      {submission.ai_review_summary ? (
        <div className="rounded-xl border border-border bg-surface-2 p-3">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
            <Info className="size-3.5" aria-hidden />
            AI xulosasi
          </p>
          <p className="whitespace-pre-line text-sm text-fg">{submission.ai_review_summary}</p>
        </div>
      ) : null}

      {/*
        CONTRACTS.md §12.1 — kuchli tomonlar o'quvchiga KO'RINADI.
        AUDIT.md §E2 ruhi: baholash adolatli va qurilish xarakterida bo'lsin,
        AI faqat tanqid qiladigan vosita emas.
      */}
      {strengths.length > 0 ? (
        <div className="rounded-xl border border-success/30 bg-success/[0.06] p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-success">
            <ThumbsUp className="size-3.5" aria-hidden />
            Kuchli tomonlar
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-4">
            {strengths.map((item, index) => (
              <li key={`strength-${index}`} className="text-sm text-fg">
                {item}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {issues.length > 0 ? (
        <div className="rounded-xl border border-border bg-surface-2 p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
            <ListChecks className="size-3.5" aria-hidden />
            Yaxshilash mumkin
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-4">
            {issues.map((item, index) => (
              <li key={`issue-${index}`} className="text-sm text-fg">
                {item}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {showFlag ? (
        <div
          className={cn(
            'flex flex-col gap-2 rounded-xl border p-3',
            highConfidence
              ? 'border-danger/35 bg-danger/[0.06]'
              : 'border-accent/40 bg-accent/[0.08]',
          )}
        >
          <p
            className={cn(
              'flex items-center gap-1.5 text-sm font-semibold',
              highConfidence ? 'text-danger' : 'text-accent',
            )}
          >
            <AlertTriangle className="size-4" aria-hidden />
            {highConfidence
              ? 'Kod AI yordamida yozilgan bo’lishi mumkin'
              : 'Ko’rib chiqish tavsiya etiladi'}
          </p>

          <div className="flex items-center gap-2">
            <Progress
              value={submission.ai_confidence_percent}
              tone={highConfidence ? 'danger' : 'accent'}
              className="h-1.5 flex-1"
            />
            <span className="text-xs font-medium tabular-nums text-muted">
              {submission.ai_confidence_percent}%
            </span>
          </div>

          <p className="text-xs text-muted">
            Bu — <span className="font-medium text-fg">ehtimollik, isbot emas</span>. Ball faqat
            o’qituvchi qarori bilan kamayadi. Rozi bo’lmasangiz e’tiroz yuboring.
          </p>

          <Separator />

          <ul className="flex flex-col gap-1.5">
            {submission.ai_evidence.map((item, index) => (
              <li key={`${item.file}-${item.line_start}-${index}`} className="text-xs text-muted">
                <span className="font-mono text-fg">
                  {item.file}:{item.line_start}
                  {item.line_end !== item.line_start ? `-${item.line_end}` : ''}
                </span>{' '}
                — {item.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {submission.ai_injection_suspected ? (
        <div className="flex items-start gap-2 rounded-xl border border-danger/35 bg-danger/[0.06] p-3 text-sm text-danger">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            Kod ichida tekshiruv tizimiga ko’rsatma berishga urinish aniqlandi. O’qituvchi bu
            holatni alohida ko’rib chiqadi.
          </span>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ e'tiroz formasi --------------------------- */

function AppealForm({ submission }: { submission: SubmissionOut }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState('');

  const mutation = useMutation({
    mutationFn: (value: string) => appealSubmission(submission.id, { text: value }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.submission(updated.id), updated);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.homeworkSubmissions(submission.homework_id),
      });
      setOpen(false);
      setText('');
      toast.success('E’tirozingiz yuborildi', {
        description: 'O’qituvchi ko’rib chiqadi.',
      });
    },
    onError: (error) => {
      toast.error('E’tiroz yuborilmadi', {
        description: isApiError(error)
          ? errorText(error.code, error.message)
          : 'Qayta urinib ko’ring.',
      });
    },
  });

  if (submission.student_appeal) {
    return (
      <div className="rounded-xl border border-border bg-surface-2 p-3">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
          Sizning e’tirozingiz
        </p>
        <p className="whitespace-pre-line text-sm text-fg">{submission.student_appeal}</p>
      </div>
    );
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <MessageSquareWarning aria-hidden />
        E’tiroz yuborish
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={text}
        autoFocus
        placeholder="Kodni qanday yozganingizni tushuntiring: qaysi darsda o’tilgan, qanday qadamlar bilan ishladingiz…"
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          loading={mutation.isPending}
          disabled={text.trim().length < 10}
          onClick={() => mutation.mutate(text.trim())}
        >
          Yuborish
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={mutation.isPending}
          onClick={() => {
            setOpen(false);
            setText('');
          }}
        >
          Bekor qilish
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------ yuklab olish ------------------------------ */

function DownloadButton({ submissionId }: { submissionId: string }) {
  const mutation = useMutation({
    mutationFn: () => getSubmissionDownloadUrl(submissionId),
    onSuccess: ({ url }) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    onError: (error) => {
      toast.error('Yuklab olinmadi', {
        description: isApiError(error)
          ? errorText(error.code, error.message)
          : 'Fayl manzili olinmadi.',
      });
    },
  });

  return (
    <Button
      variant="ghost"
      size="sm"
      loading={mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      <Download aria-hidden />
      Yuklab olish
    </Button>
  );
}

/* --------------------------------- ro'yxat -------------------------------- */

const STATUS_VARIANT: Record<SubmissionOut['status'], 'neutral' | 'primary' | 'success' | 'danger' | 'accent'> =
  {
    PENDING_AI: 'neutral',
    READY_FOR_REVIEW: 'primary',
    AI_FAILED: 'accent',
    GRADED: 'success',
    RESUBMIT_REQUIRED: 'danger',
  };

/* ------------------------- to'liq ma'lumot (lazy) ------------------------- */

/**
 * `GET /submissions/{id}` — to'liq `SubmissionOut`.
 *
 * Ro'yxat endpointi (`SubmissionWithStudent`) yengil model: unda `ai_evidence`,
 * `ai_review_summary`, `ai_strengths`/`ai_issues`, `teacher_comment` va
 * `student_appeal` YO'Q (CONTRACTS.md §4 — ro'yxat uchun og'ir). Shuning uchun
 * kartochka ochilganda to'liq yozuv alohida olinadi.
 */
function SubmissionDetail({ submissionId }: { submissionId: string }) {
  const query = useQuery({
    queryKey: queryKeys.submission(submissionId),
    queryFn: () => getSubmission(submissionId),
  });

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <ErrorState
        className="px-4 py-6"
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const submission = query.data;
  const showAppeal = submission.ai_suspected && submission.ai_evidence.length > 0;

  return (
    <div className="flex flex-col gap-3">
      {submission.teacher_comment ? (
        <div className="rounded-xl border border-border bg-surface-2 p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
            O’qituvchi izohi
          </p>
          <p className="whitespace-pre-line text-sm text-fg">{submission.teacher_comment}</p>
        </div>
      ) : null}

      <AiNotice submission={submission} />

      {showAppeal ? <AppealForm submission={submission} /> : null}
    </div>
  );
}

/* --------------------------------- ro'yxat -------------------------------- */

export interface SubmissionListProps {
  /** `GET /homeworks/{id}/submissions` yengil elementlari. */
  submissions: SubmissionWithStudent[];
  maxScore: number;
}

/**
 * Yuborilgan ishlar tarixi.
 *
 * Har urinish yengil ma'lumot bilan ko'rsatiladi; kartochka ochilganda
 * (oxirgi urinish boshidan ochiq) to'liq yozuv — baho izohi, AI xulosasi,
 * kuchli tomonlar va e'tiroz formasi — yuklanadi.
 */
export function SubmissionList({ submissions, maxScore }: SubmissionListProps) {
  const ordered = React.useMemo(
    () => [...submissions].sort((a, b) => b.attempt_no - a.attempt_no),
    [submissions],
  );

  const latestId = ordered.find((item) => item.is_latest)?.id ?? ordered[0]?.id ?? null;
  const [expanded, setExpanded] = React.useState<string | null>(latestId);

  // Ro'yxat yangilansa (yangi urinish qo'shilsa) oxirgisini ochib qo'yamiz.
  const previousLatest = React.useRef(latestId);
  React.useEffect(() => {
    if (latestId !== previousLatest.current) {
      previousLatest.current = latestId;
      setExpanded(latestId);
    }
  }, [latestId]);

  return (
    <ul className="flex flex-col gap-3">
      {ordered.map((submission) => {
        const isOpen = expanded === submission.id;
        const panelId = `submission-panel-${submission.id}`;

        return (
          <li key={submission.id}>
            <Card>
              <CardContent className="flex flex-col gap-3 p-4 pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{submission.attempt_no}-urinish</Badge>
                  <Badge variant={STATUS_VARIANT[submission.status]}>
                    {SUBMISSION_STATUS_LABELS[submission.status]}
                  </Badge>
                  {submission.is_latest ? <Badge variant="primary">Oxirgi</Badge> : null}
                  {/*
                    CONTRACTS.md §11.1 — kechikkan ish QABUL QILINADI, bu faqat ma'lumot:
                    ball avtomatik tushmaydi, jazoni o'qituvchi hal qiladi.
                  */}
                  {submission.is_late ? (
                    <Badge variant="accent">
                      <Clock3 aria-hidden />
                      Kechikdi
                    </Badge>
                  ) : null}
                  <span className="ml-auto text-xs text-muted">
                    {formatDateTime(submission.submitted_at)}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                  <span className="font-mono text-fg">{submission.file_name}</span>
                  <span>{formatBytes(submission.file_size_bytes)}</span>
                  {submission.extract_truncated ? (
                    <Badge variant="accent">Matn qisqartirilgan</Badge>
                  ) : null}
                  <DownloadButton submissionId={submission.id} />
                </div>

                {submission.final_score !== null ? (
                  <div className="flex items-center gap-3 rounded-xl border border-success/30 bg-success/[0.06] p-3">
                    <span className="text-2xl font-bold tabular-nums text-success">
                      {submission.final_score}
                    </span>
                    <span className="text-sm text-muted">/ {maxScore} ball</span>
                    {submission.penalty_applied > 0 ? (
                      <Badge variant="danger" className="ml-auto">
                        Jarima −{submission.penalty_applied}
                      </Badge>
                    ) : null}
                  </div>
                ) : null}

                <Button
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => setExpanded(isOpen ? null : submission.id)}
                >
                  <ChevronDown
                    className={cn('transition-transform duration-150', isOpen && 'rotate-180')}
                    aria-hidden
                  />
                  {isOpen ? 'Tafsilotni yopish' : 'Baho va AI xulosasi'}
                </Button>

                {isOpen ? (
                  <div id={panelId}>
                    <SubmissionDetail submissionId={submission.id} />
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
