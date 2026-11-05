'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, Pencil, Plus, Presentation as PresentationIcon, Trash2 } from 'lucide-react';

import type { PresentationListItem, Slide, SlideType } from '@/types/api';
import { SLIDE_TYPES } from '@/types/api';
import { isApiError } from '@/lib/api';
import { errorText, formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import { createPresentation, deletePresentation, getPresentations } from '@/lib/resources';
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
import { PresentationImportDialog } from '@/components/reviewer/PresentationImportDialog';
import { SLIDE_TYPE_ICON, SLIDE_TYPE_LABEL } from './[id]/builder/SlideListPanel';

export default function TeacherPresentationsPage() {
  return <PresentationsScreen />;
}

function PresentationsScreen() {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);

  return (
    <AppShell
      allowRoles={['TEACHER', 'ADMIN']}
      width="wide"
      title="Prezentatsiyalar"
      subtitle="Slayd to’plamlarini yaratish va tahrirlash"
      actions={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => setImportOpen(true)}>
            <FileUp aria-hidden />
            Taqdimot yuklash
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden />
            Yangi prezentatsiya
          </Button>
        </div>
      }
    >
      <PresentationsList
        onCreate={() => setCreateOpen(true)}
        onImport={() => setImportOpen(true)}
      />
      <CreatePresentationDialog open={createOpen} onOpenChange={setCreateOpen} />
      <PresentationImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </AppShell>
  );
}

/* --------------------------------- ro'yxat -------------------------------- */

/**
 * Ro'yxat API yengil (`slides_data` KELMAYDI) — tur bo'yicha belgilar faqat
 * to'liq obyekt (masalan, endi yaratilgan prezentatsiya keshi) kelganda chiqadi.
 */
type PresentationCardData = PresentationListItem & { slides_data?: Slide[] };

function slideCounts(presentation: PresentationCardData): Record<SlideType, number> {
  const counts: Record<SlideType, number> = {
    MARKDOWN: 0,
    CODE: 0,
    QUIZ: 0,
    IMAGE: 0,
    POLL: 0,
    OPEN: 0,
  };
  if (Array.isArray(presentation.slides_data)) {
    for (const slide of presentation.slides_data) {
      counts[slide.type] = (counts[slide.type] || 0) + 1;
    }
  }
  return counts;
}

function PresentationsList({
  onCreate,
  onImport,
}: {
  onCreate: () => void;
  onImport: () => void;
}) {
  const presentationsQuery = useQuery({
    queryKey: queryKeys.presentations,
    queryFn: getPresentations,
  });

  if (presentationsQuery.isPending) {
    return <LoadingState variant="skeleton" rows={4} />;
  }

  if (presentationsQuery.isError) {
    return (
      <ErrorState
        error={presentationsQuery.error}
        onRetry={() => void presentationsQuery.refetch()}
      />
    );
  }

  const presentations = presentationsQuery.data ?? [];

  if (presentations.length === 0) {
    return (
      <EmptyState
        title="Prezentatsiya yo’q"
        description="Noldan yarating yoki tayyor taqdimotni (PDF / PPTX) yuklang — keyin Slide Builder da so’rovnoma va ochiq savol qo’shishingiz mumkin."
        icon={<PresentationIcon aria-hidden />}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button size="sm" variant="secondary" onClick={onImport}>
              <FileUp aria-hidden />
              Taqdimot yuklash
            </Button>
            <Button size="sm" onClick={onCreate}>
              <Plus aria-hidden />
              Yangi prezentatsiya
            </Button>
          </div>
        }
      />
    );
  }

  const sorted = [...presentations].sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );

  return (
    <ul className="grid gap-4 md:grid-cols-2 studio:grid-cols-3">
      {sorted.map((presentation) => (
        <li key={presentation.id}>
          <PresentationCard presentation={presentation} />
        </li>
      ))}
    </ul>
  );
}

