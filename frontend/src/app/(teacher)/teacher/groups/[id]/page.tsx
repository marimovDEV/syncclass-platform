'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Download, FileCheck2, Users } from 'lucide-react';

import type { GroupMemberOut } from '@/types/api';
import { isApiError } from '@/lib/api';
import { errorText, formatDate, formatDateTime, formatNumber } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import {
  getGroupMembers,
  getGroups,
  getHomeworks,
  groupAttendanceCsvUrl,
} from '@/lib/resources';
import { getAccessToken } from '@/lib/tokens';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/ui/avatar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { AppShell } from '@/components/shared/AppShell';
import { CountdownBadge } from '@/components/shared/CountdownBadge';
import { EmptyState, ErrorState, LoadingState } from '@/components/shared/states';
import { XpBadge } from '@/components/shared/XpBadge';

export default function TeacherGroupDetailPage() {
  const params = useParams();
  const rawId = params.id;
  const idText = typeof rawId === 'string' ? rawId : (rawId?.[0] ?? '');
  const groupId = Number.parseInt(idText, 10);

  return (
    <AppShell
      allowRoles={['TEACHER', 'ADMIN']}
      width="wide"
      title="Guruh"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/teacher/groups">
            <ArrowLeft aria-hidden />
            Guruhlar
          </Link>
        </Button>
      }
    >
      {Number.isFinite(groupId) ? (
        <GroupDetail groupId={groupId} />
      ) : (
        <ErrorState title="Guruh topilmadi" description="Havola noto’g’ri." />
      )}
    </AppShell>
  );
}

