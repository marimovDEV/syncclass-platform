'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import { AlertTriangle, BarChart3, ImagePlus, Info, Plus, RefreshCw, Trash2 } from 'lucide-react';

import type {
  CodeLang,
  CodeSlide,
  ImageSlide,
  MarkdownSlide,
  OpenSlide,
  PollSlide,
  QuizSlide,
  Slide,
} from '@/types/api';
import {
  CODE_LANGS,
  IMAGE_MAX_ALT_CHARS,
  MAX_OPTION_CHARS,
  MAX_QUESTION_CHARS,
  MAX_SLIDE_CONTENT_CHARS,
  MAX_SLIDE_NOTES_CHARS,
  MAX_SLIDE_TITLE_CHARS,
  OPEN_MAX_DURATION_SEC,
  OPEN_MAX_MAX_CHARS,
  OPEN_MIN_DURATION_SEC,
  OPEN_MIN_MAX_CHARS,
  POLL_MAX_DURATION_SEC,
  POLL_MAX_OPTIONS,
  POLL_MIN_DURATION_SEC,
  POLL_MIN_OPTIONS,
  QUIZ_MAX_DURATION_SEC,
  QUIZ_MAX_OPTIONS,
  QUIZ_MAX_POINTS,
  QUIZ_MIN_DURATION_SEC,
  QUIZ_MIN_OPTIONS,
} from '@/types/api';
import { isApiError } from '@/lib/api';
import { errorText } from '@/lib/format';
import { uploadPresentationAsset } from '@/lib/resources';
import { clamp, cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useTheme } from '@/components/shared/ThemeToggle';
import { SLIDE_TYPE_LABEL } from './SlideListPanel';

/** AUDIT.md §G2 — Monaco faqat `next/dynamic` + `ssr:false`. */
const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.default), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />,
});

const MONACO_LANGUAGE: Record<CodeLang, string> = {
  python: 'python',
  sql: 'sql',
  javascript: 'javascript',
  html: 'html',
  css: 'css',
  bash: 'shell',
};