function PresentationCard({ presentation }: { presentation: PresentationCardData }) {
  const counts = slideCounts(presentation);
  const total = presentation.slides_count;

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle className="flex items-start justify-between gap-2 text-base">
          <span className="min-w-0 break-words">{presentation.title}</span>
          <Badge variant="outline" className="shrink-0">
            M{presentation.module_number}·D{presentation.lesson_number}
          </Badge>
        </CardTitle>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="neutral">{total} slayd</Badge>
          {SLIDE_TYPES.filter((type) => counts[type] > 0).map((type) => {
            const Icon = SLIDE_TYPE_ICON[type];
            return (
              <Badge key={type} variant="outline" title={SLIDE_TYPE_LABEL[type]}>
                <Icon aria-hidden />
                <span className="sr-only">{SLIDE_TYPE_LABEL[type]}:</span>
                {counts[type]}
              </Badge>
            );
          })}
        </div>
        <p className="text-xs text-muted">
          Oxirgi o’zgarish: {formatDateTime(presentation.updated_at)}
        </p>
      </CardContent>

      <CardFooter className="flex items-center justify-between gap-2">
        <Button asChild size="sm">
          <Link href={`/teacher/presentations/${presentation.id}/builder`}>
            <Pencil aria-hidden />
            Tahrirlash
          </Link>
        </Button>
        <DeletePresentationButton presentation={presentation} />
      </CardFooter>
    </Card>
  );
}

/* ----------------------------------- o'chirish ---------------------------- */

function DeletePresentationButton({ presentation }: { presentation: PresentationCardData }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);

  const remove = useMutation({
    mutationFn: () => deletePresentation(presentation.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.presentations });
      toast.success('Prezentatsiya o’chirildi');
      setOpen(false);
    },
    onError: (caught) => {
      toast.error('O’chirib bo’lmadi', {
        description: isApiError(caught)
          ? errorText(caught.code, caught.message)
          : 'Qayta urinib ko’ring.',
      });
    },
  });

  return (
    <>
      <Button variant="ghost" size="icon-sm" aria-label="O’chirish" onClick={() => setOpen(true)}>
        <Trash2 aria-hidden />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Prezentatsiyani o’chirish</DialogTitle>
            <DialogDescription>
              «{presentation.title}» butunlay o’chiriladi. Bu amalni qaytarib bo’lmaydi.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Bekor qilish
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              <Trash2 aria-hidden />
              O’chirish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ----------------------------------- yaratish ----------------------------- */

function CreatePresentationDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [title, setTitle] = React.useState('');
  const [moduleNumber, setModuleNumber] = React.useState('1');
  const [lessonNumber, setLessonNumber] = React.useState('1');

  const create = useMutation({
    mutationFn: () =>
      createPresentation({
        title: title.trim(),
        module_number: Number.parseInt(moduleNumber, 10),
        lesson_number: Number.parseInt(lessonNumber, 10),
        slides_data: [],
      }),
    onSuccess: (presentation) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.presentations });
      queryClient.setQueryData(queryKeys.presentation(presentation.id), presentation);
      toast.success('Prezentatsiya yaratildi');
      onOpenChange(false);
      setTitle('');
      router.push(`/teacher/presentations/${presentation.id}/builder`);
    },
    onError: (caught) => {
      toast.error('Yaratib bo’lmadi', {
        description: isApiError(caught)
          ? errorText(caught.code, caught.message)
          : 'Qayta urinib ko’ring.',
      });
    },
  });

  const moduleValid = Number.isFinite(Number.parseInt(moduleNumber, 10));
  const lessonValid = Number.isFinite(Number.parseInt(lessonNumber, 10));
  const canCreate = title.trim().length > 0 && moduleValid && lessonValid;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Yangi prezentatsiya</DialogTitle>
          <DialogDescription>
            Sarlavha, modul va dars raqamini kiriting — keyin Slide Builder ochiladi.
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
            <Label htmlFor="presentation-title" required>
              Sarlavha
            </Label>
            <Input
              id="presentation-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Python: funksiyalar"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="presentation-module" required>
                Modul
              </Label>
              <Input
                id="presentation-module"
                type="number"
                min={1}
                value={moduleNumber}
                invalid={!moduleValid}
                onChange={(event) => setModuleNumber(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="presentation-lesson" required>
                Dars
              </Label>
              <Input
                id="presentation-lesson"
                type="number"
                min={1}
                value={lessonNumber}
                invalid={!lessonValid}
                onChange={(event) => setLessonNumber(event.target.value)}
              />
            </div>
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