function GroupDetail({ groupId }: { groupId: number }) {
  const groupsQuery = useQuery({ queryKey: queryKeys.groups, queryFn: getGroups });
  const membersQuery = useQuery({
    queryKey: queryKeys.groupMembers(groupId),
    queryFn: () => getGroupMembers(groupId),
  });
  const homeworksQuery = useQuery({
    queryKey: queryKeys.homeworks(groupId),
    queryFn: () => getHomeworks(groupId),
  });

  const group = (groupsQuery.data ?? []).find((item) => item.id === groupId);

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface p-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-fg">
            {group ? group.name : `Guruh #${groupId}`}
          </h2>
          <p className="text-sm text-muted">
            {group ? group.course_title : 'Kurs ma’lumoti yuklanmoqda…'}
          </p>
        </div>
        {group ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">Taklif kodi:</span>
            <code className="rounded-lg border border-border bg-surface-2 px-2 py-0.5 text-sm font-semibold text-fg">
              {group.invite_code}
            </code>
          </div>
        ) : null}
        <AttendanceCsvButton groupId={groupId} groupName={group?.name ?? String(groupId)} />
      </section>

      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">
            <Users className="mr-1.5 size-4" aria-hidden />
            A’zolar
          </TabsTrigger>
          <TabsTrigger value="homeworks">
            <FileCheck2 className="mr-1.5 size-4" aria-hidden />
            Vazifalar
          </TabsTrigger>
        </TabsList>

        <TabsContent value="members">
          {membersQuery.isPending ? (
            <LoadingState variant="skeleton" rows={4} />
          ) : membersQuery.isError ? (
            <ErrorState error={membersQuery.error} onRetry={() => void membersQuery.refetch()} />
          ) : (membersQuery.data ?? []).length === 0 ? (
            <EmptyState
              title="A’zo yo’q"
              description="O’quvchilar taklif kodi bilan qo’shilgach shu yerda ko’rinadi."
              icon={<Users aria-hidden />}
            />
          ) : (
            <MembersTable members={membersQuery.data ?? []} />
          )}
        </TabsContent>

        <TabsContent value="homeworks">
          {homeworksQuery.isPending ? (
            <LoadingState variant="skeleton" rows={3} />
          ) : homeworksQuery.isError ? (
            <ErrorState
              error={homeworksQuery.error}
              onRetry={() => void homeworksQuery.refetch()}
            />
          ) : (homeworksQuery.data ?? []).length === 0 ? (
            <EmptyState
              title="Vazifa yo’q"
              description="Bu guruhga hali uy ishi berilmagan."
              icon={<FileCheck2 aria-hidden />}
              action={
                <Button asChild size="sm" variant="secondary">
                  <Link href="/teacher/homeworks">Vazifalar</Link>
                </Button>
              }
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {[...(homeworksQuery.data ?? [])]
                .sort((a, b) => new Date(b.deadline).getTime() - new Date(a.deadline).getTime())
                .map((homework) => (
                  <li
                    key={homework.id}
                    className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                      {homework.title}
                    </span>
                    <CountdownBadge deadline={homework.deadline} prefix="Muddat:" />
                    <Button asChild size="sm" variant="secondary">
                      <Link href={`/teacher/homeworks/${homework.id}`}>
                        Topshirganlar
                        <ArrowRight aria-hidden />
                      </Link>
                    </Button>
                  </li>
                ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ---------------------------------- a'zolar ------------------------------- */

function MembersTable({ members }: { members: GroupMemberOut[] }) {
  const sorted = [...members].sort((a, b) => b.xp_points - a.xp_points);

  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-surface scrollbar-thin">
      <table className="w-full min-w-[34rem] border-collapse text-sm">
        <caption className="sr-only">Guruh a’zolari</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="px-3 py-2 font-semibold">
              O’quvchi
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Email
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              XP
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Qo’shilgan
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((member) => (
            <tr key={member.student_id} className="border-b border-border last:border-b-0">
              <td className="px-3 py-2">
                <span className="flex items-center gap-2">
                  <UserAvatar
                    fullName={member.full_name}
                    avatarUrl={member.avatar_url}
                    className="size-7 shrink-0"
                  />
                  <span className="truncate font-medium text-fg">{member.full_name}</span>
                </span>
              </td>
              <td className="px-3 py-2 text-muted">{member.email}</td>
              <td className="px-3 py-2 text-right">
                <XpBadge xp={member.xp_points} size="sm" />
              </td>
              <td className="px-3 py-2 text-muted">{formatDate(member.joined_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border px-3 py-2 text-xs text-muted">
        Jami {formatNumber(members.length)} a’zo · oxirgi yangilanish {formatDateTime(Date.now())}
      </p>
    </div>
  );
}

/* ------------------------------- davomat CSV ------------------------------ */

/**
 * `GET /groups/{id}/attendance.csv` — `Authorization` sarlavhasi kerak,
 * shuning uchun oddiy havola emas: fayl `fetch` bilan olinadi va blob sifatida saqlanadi.
 */
function AttendanceCsvButton({ groupId, groupName }: { groupId: number; groupName: string }) {
  const [busy, setBusy] = React.useState(false);

  const download = async (): Promise<void> => {
    setBusy(true);
    let objectUrl: string | null = null;
    try {
      const token = getAccessToken();
      const response = await fetch(groupAttendanceCsvUrl(groupId), {
        headers: token === null ? {} : { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error(`CSV olinmadi (${response.status})`);
      }
      const blob = await response.blob();
      objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `davomat-${groupName}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast.success('CSV yuklab olindi');
    } catch (caught) {
      toast.error('CSV yuklab olinmadi', {
        description: isApiError(caught)
          ? errorText(caught.code, caught.message)
          : caught instanceof Error
            ? caught.message
            : 'Qayta urinib ko’ring.',
      });
    } finally {
      // Chrome yuklashni boshlab olishi uchun URL darhol bo'shatilmaydi.
      if (objectUrl !== null) {
        const toRevoke = objectUrl;
        window.setTimeout(() => URL.revokeObjectURL(toRevoke), 10_000);
      }
      setBusy(false);
    }
  };

  return (
    <Button variant="secondary" size="sm" loading={busy} onClick={() => void download()}>
      <Download aria-hidden />
      Davomat CSV
    </Button>
  );
}
