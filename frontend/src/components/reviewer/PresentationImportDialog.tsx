'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useDropzone, type FileRejection } from 'react-dropzone';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  AlertTriangle,
  ArrowRight,
  FileText,
  FileUp,
  ImageOff,
  Info,
  RotateCcw,
  ShieldAlert,
  Square,
  Upload,
} from 'lucide-react';

import type { PptxImportOut, Slide } from '@/types/api';
import { MAX_PPTX_MB, MAX_SLIDES, MAX_SLIDE_TITLE_CHARS } from '@/types/api';
import { isApiError } from '@/lib/api';
import { errorText, formatBytes } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import {
  createPresentation,
  deletePresentation,
  importPptx,
  updatePresentation,
} from '@/lib/resources';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { toast } from '@/components/ui/toast';
import {
  PDF_MAX_PAGES,
  buildPdfImageSlides,
  destroyPdf,
  importPdfPages,
  openPdf,
  type PdfPageState,
} from '@/components/reviewer/pdfImport';
import { describeSaveError } from '@/components/reviewer/slideErrors';

/* --------------------------------- yordamchi -------------------------------- */

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const MAX_PPTX_BYTES = MAX_PPTX_MB * 1024 * 1024;

type FileKind = 'pdf' | 'pptx';

function fileKind(file: File): FileKind | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.pptx')) return 'pptx';
  return null;
}

/** `Dars 3 - Funksiyalar.pdf` → `Dars 3 - Funksiyalar`. */
function titleFromFileName(name: string): string {
  const base = name.replace(/\.(pdf|pptx)$/i, '').trim();
  return (base.length > 0 ? base : 'Yangi taqdimot').slice(0, MAX_SLIDE_TITLE_CHARS);
}

function describeError(error: unknown, fallback: string): string {
  if (isApiError(error)) return errorText(error.code, error.message);
  if (error instanceof Error && error.message.length > 0) return error.message;
  return fallback;
}

/** pdf.js ochish xatolari → o'zbekcha. */
function describePdfOpenError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'PasswordException') {
    return 'PDF parol bilan himoyalangan. Parolsiz nusxasini yuklang.';
  }
  if (name === 'InvalidPDFException') {
    return 'Fayl yaroqli PDF emas yoki buzilgan.';
  }
  return `PDF ni ochib bo’lmadi: ${describeError(error, 'noma’lum xato')}. Brauzeringiz eskirgan bo’lishi mumkin — yangilab ko’ring.`;
}

/** Slayd `index` i massivdagi o'rniga teng bo'lishi shart (CONTRACTS §3). */
function reindex(slides: Slide[]): Slide[] {
  return slides.map((slide, index) => (slide.index === index ? slide : { ...slide, index }));
}

