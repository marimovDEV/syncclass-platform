'use client';

/**
 * `LiveMonaco` — jonli kod muharriri, **faqat o'qituvchi studiyasida** (AUDIT.md §G2).
 *
 * - `next/dynamic` + `ssr:false` — ~5 MB bundle asosiy yukga tushmaydi.
 * - Har o'zgarish `LIVE_CODE_THROTTLE_MS` (50 ms) bilan **coalescing** qilinadi
 *   (AUDIT.md §B1: har harfni 30 klientga yuborish trafikni yoqadi).
 * - Kod `MAX_CODE_CHARS` (20 000) dan uzun bo'lsa qirqib yuboriladi — server ham shu limitda.
 * - `ROOM_STATE_SYNC` kelganda (reconnect) muharrir serverdagi holatga tenglashtiriladi,
 *   lekin kursor joyida qoladi.
 * - Muharrir **ichida** hotkey ishlamaydi: `.monaco-editor` `useHotkeys` da bloklangan (§G1).
 */

import * as React from 'react';
import dynamic from 'next/dynamic';
import type { OnChange, OnMount } from '@monaco-editor/react';

import type { CodeCursor, CodeLang, LiveCodePatchClientData } from '@/types/api';
import { LIVE_CODE_THROTTLE_MS, MAX_CODE_CHARS } from '@/types/api';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { useTheme } from '@/components/shared/ThemeToggle';
import { prefersDarkTheme } from '@/components/live/shiki';

type MonacoEditorInstance = Parameters<OnMount>[0];

const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.default), {
  ssr: false,
  loading: () => <Skeleton className="h-full min-h-48 w-full" />,
});

/** `CodeLang` (CONTRACTS.md §3) → Monaco til identifikatori. */
const MONACO_LANGUAGE: Record<CodeLang, string> = {
  python: 'python',
  sql: 'sql',
  javascript: 'javascript',
  html: 'html',
  css: 'css',
  bash: 'shell',
};

export interface LiveMonacoProps {
  lang: CodeLang;
  slideIndex: number;
  /** Muharrir ochilganda qo'yiladigan kod (slayd `starter_code` yoki serverdagi kod). */
  initialCode: string;
  /** Serverdagi joriy kod — `syncToken` o'zgarganda shunga tenglashtiriladi. */
  serverCode: string;
  /** `useLiveRoom.syncedAt` — har `ROOM_STATE_SYNC` da yangilanadi. */
  syncToken: number | null;
  /** Throttle dan o'tgan patch — `useRoomSocket.send('LIVE_CODE_PATCH', data)`. */
  onPatch: (data: LiveCodePatchClientData) => void;
  className?: string;
}

export function LiveMonaco({
  lang,
  slideIndex,
  initialCode,
  serverCode,
  syncToken,
  onPatch,
  className,
}: LiveMonacoProps) {
  const { preference } = useTheme();
  const dark = prefersDarkTheme(preference);

  const editorRef = React.useRef<MonacoEditorInstance | null>(null);
  const pendingRef = React.useRef<{ code: string; cursor?: CodeCursor } | null>(null);
  const lastSentAtRef = React.useRef(0);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const onPatchRef = React.useRef(onPatch);
  onPatchRef.current = onPatch;
  const slideIndexRef = React.useRef(slideIndex);
  slideIndexRef.current = slideIndex;

  const [length, setLength] = React.useState(initialCode.length);

  const flush = React.useCallback(() => {
    const pending = pendingRef.current;
    if (pending === null) return;
    pendingRef.current = null;
    lastSentAtRef.current = Date.now();
    onPatchRef.current({
      slide_index: slideIndexRef.current,
      code: pending.code.slice(0, MAX_CODE_CHARS),
      cursor: pending.cursor,
    });
  }, []);

  /** 50 ms coalescing: birinchi o'zgarish darhol, qolganlari oxirgi qiymat bilan. */
  const queuePatch = React.useCallback(
    (code: string, cursor?: CodeCursor) => {
      pendingRef.current = { code, cursor };
      const elapsed = Date.now() - lastSentAtRef.current;
      if (elapsed >= LIVE_CODE_THROTTLE_MS) {
        flush();
        return;
      }
      if (timerRef.current === null) {
        timerRef.current = setTimeout(
          () => {
            timerRef.current = null;
            flush();
          },
          LIVE_CODE_THROTTLE_MS - elapsed,
        );
      }
    },
    [flush],
  );

  React.useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const handleMount = React.useCallback<OnMount>((editor) => {
    editorRef.current = editor;
  }, []);

  const handleChange = React.useCallback<OnChange>(
    (value) => {
      const code = value ?? '';
      setLength(code.length);
      const position = editorRef.current?.getPosition() ?? null;
      queuePatch(
        code,
        position === null ? undefined : { line: position.lineNumber, col: position.column },
      );
    },
    [queuePatch],
  );

  // Reconnect dan keyin serverdagi holat bilan tenglashtirish (AUDIT.md §B2).
  React.useEffect(() => {
    if (syncToken === null) return;
    const editor = editorRef.current;
    if (editor === null) return;
    if (editor.getValue() === serverCode) return;
    const position = editor.getPosition();
    editor.setValue(serverCode);
    if (position !== null) editor.setPosition(position);
    setLength(serverCode.length);
  }, [syncToken, serverCode]);

  const tooLong = length > MAX_CODE_CHARS;

  return (
    <div className={cn('flex min-h-0 flex-col overflow-hidden rounded-xl border border-border', className)}>
      <div className="min-h-0 flex-1">
        <MonacoEditor
          height="100%"
          defaultLanguage={MONACO_LANGUAGE[lang]}
          language={MONACO_LANGUAGE[lang]}
          defaultValue={initialCode}
          theme={dark ? 'vs-dark' : 'light'}
          onMount={handleMount}
          onChange={handleChange}
          options={{
            minimap: { enabled: false },
            fontSize: 15,
            lineHeight: 24,
            fontFamily: 'var(--font-jetbrains-mono), monospace',
            tabSize: 4,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            automaticLayout: true,
            renderLineHighlight: 'line',
            smoothScrolling: true,
            cursorBlinking: 'smooth',
            padding: { top: 14, bottom: 14 },
          }}
        />
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-surface px-3 py-1.5 text-[11px] tabular-nums">
        <span className="text-muted">
          Jonli kod — o&apos;quvchilarga 50 ms da bir marta yuboriladi
        </span>
        <span className={tooLong ? 'font-medium text-danger' : 'text-muted'}>
          {length.toLocaleString('uz-UZ')} / {MAX_CODE_CHARS.toLocaleString('uz-UZ')} belgi
        </span>
      </div>
    </div>
  );
}
