'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import { Columns2, Download, FileCode2, PanelLeftClose, PanelLeftOpen, Scissors } from 'lucide-react';

import type { ExtractedFile, SubmissionOut } from '@/types/api';
import { isApiError } from '@/lib/api';
import { errorText, formatBytes, formatDateTime, SUBMISSION_STATUS_LABELS } from '@/lib/format';
import { getSubmissionDownloadUrl } from '@/lib/resources';
import { clamp, cn, fileExtension } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { EmptyState } from '@/components/shared/states';
import { useTheme } from '@/components/shared/ThemeToggle';
import { AiVerdictBadge } from '@/components/reviewer/AiVerdictBadge';
import { AiVerdictCard } from '@/components/reviewer/AiVerdictCard';
import { AppealNotice } from '@/components/reviewer/AppealNotice';
import { FileTreeSidebar } from '@/components/reviewer/FileTreeSidebar';
import { GradePanel } from '@/components/reviewer/GradePanel';

/** AUDIT.md §G2 — Monaco faqat `next/dynamic` + `ssr:false` bilan yuklanadi. */
const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.default), {
  ssr: false,
  loading: () => <Skeleton className="size-full" />,
});

type MonacoMount = NonNullable<React.ComponentProps<typeof MonacoEditor>['onMount']>;
type MonacoInstance = Parameters<MonacoMount>[0];

/** Fayl kengaytmasi → Monaco tili. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  py: 'python',
  pyw: 'python',
  sql: 'sql',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  json: 'json',
  md: 'markdown',
  sh: 'shell',
  bash: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  txt: 'plaintext',
  csv: 'plaintext',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  go: 'go',
  rb: 'ruby',
  php: 'php',
};

function monacoLanguage(path: string): string {
  return LANGUAGE_BY_EXTENSION[fileExtension(path)] ?? 'plaintext';
}

/** `student_name` `null` bo'lishi mumkin (o'quvchi o'chirilgan/join to'ldirilmagan). */
const UNKNOWN_STUDENT = 'Noma’lum o’quvchi';

const SPLIT_STORAGE_KEY = 'syncclass.reviewer.split';
const SPLIT_MIN = 35;
const SPLIT_MAX = 75;
const SPLIT_DEFAULT = 58;

function readStoredSplit(): number {
  try {
    const stored = window.localStorage.getItem(SPLIT_STORAGE_KEY);
    if (stored === null) return SPLIT_DEFAULT;
    const parsed = Number.parseFloat(stored);
    if (!Number.isFinite(parsed)) return SPLIT_DEFAULT;
    return clamp(parsed, SPLIT_MIN, SPLIT_MAX);
  } catch {
    return SPLIT_DEFAULT;
  }
}

function writeStoredSplit(value: number): void {
  try {
    window.localStorage.setItem(SPLIT_STORAGE_KEY, String(Math.round(value)));
  } catch {
    /* private rejimda localStorage yo'q — holat shunchaki saqlanmaydi */
  }
}

export interface SplitScreenIDEProps {
  submission: SubmissionOut;
  /** `homeworks.max_score`. */
  maxScore: number;
  /** `homeworks.ai_penalty_points`. */
  aiPenaltyPoints: number;
  /**
   * O'quvchi ismi. Berilmasa `submission.student_name` ishlatiladi
   * (backend tekis maydon yuboradi, `null` bo'lishi mumkin).
   */
  studentName?: string;
  onGraded?: (submission: SubmissionOut) => void;
  className?: string;
}

/**
 * Split-Screen IDE Reviewer.
 *
 * Chap: fayl daraxti + Monaco (**read-only**). O'ng: AI xulosasi, e'tiroz, baholash paneli.
 * Ajratgich sichqoncha/klaviatura bilan siljiydi, nisbat `localStorage` da (try/catch bilan).
 * Mobilda (`<768px`) ikki panel ustma-ust joylashadi.
 */
