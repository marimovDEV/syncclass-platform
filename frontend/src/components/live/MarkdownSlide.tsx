'use client';

/**
 * `MARKDOWN` turidagi slayd (CONTRACTS.md §3).
 *
 * Kod bloklari **Shiki** bilan bo'yaladi (AUDIT.md §G2 — Monaco bu yerda ishlatilmaydi).
 * `react-markdown` HTML ni o'zi escape qiladi (`rehype-raw` ulanmagan), shuning uchun
 * slaydga yozilgan xom HTML bajarilmaydi.
 */

import * as React from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { MarkdownSlide as MarkdownSlideData } from '@/types/api';
import { cn } from '@/lib/utils';
import { useTheme } from '@/components/shared/ThemeToggle';
import { normalizeLang, prefersDarkTheme, useHighlightedCode } from '@/components/live/shiki';

/** Markdown ichidagi bitta kod bloki — Shiki bilan bo'yaladi. */
function CodeBlock({ code, lang }: { code: string; lang: string | null }) {
  const { preference } = useTheme();
  const dark = prefersDarkTheme(preference);
  const { html } = useHighlightedCode(code, normalizeLang(lang), dark);

  return (
    <div
      className={cn(
        'my-3 overflow-x-auto rounded-xl border border-border bg-surface p-3 text-[13px] leading-relaxed',
        '[&_pre]:m-0 [&_pre]:min-w-max [&_pre]:!bg-transparent',
        '[&_code]:block [&_code]:whitespace-pre [&_code]:font-mono',
        '[&_.shiki-fallback_code]:text-fg',
      )}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** `<pre>` dan kod matni va tilini ajratadi. */
function extractCode(children: React.ReactNode): { code: string; lang: string | null } | null {
  const first = React.Children.toArray(children)[0];
  if (!React.isValidElement<{ className?: string; children?: React.ReactNode }>(first)) return null;

  const className = typeof first.props.className === 'string' ? first.props.className : '';
  const match = /language-([\w+-]+)/.exec(className);
  const raw = React.Children.toArray(first.props.children)
    .map((part) => (typeof part === 'string' || typeof part === 'number' ? String(part) : ''))
    .join('');

  return { code: raw.replace(/\n$/, ''), lang: match?.[1] ?? null };
}

const MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }) => (
    <h1 className="mb-4 mt-2 text-3xl font-semibold tracking-tight text-fg split:text-4xl studio:text-5xl">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-3 mt-6 text-2xl font-semibold tracking-tight text-fg studio:text-3xl">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-5 text-xl font-semibold text-fg studio:text-2xl">{children}</h3>
  ),
  p: ({ children }) => <p className="my-3 leading-relaxed text-fg/90">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-6">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed text-fg/90">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-primary underline underline-offset-2"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-4 border-primary/40 bg-primary/5 py-2 pl-4 pr-3 text-fg/90">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-6 border-border" />,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-fg/5 px-3 py-2 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border px-3 py-2">{children}</td>,
  code: ({ children, className }) => (
    <code
      className={cn(
        'rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[0.9em] text-fg',
        className,
      )}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => {
    const extracted = extractCode(children);
    if (extracted === null) {
      return <pre className="my-3 overflow-x-auto rounded-xl bg-fg/5 p-3 font-mono">{children}</pre>;
    }
    return <CodeBlock code={extracted.code} lang={extracted.lang} />;
  },
};

export interface MarkdownSlideProps {
  slide: MarkdownSlideData;
  /** Mobil companion — shriftlar kichikroq, padding kam. */
  compact?: boolean;
  className?: string;
}

export function MarkdownSlide({ slide, compact = false, className }: MarkdownSlideProps) {
  return (
    <article
      className={cn(
        'mx-auto w-full max-w-4xl',
        compact ? 'px-3 py-4 text-sm' : 'px-6 py-8 text-base studio:text-lg',
        className,
      )}
    >
      {typeof slide.title === 'string' && slide.title.length > 0 ? (
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-primary">
          {slide.title}
        </p>
      ) : null}
      <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {slide.content}
      </Markdown>
    </article>
  );
}
