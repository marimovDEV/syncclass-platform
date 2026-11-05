'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import { Send } from 'lucide-react';

import type { CodeLang } from '@/types/api';
import { CODE_LANGS, MAX_CODE_CHARS } from '@/types/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useTheme } from '@/components/shared/ThemeToggle';

/**
 * Monaco — AUDIT.md §G2: ~5 MB bundle, shuning uchun FAQAT `next/dynamic` + `ssr:false`.
 * Mobil uchun ham shu muharrir ishlatiladi, lekin `wordWrap` yoqilgan.
 */
const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.default), {
  ssr: false,
  loading: () => <Skeleton className="h-80 w-full" />,
});

/** Monaco tilining kontraktdagi `code_lang` ga mosligi. */
const MONACO_LANGUAGE: Record<CodeLang, string> = {
  python: 'python',
  sql: 'sql',
  javascript: 'javascript',
  html: 'html',
  css: 'css',
  bash: 'shell',
};

const DEFAULT_FILE_NAME: Record<CodeLang, string> = {
  python: 'main.py',
  sql: 'query.sql',
  javascript: 'main.js',
  html: 'index.html',
  css: 'styles.css',
  bash: 'run.sh',
};

export interface CodeSubmitEditorProps {
  onSubmit: (payload: { code: string; file_name: string }) => void;
  pending: boolean;
  disabled?: boolean;
  error?: string | null;
}

/** Ichki kod muharriri — `POST /homeworks/{id}/submit` ning JSON varianti. */
export function CodeSubmitEditor({
  onSubmit,
  pending,
  disabled = false,
  error,
}: CodeSubmitEditorProps) {
  const { preference } = useTheme();
  const [lang, setLang] = React.useState<CodeLang>('python');
  const [fileName, setFileName] = React.useState(DEFAULT_FILE_NAME.python);
  const [code, setCode] = React.useState('');

  const prefersDark =
    preference === 'dark' ||
    (preference === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);

  const tooLong = code.length > MAX_CODE_CHARS;
  const canSubmit = code.trim().length > 0 && fileName.trim().length > 0 && !tooLong;

  const changeLang = (next: string): void => {
    const value = next as CodeLang;
    setLang(value);
    // Fayl nomi hali tahrirlanmagan bo'lsa — tilga mos nomga o'tkazamiz.
    setFileName((current) =>
      (Object.values(DEFAULT_FILE_NAME) as string[]).includes(current)
        ? DEFAULT_FILE_NAME[value]
        : current,
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="code-lang">Til</Label>
          <Select value={lang} onValueChange={changeLang}>
            <SelectTrigger id="code-lang">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CODE_LANGS.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="code-file-name" required>
            Fayl nomi
          </Label>
          <Input
            id="code-file-name"
            value={fileName}
            className="font-mono"
            onChange={(event) => setFileName(event.target.value)}
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <MonacoEditor
          height="22rem"
          language={MONACO_LANGUAGE[lang]}
          theme={prefersDark ? 'vs-dark' : 'light'}
          value={code}
          onChange={(next) => setCode(next ?? '')}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: 'var(--font-jetbrains-mono), monospace',
            tabSize: 4,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            automaticLayout: true,
            renderLineHighlight: 'line',
            padding: { top: 12, bottom: 12 },
          }}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className={cn('text-xs tabular-nums', tooLong ? 'text-danger' : 'text-muted')}>
          {code.length.toLocaleString('uz-UZ')} / {MAX_CODE_CHARS.toLocaleString('uz-UZ')} belgi
        </p>
        {tooLong ? (
          <p className="text-xs text-danger">Kod juda uzun — faylga saqlab yuklang.</p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Button
        size="lg"
        disabled={!canSubmit || disabled}
        loading={pending}
        onClick={() => onSubmit({ code, file_name: fileName.trim() })}
      >
        <Send aria-hidden />
        Kodni topshirish
      </Button>
    </div>
  );
}
