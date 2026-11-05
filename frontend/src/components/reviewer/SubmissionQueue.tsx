'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Keyboard } from 'lucide-react';

import type { SubmissionStatus, SubmissionWithStudent } from '@/types/api';
import { SUBMISSION_STATUSES } from '@/types/api';
import { formatDateTime, SUBMISSION_STATUS_LABELS } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/ui/avatar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/components/shared/states';
import { AiVerdictBadge } from '@/components/reviewer/AiVerdictBadge';

/** Backend `student_name` ni `null` qaytarishi mumkin (CONTRACTS.md §4). */
const UNKNOWN_STUDENT = 'Noma’lum o’quvchi';

/** AUDIT.md §E3 — `AI_FAILED` da ham o'qituvchi baholay oladi, shuning uchun navbatda. */
export const REVIEW_QUEUE_STATUSES: readonly SubmissionStatus[] = [
  'READY_FOR_REVIEW',
  'AI_FAILED',
  'PENDING_AI',
] as const;

type StatusFilter = SubmissionStatus | 'ALL' | 'QUEUE';

const FILTER_LABELS: Record<StatusFilter, string> = {
  ALL: 'Hammasi',
  QUEUE: 'Tekshirish navbati',
  PENDING_AI: SUBMISSION_STATUS_LABELS.PENDING_AI,
  READY_FOR_REVIEW: SUBMISSION_STATUS_LABELS.READY_FOR_REVIEW,
  AI_FAILED: SUBMISSION_STATUS_LABELS.AI_FAILED,
  GRADED: SUBMISSION_STATUS_LABELS.GRADED,
  RESUBMIT_REQUIRED: SUBMISSION_STATUS_LABELS.RESUBMIT_REQUIRED,
};

const STATUS_BADGE: Record<SubmissionStatus, 'neutral' | 'primary' | 'accent' | 'success' | 'outline'> =
  {
    PENDING_AI: 'neutral',
    READY_FOR_REVIEW: 'primary',
    AI_FAILED: 'outline',
    GRADED: 'success',
    RESUBMIT_REQUIRED: 'accent',
  };

/** Klaviatura hotkey i input/muharrir ichida ishlamasligi kerak (AUDIT.md §G1). */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.closest('.monaco-editor') !== null;
}

export interface SubmissionQueueProps {
  homeworkId: string;
  submissions: SubmissionWithStudent[];
  /** Hozir ko'rilayotgan ish (review sahifasida yon navbat uchun). */
  activeSubmissionId?: string;
  /** Faqat oxirgi urinishlarni ko'rsatish (default: ha). */
  latestOnly?: boolean;
  className?: string;
}

/**
 * Tekshiruv navbati: `j`/`k` bilan yurish, `Enter` bilan ochish, `status` filtri.
 * `AI_FAILED` statusli ishlar ham navbatda qoladi — baholash bloklanmaydi.
 */
export function SubmissionQueue({
  homeworkId,
  submissions,
  activeSubmissionId,
  latestOnly = true,
  className,
}: SubmissionQueueProps) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<StatusFilter>('QUEUE');

  const rows = React.useMemo(() => {
    const base = latestOnly ? submissions.filter((item) => item.is_latest) : submissions;
    const filtered = base.filter((item) => {
      if (filter === 'ALL') return true;
      if (filter === 'QUEUE') return REVIEW_QUEUE_STATUSES.includes(item.status);
      return item.status === filter;
    });
    return [...filtered].sort(
      (a, b) => new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime(),
    );
  }, [submissions, latestOnly, filter]);

  const [cursor, setCursor] = React.useState(0);

  // Filtr yoki ro'yxat o'zgarsa kursor diapazonda qoladi; faol ish bo'lsa unga turadi.
  React.useEffect(() => {
    if (rows.length === 0) {
      setCursor(0);
      return;
    }
    const activeIndex =
      activeSubmissionId === undefined
        ? -1
        : rows.findIndex((item) => item.id === activeSubmissionId);
    setCursor((current) => {
      if (activeIndex >= 0) return activeIndex;
      return Math.min(current, rows.length - 1);
    });
  }, [rows, activeSubmissionId]);

  const reviewHref = React.useCallback(
    (submissionId: string) => `/teacher/homeworks/${homeworkId}/review/${submissionId}`,
    [homeworkId],
  );

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (rows.length === 0) return;

      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        setCursor((current) => Math.min(current + 1, rows.length - 1));
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        setCursor((current) => Math.max(current - 1, 0));
      } else if (event.key === 'Enter') {
        const target = rows[cursor];
        if (!target) return;
        event.preventDefault();
        router.push(reviewHref(target.id));
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [rows, cursor, router, reviewHref]);

  const listRef = React.useRef<HTMLUListElement | null>(null);

  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    item?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <div className={cn('flex min-h-0 flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Select value={filter} onValueChange={(next) => setFilter(next as StatusFilter)}>
            <SelectTrigger className="h-9 w-56" aria-label="Status filtri">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="QUEUE">{FILTER_LABELS.QUEUE}</SelectItem>
              <SelectItem value="ALL">{FILTER_LABELS.ALL}</SelectItem>
              {SUBMISSION_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {SUBMISSION_STATUS_LABELS[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted">{rows.length} ta ish</span>
        </div>

        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Keyboard className="size-3.5" aria-hidden />
          <kbd className="rounded border border-border px-1">j</kbd>
          <kbd className="rounded border border-border px-1">k</kbd> — yurish ·{' '}
          <kbd className="rounded border border-border px-1">Enter</kbd> — ochish
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Navbat bo’sh"
          description={
            filter === 'QUEUE'
              ? 'Tekshirishni kutayotgan ish yo’q. Filtrni "Hammasi" ga o’zgartirib ko’ring.'
              : 'Bu filtrga mos ish topilmadi.'
          }
        />
      ) : (
        <ul ref={listRef} className="flex flex-col gap-1.5" aria-label="Tekshiruv navbati">
          {rows.map((item, index) => {
            const selected = index === cursor;
            const active = item.id === activeSubmissionId;
            return (
              <li key={item.id} data-index={index}>
                <div
                  className={cn(
                    'flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2 transition-colors duration-150',
                    active
                      ? 'border-primary bg-primary/[0.07]'
                      : selected
                        ? 'border-primary/50 bg-surface-2'
                        : 'border-border bg-surface hover:bg-fg/[0.02]',
                  )}
                >
                  <UserAvatar
                    fullName={item.student_name ?? UNKNOWN_STUDENT}
                    avatarUrl={item.student_avatar_url}
                    className="size-8 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">
                      {item.student_name ?? UNKNOWN_STUDENT}
                    </p>
                    <p className="truncate text-xs text-muted">
                      <span className="font-mono">{item.file_name}</span> ·{' '}
                      {item.attempt_no}-urinish · {formatDateTime(item.submitted_at)}
                    </p>
                  </div>

                  {/* CONTRACTS.md §11.1 — `is_late` serverda hisoblanadi. */}
                  {item.is_late ? <Badge variant="accent">Kechikdi</Badge> : null}

                  <AiVerdictBadge submission={item} />

                  <Badge variant={STATUS_BADGE[item.status]}>
                    {SUBMISSION_STATUS_LABELS[item.status]}
                  </Badge>

                  <span className="w-14 text-right text-sm font-semibold tabular-nums text-fg">
                    {item.final_score === null ? '—' : item.final_score}
                  </span>

                  <Button asChild size="sm" variant={active ? 'primary' : 'secondary'}>
                    <Link href={reviewHref(item.id)}>
                      Tekshirish
                      <ArrowRight aria-hidden />
                    </Link>
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
