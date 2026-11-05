'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { ArrowRight, FileCheck2, PlayCircle, Presentation, Users } from 'lucide-react';

import type { HomeworkOut, SubmissionWithStudent } from '@/types/api';
import { isApiError } from '@/lib/api';
import { errorText, formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import {
  createRoom,
  getGroups,
  getHomeworkSubmissions,
  getHomeworks,
  getPresentations,
} from '@/lib/resources';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { AppShell } from '@/components/shared/AppShell';
import { CountdownBadge } from '@/components/shared/CountdownBadge';
import { EmptyState, ErrorState } from '@/components/shared/states';

/** Tekshirish navbatiga tushadigan statuslar (AUDIT.md §E3 — `AI_FAILED` da ham baholanadi). */
const REVIEW_STATUSES = new Set<SubmissionWithStudent['status']>([
  'READY_FOR_REVIEW',
  'AI_FAILED',
]);

/** Nechta oxirgi vazifa bo'yicha navbat hisoblanadi (so'rov sonini cheklaymiz). */
const REVIEW_SCAN_LIMIT = 10;

export default function TeacherDashboardPage() {
  return (
    <AppShell allowRoles={['TEACHER', 'ADMIN']} title="O’qituvchi paneli" width="wide">
      <TeacherDashboard />
    </AppShell>
  );
}

function TeacherDashboard() {
  const groupsQuery = useQuery({ queryKey: queryKeys.groups, queryFn: getGroups });
  const presentationsQuery = useQuery({
    queryKey: queryKeys.presentations,
    queryFn: getPresentations,
  });

  return (
    <div className="flex flex-col gap-6">
      <StartLessonCard
        groups={groupsQuery.data ?? []}
        presentations={presentationsQuery.data ?? []}
        loading={groupsQuery.isPending || presentationsQuery.isPending}
        error={groupsQuery.error ?? presentationsQuery.error}
        onRetry={() => {
          void groupsQuery.refetch();
          void presentationsQuery.refetch();
        }}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <ReviewQueueCard groupIds={(groupsQuery.data ?? []).map((group) => group.id)} />
        <GroupsCard groups={groupsQuery.data ?? []} loading={groupsQuery.isPending} />
        <PresentationsCard
          presentations={presentationsQuery.data ?? []}
          loading={presentationsQuery.isPending}
        />
      </div>
    </div>
  );
}

/* ----------------------------- darsni boshlash ---------------------------- */

interface StartLessonCardProps {
  groups: { id: number; name: string; course_title: string }[];
  presentations: { id: string; title: string; module_number: number; lesson_number: number }[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}

function StartLessonCard({
  groups,
  presentations,
  loading,
  error,
  onRetry,
}: StartLessonCardProps) {
  const router = useRouter();
  const [groupId, setGroupId] = React.useState('');
  const [presentationId, setPresentationId] = React.useState('');

  const start = useMutation({
    mutationFn: () =>
      createRoom({ group_id: Number(groupId), presentation_id: presentationId }),
    onSuccess: (room) => {
      toast.success(`Dars boshlandi · PIN ${room.pin_code}`);
      router.push(`/live/${room.pin_code}`);
    },
    onError: (caught) => {
      toast.error('Darsni boshlab bo’lmadi', {
        description: isApiError(caught)
          ? errorText(caught.code, caught.message)
          : 'Qayta urinib ko’ring.',
      });
    },
  });

  const canStart = groupId.length > 0 && presentationId.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlayCircle className="size-4 text-primary" aria-hidden />
          Jonli darsni boshlash
        </CardTitle>
        <CardDescription>
          Guruh va prezentatsiyani tanlang — tizim 6 xonali PIN yaratadi.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10 w-32" />
          </div>
        ) : error && groups.length === 0 ? (
          <ErrorState error={error} onRetry={onRetry} />
        ) : groups.length === 0 || presentations.length === 0 ? (
          <EmptyState
            title={groups.length === 0 ? 'Guruh yo’q' : 'Prezentatsiya yo’q'}
            description={
              groups.length === 0
                ? 'Dars boshlash uchun avval guruh yarating.'
                : 'Dars boshlash uchun avval prezentatsiya tayyorlang.'
            }
            action={
              <Button asChild variant="secondary" size="sm">
                <Link href={groups.length === 0 ? '/teacher/groups' : '/teacher/presentations'}>
                  {groups.length === 0 ? 'Guruhlar' : 'Prezentatsiyalar'}
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
            }
          />
        ) : (
          <div className="grid items-end gap-3 md:grid-cols-[1fr_1fr_auto]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="start-group" required>
                Guruh
              </Label>
              <Select value={groupId} onValueChange={setGroupId}>
                <SelectTrigger id="start-group">
                  <SelectValue placeholder="Guruhni tanlang" />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((group) => (
                    <SelectItem key={group.id} value={String(group.id)}>
                      {group.name} — {group.course_title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="start-presentation" required>
                Prezentatsiya
              </Label>
              <Select value={presentationId} onValueChange={setPresentationId}>
                <SelectTrigger id="start-presentation">
                  <SelectValue placeholder="Prezentatsiyani tanlang" />
                </SelectTrigger>
                <SelectContent>
                  {presentations.map((presentation) => (
                    <SelectItem key={presentation.id} value={presentation.id}>
                      M{presentation.module_number}·D{presentation.lesson_number} —{' '}
                      {presentation.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button
              size="lg"
              disabled={!canStart}
              loading={start.isPending}
              onClick={() => start.mutate()}
            >
              <PlayCircle aria-hidden />
              Start Live Lesson
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ----------------------------- tekshiruv navbati -------------------------- */

function ReviewQueueCard({ groupIds }: { groupIds: number[] }) {
  const homeworkQueries = useQueries({
    queries: groupIds.map((groupId) => ({
      queryKey: queryKeys.homeworks(groupId),
      queryFn: () => getHomeworks(groupId),
    })),
  });

  const homeworks: HomeworkOut[] = React.useMemo(() => {
    const unique = new Map<string, HomeworkOut>();
    for (const homework of homeworkQueries.flatMap((result) => result.data ?? [])) {
      unique.set(homework.id, homework);
    }
    return [...unique.values()]
      .sort((a, b) => new Date(b.deadline).getTime() - new Date(a.deadline).getTime())
      .slice(0, REVIEW_SCAN_LIMIT);
  }, [homeworkQueries]);

  const submissionQueries = useQueries({
    queries: homeworks.map((homework) => ({
      queryKey: queryKeys.homeworkSubmissions(homework.id),
      // Navbat hisobi uchun har o'quvchidan faqat oxirgi urinish kerak.
      queryFn: () => getHomeworkSubmissions(homework.id, { only_latest: true }),
    })),
  });

  const loading =
    homeworkQueries.some((result) => result.isPending) ||
    submissionQueries.some((result) => result.isPending);

  const pendingCount = submissionQueries
    .flatMap((result) => result.data ?? [])
    .filter((submission) => submission.is_latest && REVIEW_STATUSES.has(submission.status)).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileCheck2 className="size-4 text-primary" aria-hidden />
          Tekshirilmagan vazifalar
        </CardTitle>
        <CardDescription>Baholashni kutayotgan ishlar</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {groupIds.length === 0 ? (
          <p className="text-sm text-muted">Guruh yaratilgandan keyin navbat ko’rinadi.</p>
        ) : loading ? (
          <Skeleton className="h-12 w-24" />
        ) : (
          <p className="text-4xl font-bold tabular-nums tracking-tight text-fg">{pendingCount}</p>
        )}

        <Button asChild variant="secondary" size="sm" className="self-start">
          <Link href="/teacher/homeworks">
            Tekshirishga o’tish
            <ArrowRight aria-hidden />
          </Link>
        </Button>

        {homeworks.length > 0 ? (
          <ul className="flex flex-col gap-1.5 border-t border-border pt-3">
            {homeworks.slice(0, 3).map((homework) => (
              <li key={homework.id} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-fg">{homework.title}</span>
                <CountdownBadge deadline={homework.deadline} />
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ---------------------------------- guruhlar ------------------------------ */

function GroupsCard({
  groups,
  loading,
}: {
  groups: { id: number; name: string; course_title: string; invite_code: string }[];
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-4 text-primary" aria-hidden />
          Guruhlar
        </CardTitle>
        <CardDescription>{groups.length} ta guruh</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted">Hali guruh yaratilmagan.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {groups.slice(0, 5).map((group) => (
              <li key={group.id}>
                <Link
                  href={`/teacher/groups/${group.id}`}
                  className="flex items-center gap-2 rounded-xl px-2 py-1.5 transition-colors duration-150 hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{group.name}</span>
                  <Badge variant="outline" className="font-mono">
                    {group.invite_code}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------ prezentatsiyalar -------------------------- */

function PresentationsCard({
  presentations,
  loading,
}: {
  presentations: {
    id: string;
    title: string;
    module_number: number;
    lesson_number: number;
    updated_at: string;
  }[];
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Presentation className="size-4 text-primary" aria-hidden />
          Prezentatsiyalar
        </CardTitle>
        <CardDescription>{presentations.length} ta prezentatsiya</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        ) : presentations.length === 0 ? (
          <p className="text-sm text-muted">Hali prezentatsiya yaratilmagan.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {presentations.slice(0, 5).map((presentation) => (
              <li key={presentation.id}>
                <Link
                  href={`/teacher/presentations/${presentation.id}/builder`}
                  className="flex flex-col rounded-xl px-2 py-1.5 transition-colors duration-150 hover:bg-surface-2"
                >
                  <span className="truncate text-sm text-fg">{presentation.title}</span>
                  <span className="text-xs text-muted">
                    M{presentation.module_number}·D{presentation.lesson_number} ·{' '}
                    {formatDateTime(presentation.updated_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
