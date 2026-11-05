'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { ArrowRight, BookOpen, Crown, GraduationCap, LogIn, QrCode, Trophy } from 'lucide-react';

import type { GroupMemberOut, HomeworkOut, SubmissionStatus } from '@/types/api';
import { isApiError } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { errorText, formatDateTime, SUBMISSION_STATUS_LABELS } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import { getGroupMembers, getHomeworks, getSubmission, joinRoom } from '@/lib/resources';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/avatar';
import { toast } from '@/components/ui/toast';
import { AppShell } from '@/components/shared/AppShell';
import { CountdownBadge } from '@/components/shared/CountdownBadge';
import { EmptyState, ErrorState } from '@/components/shared/states';
import { XpBadge } from '@/components/shared/XpBadge';
import { PIN_LENGTH, PinInput } from '@/app/(student)/dashboard/PinInput';
import { QrScannerDialog } from '@/app/(student)/dashboard/QrScannerDialog';

/** `SubmissionStatus` → `Badge` varianti. */
const STATUS_VARIANT: Record<SubmissionStatus, 'neutral' | 'primary' | 'accent' | 'success' | 'danger'> = {
  PENDING_AI: 'neutral',
  READY_FOR_REVIEW: 'primary',
  AI_FAILED: 'accent',
  GRADED: 'success',
  RESUBMIT_REQUIRED: 'danger',
};

export default function StudentDashboardPage() {
  return (
    <AppShell allowRoles={['STUDENT']} title="Bosh sahifa" width="wide">
      <DashboardContent />
    </AppShell>
  );
}