export function SplitScreenIDE({
  submission,
  maxScore,
  aiPenaltyPoints,
  studentName,
  onGraded,
  className,
}: SplitScreenIDEProps) {
  const { preference } = useTheme();
  const files = submission.extracted_files;

  const [activePath, setActivePath] = React.useState<string | null>(() => files[0]?.path ?? null);
  const [treeOpen, setTreeOpen] = React.useState(true);
  const [split, setSplit] = React.useState<number>(SPLIT_DEFAULT);
  const [dragging, setDragging] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const editorRef = React.useRef<MonacoInstance | null>(null);
  const pendingJumpRef = React.useRef<{ line: number; lineEnd: number } | null>(null);

  React.useEffect(() => {
    setSplit(readStoredSplit());
  }, []);

  // Submission o'zgarsa birinchi fayl ochiladi.
  const [syncedId, setSyncedId] = React.useState(submission.id);
  if (syncedId !== submission.id) {
    setSyncedId(submission.id);
    setActivePath(files[0]?.path ?? null);
  }

  const activeFile: ExtractedFile | null = React.useMemo(
    () => files.find((file) => file.path === activePath) ?? null,
    [files, activePath],
  );

  const evidencePaths = React.useMemo(
    () => new Set(submission.ai_evidence.map((item) => item.file)),
    [submission.ai_evidence],
  );

  /** Kutilayotgan sakrashni muharrirga qo'llaydi. */
  const applyJump = React.useCallback(() => {
    const editor = editorRef.current;
    const jump = pendingJumpRef.current;
    if (!editor || !jump) return;
    pendingJumpRef.current = null;
    editor.revealLineInCenter(jump.line);
    editor.setSelection({
      startLineNumber: jump.line,
      startColumn: 1,
      endLineNumber: Math.max(jump.line, jump.lineEnd),
      endColumn: 1,
    });
    editor.focus();
  }, []);

  /** Dalilga bosilganda: faylni ochadi va qatorga sakraydi. */
  const jumpToEvidence = React.useCallback(
    (file: string, lineStart: number, lineEnd: number) => {
      const target =
        files.find((item) => item.path === file) ??
        files.find((item) => item.path.endsWith(`/${file}`)) ??
        files.find((item) => item.path.split('/').pop() === file);

      if (!target) {
        toast.info('Bu fayl arxivdan chiqarilmagan', {
          description: `${file} — faylni yuklab olib tekshirishingiz mumkin.`,
        });
        return;
      }

      pendingJumpRef.current = { line: lineStart, lineEnd };
      if (target.path === activePath) {
        applyJump();
      } else {
        setActivePath(target.path);
      }
    },
    [files, activePath, applyJump],
  );

  // Fayl almashgach model yangilanadi — sakrash shundan keyin bajariladi.
  React.useEffect(() => {
    if (pendingJumpRef.current) applyJump();
  }, [activePath, applyJump]);

  /* ------------------------------ ajratgich ------------------------------- */

  const updateSplitFromClientX = React.useCallback((clientX: number) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0) return;
    const percent = ((clientX - rect.left) / rect.width) * 100;
    setSplit(clamp(percent, SPLIT_MIN, SPLIT_MAX));
  }, []);

  React.useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent): void => {
      event.preventDefault();
      updateSplitFromClientX(event.clientX);
    };
    const onUp = (): void => setDragging(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging, updateSplitFromClientX]);

  React.useEffect(() => {
    if (dragging) return;
    writeStoredSplit(split);
  }, [dragging, split]);

  /* ------------------------------ yuklab olish ---------------------------- */

  const download = async (): Promise<void> => {
    setDownloading(true);
    try {
      const { url } = await getSubmissionDownloadUrl(submission.id);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (caught) {
      toast.error('Yuklab olish havolasi olinmadi', {
        description: isApiError(caught)
          ? errorText(caught.code, caught.message)
          : 'Qayta urinib ko’ring.',
      });
    } finally {
      setDownloading(false);
    }
  };

  // CONTRACTS.md §11.1 — `is_late` serverda hisoblanadi, klient hisoblamaydi.
  const isLate = submission.is_late;
  const displayName = studentName ?? submission.student_name ?? UNKNOWN_STUDENT;

  const prefersDark =
    preference === 'dark' ||
    (preference === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);

  return (
    <div className={cn('flex min-h-0 flex-col gap-3', className)}>
      {/* Sarlavha qatori */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface px-3 py-2">
        <FileCode2 className="size-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-fg">
            {displayName} · <span className="font-mono">{submission.file_name}</span>
          </p>
          <p className="truncate text-xs text-muted">
            {formatBytes(submission.file_size_bytes)} · {submission.attempt_no}-urinish ·{' '}
            {formatDateTime(submission.submitted_at)}
          </p>
        </div>
        <Badge variant={submission.status === 'GRADED' ? 'success' : 'neutral'}>
          {SUBMISSION_STATUS_LABELS[submission.status]}
        </Badge>
        {isLate ? <Badge variant="accent">Kechikdi</Badge> : null}
        <AiVerdictBadge submission={submission} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setTreeOpen((open) => !open)}
          className="hidden md:inline-flex"
        >
          {treeOpen ? <PanelLeftClose aria-hidden /> : <PanelLeftOpen aria-hidden />}
          Fayllar
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={downloading}
          onClick={() => void download()}
        >
          <Download aria-hidden />
          Yuklab olish
        </Button>
      </div>

      {/* Ikki panel */}
      <div
        ref={containerRef}
        className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row md:gap-0"
        style={{ ['--reviewer-split' as string]: `${split}%` }}
      >
        {/* Chap: daraxt + Monaco */}
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface md:basis-[var(--reviewer-split)]">
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            {treeOpen ? (
              <FileTreeSidebar
                files={files}
                activePath={activePath}
                onSelect={setActivePath}
                extractTruncated={submission.extract_truncated}
                evidencePaths={evidencePaths}
                className="max-h-56 w-full shrink-0 border-b md:max-h-none md:w-56 md:border-b-0 md:border-r"
              />
            ) : null}

            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {activeFile ? (
                <>
                  <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
                      {activeFile.path}
                    </span>
                    {activeFile.truncated ? (
                      <Badge variant="accent">
                        <Scissors aria-hidden />
                        qirqilgan
                      </Badge>
                    ) : null}
                    <Badge variant="outline">faqat o’qish</Badge>
                  </div>
                  <div className="h-[52dvh] min-h-0 md:h-auto md:flex-1">
                    <MonacoEditor
                      key={activeFile.path}
                      height="100%"
                      language={monacoLanguage(activeFile.path)}
                      theme={prefersDark ? 'vs-dark' : 'light'}
                      value={activeFile.content}
                      onMount={(instance) => {
                        editorRef.current = instance;
                        if (pendingJumpRef.current) applyJump();
                      }}
                      options={{
                        readOnly: true,
                        domReadOnly: true,
                        minimap: { enabled: false },
                        fontSize: 13,
                        fontFamily: 'var(--font-jetbrains-mono), monospace',
                        lineNumbers: 'on',
                        scrollBeyondLastLine: false,
                        wordWrap: 'on',
                        automaticLayout: true,
                        renderLineHighlight: 'line',
                        contextmenu: false,
                        padding: { top: 10, bottom: 10 },
                      }}
                    />
                  </div>
                  {activeFile.truncated ? (
                    <p className="border-t border-accent/40 bg-accent/[0.08] px-3 py-1.5 text-xs text-accent">
                      Fayl juda uzun — qisqartirilgan. To’liq matn uchun arxivni yuklab oling.
                    </p>
                  ) : null}
                  {submission.extract_truncated ? (
                    <p className="border-t border-border bg-surface-2 px-3 py-1.5 text-xs text-muted">
                      Arxiv limitdan oshgani uchun ba’zi fayllar o’qilmagan (AUDIT §D6).
                    </p>
                  ) : null}
                </>
              ) : (
                <EmptyState
                  className="m-3"
                  title="Ko’rsatiladigan kod yo’q"
                  description="Arxivdan matn chiqmadi (binar fayl yoki limit oshgan). Faylni yuklab olib tekshiring."
                  icon={<FileCode2 aria-hidden />}
                  action={
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      loading={downloading}
                      onClick={() => void download()}
                    >
                      <Download aria-hidden />
                      Yuklab olish
                    </Button>
                  }
                />
              )}
            </div>
          </div>
        </div>

        {/* Ajratgich — faqat md+ da */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Panellar kengligini o’zgartirish"
          aria-valuenow={Math.round(split)}
          aria-valuemin={SPLIT_MIN}
          aria-valuemax={SPLIT_MAX}
          tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              setSplit((current) => clamp(current - 2, SPLIT_MIN, SPLIT_MAX));
            } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              setSplit((current) => clamp(current + 2, SPLIT_MIN, SPLIT_MAX));
            } else if (event.key === 'Home') {
              event.preventDefault();
              setSplit(SPLIT_DEFAULT);
            }
          }}
          className={cn(
            'group hidden w-3 shrink-0 cursor-col-resize items-center justify-center md:flex',
            'focus-visible:outline-none',
          )}
        >
          <span
            className={cn(
              'h-10 w-1 rounded-full bg-border transition-colors duration-150 group-hover:bg-primary',
              dragging ? 'bg-primary' : '',
            )}
          >
            <Columns2 className="sr-only" aria-hidden />
          </span>
        </div>

        {/* O'ng: AI + e'tiroz + baholash */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto scrollbar-thin md:pl-0">
          <AppealNotice
            appeal={submission.student_appeal}
            studentName={submission.student_name ?? studentName}
            at={submission.updated_at}
          />
          <AiVerdictCard submission={submission} onJumpToEvidence={jumpToEvidence} />
          <GradePanel
            submission={submission}
            maxScore={maxScore}
            aiPenaltyPoints={aiPenaltyPoints}
            isLate={isLate}
            onGraded={onGraded}
          />
        </div>
      </div>
    </div>
  );
}
