'use client';

/**
 * Shiki — o'quvchi/mobil uchun **read-only** sintaksis bo'yash (AUDIT.md §G2).
 *
 * Monaco (~5 MB) jonli xonada faqat o'qituvchi studiyasida ishlatiladi; o'quvchi tomonda
 * kod shu modul orqali HTML ga aylantiriladi.
 *
 * - `shiki/bundle/web` — to'liq bundle emas (`shiki` ildizi ~200 til), bizga kerak
 *   6 ta til (`CodeLang`) shu paketda bor.
 * - Highlighter **bir marta** yaratiladi va promise sifatida keshlanadi.
 * - Chunk yuklanmasa (offline) — xavfsiz `escapeHtml` fallback ishlaydi, UI yiqilmaydi.
 */

import { useEffect, useState } from 'react';

import type { CodeLang } from '@/types/api';

type WebHighlighter = Awaited<
  ReturnType<typeof import('shiki/bundle/web').createHighlighter>
>;

const SHIKI_THEMES = ['github-light', 'github-dark'] as const;

/** `CodeLang` (CONTRACTS.md §3) → shiki til nomi. */
const SHIKI_LANGS: readonly CodeLang[] = ['python', 'sql', 'javascript', 'html', 'css', 'bash'];

/** Markdown fence (` ```py `) nomlarini `CodeLang` ga keltiradi. */
const LANG_ALIASES: Record<string, CodeLang> = {
  python: 'python',
  py: 'python',
  python3: 'python',
  sql: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  psql: 'sql',
  javascript: 'javascript',
  js: 'javascript',
  node: 'javascript',
  html: 'html',
  css: 'css',
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
};

let highlighterPromise: Promise<WebHighlighter> | null = null;

function loadHighlighter(): Promise<WebHighlighter> {
  if (highlighterPromise === null) {
    // JavaScript regex dvigateli — wasm YO'Q. Oniguruma wasm yuklagichi
    // `Response.bytes()` ishlatadi, bu eskiroq brauzerlarda (Safari < 18.4,
    // Chrome < 128) `TypeError: .bytes is not a function` bilan yiqilardi va
    // kod slaydlari bo'yalmay qolardi. `forgiving: true` — JS dvigatelida
    // qo'llab-quvvatlanmagan nodir grammatika bo'lsa ham xato otmaydi.
    highlighterPromise = Promise.all([
      import('shiki/bundle/web'),
      import('shiki/engine/javascript'),
    ])
      .then(([shiki, engine]) =>
        shiki.createHighlighter({
          themes: [...SHIKI_THEMES],
          langs: [...SHIKI_LANGS],
          engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
        }),
      )
      .catch((error: unknown) => {
        // Keyingi urinish qayta yuklay olsin.
        highlighterPromise = null;
        throw error;
      });
  }
  return highlighterPromise;
}

export function normalizeLang(value: string | null | undefined): CodeLang | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return LANG_ALIASES[value.trim().toLowerCase()] ?? null;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Shiki ishlamasa ishlatiladigan xavfsiz HTML (matn escape qilinadi). */
export function plainCodeHtml(code: string): string {
  return `<pre class="shiki-fallback"><code>${escapeHtml(code)}</code></pre>`;
}

export async function highlightToHtml(
  code: string,
  lang: CodeLang,
  dark: boolean,
): Promise<string> {
  const highlighter = await loadHighlighter();
  return highlighter.codeToHtml(code, {
    lang,
    theme: dark ? 'github-dark' : 'github-light',
    transformers: [
      {
        // Shiki o'z `background-color` ini qo'yadi — biz dizayn tokenini ishlatamiz.
        pre(node) {
          node.properties.style = '';
          node.properties.tabindex = '-1';
        },
      },
    ],
  });
}

export interface HighlightedCode {
  /** Bo'yalgan yoki fallback HTML — har doim xavfsiz (escape qilingan). */
  html: string;
  /** Shiki yuklanib bo'ldi-mi (false — hozircha oddiy matn). */
  ready: boolean;
}

/**
 * Kodni bo'yab beradi. Kod har 50 ms da o'zgarishi mumkin (jonli kod), shuning uchun
 * natija har o'zgarishda qayta hisoblanadi, lekin highlighter qayta yaratilmaydi.
 */
export function useHighlightedCode(
  code: string,
  lang: CodeLang | null,
  dark: boolean,
): HighlightedCode {
  const [state, setState] = useState<HighlightedCode>(() => ({
    html: plainCodeHtml(code),
    ready: false,
  }));

  useEffect(() => {
    if (lang === null) {
      setState({ html: plainCodeHtml(code), ready: true });
      return;
    }

    let cancelled = false;
    highlightToHtml(code, lang, dark)
      .then((html) => {
        if (!cancelled) setState({ html, ready: true });
      })
      .catch(() => {
        if (!cancelled) setState({ html: plainCodeHtml(code), ready: false });
      });

    return () => {
      cancelled = true;
    };
  }, [code, lang, dark]);

  return state;
}

/** Monaco/shiki uchun "qorong'i tema kerakmi" — `useTheme()` tanlovidan hisoblanadi. */
export function prefersDarkTheme(preference: 'light' | 'dark' | 'system'): boolean {
  if (preference === 'dark') return true;
  if (preference === 'light') return false;
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