/** Raqamli inputni butun songa aylantiradi (bo'sh/yaroqsiz bo'lsa `fallback`). */
function parseIntOr(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Bo'sh matn → `null` (backend `title`/`notes` ni `string | null` deb kutadi). */
function emptyToNull(value: string): string | null {
  return value.length > 0 ? value : null;
}

export interface SlideEditorProps {
  presentationId: string;
  slide: Slide;
  /** Slaydni yangilash — builder sahifasidagi draft ga yoziladi. */
  onChange: (slide: Slide) => void;
  /** Shu slaydga tegishli validatsiya xatolari. */
  issues?: string[];
  className?: string;
}

/**
 * Tanlangan slaydning tahrirlash formasi (tur bo'yicha).
 * Turni o'zgartirish ATAYLAB yo'q (FUTURE.md #8): masalan QUIZ → POLL da to'g'ri javob
 * jimgina yo'qolardi. Boshqa tur kerak bo'lsa — yangi slayd qo'shiladi.
 */
export function SlideEditor({
  presentationId,
  slide,
  onChange,
  issues = [],
  className,
}: SlideEditorProps) {
  return (
    <div className={cn('flex min-h-0 flex-col gap-4', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{slide.index + 1}-slayd</Badge>
        <Badge variant="primary">{SLIDE_TYPE_LABEL[slide.type]}</Badge>
        <span className="text-xs text-muted">
          Turni o’zgartirib bo’lmaydi — boshqa tur kerak bo’lsa yangi slayd qo’shing.
        </span>
      </div>

      {issues.length > 0 ? (
        <div
          className="flex flex-col gap-1 rounded-xl border border-danger/40 bg-danger/[0.06] p-3"
          role="alert"
        >
          <p className="flex items-center gap-1.5 text-sm font-semibold text-danger">
            <AlertTriangle className="size-4" aria-hidden />
            Slayd saqlanmaydi — quyidagilarni tuzating
          </p>
          <ul className="list-disc pl-5 text-xs text-danger">
            {issues.map((issue, index) => (
              <li key={`issue-${index}`}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="slide-title">Slayd sarlavhasi</Label>
        <Input
          id="slide-title"
          value={slide.title ?? ''}
          maxLength={MAX_SLIDE_TITLE_CHARS}
          onChange={(event) => onChange({ ...slide, title: emptyToNull(event.target.value) })}
          placeholder="Ixtiyoriy"
        />
      </div>

      {slide.type === 'MARKDOWN' ? (
        <MarkdownSlideForm presentationId={presentationId} slide={slide} onChange={onChange} />
      ) : null}
      {slide.type === 'CODE' ? <CodeSlideForm slide={slide} onChange={onChange} /> : null}
      {slide.type === 'IMAGE' ? (
        <ImageSlideForm presentationId={presentationId} slide={slide} onChange={onChange} />
      ) : null}
      {slide.type === 'QUIZ' ? <QuizSlideForm slide={slide} onChange={onChange} /> : null}
      {slide.type === 'POLL' ? <PollSlideForm slide={slide} onChange={onChange} /> : null}
      {slide.type === 'OPEN' ? <OpenSlideForm slide={slide} onChange={onChange} /> : null}
    </div>
  );
}

/* --------------------------- rasm yuklash yordamchi ------------------------ */

/**
 * Bitta rasmni `POST /presentations/{id}/assets` ga yuklaydi va URL qaytaradi.
 * Xato bo'lsa toast ko'rsatadi va `null` qaytaradi (`STORAGE_NOT_CONFIGURED` ham shu yerda).
 */
export async function uploadSlideImage(
  presentationId: string,
  file: File,
): Promise<string | null> {
  if (!file.type.startsWith('image/')) {
    toast.error('Faqat rasm fayli yuklanadi', { description: `${file.name} — rasm emas.` });
    return null;
  }
  try {
    const { url } = await uploadPresentationAsset(presentationId, file);
    return url;
  } catch (caught) {
    toast.error('Rasmni yuklab bo’lmadi', {
      description: isApiError(caught)
        ? errorText(caught.code, caught.message)
        : 'Qayta urinib ko’ring.',
    });
    return null;
  }
}

function useImagePicker(onPick: (file: File) => void): {
  open: () => void;
  input: React.ReactNode;
} {
  const ref = React.useRef<HTMLInputElement | null>(null);
  return {
    open: () => ref.current?.click(),
    input: (
      <input
        ref={ref}
        type="file"
        accept="image/*"
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onPick(file);
        }}
      />
    ),
  };
}

/* -------------------------------- MARKDOWN -------------------------------- */

function MarkdownSlideForm({
  presentationId,
  slide,
  onChange,
}: {
  presentationId: string;
  slide: MarkdownSlide;
  onChange: (slide: Slide) => void;
}) {
  const [uploading, setUploading] = React.useState(false);

  /** AUDIT.md §H8 — slayd ichiga rasm `POST /presentations/{id}/assets` orqali. */
  const picker = useImagePicker((file) => {
    setUploading(true);
    void uploadSlideImage(presentationId, file)
      .then((url) => {
        if (url === null) return;
        onChange({ ...slide, content: `${slide.content}\n![${file.name}](${url})\n` });
        toast.success('Rasm matnga qo’shildi');
      })
      .finally(() => setUploading(false));
  });

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="slide-content" required>
            Markdown matni
          </Label>
          <Button type="button" variant="ghost" size="sm" loading={uploading} onClick={picker.open}>
            <ImagePlus aria-hidden />
            Rasm joylash
          </Button>
          {picker.input}
        </div>
        <Textarea
          id="slide-content"
          rows={14}
          className="font-mono text-xs"
          maxLength={MAX_SLIDE_CONTENT_CHARS}
          value={slide.content}
          onChange={(event) => onChange({ ...slide, content: event.target.value })}
          placeholder={'# Sarlavha\n\n- Birinchi fikr\n- Ikkinchi fikr'}
        />
        <p className="text-xs text-muted">
          Markdown qo’llanadi (GFM): sarlavhalar, ro’yxatlar, jadval, kod bloklari, rasm.
        </p>
      </div>

      <NotesField slide={slide} onChange={onChange} />
    </>
  );
}

/* ----------------------------------- CODE --------------------------------- */

function CodeSlideForm({
  slide,
  onChange,
}: {
  slide: CodeSlide;
  onChange: (slide: Slide) => void;
}) {
  const { preference } = useTheme();
  const prefersDark =
    preference === 'dark' ||
    (preference === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="slide-code-lang" required>
          Til
        </Label>
        <Select
          value={slide.code_lang}
          onValueChange={(next) => onChange({ ...slide, code_lang: next as CodeLang })}
        >
          <SelectTrigger id="slide-code-lang" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CODE_LANGS.map((lang) => (
              <SelectItem key={lang} value={lang}>
                {lang}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Boshlang’ich kod</Label>
        <div className="overflow-hidden rounded-xl border border-border">
          <MonacoEditor
            height="18rem"
            language={MONACO_LANGUAGE[slide.code_lang]}
            theme={prefersDark ? 'vs-dark' : 'light'}
            value={slide.starter_code}
            onChange={(next) => onChange({ ...slide, starter_code: next ?? '' })}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: 'var(--font-jetbrains-mono), monospace',
              tabSize: 4,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              automaticLayout: true,
              padding: { top: 10, bottom: 10 },
            }}
          />
        </div>
        <p className="text-xs text-muted">
          Jonli darsda shu kod boshlang’ich holat bo’ladi; o’qituvchi uni efirda tahrirlaydi.
        </p>
      </div>

      <NotesField slide={slide} onChange={onChange} />
    </>
  );
}

/* ----------------------------------- IMAGE -------------------------------- */

function ImageSlideForm({
  presentationId,
  slide,
  onChange,
}: {
  presentationId: string;
  slide: ImageSlide;
  onChange: (slide: Slide) => void;
}) {
  const [uploading, setUploading] = React.useState(false);
  const altMissing = slide.alt.trim().length === 0;

  const picker = useImagePicker((file) => {
    setUploading(true);
    void uploadSlideImage(presentationId, file)
      .then((url) => {
        if (url === null) return;
        // Almashtirilgan rasm endi PDF sahifasi emas — manba `UPLOAD`.
        onChange({ ...slide, image_url: url, source: { kind: 'UPLOAD', page: null } });
        toast.success('Rasm almashtirildi');
      })
      .finally(() => setUploading(false));
  });

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label>Rasm</Label>
          <Button type="button" variant="outline" size="sm" loading={uploading} onClick={picker.open}>
            <RefreshCw aria-hidden />
            Rasmni almashtirish
          </Button>
          {picker.input}
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-surface-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- R2 asset, o'lchami oldindan ma'lum emas */}
          <img
            src={slide.image_url}
            alt={slide.alt}
            className="max-h-72 w-full object-contain"
          />
        </div>
        {slide.source ? (
          <p className="text-xs text-muted">
            Manba: {slide.source.kind}
            {slide.source.page !== null ? ` · ${slide.source.page}-sahifa` : ''}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="slide-alt" required>
          Alt matn (rasm tavsifi)
        </Label>
        <Textarea
          id="slide-alt"
          rows={2}
          maxLength={IMAGE_MAX_ALT_CHARS}
          value={slide.alt}
          invalid={altMissing}
          aria-describedby="slide-alt-help"
          onChange={(event) => onChange({ ...slide, alt: event.target.value })}
          placeholder="Masalan: Python ro’yxat metodlari jadvali"
        />
        <p
          id="slide-alt-help"
          className={cn('flex justify-between gap-2 text-xs', altMissing ? 'text-danger' : 'text-muted')}
        >
          <span>
            {altMissing
              ? 'Alt matn majburiy — usiz taqdimot saqlanmaydi. Ko’rishida nuqsoni bor o’quvchi rasmni shu matn orqali “ko’radi”.'
              : 'Ekran o’quvchi dasturlar shu matnni o’qiydi.'}
          </span>
          <span className="shrink-0 tabular-nums">
            {slide.alt.length}/{IMAGE_MAX_ALT_CHARS}
          </span>
        </p>
      </div>

      <NotesField slide={slide} onChange={onChange} />
    </>
  );
}

/* ------------------------------- variantlar ------------------------------- */

interface OptionsEditorProps {
  options: string[];
  min: number;
  max: number;
  onChange: (options: string[], removedIndex: number | null) => void;
  /** Faqat QUIZ uchun: to'g'ri javob radiosi. POLL da `undefined` — radio umuman chizilmaydi. */
  correct?: { index: number; onSelect: (index: number) => void };
  legend: string;
}

/** QUIZ va POLL uchun umumiy variantlar muharriri. */
function OptionsEditor({ options, min, max, onChange, correct, legend }: OptionsEditorProps) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-fg">
        {legend} ({options.length}/{max})
      </legend>
      {options.map((option, index) => (
        <div key={`option-${index}`} className="flex items-center gap-2">
          {correct ? (
            <input
              type="radio"
              name="quiz-correct-option"
              checked={correct.index === index}
              onChange={() => correct.onSelect(index)}
              className="size-4 shrink-0 accent-success"
              aria-label={`${index + 1}-variant to’g’ri`}
            />
          ) : (
            <span className="w-4 shrink-0 text-center text-xs font-semibold text-muted" aria-hidden>
              {index + 1}
            </span>
          )}
          <Input
            value={option}
            maxLength={MAX_OPTION_CHARS}
            onChange={(event) =>
              onChange(
                options.map((item, i) => (i === index ? event.target.value : item)),
                null,
              )
            }
            placeholder={`${index + 1}-variant`}
            invalid={option.trim().length === 0}
            aria-label={`${index + 1}-variant matni`}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`${index + 1}-variantni o’chirish`}
            disabled={options.length <= min}
            onClick={() => onChange(options.filter((_, i) => i !== index), index)}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={options.length >= max}
        onClick={() => onChange([...options, ''], null)}
      >
        <Plus aria-hidden />
        Variant qo’shish
      </Button>
      {options.length >= max ? (
        <p className="text-xs text-muted">Ko’pi bilan {max} ta variant.</p>
      ) : null}
    </fieldset>
  );
}

function QuestionField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="slide-question" required>
        Savol
      </Label>
      <Textarea
        id="slide-question"
        rows={3}
        maxLength={MAX_QUESTION_CHARS}
        value={value}
        invalid={value.trim().length === 0}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

function DurationField({
  id,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} required>
        Vaqt (sekund) · {min}–{max}
      </Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        invalid={value < min || value > max}
        onChange={(event) => onChange(parseIntOr(event.target.value, min))}
      />
    </div>
  );
}

/* ----------------------------------- QUIZ --------------------------------- */

function QuizSlideForm({
  slide,
  onChange,
}: {
  slide: QuizSlide;
  onChange: (slide: Slide) => void;
}) {
  return (
    <>
      <QuestionField
        value={slide.question}
        onChange={(question) => onChange({ ...slide, question })}
        placeholder="Masalan: Python da ro’yxatga element qo’shadigan metod qaysi?"
      />

      <OptionsEditor
        legend="Variantlar · to’g’ri javobni belgilang"
        options={slide.options}
        min={QUIZ_MIN_OPTIONS}
        max={QUIZ_MAX_OPTIONS}
        correct={{
          index: slide.correct_option,
          onSelect: (index) => onChange({ ...slide, correct_option: index }),
        }}
        onChange={(options, removedIndex) => {
          let correct = slide.correct_option;
          if (removedIndex !== null) {
            if (correct === removedIndex) correct = 0;
            else if (correct > removedIndex) correct -= 1;
          }
          onChange({
            ...slide,
            options,
            correct_option: clamp(correct, 0, Math.max(0, options.length - 1)),
          });
        }}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <DurationField
          id="slide-duration"
          value={slide.duration_sec}
          min={QUIZ_MIN_DURATION_SEC}
          max={QUIZ_MAX_DURATION_SEC}
          onChange={(duration_sec) => onChange({ ...slide, duration_sec })}
        />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="slide-points" required>
            XP (ball) · 1–{QUIZ_MAX_POINTS}
          </Label>
          <Input
            id="slide-points"
            type="number"
            min={1}
            max={QUIZ_MAX_POINTS}
            value={slide.points}
            invalid={slide.points < 1 || slide.points > QUIZ_MAX_POINTS}
            onChange={(event) => onChange({ ...slide, points: parseIntOr(event.target.value, 1) })}
          />
          <p className="text-xs text-muted">
            XP serverda hisoblanadi: tez va to’g’ri javob ko’proq ball beradi (CONTRACTS §6).
          </p>
        </div>
      </div>
    </>
  );
}

/* ----------------------------------- POLL --------------------------------- */

function PollSlideForm({
  slide,
  onChange,
}: {
  slide: PollSlide;
  onChange: (slide: Slide) => void;
}) {
  return (
    <>
      {/* QUIZ dan asosiy farq — UI da aniq ko'rinsin. */}
      <p className="flex items-start gap-2 rounded-xl border border-primary/30 bg-primary/[0.06] p-3 text-sm text-fg">
        <BarChart3 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <span>
          <span className="font-semibold">Bu savol baholanmaydi, XP berilmaydi.</span> To’g’ri
          javob yo’q — o’quvchilar fikrini bilish uchun. Baholanadigan savol kerak bo’lsa “Quiz”
          slaydini qo’shing.
        </span>
      </p>

      <QuestionField
        value={slide.question}
        onChange={(question) => onChange({ ...slide, question })}
        placeholder="Masalan: Bugungi mavzu qanchalik tushunarli bo’ldi?"
      />

      <OptionsEditor
        legend="Variantlar"
        options={slide.options}
        min={POLL_MIN_OPTIONS}
        max={POLL_MAX_OPTIONS}
        onChange={(options) => onChange({ ...slide, options })}
      />

      <DurationField
        id="slide-poll-duration"
        value={slide.duration_sec}
        min={POLL_MIN_DURATION_SEC}
        max={POLL_MAX_DURATION_SEC}
        onChange={(duration_sec) => onChange({ ...slide, duration_sec })}
      />
    </>
  );
}

/* ----------------------------------- OPEN --------------------------------- */

function OpenSlideForm({
  slide,
  onChange,
}: {
  slide: OpenSlide;
  onChange: (slide: Slide) => void;
}) {
  const maxCharsInvalid = slide.max_chars < OPEN_MIN_MAX_CHARS || slide.max_chars > OPEN_MAX_MAX_CHARS;

  return (
    <>
      <p className="flex items-start gap-2 rounded-xl border border-border bg-surface-2 p-3 text-sm text-fg">
        <Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
        <span>
          <span className="font-semibold">Ochiq savol / so’z buluti.</span> Javoblar anonim —
          siz ham kim yozganini ko’rmaysiz. Baholanmaydi. Darsda nomaqbul javobni yashirishingiz
          mumkin.
        </span>
      </p>

      <QuestionField
        value={slide.question}
        onChange={(question) => onChange({ ...slide, question })}
        placeholder="Masalan: “Funksiya” so’zini bitta so’z bilan ta’riflang"
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <DurationField
          id="slide-open-duration"
          value={slide.duration_sec}
          min={OPEN_MIN_DURATION_SEC}
          max={OPEN_MAX_DURATION_SEC}
          onChange={(duration_sec) => onChange({ ...slide, duration_sec })}
        />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="slide-max-chars" required>
            Javob uzunligi (belgi) · {OPEN_MIN_MAX_CHARS}–{OPEN_MAX_MAX_CHARS}
          </Label>
          <Input
            id="slide-max-chars"
            type="number"
            min={OPEN_MIN_MAX_CHARS}
            max={OPEN_MAX_MAX_CHARS}
            value={slide.max_chars}
            invalid={maxCharsInvalid}
            onChange={(event) =>
              onChange({ ...slide, max_chars: parseIntOr(event.target.value, OPEN_MIN_MAX_CHARS) })
            }
          />
          <p className="text-xs text-muted">
            So’z buluti uchun qisqa javob yaxshiroq. Uzun javob serverda shu uzunlikka qirqiladi.
          </p>
        </div>
      </div>
    </>
  );
}

/* --------------------------------- eslatma -------------------------------- */

function NotesField({
  slide,
  onChange,
}: {
  slide: MarkdownSlide | CodeSlide | ImageSlide;
  onChange: (slide: Slide) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="slide-notes">O’qituvchi eslatmasi</Label>
      <Textarea
        id="slide-notes"
        rows={3}
        maxLength={MAX_SLIDE_NOTES_CHARS}
        value={slide.notes ?? ''}
        onChange={(event) => onChange({ ...slide, notes: emptyToNull(event.target.value) })}
        placeholder="O’quvchiga ko’rinmaydi — faqat siz uchun"
      />
    </div>
  );
}