/** PPTX oldindan ko'rishda bitta qatorga sig'adigan matn. */
function slideSummary(slide: Slide): string {
  if (slide.type === 'MARKDOWN') {
    const line = slide.content
      .split('\n')
      .map((item) => item.replace(/^[#\-*\s]+/, '').trim())
      .find((item) => item.length > 0);
    return line ?? 'Matn yo’q';
  }
  return slide.type;
}

/* ---------------------------------- holat ---------------------------------- */

type Step =
  | { kind: 'select' }
  | { kind: 'reading'; fileName: string; percent: number | null }
  | { kind: 'pdf-ready'; fileName: string; fileSize: number; pageCount: number }
  | { kind: 'pdf-running' }
  | { kind: 'pdf-result' }
  | { kind: 'pptx-preview'; fileName: string; result: PptxImportOut }
  | { kind: 'pptx-saving' };

/** PDF jarayoni yakunidagi "yarim taqdimot" taqdiri — foydalanuvchiga ochiq aytiladi. */
type CleanupNote = 'none' | 'deleted' | 'delete-failed';

export interface PresentationImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "Taqdimot yuklash" — CONTRACTS.md §16.2.
 *
 * - **PDF** brauzerda sahifama-sahifa rasmga aylanadi va `IMAGE` slaydlar bo'ladi
 *   (server PDF ni ko'rmaydi). Tartib MAJBURIY: `POST /presentations` → rasmlar → `PATCH`.
 * - **PPTX** serverda faqat matnga aylanadi; natija SAQLANMASDAN oldindan ko'rsatiladi,
 *   ogohlantirishlar ochiq panelda, o'qituvchi tasdiqlagach yaratiladi.
 */
export function PresentationImportDialog({ open, onOpenChange }: PresentationImportDialogProps) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [step, setStep] = React.useState<Step>({ kind: 'select' });
  const [selectError, setSelectError] = React.useState<string | null>(null);

  const [title, setTitle] = React.useState('');
  const [moduleNumber, setModuleNumber] = React.useState('1');
  const [lessonNumber, setLessonNumber] = React.useState('1');

  // PDF jarayoni holati.
  const docRef = React.useRef<PDFDocumentProxy | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const presentationIdRef = React.useRef<string | null>(null);
  const pageUrlsRef = React.useRef<Map<number, string>>(new Map());
  const [pageStates, setPageStates] = React.useState<PdfPageState[]>([]);
  const [fatalMessage, setFatalMessage] = React.useState<string | null>(null);
  const [storageMissing, setStorageMissing] = React.useState(false);
  const [cleanupNote, setCleanupNote] = React.useState<CleanupNote>('none');
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [savedPresentationId, setSavedPresentationId] = React.useState<string | null>(null);
  const [cancelled, setCancelled] = React.useState(false);

  const running = step.kind === 'pdf-running' || step.kind === 'reading' || step.kind === 'pptx-saving';

  /* ------------------------------ tozalash ------------------------------- */

  const releaseDoc = React.useCallback(() => {
    const doc = docRef.current;
    docRef.current = null;
    if (doc) destroyPdf(doc);
  }, []);

  const reset = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    releaseDoc();
    presentationIdRef.current = null;
    pageUrlsRef.current = new Map();
    setStep({ kind: 'select' });
    setSelectError(null);
    setPageStates([]);
    setFatalMessage(null);
    setStorageMissing(false);
    setCleanupNote('none');
    setSaveError(null);
    setSavedPresentationId(null);
    setCancelled(false);
    setTitle('');
    setModuleNumber('1');
    setLessonNumber('1');
  }, [releaseDoc]);

  // Komponent yopilsa/ketsa — uchishdagi so'rovlar va PDF xotirasi bo'shatiladi.
  React.useEffect(
    () => () => {
      abortRef.current?.abort();
      releaseDoc();
    },
    [releaseDoc],
  );

  const handleOpenChange = (next: boolean): void => {
    // Jarayon paytida yopish — yarim holat qoldiradi; avval "Bekor qilish" kerak.
    if (!next && running) {
      toast.info('Jarayon davom etmoqda', { description: 'Avval “Bekor qilish” ni bosing.' });
      return;
    }
    if (!next) reset();
    onOpenChange(next);
  };

  /* ------------------------------ fayl tanlash --------------------------- */

  const acceptFile = React.useCallback(
    async (file: File) => {
      setSelectError(null);
      const kind = fileKind(file);
      if (kind === null) {
        setSelectError(`${file.name} — faqat .pdf yoki .pptx fayl qabul qilinadi.`);
        return;
      }
      setTitle(titleFromFileName(file.name));

      if (kind === 'pptx') {
        // Klientda tekshiramiz (tez javob uchun), lekin yakuniy hakam — server.
        if (file.size > MAX_PPTX_BYTES) {
          setSelectError(
            `PPTX hajmi ${formatBytes(file.size)} — ko’pi bilan ${MAX_PPTX_MB} MB. To’liq vizual import uchun PDF ga eksport qilib yuklang.`,
          );
          return;
        }
        const controller = new AbortController();
        abortRef.current = controller;
        setStep({ kind: 'reading', fileName: file.name, percent: 0 });
        try {
          const result = await importPptx(file, {
            signal: controller.signal,
            onProgress: (percent) =>
              setStep((current) =>
                current.kind === 'reading' ? { ...current, percent } : current,
              ),
          });
          setStep({ kind: 'pptx-preview', fileName: file.name, result });
        } catch (error) {
          setStep({ kind: 'select' });
          if (!(isApiError(error) && error.code === 'ABORTED')) {
            setSelectError(describeError(error, 'PPTX ni o’qib bo’lmadi.'));
          }
        } finally {
          abortRef.current = null;
        }
        return;
      }

      // PDF — faqat brauzerda ochiladi (sahifalar sonini bilish uchun).
      setStep({ kind: 'reading', fileName: file.name, percent: null });
      releaseDoc();
      try {
        const doc = await openPdf(file);
        if (doc.numPages > PDF_MAX_PAGES) {
          destroyPdf(doc);
          setStep({ kind: 'select' });
          setSelectError(
            `PDF da ${doc.numPages} sahifa — ko’pi bilan ${PDF_MAX_PAGES} ta. Faylni bo’laklarga ajratib yuklang.`,
          );
          return;
        }
        if (doc.numPages === 0) {
          destroyPdf(doc);
          setStep({ kind: 'select' });
          setSelectError('PDF da sahifa yo’q.');
          return;
        }
        docRef.current = doc;
        setStep({
          kind: 'pdf-ready',
          fileName: file.name,
          fileSize: file.size,
          pageCount: doc.numPages,
        });
      } catch (error) {
        setStep({ kind: 'select' });
        setSelectError(describePdfOpenError(error));
      }
    },
    [releaseDoc],
  );

  const onDrop = React.useCallback(
    (accepted: File[], rejections: FileRejection[]) => {
      const picked = accepted[0];
      if (picked) {
        void acceptFile(picked);
        return;
      }
      const rejected = rejections[0];
      if (rejected) {
        setSelectError(`${rejected.file.name} — faqat bitta .pdf yoki .pptx fayl qabul qilinadi.`);
      }
    },
    [acceptFile],
  );

  const { getRootProps, getInputProps, isDragActive, open: openPicker } = useDropzone({
    onDrop,
    multiple: false,
    // Sichqoncha uchun butun zona; klaviatura uchun alohida "Fayl tanlash" tugmasi bor.
    noClick: true,
    noKeyboard: true,
    accept: {
      'application/pdf': ['.pdf'],
      [PPTX_MIME]: ['.pptx'],
    },
    disabled: step.kind !== 'select',
  });

  /* ------------------------------ meta forma ----------------------------- */

  const moduleValue = Number.parseInt(moduleNumber, 10);
  const lessonValue = Number.parseInt(lessonNumber, 10);
  const metaValid =
    title.trim().length > 0 &&
    Number.isFinite(moduleValue) &&
    moduleValue >= 1 &&
    Number.isFinite(lessonValue) &&
    lessonValue >= 1;

  const metaFields = (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_6rem_6rem]">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="import-title" required>
          Taqdimot nomi
        </Label>
        <Input
          id="import-title"
          value={title}
          maxLength={MAX_SLIDE_TITLE_CHARS}
          invalid={title.trim().length === 0}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="import-module" required>
          Modul
        </Label>
        <Input
          id="import-module"
          type="number"
          min={1}
          value={moduleNumber}
          invalid={!Number.isFinite(moduleValue) || moduleValue < 1}
          onChange={(event) => setModuleNumber(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="import-lesson" required>
          Dars
        </Label>
        <Input
          id="import-lesson"
          type="number"
          min={1}
          value={lessonNumber}
          invalid={!Number.isFinite(lessonValue) || lessonValue < 1}
          onChange={(event) => setLessonNumber(event.target.value)}
        />
      </div>
    </div>
  );

  /* -------------------------------- PDF oqimi ----------------------------- */

  const updatePageState = React.useCallback((page: number, state: PdfPageState) => {
    if (state.state === 'done') pageUrlsRef.current.set(page, state.url);
    setPageStates((current) => {
      const next = [...current];
      next[page - 1] = state;
      return next;
    });
  }, []);

  /** Muvaffaqiyatli sahifalarni taqdimotga yozadi (`PATCH`). */
  const saveImportedSlides = React.useCallback(
    async (presentationId: string): Promise<boolean> => {
      setSaveError(null);
      try {
        await updatePresentation(presentationId, {
          slides_data: buildPdfImageSlides(pageUrlsRef.current),
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.presentations });
        void queryClient.invalidateQueries({ queryKey: queryKeys.presentation(presentationId) });
        setSavedPresentationId(presentationId);
        return true;
      } catch (error) {
        // `VALIDATION_ERROR` bo'lsa — aniq slayd va maydon (`slides_data.N.image_url`).
        setSaveError(describeSaveError(error, 'Slaydlarni saqlab bo’lmadi.'));
        return false;
      }
    },
    [queryClient],
  );

  /**
   * `pages` — yuklanadigan sahifalar (birinchi marta hammasi, qayta urinishda yiqilganlari).
   * Tartib: (1) taqdimot yaratiladi (yo'q bo'lsa), (2) rasmlar yuklanadi, (3) `PATCH`.
   */
  const runPdfImport = async (pages: number[]): Promise<void> => {
    const doc = docRef.current;
    if (!doc) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setStep({ kind: 'pdf-running' });
    setFatalMessage(null);
    setStorageMissing(false);
    setSaveError(null);
    setCancelled(false);
    setPageStates((current) => {
      const next =
        current.length === doc.numPages
          ? [...current]
          : Array.from({ length: doc.numPages }, (): PdfPageState => ({ state: 'pending' }));
      for (const page of pages) next[page - 1] = { state: 'pending' };
      return next;
    });

    // (1) Taqdimot — rasm yuklashdan OLDIN (asset endpointi taqdimot ID sini talab qiladi).
    let presentationId = presentationIdRef.current;
    if (presentationId === null) {
      try {
        const created = await createPresentation({
          title: title.trim(),
          module_number: moduleValue,
          lesson_number: lessonValue,
          slides_data: [],
        });
        presentationId = created.id;
        presentationIdRef.current = created.id;
        void queryClient.invalidateQueries({ queryKey: queryKeys.presentations });
      } catch (error) {
        abortRef.current = null;
        setFatalMessage(`Taqdimot yaratilmadi: ${describeError(error, 'noma’lum xato')}`);
        setStep({ kind: 'pdf-result' });
        return;
      }
    }

    // (2) Rasmlar.
    let fatal: unknown = null;
    try {
      await importPdfPages({
        doc,
        presentationId,
        pages,
        signal: controller.signal,
        onPageState: updatePageState,
      });
    } catch (error) {
      fatal = error;
    }
    abortRef.current = null;
    const wasCancelled = controller.signal.aborted && fatal === null;
    setCancelled(wasCancelled);

    if (fatal !== null) {
      const storage = isApiError(fatal) && fatal.code === 'STORAGE_NOT_CONFIGURED';
      setStorageMissing(storage);
      setFatalMessage(
        storage
          ? 'Rasm saqlash xizmati sozlanmagan, administratorga murojaat qiling.'
          : describeError(fatal, 'Import to’xtadi.'),
      );
    }

    // (3) Hech narsa yuklanmagan bo'lsa — bo'sh taqdimot ro'yxatda qolmasin.
    if (pageUrlsRef.current.size === 0) {
      try {
        await deletePresentation(presentationId);
        setCleanupNote('deleted');
      } catch {
        setCleanupNote('delete-failed');
      }
      presentationIdRef.current = null;
      void queryClient.invalidateQueries({ queryKey: queryKeys.presentations });
    } else {
      setCleanupNote('none');
      await saveImportedSlides(presentationId);
    }

    setStep({ kind: 'pdf-result' });
  };

  const cancelRun = (): void => {
    abortRef.current?.abort();
  };

  const doneCount = pageStates.filter((item) => item?.state === 'done').length;
  const failedPages = pageStates
    .map((item, index) => ({ page: index + 1, item }))
    .filter(({ item }) => item?.state === 'failed' || item?.state === 'cancelled');
  const totalPages = pageStates.length;

  /* ------------------------------- PPTX saqlash --------------------------- */

  const savePptx = async (result: PptxImportOut, fileName: string): Promise<void> => {
    setStep({ kind: 'pptx-saving' });
    try {
      const created = await createPresentation({
        title: title.trim(),
        module_number: moduleValue,
        lesson_number: lessonValue,
        slides_data: reindex(result.slides),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.presentations });
      queryClient.setQueryData(queryKeys.presentation(created.id), created);
      toast.success(`Taqdimot yaratildi · ${result.slides.length} slayd`);
      reset();
      onOpenChange(false);
      router.push(`/teacher/presentations/${created.id}/builder`);
    } catch (error) {
      setStep({ kind: 'pptx-preview', fileName, result });
      toast.error('Taqdimot saqlanmadi', {
        description: describeSaveError(error, 'Qayta urinib ko’ring.'),
      });
    }
  };

  const openBuilder = (presentationId: string): void => {
    reset();
    onOpenChange(false);
    router.push(`/teacher/presentations/${presentationId}/builder`);
  };

  /* ---------------------------------- render ----------------------------- */

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl" hideClose={running}>
        <DialogHeader>
          <DialogTitle>Taqdimot yuklash</DialogTitle>
          <DialogDescription>
            PDF — har sahifa rasm-slaydga aylanadi (fayl brauzeringizdan chiqmaydi). PPTX — faqat
            matn olinadi.
          </DialogDescription>
        </DialogHeader>

        {step.kind === 'select' ? (
          <div className="flex flex-col gap-3">
            <div
              {...getRootProps({
                className: cn(
                  'flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors duration-150',
                  isDragActive ? 'border-primary bg-primary/[0.06]' : 'border-border bg-surface/60',
                ),
              })}
            >
              <input {...getInputProps()} />
              <div className="flex size-12 items-center justify-center rounded-full bg-fg/5 text-muted">
                <FileUp className="size-6" aria-hidden />
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-sm font-semibold text-fg">
                  {isDragActive ? 'Faylni shu yerga tashlang' : 'PDF yoki PPTX faylni shu yerga sudrang'}
                </p>
                <p className="text-xs text-muted">
                  PDF: ko’pi bilan {PDF_MAX_PAGES} sahifa · PPTX: ko’pi bilan {MAX_PPTX_MB} MB
                </p>
              </div>
              <Button type="button" variant="secondary" size="sm" onClick={openPicker}>
                <Upload aria-hidden />
                Fayl tanlash
              </Button>
            </div>

            {selectError ? (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/[0.06] p-3 text-sm text-danger"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{selectError}</span>
              </p>
            ) : null}

            <p className="flex items-start gap-2 text-xs text-muted">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                PPTX dan dizayn, rasm va animatsiya o’tmaydi. Taqdimot ko’rinishini saqlash uchun
                uni PowerPoint/Google Slides da PDF ga eksport qilib yuklang.
              </span>
            </p>
          </div>
        ) : null}

        {step.kind === 'reading' ? (
          <div className="flex flex-col gap-3 py-4" aria-live="polite">
            <p className="text-sm text-fg">
              <span className="font-medium">{step.fileName}</span>{' '}
              {step.percent === null ? 'ochilmoqda…' : `yuklanmoqda va o’qilmoqda… ${step.percent}%`}
            </p>
            <Progress value={step.percent ?? 30} className={cn(step.percent === null && 'animate-pulse')} />
            {/* PPTX yuklanishini to'xtatish mumkin; PDF ochish brauzerda bir zumda tugaydi. */}
            {step.percent !== null ? (
              <Button type="button" variant="ghost" size="sm" className="self-start" onClick={cancelRun}>
                <Square aria-hidden />
                Bekor qilish
              </Button>
            ) : null}
          </div>
        ) : null}

        {step.kind === 'pdf-ready' ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-2 p-3">
              <FileText className="size-5 shrink-0 text-primary" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-fg">{step.fileName}</p>
                <p className="text-xs text-muted">
                  {step.pageCount} sahifa · {formatBytes(step.fileSize)} → {step.pageCount} ta rasm-slayd
                </p>
              </div>
            </div>
            {metaFields}
            <p className="text-xs text-muted">
              Har sahifaning alt matni “N-sahifa” bo’ladi — keyin Slide Builder da tahrirlashingiz
              mumkin. Katta PDF bir necha daqiqa olishi mumkin.
            </p>
          </div>
        ) : null}

        {step.kind === 'pdf-running' || step.kind === 'pdf-result' ? (
          <PdfProgressPanel
            pageStates={pageStates}
            doneCount={doneCount}
            totalPages={totalPages}
            running={step.kind === 'pdf-running'}
          />
        ) : null}

        {step.kind === 'pdf-result' ? (
          <div className="flex flex-col gap-3">
            {fatalMessage ? (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/[0.06] p-3 text-sm text-danger"
              >
                <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{fatalMessage}</span>
              </div>
            ) : null}

            {cleanupNote === 'deleted' ? (
              <p className="text-xs text-muted">
                Hech bir sahifa yuklanmagani uchun bo’sh taqdimot o’chirildi — ro’yxatda keraksiz
                yozuv qolmadi.
              </p>
            ) : null}
            {cleanupNote === 'delete-failed' ? (
              <p role="alert" className="text-xs text-danger">
                Bo’sh taqdimot «{title.trim()}» yaratilgan edi, lekin uni o’chirib bo’lmadi.
                Prezentatsiyalar ro’yxatidan qo’lda o’chiring.
              </p>
            ) : null}

            {cancelled ? (
              <p className="text-sm text-muted">
                Import bekor qilindi.{' '}
                {doneCount > 0 ? `Tayyor bo’lgan ${doneCount} sahifa saqlandi.` : ''}
              </p>
            ) : null}

            {saveError ? (
              <div
                role="alert"
                className="flex flex-col gap-2 rounded-xl border border-danger/40 bg-danger/[0.06] p-3 text-sm text-danger"
              >
                <p className="font-semibold">Rasmlar yuklandi, lekin slaydlar saqlanmadi:</p>
                <p className="whitespace-pre-line">{saveError}</p>
                {presentationIdRef.current ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="self-start"
                    onClick={() => {
                      const id = presentationIdRef.current;
                      if (id) void saveImportedSlides(id);
                    }}
                  >
                    <RotateCcw aria-hidden />
                    Saqlashni qayta urinish
                  </Button>
                ) : null}
              </div>
            ) : null}

            {failedPages.length > 0 && !storageMissing ? (
              <div className="flex flex-col gap-2 rounded-xl border border-accent/40 bg-accent/[0.06] p-3">
                <p className="text-sm font-semibold text-fg">
                  {failedPages.length} ta sahifa yuklanmadi — qolganlari saqlangan
                </p>
                <div className="max-h-32 overflow-y-auto scrollbar-thin">
                  <ul className="flex flex-col gap-1 pr-2 text-xs">
                    {failedPages.map(({ page, item }) => (
                      <li key={page} className="text-muted">
                        <span className="font-semibold text-fg">{page}-sahifa:</span>{' '}
                        {item?.state === 'failed' ? item.message : 'bekor qilindi'}
                      </li>
                    ))}
                  </ul>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  onClick={() => void runPdfImport(failedPages.map(({ page }) => page))}
                >
                  <RotateCcw aria-hidden />
                  Yiqilganlarni qayta urinish
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {step.kind === 'pptx-preview' || step.kind === 'pptx-saving' ? (
          <PptxPreview
            result={step.kind === 'pptx-preview' ? step.result : null}
            metaFields={metaFields}
          />
        ) : null}

        <DialogFooter>
          {step.kind === 'pdf-ready' ? (
            <>
              <Button type="button" variant="ghost" onClick={reset}>
                Boshqa fayl
              </Button>
              <Button
                type="button"
                disabled={!metaValid}
                onClick={() =>
                  void runPdfImport(Array.from({ length: step.pageCount }, (_, i) => i + 1))
                }
              >
                <Upload aria-hidden />
                {step.pageCount} sahifani import qilish
              </Button>
            </>
          ) : null}

          {step.kind === 'pdf-running' ? (
            <Button type="button" variant="danger" onClick={cancelRun}>
              <Square aria-hidden />
              Bekor qilish
            </Button>
          ) : null}

          {step.kind === 'pdf-result' ? (
            <>
              <Button type="button" variant="ghost" onClick={reset}>
                Boshqa fayl
              </Button>
              {savedPresentationId ? (
                <Button type="button" onClick={() => openBuilder(savedPresentationId)}>
                  Taqdimotni ochish
                  <ArrowRight aria-hidden />
                </Button>
              ) : null}
            </>
          ) : null}

          {step.kind === 'pptx-preview' ? (
            <PptxConfirmButtons
              result={step.result}
              metaValid={metaValid}
              onBack={reset}
              onConfirm={() => void savePptx(step.result, step.fileName)}
            />
          ) : null}

          {step.kind === 'pptx-saving' ? (
            <Button type="button" loading disabled>
              Saqlanmoqda…
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------- PDF progress panel ---------------------------- */

const PAGE_CHIP_CLASS: Record<PdfPageState['state'], string> = {
  pending: 'border-border text-muted',
  rendering: 'border-primary/50 text-primary animate-pulse',
  uploading: 'border-primary text-primary animate-pulse',
  done: 'border-success/40 bg-success/[0.10] text-success',
  failed: 'border-danger/50 bg-danger/[0.08] text-danger',
  cancelled: 'border-dashed border-border text-muted',
};

const PAGE_STATE_LABEL: Record<PdfPageState['state'], string> = {
  pending: 'navbatda',
  rendering: 'chizilmoqda',
  uploading: 'yuklanmoqda',
  done: 'tayyor',
  failed: 'xato',
  cancelled: 'bekor qilindi',
};

function PdfProgressPanel({
  pageStates,
  doneCount,
  totalPages,
  running,
}: {
  pageStates: PdfPageState[];
  doneCount: number;
  totalPages: number;
  running: boolean;
}) {
  const active = pageStates.findIndex(
    (item) => item?.state === 'rendering' || item?.state === 'uploading',
  );
  const percent = totalPages > 0 ? Math.round((doneCount / totalPages) * 100) : 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-sm">
        <p className="font-medium text-fg" aria-live="polite">
          {running
            ? `Sahifa ${Math.min(doneCount + 1, totalPages)}/${totalPages} · ${doneCount} ta tayyor`
            : `${doneCount}/${totalPages} sahifa yuklandi`}
        </p>
        {running && active >= 0 ? (
          <span className="text-xs text-muted">
            {active + 1}-sahifa {PAGE_STATE_LABEL[pageStates[active]?.state ?? 'pending']}
          </span>
        ) : null}
      </div>
      <Progress
        value={percent}
        tone={doneCount === totalPages && totalPages > 0 ? 'success' : 'primary'}
        aria-label="Import jarayoni"
      />
      <ul className="flex flex-wrap gap-1" aria-label="Sahifalar holati">
        {pageStates.map((item, index) => {
          const state = item?.state ?? 'pending';
          return (
            <li
              key={index}
              title={`${index + 1}-sahifa: ${PAGE_STATE_LABEL[state]}`}
              className={cn(
                'flex h-6 min-w-6 items-center justify-center rounded-md border px-1 text-[10px] font-semibold tabular-nums',
                PAGE_CHIP_CLASS[state],
              )}
            >
              <span className="sr-only">{`${index + 1}-sahifa: ${PAGE_STATE_LABEL[state]}`}</span>
              <span aria-hidden>{index + 1}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ------------------------------- PPTX preview ------------------------------- */

function PptxPreview({
  result,
  metaFields,
}: {
  result: PptxImportOut | null;
  metaFields: React.ReactNode;
}) {
  if (!result) return null;
  const tooMany = result.slides.length > MAX_SLIDES;

  return (
    <div className="flex flex-col gap-4">
      {/* Ogohlantirishlar — HAR DOIM ochiq (accordion ichida emas): o'qituvchi nima
          yo'qolganini bilishi shart (§16.2). */}
      <section
        role="note"
        aria-label="Import ogohlantirishlari"
        className="flex flex-col gap-2 rounded-xl border border-accent/40 bg-accent/[0.08] p-3"
      >
        <p className="flex items-center gap-1.5 text-sm font-semibold text-fg">
          <AlertTriangle className="size-4 shrink-0 text-accent" aria-hidden />
          Nima o’tmadi
        </p>
        {result.warnings.length > 0 ? (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-fg">
            {result.warnings.map((warning, index) => (
              <li key={`warning-${index}`}>{warning}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg">
            Dizayn, rasm va animatsiya saqlanmaydi — faqat matn olinadi.
          </p>
        )}
        {result.skipped_images > 0 ? (
          <p className="flex items-center gap-1.5 text-sm text-fg">
            <ImageOff className="size-4 shrink-0 text-accent" aria-hidden />
            <span>
              <span className="font-semibold">{result.skipped_images} ta rasm</span> o’tkazib
              yuborildi.
            </span>
          </p>
        ) : null}
      </section>

      {metaFields}

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          Oldindan ko’rish · {result.slides.length} slayd
        </p>
        {result.slides.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-3 text-sm text-muted">
            PPTX dan matn topilmadi. Rasmli taqdimot bo’lsa, PDF ga eksport qilib yuklang.
          </p>
        ) : (
          <div
            className="max-h-64 overflow-y-auto rounded-xl border border-border scrollbar-thin"
            tabIndex={0}
            aria-label="PPTX slaydlari ro’yxati"
          >
            <ol className="flex flex-col divide-y divide-border">
              {result.slides.map((slide, index) => (
                <li key={`pptx-${index}`} className="flex items-start gap-3 px-3 py-2">
                  <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">
                      {slide.title ?? 'Sarlavhasiz slayd'}
                    </p>
                    <p className="truncate text-xs text-muted">{slideSummary(slide)}</p>
                  </div>
                  <Badge variant="outline">{slide.type}</Badge>
                </li>
              ))}
            </ol>
          </div>
        )}
        {tooMany ? (
          <p role="alert" className="text-sm text-danger">
            {result.slides.length} ta slayd — taqdimotda ko’pi bilan {MAX_SLIDES} ta bo’ladi.
            Faylni bo’lib yuklang.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PptxConfirmButtons({
  result,
  metaValid,
  onBack,
  onConfirm,
}: {
  result: PptxImportOut;
  metaValid: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const empty = result.slides.length === 0;
  const tooMany = result.slides.length > MAX_SLIDES;
  return (
    <>
      <Button type="button" variant="ghost" onClick={onBack}>
        Bekor qilish
      </Button>
      <Button type="button" disabled={!metaValid || empty || tooMany} onClick={onConfirm}>
        Tasdiqlash va saqlash
        <ArrowRight aria-hidden />
      </Button>
    </>
  );
}
