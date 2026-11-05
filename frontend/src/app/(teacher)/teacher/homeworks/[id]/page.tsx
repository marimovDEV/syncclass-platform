'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ShieldAlert } from 'lucide-react';

import type { SubmissionWithStudent } from '@/types/api';
import { formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import { getHomework, getHomeworkSubmissions } from '@/lib/resources';
import { Button } from '@/components/ui/button';
import { AppShell } from '@/components/shared/AppShell';
import { CountdownBadge } from '@/components/shared/CountdownBadge';
import { ErrorState, LoadingState } from '@/components/shared/states';
import { REVIEW_QUEUE_STATUSES, SubmissionQueue } from '@/components/reviewer/SubmissionQueue';

export default function TeacherHomeworkDetailPage() {
  const params = useParams();
  const rawId = params.id;
  const homeworkId = typeof rawId === 'string' ? rawId : (rawId?.[0] ?? '');

  return (
    <AppShell
      allowRoles={['TEACHER', 'ADMIN']}
      width="wide"
      title="Topshirilgan ishlar"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/teacher/homeworks">
            <ArrowLeft aria-hidden />
            Vazifalar
          </Link>
        </Button>
      }
    >
      {homeworkId.length === 0 ? (
        <ErrorState title="Vazifa topilmadi" description="Havola noto’g’ri." />
      ) : (
        <HomeworkDetail homeworkId={homeworkId} />
      )}
    </AppShell>
  );
}

function HomeworkDetail({ homeworkId }: { homeworkId: string }) {
  const homeworkQuery = useQuery({
    queryKey: queryKeys.homework(homeworkId),
    queryFn: () => getHomework(homeworkId),
  });
  const submissionsQuery = useQuery({
    queryKey: queryKeys.homeworkSubmissions(homeworkId),
    queryFn: () => getHomeworkSubmissions(homeworkId),
  });

  if (homeworkQuery.isPending) {
    return <LoadingState label="Vazifa yuklanmoqda…" />;
  }
  if (homeworkQuery.isError) {
    return <ErrorState error={homeworkQuery.error} onRetry={() => void homeworkQuery.refetch()} />;
  }

  const homework = homeworkQuery.data;
  const submissions: SubmissionWithStudent[] = submissionsQuery.data ?? [];
  const latest = submissions.filter((item) => item.is_latest);

  // ⚠️ Ro'yxat modeli YENGIL (CONTRACTS.md §4): `ai_evidence` va `student_appeal`
  // yuborilmaydi. Shuning uchun bu yerda "dalil tasdiqlangan" deb hisoblash mumkin
  // emas — AUDIT §E2 ga ko'ra faqat "ko'rib chiqish tavsiya etildi" deb sanaladi,
  // qizil bayroq esa faqat tekshiruv sahifasida (to'liq ma'lumot bilan) chiqadi.
  const stats = {
    submitted: latest.length,
    queue: latest.filter((item) => REVIEW_QUEUE_STATUSES.includes(item.status)).length,
    graded: latest.filter((item) => item.status === 'GRADED').length,
    suspected: latest.filter((item) => item.ai_suspected).length,
    late: latest.filter((item) => item.is_late).length,
  };

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 flex-1 text-lg font-semibold text-fg">{homework.title}</h2>
          <CountdownBadge deadline={homework.deadline} prefix="Muddat:" />
        </div>
        <p className="whitespace-pre-line text-sm text-muted">{homework.description}</p>
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>Deadline: {formatDateTime(homework.deadline)}</span>
          <span>·</span>
          <span>Maksimal ball: {homework.max_score}</span>
          <span>·</span>
          <span className="inline-flex items-center gap-1">
            <ShieldAlert className="size-3" aria-hidden />
            AI jarimasi: {homework.ai_penalty_points}
          </span>
          <span>·</span>
          <span>
            {homework.allow_resubmit ? 'Qayta topshirish mumkin' : 'Qayta topshirish yopilgan'}
          </span>
        </p>
      </section>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Topshirgan" value={stats.submitted} />
        <StatTile label="Navbatda" value={stats.queue} tone="primary" />
        <StatTile label="Baholangan" value={stats.graded} tone="success" />
        <StatTile
          label="Ko’rib chiqish tavsiyasi"
          value={stats.suspected}
          tone="accent"
          hint={stats.late > 0 ? `${stats.late} ta kechikkan ish` : 'dalillar tekshiruv sahifasida'}
        />
      </section>

      {stats.suspected > 0 ? (
        <p className="rounded-xl border border-border bg-surface-2 p-3 text-xs text-muted">
          AI {stats.suspected} ta ishni ko’rib chiqishni tavsiya qildi.{' '}
          <span className="font-medium text-fg">Bu — ehtimollik, isbot emas.</span> Dalillar va
          yakuniy xulosa har bir ishning tekshiruv sahifasida; ball faqat sizning qaroringiz bilan
          kamayadi.
        </p>
      ) : null}

      {submissionsQuery.isPending ? (
        <LoadingState variant="skeleton" rows={4} />
      ) : submissionsQuery.isError ? (
        <ErrorState
          error={submissionsQuery.error}
          onRetry={() => void submissionsQuery.refetch()}
        />
      ) : (
        <SubmissionQueue homeworkId={homeworkId} submissions={submissions} />
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  tone = 'neutral',
  hint,
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'primary' | 'success' | 'accent';
  hint?: string;
}) {
  const toneClass: Record<'neutral' | 'primary' | 'success' | 'accent', string> = {
    neutral: 'text-fg',
    primary: 'text-primary',
    success: 'text-success',
    accent: 'text-accent',
  };
  return (
    <div className="flex flex-col gap-0.5 rounded-2xl border border-border bg-surface p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${toneClass[tone]}`}>{value}</p>
      {hint ? <p className="text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}
