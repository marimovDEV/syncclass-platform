'use client';

import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  BarChart3,
  CheckCircle2,
  Circle,
  Clock,
  EyeOff,
  GraduationCap,
  MessageSquareText,
  Trophy,
} from 'lucide-react';

import type { ImageSlide, OpenSlide, PollSlide, Slide } from '@/types/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';

/* ----------------------------- markdown render ---------------------------- */

/**
 * `@tailwindcss/typography` o'rnatilmagan, shuning uchun har bir element
 * dizayn tokenlari bilan qo'lda stillanadi (dark mode avtomatik ishlaydi).
 */
const MARKDOWN_COMPONENTS = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="mb-3 mt-0 text-2xl font-bold tracking-tight text-fg">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="mb-2 mt-5 text-xl font-semibold text-fg">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mb-2 mt-4 text-base font-semibold text-fg">{children}</h3>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="mb-3 text-sm leading-relaxed text-fg">{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="mb-3 list-disc pl-5 text-sm text-fg">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="mb-3 list-decimal pl-5 text-sm text-fg">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => <li className="mb-1">{children}</li>,
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-fg">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => <em className="italic">{children}</em>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="mb-3 border-l-2 border-primary/50 pl-3 text-sm italic text-muted">
      {children}
    </blockquote>
  ),
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-border" />,
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="mb-3 overflow-x-auto rounded-xl border border-border bg-surface-2 p-3 text-xs leading-relaxed text-fg scrollbar-thin">
      {children}
    </pre>
  ),
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const isBlock = typeof className === 'string' && className.startsWith('language-');
    if (isBlock) return <code className="font-mono">{children}</code>;
    return (
      <code className="rounded bg-fg/[0.07] px-1 py-0.5 font-mono text-[0.85em] text-fg">
        {children}
      </code>
    );
  },
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="mb-3 overflow-x-auto scrollbar-thin">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border border-border bg-surface-2 px-2 py-1 text-left font-semibold text-fg">
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border border-border px-2 py-1 text-fg">{children}</td>
  ),
  img: ({ src, alt }: { src?: string | Blob; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element -- slayd rasmi R2 dan keladi, o'lchami oldindan ma'lum emas
    <img
      src={typeof src === 'string' ? src : undefined}
      alt={alt ?? ''}
      className="mb-3 max-h-72 rounded-xl border border-border object-contain"
    />
  ),
};

export function MarkdownPreview({ content }: { content: string }) {
  if (content.trim().length === 0) {
    return <p className="text-sm italic text-muted">Matn kiritilmagan.</p>;
  }
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
      {content}
    </ReactMarkdown>
  );
}

/* ------------------------------- slayd preview ---------------------------- */

export interface SlidePreviewProps {
  slide: Slide | null;
  className?: string;
}

const TYPE_BADGE: Record<Slide['type'], 'primary' | 'accent' | 'success' | 'neutral'> = {
  MARKDOWN: 'primary',
  CODE: 'accent',
  QUIZ: 'success',
  IMAGE: 'neutral',
  POLL: 'primary',
  OPEN: 'primary',
};

