'use client';

/**
 * `LiveCodeView` — o'quvchi va mobil uchun jonli kod ko'rinishi.
 *
 * AUDIT.md §G2: Monaco (~5 MB, virtual klaviatura muammosi) o'quvchiga **berilmaydi**.
 * Shu yerda **Shiki** read-only + `overflow-x-auto` ishlatiladi.
 *
 * ⚠️ AUDIT.md §F: `user-select:none` va context-menu ni o'chirish — **psixologik to'siq**,
 * xavfsizlik chorasi EMAS. Brauzerda nusxalashni to'liq to'sib bo'lmaydi (devtools,
 * screenshot, telefon kamerasi). Shuning uchun bu yerda hech qanday "himoya" da'vo
 * qilinmaydi; o'quvchiga ham shunday tushuntiriladi.
 */

import * as React from 'react';
import { Radio } from 'lucide-react';

import type { CodeCursor, CodeLang } from '@/types/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { useTheme } from '@/components/shared/ThemeToggle';
import { prefersDarkTheme, useHighlightedCode } from '@/components/live/shiki';

export interface LiveCodeViewProps {
  code: string;
  lang: CodeLang;
  /** O'qituvchi kursori — "hozir shu satrda" belgisi uchun. */
  cursor?: CodeCursor | null;
  title?: string;
  /** Jonli uzatish ketayotganini ko'rsatish (pulsatsiya). */
  live?: boolean;
  /** O'qituvchi o'z ekranida ko'rsa — nusxalash to'siqlari qo'llanmaydi. */
  allowSelect?: boolean;
  className?: string;
}

export function LiveCodeView({
  code,
  lang,
  cursor = null,
  title,
  live = false,
  allowSelect = false,
  className,
}: LiveCodeViewProps) {
  const { preference } = useTheme();
  const dark = prefersDarkTheme(preference);
  const { html, ready } = useHighlightedCode(code, lang, dark);

  const lineCount = React.useMemo(() => (code.length === 0 ? 0 : code.split('\n').length), [code]);

  return (
    <section
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface',
        className,
      )}
      aria-label={title ?? 'Jonli kod'}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {live ? (
            // Ataylab NURSIZ va pulsatsiyasiz: yagona yorqin LIVE nishoni xona sarlavhasida
            // (DESIGN_GLOW §1). Bu yerda faqat "kod uzatilyapti" degan tinch belgi.
            <Badge variant="accent">
              <Radio aria-hidden />
              Jonli kod
            </Badge>
          ) : null}
          <p className="truncate text-sm font-medium text-fg">{title ?? 'Jonli kod'}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-muted">
          <span className="rounded-md bg-fg/5 px-1.5 py-0.5 font-mono uppercase">{lang}</span>
          <span>{lineCount} satr</span>
          {cursor !== null ? (
            <span aria-label="O'qituvchi kursori">
              ⌁ {cursor.line}:{cursor.col}
            </span>
          ) : null}
        </div>
      </header>

      <div
        className={cn(
          'min-h-0 flex-1 overflow-auto scrollbar-thin',
          allowSelect ? '' : 'no-select',
        )}
        // Psixologik to'siq (AUDIT.md §F) — xavfsizlik emas.
        onContextMenu={allowSelect ? undefined : (event) => event.preventDefault()}
        onCopy={allowSelect ? undefined : (event) => event.preventDefault()}
      >
        {code.length === 0 ? (
          <p className="p-4 text-sm text-muted">
            O&apos;qituvchi hali kod yozmadi. Birinchi harf bosilishi bilan shu yerda paydo
            bo&apos;ladi.
          </p>
        ) : (
          <div
            className={cn(
              'w-full overflow-x-auto p-3 text-[13px] leading-relaxed',
              // Shiki chiqargan `<pre>`/`<code>` ni dizayn tokenlariga moslash.
              '[&_pre]:m-0 [&_pre]:min-w-max [&_pre]:!bg-transparent',
              '[&_code]:block [&_code]:whitespace-pre [&_code]:font-mono',
              '[&_.shiki-fallback_code]:text-fg',
              !ready && 'opacity-80',
            )}
            // Shiki HTML ni o'zi escape qiladi; fallback `plainCodeHtml` ham escape qilingan.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </section>
  );
}
