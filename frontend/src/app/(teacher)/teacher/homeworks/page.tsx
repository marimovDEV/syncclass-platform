'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, FileCheck2, Plus, ShieldAlert } from 'lucide-react';

import type { GroupOut, HomeworkOut } from '@/types/api';
import { isApiError } from '@/lib/api';
import { errorText, formatDateTime, toLocalInputValue } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import { createHomework, getGroups, getHomeworks } from '@/lib/resources';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { AppShell } from '@/components/shared/AppShell';
import { CountdownBadge } from '@/components/shared/CountdownBadge';
import { EmptyState, ErrorState, LoadingState } from '@/components/shared/states';

/**
 * `datetime-local` qiymati → ISO (UTC).
 * O'zbekistonda yozgi vaqt yo'q, smena doimiy `+05:00` (AUDIT.md §H5) —
 * shuning uchun kiritilgan vaqt har doim Toshkent vaqti sifatida o'qiladi,
 * brauzerning o'z vaqt zonasiga bog'liq bo'lmaydi.
 */
function tashkentInputToIso(value: string): string | null {
  if (value.length === 0) return null;
  const date = new Date(`${value}:00+05:00`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

const DEFAULT_MAX_SCORE = 100;
const DEFAULT_AI_PENALTY = 30;

export default function TeacherHomeworksPage() {
  const [createOpen, setCreateOpen] = React.useState(false);
  const groupsQuery = useQuery({ queryKey: queryKeys.groups, queryFn: getGroups });
  const groups = groupsQuery.data ?? [];

  return (
    <AppShell
      allowRoles={['TEACHER', 'ADMIN']}
      width="wide"
      title="Vazifalar"
      subtitle="Uy ishlarini yaratish va topshirilgan ishlarni tekshirish"
      actions={
        <Button size="sm" disabled={groups.length === 0} onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden />
          Yangi vazifa
        </Button>
      }
    >
      <HomeworksList groups={groups} groupsLoading={groupsQuery.isPending} />
      <CreateHomeworkDialog open={createOpen} onOpenChange={setCreateOpen} groups={groups} />
    </AppShell>
  );
}

/* --------------------------------- ro'yxat -------------------------------- */

function HomeworksList({
  groups,
  groupsLoading,
}: {
  groups: GroupOut[];
  groupsLoading: boolean;
}) {
  const [groupFilter, setGroupFilter] = React.useState<string>('ALL');
  const selectedGroupId = groupFilter === 'ALL' ? undefined : Number.parseInt(groupFilter, 10);

  const homeworksQuery = useQuery({
    queryKey: queryKeys.homeworks(selectedGroupId),
    queryFn: () => getHomeworks(selectedGroupId),
  });

  const groupName = React.useCallback(
    (groupId: number): string => groups.find((group) => group.id === groupId)?.name ?? `#${groupId}`,
    [groups],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="homework-group-filter" className="text-xs text-muted">
          Guruh
        </Label>
        <Select value={groupFilter} onValueChange={setGroupFilter}>
          <SelectTrigger id="homework-group-filter" className="h-9 w-64">
            <SelectValue placeholder="Hamma guruh" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Hamma guruh</SelectItem>
            {groups.map((group) => (
              <SelectItem key={group.id} value={String(group.id)}>
                {group.name} — {group.course_title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {groupsLoading ? <span className="text-xs text-muted">Guruhlar yuklanmoqda…</span> : null}
      </div>

      {homeworksQuery.isPending ? (
        <LoadingState variant="skeleton" rows={4} />
      ) : homeworksQuery.isError ? (
        <ErrorState error={homeworksQuery.error} onRetry={() => void homeworksQuery.refetch()} />
      ) : (homeworksQuery.data ?? []).length === 0 ? (
        <EmptyState
          title="Vazifa yo’q"
          description={
            groups.length === 0
              ? 'Avval guruh yarating — vazifa guruhga biriktiriladi.'
              : 'Bu guruh uchun hali uy ishi berilmagan.'
          }
          icon={<FileCheck2 aria-hidden />}
          action={
            groups.length === 0 ? (
              <Button asChild variant="secondary" size="sm">
                <Link href="/teacher/groups">Guruhlar</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {[...(homeworksQuery.data ?? [])]
            .sort((a, b) => new Date(b.deadline).getTime() - new Date(a.deadline).getTime())
            .map((homework) => (
              <li key={homework.id}>
                <HomeworkRow homework={homework} groupName={groupName(homework.group_id)} />
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

function HomeworkRow({ homework, groupName }: { homework: HomeworkOut; groupName: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span className="min-w-0 flex-1 break-words">{homework.title}</span>
          <Badge variant="outline">{groupName}</Badge>
          <CountdownBadge deadline={homework.deadline} prefix="Muddat:" />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="line-clamp-2 max-w-2xl text-sm text-muted">{homework.description}</p>
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
            <span>{homework.allow_resubmit ? 'Qayta topshirish mumkin' : 'Qayta topshirilmaydi'}</span>
          </p>
        </div>
        <Button asChild size="sm">
          <Link href={`/teacher/homeworks/${homework.id}`}>
            Topshirganlar
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/* --------------------------------- yaratish ------------------------------- */

function CreateHomeworkDialog({
  open,
  onOpenChange,
  groups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: GroupOut[];
}) {
  const queryClient = useQueryClient();
  const [groupId, setGroupId] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [deadline, setDeadline] = React.useState(() =>
    toLocalInputValue(new Date(Date.now() + 7 * 24 * 3_600_000)),
  );
  const [maxScore, setMaxScore] = React.useState(String(DEFAULT_MAX_SCORE));
  const [aiPenalty, setAiPenalty] = React.useState(String(DEFAULT_AI_PENALTY));
  const [allowResubmit, setAllowResubmit] = React.useState(true);

  const deadlineIso = tashkentInputToIso(deadline);
  const maxScoreValue = Number.parseInt(maxScore, 10);
  const aiPenaltyValue = Number.parseInt(aiPenalty, 10);

  const maxScoreValid = Number.isFinite(maxScoreValue) && maxScoreValue > 0;
  const aiPenaltyValid =
    Number.isFinite(aiPenaltyValue) && aiPenaltyValue >= 0 && aiPenaltyValue <= maxScoreValue;

  const canCreate =
    groupId.length > 0 &&
    title.trim().length > 0 &&
    description.trim().length > 0 &&
    deadlineIso !== null &&
    maxScoreValid &&
    aiPenaltyValid;

  const create = useMutation({
    mutationFn: () =>
      createHomework({
        group_id: Number.parseInt(groupId, 10),
        title: title.trim(),
        description: description.trim(),
        deadline: deadlineIso ?? '',
        max_score: maxScoreValue,
        ai_penalty_points: aiPenaltyValue,
        allow_resubmit: allowResubmit,
      }),
    onSuccess: (homework) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.homeworks(homework.group_id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.homeworks() });
      queryClient.setQueryData(queryKeys.homework(homework.id), homework);
      toast.success('Vazifa yaratildi');
      onOpenChange(false);
      setTitle('');
      setDescription('');
    },
    onError: (caught) => {
      toast.error('Vazifa yaratilmadi', {
        description: isApiError(caught)
          ? errorText(caught.code, caught.message)
          : 'Qayta urinib ko’ring.',
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Yangi vazifa</DialogTitle>
          <DialogDescription>
            Muddat Toshkent vaqtida kiritiladi. AI jarimasi — faqat tavsiya qiymati, avtomatik
            qo’llanmaydi.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canCreate) create.mutate();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="homework-group" required>
              Guruh
            </Label>
            <Select value={groupId} onValueChange={setGroupId}>
              <SelectTrigger id="homework-group">
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
            <Label htmlFor="homework-title" required>
              Sarlavha
            </Label>
            <Input
              id="homework-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="3-dars: funksiyalar"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="homework-description" required>
              Topshiriq matni
            </Label>
            <Textarea
              id="homework-description"
              rows={5}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Nima qilish kerak, qanday fayl topshiriladi…"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5 sm:col-span-3">
              <Label htmlFor="homework-deadline" required>
                Muddat (Toshkent vaqti)
              </Label>
              <Input
                id="homework-deadline"
                type="datetime-local"
                value={deadline}
                invalid={deadlineIso === null}
                onChange={(event) => setDeadline(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="homework-max-score" required>
                Maksimal ball
              </Label>
              <Input
                id="homework-max-score"
                type="number"
                min={1}
                value={maxScore}
                invalid={!maxScoreValid}
                onChange={(event) => setMaxScore(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="homework-ai-penalty" required>
                AI jarimasi
              </Label>
              <Input
                id="homework-ai-penalty"
                type="number"
                min={0}
                value={aiPenalty}
                invalid={!aiPenaltyValid}
                onChange={(event) => setAiPenalty(event.target.value)}
              />
            </div>
            <div className="flex items-end">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={allowResubmit}
                  onChange={(event) => setAllowResubmit(event.target.checked)}
                  className="size-4 accent-primary"
                />
                Qayta topshirish
              </label>
            </div>
          </div>

          {!aiPenaltyValid ? (
            <p role="alert" className="text-xs text-danger">
              AI jarimasi 0 va maksimal ball orasida bo’lishi kerak.
            </p>
          ) : null}

          <p className="rounded-xl border border-border bg-surface-2 p-3 text-xs text-muted">
            AI jarimasi — <span className="font-medium text-fg">tavsiya</span>. Ball faqat siz
            tekshiruv sahifasida tasdiqlaganda kamayadi (AUDIT §E2).
          </p>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Bekor qilish
            </Button>
            <Button type="submit" disabled={!canCreate} loading={create.isPending}>
              <Plus aria-hidden />
              Yaratish
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