function DashboardContent() {
  const { user } = useSession();
  const groups = user?.groups ?? [];
  const primaryGroup = groups[0] ?? null;

  return (
    <div className="flex flex-col gap-6">
      <JoinLessonCard />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <DeadlinesCard groupIds={groups.map((group) => group.id)} />
          <RecentGradesCard groupIds={groups.map((group) => group.id)} />
        </div>
        <div className="flex flex-col gap-6">
          <XpCard />
          <LeaderboardCard groupId={primaryGroup?.id ?? null} groupName={primaryGroup?.name ?? null} />
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- darsga qo'shilish -------------------------- */

function JoinLessonCard() {
  const router = useRouter();
  const [pin, setPin] = React.useState('');
  const [scannerOpen, setScannerOpen] = React.useState(false);

  const join = useMutation({
    mutationFn: joinRoom,
    onSuccess: (room) => {
      toast.success('Darsga qo’shildingiz', { description: room.presentation.title });
      router.push(`/live/${room.pin_code}`);
    },
    onError: (error) => {
      setPin('');
      toast.error('Qo’shilib bo’lmadi', {
        description: isApiError(error)
          ? errorText(error.code, error.message)
          : 'Noma’lum xato. Qayta urinib ko’ring.',
      });
    },
  });

  const submit = React.useCallback(
    (value: string) => {
      if (value.length !== PIN_LENGTH || join.isPending) return;
      join.mutate(value);
    },
    [join],
  );

  const handleScannedPin = React.useCallback(
    (scanned: string) => {
      setPin(scanned);
      submit(scanned);
    },
    [submit],
  );

  return (
    <Card className="overflow-hidden">
      <CardContent className="flex flex-col items-center gap-5 p-6 pt-6 md:p-8 md:pt-8">
        <div className="flex flex-col items-center gap-1 text-center">
          <CardTitle className="text-lg">Darsga qo’shilish</CardTitle>
          <CardDescription>
            O’qituvchi ekranidagi 6 xonali PIN ni kiriting yoki QR kodni skanerlang.
          </CardDescription>
        </div>

        <PinInput
          value={pin}
          onChange={setPin}
          onComplete={submit}
          disabled={join.isPending}
          invalid={join.isError}
        />

        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <Button
            size="lg"
            loading={join.isPending}
            disabled={pin.length !== PIN_LENGTH}
            onClick={() => submit(pin)}
          >
            <LogIn aria-hidden />
            Kirish
          </Button>
          <Button size="lg" variant="secondary" onClick={() => setScannerOpen(true)}>
            <QrCode aria-hidden />
            QR skaner
          </Button>
        </div>
      </CardContent>

      <QrScannerDialog open={scannerOpen} onOpenChange={setScannerOpen} onPin={handleScannedPin} />
    </Card>
  );
}

/* ------------------------------- deadline lar ----------------------------- */

function DeadlinesCard({ groupIds }: { groupIds: number[] }) {
  const results = useQueries({
    queries: groupIds.map((groupId) => ({
      queryKey: queryKeys.homeworks(groupId),
      queryFn: () => getHomeworks(groupId),
    })),
  });

  const isPending = results.some((result) => result.isPending);
  const firstError = results.find((result) => result.isError)?.error;

  const homeworks: HomeworkOut[] = React.useMemo(() => {
    const all = results.flatMap((result) => result.data ?? []);
    const unique = new Map<string, HomeworkOut>();
    for (const homework of all) unique.set(homework.id, homework);
    return [...unique.values()].sort(
      (a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime(),
    );
  }, [results]);

  const upcoming = homeworks.filter((homework) => new Date(homework.deadline).getTime() > Date.now());
  const shown = (upcoming.length > 0 ? upcoming : homeworks).slice(0, 5);

  return (
    <Card className="h-full">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <div>
          <CardTitle>Yaqin muddatlar</CardTitle>
          <CardDescription>Topshirish vaqti yaqinlashayotgan vazifalar</CardDescription>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/homeworks">
            Barchasi
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {groupIds.length === 0 ? (
          <EmptyState
            icon={<BookOpen aria-hidden />}
            title="Siz hali guruhga qo’shilmagansiz"
            description="O’qituvchidan taklif kodini so’rang."
          />
        ) : isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : firstError && homeworks.length === 0 ? (
          <ErrorState error={firstError} onRetry={() => results.forEach((r) => void r.refetch())} />
        ) : shown.length === 0 ? (
          <EmptyState
            icon={<BookOpen aria-hidden />}
            title="Vazifa yo’q"
            description="Hozircha topshiriladigan vazifa yo’q."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {shown.map((homework) => (
              <li key={homework.id}>
                <Link
                  href={`/homeworks/${homework.id}`}
                  className="interactive-glow flex min-h-11 items-center gap-3 rounded-xl border border-border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">{homework.title}</p>
                    <p className="truncate text-xs text-muted">
                      {formatDateTime(homework.deadline)} · {homework.max_score} ball
                    </p>
                  </div>
                  {/*
                    `my_status` — serverda hisoblangan maydon (CONTRACTS.md §4):
                    topshirgan-topshirmaganini bilish uchun qo'shimcha so'rov KERAK EMAS.
                  */}
                  {homework.my_status !== null ? (
                    <Badge variant={STATUS_VARIANT[homework.my_status]}>
                      {SUBMISSION_STATUS_LABELS[homework.my_status]}
                    </Badge>
                  ) : (
                    <Badge variant="outline">Topshirilmagan</Badge>
                  )}
                  <CountdownBadge deadline={homework.deadline} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------ oxirgi baholar ---------------------------- */

/** Dashboardda ko'rsatiladigan baho kartochkalari soni (so'rovlar chegarasi). */
const RECENT_GRADES_LIMIT = 3;

/**
 * Oxirgi baholar.
 *
 * `HomeworkOut.my_status` / `my_submission_id` — serverda hisoblangan maydonlar,
 * shuning uchun har vazifa bo'yicha `GET /homeworks/{id}/submissions` chaqirilmaydi
 * (N+1 so'rov va o'quvchi uchun 403 xavfi yo'q). Faqat `GRADED` bo'lgan eng oxirgi
 * {@link RECENT_GRADES_LIMIT} ta topshiriq uchun to'liq yozuv olinadi — ball shu yerda.
 * Kesh `queryKeys.submission(id)` — vazifa sahifasi bilan bo'lishiladi.
 */
function RecentGradesCard({ groupIds }: { groupIds: number[] }) {
  const homeworkResults = useQueries({
    queries: groupIds.map((groupId) => ({
      queryKey: queryKeys.homeworks(groupId),
      queryFn: () => getHomeworks(groupId),
    })),
  });

  const graded = React.useMemo(() => {
    const unique = new Map<string, HomeworkOut>();
    for (const homework of homeworkResults.flatMap((result) => result.data ?? [])) {
      unique.set(homework.id, homework);
    }
    return [...unique.values()]
      .filter((homework) => homework.my_status === 'GRADED' && homework.my_submission_id !== null)
      .sort((a, b) => new Date(b.deadline).getTime() - new Date(a.deadline).getTime())
      .slice(0, RECENT_GRADES_LIMIT);
  }, [homeworkResults]);

  const submissionResults = useQueries({
    queries: graded.map((homework) => ({
      queryKey: queryKeys.submission(homework.my_submission_id as string),
      queryFn: () => getSubmission(homework.my_submission_id as string),
    })),
  });

  const homeworksPending = groupIds.length > 0 && homeworkResults.some((r) => r.isPending);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <div>
          <CardTitle>Oxirgi baholar</CardTitle>
          <CardDescription>Baholangan ishlaringiz</CardDescription>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/homeworks">
            Barchasi
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {groupIds.length === 0 ? (
          <p className="text-sm text-muted">Guruhga qo’shilgach baholar ko’rinadi.</p>
        ) : homeworksPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : graded.length === 0 ? (
          <EmptyState
            icon={<GraduationCap aria-hidden />}
            title="Hali baho yo’q"
            description="O’qituvchi ishingizni baholagach shu yerda ko’rinadi."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {graded.map((homework, index) => {
              const result = submissionResults[index];
              const submission = result?.data;
              return (
                <li key={homework.id}>
                  <Link
                    href={`/homeworks/${homework.id}`}
                    className="interactive-glow flex min-h-11 items-center gap-3 rounded-xl border border-border p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-fg">{homework.title}</p>
                      <p className="truncate text-xs text-muted">
                        {submission ? formatDateTime(submission.graded_at) : 'Baholangan'}
                        {submission?.is_late ? ' · kechikkan' : ''}
                      </p>
                    </div>
                    {result?.isPending ? (
                      <Skeleton className="h-7 w-16" />
                    ) : submission?.final_score !== null && submission !== undefined ? (
                      <span className="shrink-0 text-lg font-bold tabular-nums text-success">
                        {submission.final_score}
                        <span className="text-xs font-normal text-muted">/{homework.max_score}</span>
                      </span>
                    ) : (
                      <Badge variant="success">Baholandi</Badge>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/* ----------------------------------- XP ----------------------------------- */

function XpCard() {
  const { user } = useSession();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Trophy className="size-4 text-accent" aria-hidden />
          Sizning XP
        </CardTitle>
        <CardDescription>Quiz javoblaringiz uchun yig’ilgan ball</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-3">
        {user ? (
          <>
            <XpBadge xp={user.xp_points} size="lg" animateOnChange />
            <div className="flex flex-wrap justify-end gap-1.5">
              {user.groups.map((group) => (
                <Badge key={group.id} variant="outline">
                  {group.name}
                </Badge>
              ))}
            </div>
          </>
        ) : (
          <Skeleton className="h-8 w-28" />
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------- leaderboard ------------------------------ */

function LeaderboardCard({
  groupId,
  groupName,
}: {
  groupId: number | null;
  groupName: string | null;
}) {
  const { user } = useSession();

  const query = useQuery({
    queryKey: queryKeys.groupMembers(groupId ?? 0),
    queryFn: () => getGroupMembers(groupId as number),
    enabled: groupId !== null,
  });

  const rows: GroupMemberOut[] = React.useMemo(
    () => [...(query.data ?? [])].sort((a, b) => b.xp_points - a.xp_points).slice(0, 5),
    [query.data],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Crown className="size-4 text-accent" aria-hidden />
          Reyting
        </CardTitle>
        <CardDescription>{groupName ? `${groupName} guruhi` : 'Guruh tanlanmagan'}</CardDescription>
      </CardHeader>
      <CardContent>
        {groupId === null ? (
          <p className="text-sm text-muted">Guruhga qo’shilgach reyting ko’rinadi.</p>
        ) : query.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted">Guruhda a’zo topilmadi.</p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {rows.map((member, index) => {
              const isMe = member.student_id === user?.id;
              return (
                <li
                  key={member.student_id}
                  className={cn(
                    'flex items-center gap-2.5 rounded-xl px-2 py-1.5',
                    isMe && 'bg-primary/10',
                  )}
                >
                  <span className="w-5 text-center text-xs font-semibold tabular-nums text-muted">
                    {index + 1}
                  </span>
                  <UserAvatar
                    fullName={member.full_name}
                    avatarUrl={member.avatar_url}
                    className="size-7"
                  />
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-sm',
                      isMe ? 'font-semibold text-primary' : 'text-fg',
                    )}
                  >
                    {member.full_name}
                  </span>
                  <span className="text-xs font-medium tabular-nums text-muted">
                    {member.xp_points} XP
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
