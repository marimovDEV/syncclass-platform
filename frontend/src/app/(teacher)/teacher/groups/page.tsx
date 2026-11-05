'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Copy, Plus, Users } from 'lucide-react';

import type { GroupOut } from '@/types/api';
import { isApiError } from '@/lib/api';
import { errorText } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import { createGroup, getGroups } from '@/lib/resources';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
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
import { toast } from '@/components/ui/toast';
import { AppShell } from '@/components/shared/AppShell';
import { EmptyState, ErrorState, LoadingState } from '@/components/shared/states';

export default function TeacherGroupsPage() {
  const [createOpen, setCreateOpen] = React.useState(false);

  return (
    <AppShell
      allowRoles={['TEACHER', 'ADMIN']}
      width="wide"
      title="Guruhlar"
      subtitle="A’zolar, taklif kodi va davomat tarixi"
      actions={
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden />
          Yangi guruh
        </Button>
      }
    >
      <GroupsList onCreate={() => setCreateOpen(true)} />
      <CreateGroupDialog open={createOpen} onOpenChange={setCreateOpen} />
    </AppShell>
  );
}

function GroupsList({ onCreate }: { onCreate: () => void }) {
  const groupsQuery = useQuery({ queryKey: queryKeys.groups, queryFn: getGroups });

  if (groupsQuery.isPending) return <LoadingState variant="skeleton" rows={3} />;
  if (groupsQuery.isError) {
    return <ErrorState error={groupsQuery.error} onRetry={() => void groupsQuery.refetch()} />;
  }

  const groups = groupsQuery.data ?? [];
  if (groups.length === 0) {
    return (
      <EmptyState
        title="Guruh yo’q"
        description="Guruh yaratsangiz, o’quvchilar taklif kodi bilan qo’shiladi."
        icon={<Users aria-hidden />}
        action={
          <Button size="sm" onClick={onCreate}>
            <Plus aria-hidden />
            Yangi guruh
          </Button>
        }
      />
    );
  }

  return (
    <ul className="grid gap-4 md:grid-cols-2 studio:grid-cols-3">
      {groups.map((group) => (
        <li key={group.id}>
          <GroupCard group={group} />
        </li>
      ))}
    </ul>
  );
}

function GroupCard({ group }: { group: GroupOut }) {
  const [copied, setCopied] = React.useState(false);

  const copyInvite = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(group.invite_code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('Nusxalab bo’lmadi', { description: 'Kodni qo’lda belgilab oling.' });
    }
  };

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle className="flex items-start justify-between gap-2 text-base">
          <span className="min-w-0 break-words">{group.name}</span>
          <Badge variant={group.is_active ? 'success' : 'outline'} className="shrink-0">
            {group.is_active ? 'Faol' : 'Arxiv'}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <p className="text-sm text-muted">{group.course_title}</p>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">Taklif kodi:</span>
          <code className="rounded-lg border border-border bg-surface-2 px-2 py-0.5 text-sm font-semibold text-fg">
            {group.invite_code}
          </code>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Taklif kodini nusxalash"
            onClick={() => void copyInvite()}
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </Button>
        </div>
      </CardContent>
      <CardFooter>
        <Button asChild size="sm">
          <Link href={`/teacher/groups/${group.id}`}>
            A’zolar va davomat
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}

function CreateGroupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState('');
  const [courseTitle, setCourseTitle] = React.useState('');

  const create = useMutation({
    mutationFn: () => createGroup({ name: name.trim(), course_title: courseTitle.trim() }),
    onSuccess: (group) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      toast.success(`${group.name} yaratildi · kod ${group.invite_code}`);
      onOpenChange(false);
      setName('');
      setCourseTitle('');
    },
    onError: (caught) => {
      toast.error('Guruh yaratilmadi', {
        description: isApiError(caught)
          ? errorText(caught.code, caught.message)
          : 'Qayta urinib ko’ring.',
      });
    },
  });

  const canCreate = name.trim().length > 0 && courseTitle.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Yangi guruh</DialogTitle>
          <DialogDescription>
            Guruh nomi takrorlanmas bo’lishi kerak. Taklif kodi avtomatik yaratiladi.
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
            <Label htmlFor="group-name" required>
              Guruh nomi
            </Label>
            <Input
              id="group-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="P-30"
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="group-course" required>
              Kurs nomi
            </Label>
            <Input
              id="group-course"
              value={courseTitle}
              onChange={(event) => setCourseTitle(event.target.value)}
              placeholder="Python backend"
            />
          </div>

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
