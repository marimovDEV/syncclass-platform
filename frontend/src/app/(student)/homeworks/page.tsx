'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQueries } from '@tanstack/react-query';
import { BookOpen } from 'lucide-react';

import type { HomeworkOut } from '@/types/api';
import { useSession } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import { getHomeworks } from '@/lib/resources';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AppShell } from '@/components/shared/AppShell';
import { CountdownBadge } from '@/components/shared/CountdownBadge';
import { EmptyState, ErrorState, LoadingState } from '@/components/shared/states';

export default function StudentHomeworksPage() {
  return (
    <AppShell allowRoles={['STUDENT']} title="Vazifalar" width="wide">
      <HomeworksList />
    </AppShell>
  );
}

function HomeworksList() {
  const { user } = useSession();
  const groupIds = React.useMemo(() => (user?.groups ?? []).map((group) => group.id), [user]);

  const results = useQueries({
    queries: groupIds.map((groupId) => ({
      queryKey: queryKeys.homeworks(groupId),
      queryFn: () => getHomeworks(groupId),
    })),
  });

  const isPending = groupIds.length > 0 && results.some((result) => result.isPending);
  const firstError = results.find((result) => result.isError)?.error;

  const homeworks: HomeworkOut[] = React.useMemo(() => {
    const unique = new Map<string, HomeworkOut>();
    for (const homework of results.flatMap((result) => result.data ?? [])) {
      unique.set(homework.id, homework);
    }
    return [...unique.values()].sort(
      (a, b) => new Date(b.deadline).getTime() - new Date(a.deadline).getTime(),
    );
  }, [results]);

  const now = Date.now();
  const active = homeworks.filter((homework) => new Date(homework.deadline).getTime() > now);
  const past = homeworks.filter((homework) => new Date(homework.deadline).getTime() <= now);

  if (groupIds.length === 0) {
    return (
      <EmptyState
        icon={<BookOpen aria-hidden />}
        title="Siz hali guruhga qo’shilmagansiz"
        description="Vazifalar guruhga qo’shilgandan keyin ko’rinadi."
      />
    );
  }

  if (isPending) return <LoadingState variant="skeleton" rows={4} />;

  if (firstError && homeworks.length === 0) {
    return (
      <ErrorState error={firstError} onRetry={() => results.forEach((result) => void result.refetch())} />
    );
  }

  return (
    <Tabs defaultValue="active">
      <TabsList>
        <TabsTrigger value="active">Faol ({active.length})</TabsTrigger>
        <TabsTrigger value="past">Muddati o’tgan ({past.length})</TabsTrigger>
      </TabsList>

      <TabsContent value="active">
        {active.length === 0 ? (
          <EmptyState
            icon={<BookOpen aria-hidden />}
            title="Faol vazifa yo’q"
            description="Yangi vazifa qo’shilsa shu yerda ko’rinadi."
          />
        ) : (
          <HomeworkCards homeworks={active} />
        )}
      </TabsContent>

      <TabsContent value="past">
        {past.length === 0 ? (
          <EmptyState
            icon={<BookOpen aria-hidden />}
            title="Muddati o’tgan vazifa yo’q"
          />
        ) : (
          <HomeworkCards homeworks={past} />
        )}
      </TabsContent>
    </Tabs>
  );
}

function HomeworkCards({ homeworks }: { homeworks: HomeworkOut[] }) {
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {homeworks.map((homework) => (
        <li key={homework.id}>
          {/* Fokus Link da (kartochka ichida emas) — nurni `group-focus-visible` uzatadi. */}
          <Link href={`/homeworks/${homework.id}`} className="group block h-full rounded-2xl">
            <Card
              interactive
              className="h-full group-focus-visible:border-primary/40 group-focus-visible:shadow-glow-soft"
            >
              <CardContent className="flex h-full flex-col gap-3 p-5 pt-5">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-fg">{homework.title}</p>
                  <CountdownBadge deadline={homework.deadline} />
                </div>
                <p className="line-clamp-2 text-sm text-muted">{homework.description}</p>
                <div className="mt-auto flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">{formatDateTime(homework.deadline)}</Badge>
                  <Badge variant="neutral">{homework.max_score} ball</Badge>
                  {homework.allow_resubmit ? (
                    <Badge variant="primary">Qayta topshirish mumkin</Badge>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}
