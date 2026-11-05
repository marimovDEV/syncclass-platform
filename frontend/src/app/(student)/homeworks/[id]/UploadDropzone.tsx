'use client';

import * as React from 'react';
import { useDropzone, type FileRejection } from 'react-dropzone';
import { FileUp, Paperclip, UploadCloud, X } from 'lucide-react';

import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from '@/types/api';
import { formatBytes } from '@/lib/format';
import { cn, fileExtension } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

/** Ruxsat etilgan kengaytmalar (AUDIT.md §A4 — whitelist). */
export const ALLOWED_EXTENSIONS = [
  'zip',
  'py',
  'sql',
  'js',
  'ts',
  'jsx',
  'tsx',
  'html',
  'css',
  'sh',
  'json',
  'md',
  'txt',
  'ipynb',
  'csv',
] as const;

export interface UploadDropzoneProps {
  onSubmit: (file: File) => void;
  /** 0..100 — yuklash davom etayotganda. */
  progress: number | null;
  disabled?: boolean;
  /** Tashqi xato matni (server javobi). */
  error?: string | null;
}

/**
 * Drag & Drop yuklash maydoni.
 * Klient tomonda: 25 MB cheklov (`MAX_UPLOAD_MB`) + kengaytma validatsiyasi.
 * Server tomoni ham tekshiradi — bu faqat tez qaytariladigan UX himoyasi.
 */
export function UploadDropzone({ onSubmit, progress, disabled = false, error }: UploadDropzoneProps) {
  const [file, setFile] = React.useState<File | null>(null);
  const [localError, setLocalError] = React.useState<string | null>(null);

  const uploading = progress !== null;

  const onDrop = React.useCallback((accepted: File[], rejections: FileRejection[]) => {
    setLocalError(null);

    if (rejections.length > 0) {
      const first = rejections[0];
      const code = first?.errors[0]?.code;
      if (code === 'file-too-large') {
        setLocalError(`Fayl juda katta. Maksimal hajm — ${MAX_UPLOAD_MB} MB.`);
      } else if (code === 'too-many-files') {
        setLocalError('Bir vaqtda faqat bitta fayl yuklanadi.');
      } else {
        setLocalError('Bu fayl turi qabul qilinmaydi.');
      }
      return;
    }

    const picked = accepted[0];
    if (!picked) return;

    const extension = fileExtension(picked.name);
    if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(extension)) {
      setLocalError(
        `“.${extension || '?'}” qabul qilinmaydi. Ruxsat etilgan: ${ALLOWED_EXTENSIONS.join(', ')}.`,
      );
      return;
    }
    if (picked.size > MAX_UPLOAD_BYTES) {
      setLocalError(`Fayl juda katta (${formatBytes(picked.size)}). Maksimal — ${MAX_UPLOAD_MB} MB.`);
      return;
    }

    setFile(picked);
  }, []);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    maxFiles: 1,
    maxSize: MAX_UPLOAD_BYTES,
    multiple: false,
    disabled: disabled || uploading,
    noClick: true,
    noKeyboard: true,
  });

  const shownError = localError ?? error ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div
        {...getRootProps()}
        className={cn(
          'flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border bg-surface/60 px-6 py-10 text-center transition-colors duration-150',
          isDragActive && 'border-primary bg-primary/[0.06]',
          (disabled || uploading) && 'opacity-60',
        )}
      >
        <input {...getInputProps()} />
        <span className="flex size-12 items-center justify-center rounded-full bg-primary/15 text-primary">
          <UploadCloud className="size-6" aria-hidden />
        </span>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-fg">
            {isDragActive ? 'Faylni shu yerga qo’yib yuboring' : 'Faylni bu yerga tashlang'}
          </p>
          <p className="text-xs text-muted">
            Maksimal {MAX_UPLOAD_MB} MB · {ALLOWED_EXTENSIONS.slice(0, 6).join(', ')} va boshqalar
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={open} disabled={disabled || uploading}>
          <FileUp aria-hidden />
          Fayl tanlash
        </Button>
      </div>

      {file ? (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3">
          <Paperclip className="size-4 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-fg">{file.name}</p>
            <p className="text-xs text-muted">{formatBytes(file.size)}</p>
          </div>
          {uploading ? null : (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Faylni olib tashlash"
              onClick={() => setFile(null)}
            >
              <X aria-hidden />
            </Button>
          )}
        </div>
      ) : null}

      {uploading ? (
        <div className="flex flex-col gap-1.5">
          <Progress value={progress ?? 0} />
          <p className="text-xs tabular-nums text-muted">Yuklanmoqda… {progress ?? 0}%</p>
        </div>
      ) : null}

      {shownError ? (
        <p role="alert" className="text-sm text-danger">
          {shownError}
        </p>
      ) : null}

      <Button
        size="lg"
        disabled={file === null || disabled}
        loading={uploading}
        onClick={() => {
          if (file) onSubmit(file);
        }}
      >
        Vazifani topshirish
      </Button>
    </div>
  );
}
