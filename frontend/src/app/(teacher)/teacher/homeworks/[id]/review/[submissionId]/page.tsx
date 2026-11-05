'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';

import type { SubmissionWithStudent } from '@/types/api';
import { queryKeys } from '@/lib/query';
import { getHomework, getHomeworkSubmissions, getSubmission } from '@/lib/resources';
import { Button } from '@/components/ui/button';
import { AppShell } from '@/components/shared/AppShell';
import { ErrorState, LoadingState } from '@/components/shared/states';
import { SplitScreenIDE } from '@/components/reviewer/SplitScreenIDE';
import { REVIEW_QUEUE_STATUSES } from '@/components/reviewer/SubmissionQueue';

export default function SubmissionReviewPage() {
  const params = useParams();
  const rawHomeworkId = params.id;
  const rawSubmissionId = params.submissionId;
  const homeworkId = typeof rawHomeworkId === 'string' ? rawHomeworkId : (rawHomeworkId?.[0] ?? '');
  const submissionId =
    typeof rawSubmissionId === 'string' ? rawSubmissionId : (rawSubmissionId?.[0] ?? '');

  return (
    <AppShell
      allowRoles={['TEACHER', 'ADMIN']}
      width="full"
      title="Ishni tekshirish"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href={`/teacher/homeworks/${homeworkId}`}>
            <ArrowLeft aria-hidden />
            Navbatga qaytish
          </Link>
        </Button>
      }
    >
      {homeworkId.length === 0 || submissionId.length === 0 ? (
        <ErrorState title="Ish topilmadi" description="Havola noto’g’ri." />
      ) : (
        <ReviewScreen homeworkId={homeworkId} submissionId={submissionId} />
      )}
    </AppShell>
  );
}

function ReviewScreen({
  homeworkId,
  submissionId,
}: {
  homeworkId: string;
  submissionId: string;
}) {
  const router = useRouter();

  const homeworkQuery = useQuery({
    queryKey: queryKeys.homework(homeworkId),
    queryFn: () => getHomework(homeworkId),
  });
  const submissionQuery = useQuery({
    queryKey: queryKeys.submission(submissionId),
    queryFn: () => getSubmission(submissionId),
  });
  const listQuery = useQuery({
    queryKey: queryKeys.homeworkSubmissions(homeworkId),
    queryFn: () => getHomeworkSubmissions(homeworkId),
  });

  const queue: SubmissionWithStudent[] = React.useMemo(() => {
    const all = listQuery.data ?? [];
    return all
      .filter((item) => item.is_latest)
      .sort((a, b) => new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime());
  }, [listQuery.data]);

  const currentIndex = queue.findIndex((item) => item.id === submissionId);
  const previous = currentIndex > 0 ? queue[currentIndex - 1] : undefined;
  const next = currentIndex >= 0 && currentIndex < queue.length - 1 ? queue[currentIndex + 1] : undefined;
  // Backend tekis maydon yuboradi (`student_name`), `null` bo'lishi mumkin.
  const queueStudentName = currentIndex >= 0 ? queue[currentIndex]?.student_name : undefined;

  const reviewHref = (id: string): string => `/teacher/homeworks/${homeworkId}/review/${id}`;

  /** Baholangach navbatdagi keyingi tekshirilmagan ishga o'tish taklifi. */
  const goToNextPending = React.useCallback(() => {
    const candidate = queue
      .slice(currentIndex + 1)
      .find((item) => REVIEW_QUEUE_STATUSES.includes(item.status));
    if (candidate) router.push(reviewHref(candidate.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, currentIndex, router, homeworkId]);

  if (submissionQuery.isPending || homeworkQuery.isPending) {
    return <LoadingState label="Ish yuklanmoqda…" />;
  }
  if (submissionQuery.isError) {
    return (
      <ErrorState error={submissionQuery.error} onRetry={() => void submissionQuery.refetch()} />
    );
  }
  if (homeworkQuery.isError) {
    return <ErrorState error={homeworkQuery.error} onRetry={() => void homeworkQuery.refetch()} />;
  }

  const submission = submissionQuery.data;
  const homework = homeworkQuery.data;

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <nav className="flex flex-wrap items-center justify-between gap-2" aria-label="Navbat">
        <p className="text-sm text-muted">
          <span className="font-medium text-fg">{homework.title}</span>
          {currentIndex >= 0 ? ` · ${currentIndex + 1}/${queue.length}` : ''}
        </p>
        <div className="flex items-center gap-2">
          <Button asChild variant="secondary" size="sm" disabled={previous === undefined}>
            {previous === undefined ? (
              <span>
                <ChevronLeft aria-hidden />
                Oldingi
              </span>
            ) : (
              <Link href={reviewHref(previous.id)}>
                <ChevronLeft aria-hidden />
                Oldingi
              </Link>
            )}
          </Button>
          <Button asChild variant="secondary" size="sm" disabled={next === undefined}>
            {next === undefined ? (
              <span>
                Keyingi
                <ChevronRight aria-hidden />
              </span>
            ) : (
              <Link href={reviewHref(next.id)}>
                Keyingi
                <ChevronRight aria-hidden />
              </Link>
            )}
          </Button>
        </div>
      </nav>

      <SplitScreenIDE
        submission={submission}
        maxScore={homework.max_score}
        aiPenaltyPoints={homework.ai_penalty_points}
        studentName={submission.student_name ?? queueStudentName ?? undefined}
        onGraded={goToNextPending}
        /*
         * md+ da ANIQ balandlik (faqat `min-h` emas): Monaco `height="100%"` zanjiri
         * aniqlangan ota balandligini talab qiladi, aks holda editor siqilib qoladi.
         * Yangi AppShell (yon menyusiz) bo'yicha IDE dan tashqaridagi vertikal joy:
         *   TopBar 64 + main pt 32 + h1/actions qatori 36 + mb-4 16
         *   + navbat qatori 36 + gap-3 12 + main pb 32 = 228px ≈ 14.25rem (+0.25rem zaxira).
         * Natija: sahifa ekranga aynan sig'adi, kod va baholash paneli ichida scroll bo'ladi.
         * 30rem dan past ekranda editor siqilmaydi — sahifaning o'zi scroll qiladi.
         * Mobil (<768) da panellar ustma-ust, tabiiy balandlikda (Monaco 52dvh).
         */
        className="md:h-[max(30rem,calc(100dvh_-_14.5rem))]"
      />
    </div>
  );
}
