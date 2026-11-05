'use client';

import * as React from 'react';
import { MessageSquareWarning } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format';

export interface AppealNoticeProps {
  /** `submissions.student_appeal` — bo'sh bo'lsa komponent hech narsa chizmaydi. */
  appeal: string | null | undefined;
  /** O'quvchi ismi (bo'lsa sarlavhada ko'rinadi). */
  studentName?: string;
  /** E'tiroz yuborilgan vaqt (odatda `updated_at`). */
  at?: string | null;
  className?: string;
}

/**
 * O'quvchi e'tirozi — AUDIT.md §E2.
 * O'qituvchi ball kamaytirishdan oldin bu matnni ko'rishi SHART.
 */
export function AppealNotice({ appeal, studentName, at, className }: AppealNoticeProps) {
  const text = appeal?.trim() ?? '';
  if (text.length === 0) return null;

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl border border-accent/40 bg-accent/[0.08] p-3',
        className,
      )}
      role="note"
    >
      <p className="flex items-center gap-1.5 text-sm font-semibold text-accent">
        <MessageSquareWarning className="size-4 shrink-0" aria-hidden />
        {studentName ? `${studentName} e’tiroz yubordi` : 'O’quvchi e’tiroz yubordi'}
      </p>
      <p className="whitespace-pre-line text-sm text-fg">{text}</p>
      {at ? <p className="text-xs text-muted">{formatDateTime(at)}</p> : null}
      <p className="text-xs text-muted">
        E’tiroz — baholashni to’xtatmaydi, lekin qaroringizdan oldin o’quvchi bilan gaplashish
        tavsiya etiladi.
      </p>
    </div>
  );
}