/** Jonli preview — o'quvchi ekranidagi ko'rinishga yaqin, faqat o'qish uchun. */
export function SlidePreview({ slide, className }: SlidePreviewProps) {
  if (!slide) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-2xl border border-dashed border-border bg-surface/60 p-8 text-center',
          className,
        )}
      >
        <p className="text-sm text-muted">Slayd tanlanmagan.</p>
      </div>
    );
  }

  // `notes` faqat MARKDOWN/CODE/IMAGE da bor (QUIZ/POLL/OPEN sxemasida yo'q — `extra="forbid"`).
  const notes =
    slide.type === 'MARKDOWN' || slide.type === 'CODE' || slide.type === 'IMAGE'
      ? slide.notes
      : null;

  return (
    <div
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface',
        className,
      )}
      aria-label="Slayd preview"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Badge variant="outline">{slide.index + 1}-slayd</Badge>
        <Badge variant={TYPE_BADGE[slide.type]}>{slide.type}</Badge>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{slide.title ?? ''}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
        {slide.title ? (
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
            {slide.title}
          </p>
        ) : null}

        {slide.type === 'MARKDOWN' ? <MarkdownPreview content={slide.content} /> : null}

        {slide.type === 'CODE' ? (
          <div className="flex flex-col gap-2">
            <Badge variant="outline" className="self-start font-mono">
              {slide.code_lang}
            </Badge>
            <pre className="overflow-x-auto rounded-xl border border-border bg-surface-2 p-3 text-xs leading-relaxed text-fg scrollbar-thin">
              <code className="font-mono">
                {slide.starter_code.length > 0 ? slide.starter_code : '# Kod kiritilmagan'}
              </code>
            </pre>
          </div>
        ) : null}

        {slide.type === 'IMAGE' ? <ImagePreview slide={slide} /> : null}

        {slide.type === 'QUIZ' ? (
          <div className="flex flex-col gap-3">
            <p className="text-base font-semibold text-fg">
              {slide.question.trim().length > 0 ? slide.question : 'Savol kiritilmagan'}
            </p>
            <ul className="flex flex-col gap-2">
              {slide.options.map((option, index) => {
                const correct = index === slide.correct_option;
                return (
                  <li
                    key={`option-${index}`}
                    className={cn(
                      'flex items-center gap-2 rounded-xl border px-3 py-2 text-sm',
                      correct
                        ? 'border-success/40 bg-success/[0.08] text-fg'
                        : 'border-border bg-surface-2 text-fg',
                    )}
                  >
                    {correct ? (
                      <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
                    ) : (
                      <Circle className="size-4 shrink-0 text-muted" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1">
                      {option.trim().length > 0 ? option : `${index + 1}-variant bo’sh`}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <Badge variant="neutral">
                <Clock aria-hidden />
                {slide.duration_sec} s
              </Badge>
              <Badge variant="neutral">
                <Trophy aria-hidden />
                {slide.points} XP
              </Badge>
              <span>To’g’ri javob o’quvchiga faqat natijalar bosqichida ko’rinadi.</span>
            </div>
          </div>
        ) : null}

        {slide.type === 'POLL' ? <PollPreview slide={slide} /> : null}
        {slide.type === 'OPEN' ? <OpenPreview slide={slide} /> : null}

        {notes ? (
          <div className="mt-4 rounded-xl border border-dashed border-border bg-surface-2 p-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
              O’qituvchi eslatmasi (o’quvchiga ko’rinmaydi)
            </p>
            <p className="whitespace-pre-line text-sm text-muted">{notes}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------------------------- IMAGE --------------------------------- */

function ImagePreview({ slide }: { slide: ImageSlide }) {
  return (
    <figure className="flex flex-col gap-2">
      {/* `image_url` — faqat platformaning o'z asset URL i (backend tashqi URL ni 422 bilan rad etadi). */}
      {/* eslint-disable-next-line @next/next/no-img-element -- R2 asset, o'lchami oldindan ma'lum emas */}
      <img
        src={slide.image_url}
        alt={slide.alt}
        className="max-h-[60dvh] w-full rounded-xl border border-border bg-surface-2 object-contain"
      />
      <figcaption className="flex flex-wrap items-center gap-2 text-xs text-muted">
        {slide.alt.trim().length > 0 ? (
          <span>
            <span className="font-medium text-fg">Alt:</span> {slide.alt}
          </span>
        ) : (
          <span className="text-danger">Alt matn yo’q — saqlanmaydi.</span>
        )}
        {slide.source ? (
          <Badge variant="outline">
            {slide.source.kind}
            {slide.source.page !== null ? ` · ${slide.source.page}-sahifa` : ''}
          </Badge>
        ) : null}
      </figcaption>
    </figure>
  );
}

/* ---------------------------- POLL / OPEN namuna --------------------------- */

/**
 * "Namuna" belgisi — preview dagi raqamlar SOXTA ekanini aniq aytadi
 * (haqiqiy ovozlar/javoblar faqat jonli darsda keladi).
 */
function SampleTag() {
  return (
    <Badge variant="outline" className="border-dashed">
      namuna
    </Badge>
  );
}

function PreviewPane({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border bg-surface-2 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
        {icon}
        {title}
        <SampleTag />
      </p>
      {children}
    </div>
  );
}

/** Namuna taqsimot — deterministik (har render da sakramasin), faqat ko'rinish uchun. */
function sampleDistribution(count: number): number[] {
  const pattern = [12, 7, 4, 9, 3, 5];
  return Array.from({ length: count }, (_, index) => pattern[index % pattern.length] ?? 1);
}

function PollPreview({ slide }: { slide: PollSlide }) {
  const sample = sampleDistribution(slide.options.length);
  const total = sample.reduce((sum, value) => sum + value, 0);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-base font-semibold text-fg">
        {slide.question.trim().length > 0 ? slide.question : 'Savol kiritilmagan'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="neutral">
          <Clock aria-hidden />
          {slide.duration_sec} s
        </Badge>
        <Badge variant="outline">Baholanmaydi · XP yo’q</Badge>
      </div>

      <PreviewPane icon={<GraduationCap className="size-3.5" aria-hidden />} title="O’quvchi ekrani">
        <ul className="flex flex-col gap-1.5">
          {slide.options.map((option, index) => (
            <li
              key={`student-${index}`}
              className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg"
            >
              <Circle className="size-4 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                {option.trim().length > 0 ? option : `${index + 1}-variant bo’sh`}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">
          O’quvchi natijani faqat so’rovnoma yakunlangach ko’radi (olomonga ergashish bo’lmasin).
        </p>
      </PreviewPane>

      <PreviewPane icon={<BarChart3 className="size-3.5" aria-hidden />} title="O’qituvchi ekrani — jonli diagramma">
        <ul className="flex flex-col gap-1.5">
          {slide.options.map((option, index) => {
            const value = sample[index] ?? 0;
            const percent = total > 0 ? Math.round((value / total) * 100) : 0;
            return (
              <li key={`teacher-${index}`} className="flex flex-col gap-1">
                <span className="flex items-center justify-between gap-2 text-xs text-fg">
                  <span className="min-w-0 truncate">
                    {option.trim().length > 0 ? option : `${index + 1}-variant`}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted">
                    {value} · {percent}%
                  </span>
                </span>
                <Progress value={percent} tone="primary" className="h-1.5" aria-hidden />
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted">Raqamlar namuna — haqiqiy ovozlar darsda keladi.</p>
      </PreviewPane>
    </div>
  );
}

const SAMPLE_WORDS: { text: string; count: number }[] = [
  { text: 'funksiya', count: 9 },
  { text: 'tsikl', count: 6 },
  { text: 'o’zgaruvchi', count: 5 },
  { text: 'ro’yxat', count: 4 },
  { text: 'shart', count: 3 },
  { text: 'lug’at', count: 2 },
  { text: 'xato', count: 1 },
];

/** Hajm va rang faqat dizayn tokenlari / Tailwind shkalasidan. */
const WORD_SIZE = ['text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl', 'text-2xl'];
const WORD_TONE = ['text-primary', 'text-accent', 'text-success', 'text-fg'];

function OpenPreview({ slide }: { slide: OpenSlide }) {
  const maxCount = SAMPLE_WORDS.reduce((max, word) => Math.max(max, word.count), 1);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-base font-semibold text-fg">
        {slide.question.trim().length > 0 ? slide.question : 'Savol kiritilmagan'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="neutral">
          <Clock aria-hidden />
          {slide.duration_sec} s
        </Badge>
        <Badge variant="neutral">≤ {slide.max_chars} belgi</Badge>
        <Badge variant="outline">
          <EyeOff aria-hidden />
          Anonim
        </Badge>
      </div>

      <PreviewPane icon={<GraduationCap className="size-3.5" aria-hidden />} title="O’quvchi ekrani">
        <div className="flex flex-col gap-1">
          <div className="flex h-10 items-center rounded-xl border border-border bg-surface px-3 text-sm text-muted">
            Javobingizni yozing…
          </div>
          <p className="text-right text-[11px] tabular-nums text-muted">0 / {slide.max_chars}</p>
        </div>
        <p className="text-xs text-muted">
          Javob anonim: o’qituvchi ham kim yozganini ko’rmaydi.
        </p>
      </PreviewPane>

      <PreviewPane
        icon={<MessageSquareText className="size-3.5" aria-hidden />}
        title="O’qituvchi ekrani — so’z buluti"
      >
        <div className="flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1 py-2">
          {SAMPLE_WORDS.map((word, index) => {
            const sizeIndex = Math.min(
              WORD_SIZE.length - 1,
              Math.round((word.count / maxCount) * (WORD_SIZE.length - 1)),
            );
            return (
              <span
                key={word.text}
                className={cn(
                  'font-semibold',
                  WORD_SIZE[sizeIndex],
                  WORD_TONE[index % WORD_TONE.length],
                )}
              >
                {word.text}
              </span>
            );
          })}
        </div>
        <p className="text-xs text-muted">
          So’zlar namuna. Darsda nomaqbul javobni yashirish mumkin (moderatsiya).
        </p>
      </PreviewPane>
    </div>
  );
}

