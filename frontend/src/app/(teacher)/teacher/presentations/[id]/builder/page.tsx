'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Check, CloudOff, Loader2, Save } from 'lucide-react';

import type { PresentationOut, Slide, SlideType } from '@/types/api';
import {
  IMAGE_MAX_ALT_CHARS,
  MAX_SLIDES,
  OPEN_DEFAULT_MAX_CHARS,
  OPEN_MAX_DURATION_SEC,
  OPEN_MAX_MAX_CHARS,
  OPEN_MIN_DURATION_SEC,
  OPEN_MIN_MAX_CHARS,
  POLL_MAX_DURATION_SEC,
  POLL_MAX_OPTIONS,
  POLL_MIN_DURATION_SEC,
  POLL_MIN_OPTIONS,
  QUIZ_DEFAULT_POINTS,
  QUIZ_MAX_DURATION_SEC,
  QUIZ_MAX_OPTIONS,
  QUIZ_MAX_POINTS,
  QUIZ_MIN_DURATION_SEC,
  QUIZ_MIN_OPTIONS,
} from '@/types/api';
import { queryKeys } from '@/lib/query';
import { getPresentation, updatePresentation } from '@/lib/resources';
import { clamp, cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { AppShell } from '@/components/shared/AppShell';
import { EmptyState, ErrorState, LoadingState } from '@/components/shared/states';
import { describeSaveError, slideFieldErrors } from '@/components/reviewer/slideErrors';
import { SlideEditor, uploadSlideImage } from './SlideEditor';
import { SlideListPanel } from './SlideListPanel';
import { SlidePreview } from './SlidePreview';

/** Avtosaqlash kechikishi (ms). */
const AUTOSAVE_DELAY_MS = 800;

type SaveStatus = 'clean' | 'dirty' | 'saving' | 'saved' | 'error' | 'blocked';

interface Draft {
  title: string;
  moduleNumber: string;
  lessonNumber: string;
  slides: Slide[];
}

/* ------------------------------ yordamchilar ------------------------------ */

/** `index` maydoni har doim massivdagi o'rniga teng bo'lishi shart (CONTRACTS §3). */
function reindex(slides: Slide[]): Slide[] {
  return slides.map((slide, index) => (slide.index === index ? slide : { ...slide, index }));
}

/** Yangi slayd shabloni. `IMAGE` bu yerda yo'q — u faqat yuklangan rasm URL i bilan yaratiladi. */
function emptySlide(type: Exclude<SlideType, 'IMAGE'>, index: number): Slide {
  switch (type) {
    case 'MARKDOWN':
      return {
        index,
        type: 'MARKDOWN',
        title: 'Yangi slayd',
        content: '# Sarlavha\n\n- Birinchi fikr\n- Ikkinchi fikr',
        notes: null,
      };
    case 'CODE':
      return {
        index,
        type: 'CODE',
        title: 'Kod bilan ishlash',
        code_lang: 'python',
        starter_code: '# Boshlang’ich kod\n',
        notes: null,
      };
    case 'QUIZ':
      return {
        index,
        type: 'QUIZ',
        title: 'Nazorat savoli',
        question: '',
        options: ['', ''],
        correct_option: 0,
        duration_sec: 30,
        points: QUIZ_DEFAULT_POINTS,
      };
    case 'POLL':
      return {
        index,
        type: 'POLL',
        title: 'So’rovnoma',
        question: '',
        options: ['', ''],
        duration_sec: 60,
      };
    case 'OPEN':
      return {
        index,
        type: 'OPEN',
        title: 'Ochiq savol',
        question: '',
        duration_sec: 90,
        max_chars: OPEN_DEFAULT_MAX_CHARS,
      };
  }
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

/** QUIZ va POLL uchun umumiy variant tekshiruvi. */
function validateOptions(options: string[], min: number, max: number, issues: string[]): void {
  if (options.length < min || options.length > max) {
    issues.push(`Variantlar soni ${min}–${max} bo’lishi kerak.`);
  }
  if (options.some((option) => option.trim().length === 0)) {
    issues.push('Bo’sh variant qoldirilmaydi.');
  }
}

/**
 * Backend Pydantic validatsiyasi rad etadigan holatlar (CONTRACTS §3, §16.1).
 * Chegaralar `@/types/api` doimiylaridan — qo'lda yozilgan raqam yo'q.
 */
function validateSlide(slide: Slide): string[] {
  const issues: string[] = [];
  switch (slide.type) {
    case 'MARKDOWN':
      if (slide.content.trim().length === 0) issues.push('Markdown matni bo’sh.');
      break;
    case 'CODE':
      break;
    case 'IMAGE':
      if (slide.alt.trim().length === 0) {
        issues.push('Alt matn (rasm tavsifi) majburiy — ko’rishida nuqsoni bor o’quvchi uchun.');
      } else if (slide.alt.length > IMAGE_MAX_ALT_CHARS) {
        issues.push(`Alt matn ${IMAGE_MAX_ALT_CHARS} belgidan oshmasin.`);
      }
      if (slide.image_url.length === 0) issues.push('Rasm yuklanmagan.');
      break;
    case 'QUIZ':
      if (slide.question.trim().length === 0) issues.push('Savol matni bo’sh.');
      validateOptions(slide.options, QUIZ_MIN_OPTIONS, QUIZ_MAX_OPTIONS, issues);
      if (slide.correct_option < 0 || slide.correct_option >= slide.options.length) {
        issues.push('To’g’ri javob belgilanmagan.');
      }
      if (!inRange(slide.duration_sec, QUIZ_MIN_DURATION_SEC, QUIZ_MAX_DURATION_SEC)) {
        issues.push(`Vaqt ${QUIZ_MIN_DURATION_SEC}–${QUIZ_MAX_DURATION_SEC} sekund bo’lishi kerak.`);
      }
      if (!inRange(slide.points, 1, QUIZ_MAX_POINTS)) {
        issues.push(`XP 1–${QUIZ_MAX_POINTS} oralig’ida bo’lishi kerak.`);
      }
      break;
    case 'POLL':
      if (slide.question.trim().length === 0) issues.push('Savol matni bo’sh.');
      validateOptions(slide.options, POLL_MIN_OPTIONS, POLL_MAX_OPTIONS, issues);
      if (!inRange(slide.duration_sec, POLL_MIN_DURATION_SEC, POLL_MAX_DURATION_SEC)) {
        issues.push(`Vaqt ${POLL_MIN_DURATION_SEC}–${POLL_MAX_DURATION_SEC} sekund bo’lishi kerak.`);
      }
      break;
    case 'OPEN':
      if (slide.question.trim().length === 0) issues.push('Savol matni bo’sh.');
      if (!inRange(slide.duration_sec, OPEN_MIN_DURATION_SEC, OPEN_MAX_DURATION_SEC)) {
        issues.push(`Vaqt ${OPEN_MIN_DURATION_SEC}–${OPEN_MAX_DURATION_SEC} sekund bo’lishi kerak.`);
      }
      if (!inRange(slide.max_chars, OPEN_MIN_MAX_CHARS, OPEN_MAX_MAX_CHARS)) {
        issues.push(`Javob uzunligi ${OPEN_MIN_MAX_CHARS}–${OPEN_MAX_MAX_CHARS} belgi bo’lishi kerak.`);
      }
      break;
  }
  return issues;
}

/* --------------------------------- sahifa --------------------------------- */

export default function SlideBuilderPage() {
  const params = useParams();
  const rawId = params.id;
  const presentationId = typeof rawId === 'string' ? rawId : (rawId?.[0] ?? '');

  return (
    <AppShell
      allowRoles={['TEACHER', 'ADMIN']}
      width="full"
      title="Slide Builder"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/teacher/presentations">
            <ArrowLeft aria-hidden />
            Prezentatsiyalar
          </Link>
        </Button>
      }
    >
      {presentationId.length === 0 ? (
        <ErrorState title="Prezentatsiya topilmadi" description="Havola noto’g’ri." />
      ) : (
        <SlideBuilder presentationId={presentationId} />
      )}
    </AppShell>
  );
}

function SlideBuilder({ presentationId }: { presentationId: string }) {
  const queryClient = useQueryClient();
  const presentationQuery = useQuery({
    queryKey: queryKeys.presentation(presentationId),
    queryFn: () => getPresentation(presentationId),
  });

  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [status, setStatus] = React.useState<SaveStatus>('clean');

  // Server ma'lumoti kelganda draft bir marta to'ldiriladi (keyin lokal holat ustun).
  const loadedIdRef = React.useRef<string | null>(null);
  const presentation = presentationQuery.data;
  React.useEffect(() => {
    if (!presentation) return;
    if (loadedIdRef.current === presentation.id) return;
    loadedIdRef.current = presentation.id;
    setDraft({
      title: presentation.title,
      moduleNumber: String(presentation.module_number),
      lessonNumber: String(presentation.lesson_number),
      slides: reindex(presentation.slides_data),
    });
    setActiveIndex(0);
    setStatus('clean');
  }, [presentation]);

  const issuesBySlide = React.useMemo(
    () => (draft ? draft.slides.map((slide) => validateSlide(slide)) : []),
    [draft],
  );
  const issueCountByIndex = React.useMemo(() => {
    const map: Record<number, number> = {};
    issuesBySlide.forEach((issues, index) => {
      if (issues.length > 0) map[index] = issues.length;
    });
    return map;
  }, [issuesBySlide]);
  const hasIssues = issuesBySlide.some((issues) => issues.length > 0);

  const moduleNumber = draft ? Number.parseInt(draft.moduleNumber, 10) : Number.NaN;
  const lessonNumber = draft ? Number.parseInt(draft.lessonNumber, 10) : Number.NaN;
  const metaValid =
    Number.isFinite(moduleNumber) &&
    moduleNumber >= 1 &&
    Number.isFinite(lessonNumber) &&
    lessonNumber >= 1 &&
    (draft?.title.trim().length ?? 0) > 0;

  const save = useMutation({
    mutationFn: (payload: Draft) =>
      updatePresentation(presentationId, {
        title: payload.title.trim(),
        module_number: Number.parseInt(payload.moduleNumber, 10),
        lesson_number: Number.parseInt(payload.lessonNumber, 10),
        slides_data: reindex(payload.slides),
      }),
    onMutate: () => setStatus('saving'),
    onSuccess: (updated: PresentationOut) => {
      queryClient.setQueryData(queryKeys.presentation(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.presentations });
      setStatus('saved');
    },
    onError: (caught) => {
      setStatus('error');
      // `VALIDATION_ERROR` bo'lsa — aniq slayd va maydon (`fields['slides_data.N.image_url']`).
      const fieldErrors = slideFieldErrors(caught);
      const first = fieldErrors[0];
      if (first) setActiveIndex(first.index);
      toast.error(
        first ? `${first.index + 1}-slayd saqlanmadi` : 'Saqlanmadi',
        {
          description: describeSaveError(
            caught,
            'Internet aloqasini tekshirib, "Saqlash" ni bosing.',
          ),
        },
      );
    },
  });

  const saveRef = React.useRef(save);
  saveRef.current = save;

  /** Har tahrirdan keyin — 800 ms debounce bilan `PATCH`. */
  const update = React.useCallback((next: Draft) => {
    setDraft(next);
    setStatus('dirty');
  }, []);

  // Asinxron amal (rasm yuklash) tugaganda eng so'nggi draft ustiga yozish uchun —
  // yuklash paytida o'qituvchi tahrirlashda davom etsa, o'zgarishlari yo'qolmasin.
  const draftRef = React.useRef<Draft | null>(draft);
  draftRef.current = draft;

  const [addingImage, setAddingImage] = React.useState(false);
  const imageInputRef = React.useRef<HTMLInputElement | null>(null);

  /** "Rasm" slaydi: avval rasm yuklanadi, keyin `IMAGE` slayd qo'shiladi (URLsiz IMAGE yaroqsiz). */
  const addImageSlide = React.useCallback(
    async (file: File) => {
      setAddingImage(true);
      try {
        const url = await uploadSlideImage(presentationId, file);
        if (url === null) return;
        const current = draftRef.current;
        if (!current) return;
        if (current.slides.length >= MAX_SLIDES) {
          toast.error(`Taqdimotda ko’pi bilan ${MAX_SLIDES} ta slayd bo’ladi`);
          return;
        }
        const slides = reindex([
          ...current.slides,
          {
            index: current.slides.length,
            type: 'IMAGE',
            title: null,
            image_url: url,
            // Ataylab bo'sh: fayl nomi yaxshi tavsif emas — o'qituvchi o'zi yozadi
            // (bo'sh bo'lsa saqlash to'xtaydi va sababi ko'rsatiladi).
            alt: '',
            notes: null,
            source: { kind: 'UPLOAD', page: null },
          },
        ]);
        update({ ...current, slides });
        setActiveIndex(slides.length - 1);
        toast.success('Rasm qo’shildi — alt matnni yozing');
      } finally {
        setAddingImage(false);
      }
    },
    [presentationId, update],
  );

  React.useEffect(() => {
    if (status !== 'dirty' || !draft) return;
    if (hasIssues || !metaValid) {
      setStatus('blocked');
      return;
    }
    const timer = window.setTimeout(() => {
      saveRef.current.mutate(draft);
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [status, draft, hasIssues, metaValid]);

  // Xato tuzatilgach avtosaqlash qayta yoqiladi.
  React.useEffect(() => {
    if (status === 'blocked' && !hasIssues && metaValid) setStatus('dirty');
  }, [status, hasIssues, metaValid]);

  // Saqlanmagan o'zgarish bilan sahifani tashlab ketmaslik.
  const unsaved = status === 'dirty' || status === 'saving' || status === 'blocked' || status === 'error';
  React.useEffect(() => {
    if (!unsaved) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [unsaved]);

  if (presentationQuery.isPending) {
    return <LoadingState label="Prezentatsiya yuklanmoqda…" />;
  }
  if (presentationQuery.isError) {
    return (
      <ErrorState
        error={presentationQuery.error}
        onRetry={() => void presentationQuery.refetch()}
      />
    );
  }
  if (!draft) {
    return <LoadingState label="Tahrirlash tayyorlanmoqda…" />;
  }

  const activeSlide = draft.slides[activeIndex] ?? null;
  const activeIssues = issuesBySlide[activeIndex] ?? [];

  const setSlides = (slides: Slide[], nextActive?: number): void => {
    const reindexed = reindex(slides);
    update({ ...draft, slides: reindexed });
    if (nextActive !== undefined) {
      setActiveIndex(clamp(nextActive, 0, Math.max(0, reindexed.length - 1)));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Meta + saqlash holati */}
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-3 md:flex-row md:items-end">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor="presentation-title" required>
            Prezentatsiya sarlavhasi
          </Label>
          <Input
            id="presentation-title"
            value={draft.title}
            invalid={draft.title.trim().length === 0}
            onChange={(event) => update({ ...draft, title: event.target.value })}
          />
        </div>
        <div className="flex gap-3">
          <div className="flex w-24 flex-col gap-1.5">
            <Label htmlFor="presentation-module" required>
              Modul
            </Label>
            <Input
              id="presentation-module"
              type="number"
              min={1}
              value={draft.moduleNumber}
              invalid={!Number.isFinite(moduleNumber) || moduleNumber < 1}
              onChange={(event) => update({ ...draft, moduleNumber: event.target.value })}
            />
          </div>
          <div className="flex w-24 flex-col gap-1.5">
            <Label htmlFor="presentation-lesson" required>
              Dars
            </Label>
            <Input
              id="presentation-lesson"
              type="number"
              min={1}
              value={draft.lessonNumber}
              invalid={!Number.isFinite(lessonNumber) || lessonNumber < 1}
              onChange={(event) => update({ ...draft, lessonNumber: event.target.value })}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <SaveIndicator status={status} />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={save.isPending}
            disabled={hasIssues || !metaValid}
            onClick={() => save.mutate(draft)}
          >
            <Save aria-hidden />
            Saqlash
          </Button>
        </div>
      </div>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void addImageSlide(file);
        }}
      />

      {/* Uch panel: ro'yxat · tahrir · preview */}
      <div className="grid gap-4 md:grid-cols-[17rem_minmax(0,1fr)] studio:grid-cols-[17rem_minmax(0,1fr)_minmax(0,26rem)]">
        <SlideListPanel
          slides={draft.slides}
          activeIndex={activeIndex}
          issueCountByIndex={issueCountByIndex}
          onSelect={setActiveIndex}
          addingImage={addingImage}
          onAdd={(type) => {
            if (draft.slides.length >= MAX_SLIDES) return;
            if (type === 'IMAGE') {
              imageInputRef.current?.click();
              return;
            }
            const next = [...draft.slides, emptySlide(type, draft.slides.length)];
            setSlides(next, next.length - 1);
          }}
          onDuplicate={(index) => {
            const source = draft.slides[index];
            if (!source || draft.slides.length >= MAX_SLIDES) return;
            const copy: Slide = { ...source };
            const next = [...draft.slides];
            next.splice(index + 1, 0, copy);
            setSlides(next, index + 1);
          }}
          onDelete={(index) => {
            const next = draft.slides.filter((_, i) => i !== index);
            setSlides(next, Math.min(index, Math.max(0, next.length - 1)));
          }}
          onMove={(from, to) => {
            if (from === to) return;
            const next = [...draft.slides];
            const [moved] = next.splice(from, 1);
            if (!moved) return;
            next.splice(to, 0, moved);
            setSlides(next, to);
          }}
          className="md:row-span-2 md:max-h-[70dvh] studio:row-span-1 studio:max-h-[78dvh]"
        />

        <div className="min-w-0 rounded-2xl border border-border bg-surface p-4">
          {activeSlide ? (
            <SlideEditor
              key={`${activeIndex}-${activeSlide.type}`}
              presentationId={presentationId}
              slide={activeSlide}
              issues={activeIssues}
              onChange={(nextSlide) => {
                const next = draft.slides.map((slide, index) =>
                  index === activeIndex ? nextSlide : slide,
                );
                setSlides(next);
              }}
            />
          ) : (
            <EmptyState
              title="Slayd yo’q"
              description="Chapdagi tugmalardan slayd turini tanlab qo’shing: MARKDOWN, CODE yoki QUIZ."
            />
          )}
        </div>

        <SlidePreview
          slide={activeSlide}
          className="min-w-0 md:col-start-2 md:max-h-[70dvh] studio:col-start-3 studio:row-start-1 studio:max-h-[78dvh]"
        />
      </div>
    </div>
  );
}

/* ---------------------------- saqlash indikatori -------------------------- */

function SaveIndicator({ status }: { status: SaveStatus }) {
  const config: Record<SaveStatus, { text: string; icon: React.ReactNode; className: string }> = {
    clean: { text: 'O’zgarish yo’q', icon: null, className: 'text-muted' },
    dirty: { text: 'Saqlanmoqda…', icon: <Loader2 className="size-3.5 animate-spin" aria-hidden />, className: 'text-muted' },
    saving: { text: 'Saqlanmoqda…', icon: <Loader2 className="size-3.5 animate-spin" aria-hidden />, className: 'text-muted' },
    saved: { text: 'Saqlandi', icon: <Check className="size-3.5" aria-hidden />, className: 'text-success' },
    error: { text: 'Saqlanmadi', icon: <CloudOff className="size-3.5" aria-hidden />, className: 'text-danger' },
    blocked: {
      text: 'Xato bor — saqlanmadi',
      icon: <AlertTriangle className="size-3.5" aria-hidden />,
      className: 'text-danger',
    },
  };
  const { text, icon, className } = config[status];

  return (
    <p
      className={cn('flex shrink-0 items-center gap-1.5 text-xs font-medium', className)}
      role="status"
      aria-live="polite"
    >
      {icon}
      {text}
    </p>
  );
}
