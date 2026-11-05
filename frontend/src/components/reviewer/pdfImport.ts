/**
 * PDF import — CONTRACTS.md §16.2. **Hammasi brauzerda**: server PDF ni ko'rmaydi.
 *
 * Oqim: `pdf.js` sahifani `<= 1600 px` kenglikda canvas ga chizadi → WebP (yo'q bo'lsa PNG)
 * → mavjud `POST /presentations/{id}/assets` ga yuklanadi → URL `IMAGE` slaydga aylanadi.
 *
 * Xotira (8 GB RAM, 60 sahifa): sahifalar **ketma-ket** chiziladi, har canvas blob olingach
 * darhol bo'shatiladi (`width = height = 0`), bir vaqtda faqat `UPLOAD_CONCURRENCY` ta
 * siqilgan blob xotirada turadi. Hech qachon 60 ta bitmap birga turmaydi.
 */

import type { PDFDocumentProxy } from 'pdfjs-dist';

import type { ImageSlide } from '@/types/api';
import { isApiError } from '@/lib/api';
import { errorText } from '@/lib/format';
import { uploadPresentationAsset } from '@/lib/resources';

/** §16.2 — PDF importida sahifalar chegarasi. */
export const PDF_MAX_PAGES = 60;
/** §16.2 — sahifa kengligi chegarasi (px). */
export const PDF_RENDER_MAX_WIDTH = 1600;
/** Juda uzun sahifa (masalan plakat) bitmap ni shishirmasligi uchun. */
const PDF_RENDER_MAX_HEIGHT = 4000;
/** §16.2 — bir vaqtda yuklanadigan rasmlar soni. */
export const PDF_UPLOAD_CONCURRENCY = 3;
/** Har sahifa yuklanishi muvaffaqiyatsiz bo'lsa — 1 marta qayta urinish. */
const UPLOAD_RETRIES = 1;
const WEBP_QUALITY = 0.85;

/* ------------------------------ pdf.js yuklash ----------------------------- */

type PdfJsModule = typeof import('pdfjs-dist');

let pdfjsPromise: Promise<PdfJsModule> | null = null;

/**
 * `pdf.js` ni faqat kerak bo'lganda yuklaydi (~450 KB + ~1.2 MB worker) — sahifa
 * bundliga kirmaydi. Worker alohida fayl sifatida (`new URL(..., import.meta.url)`)
 * chiqariladi va asosiy oqimni bloklamaydi.
 */
export function loadPdfJs(): Promise<PdfJsModule> {
  if (pdfjsPromise === null) {
    pdfjsPromise = import('pdfjs-dist')
      .then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url,
        ).toString();
        return pdfjs;
      })
      .catch((error: unknown) => {
        // Keyingi urinishda qaytadan yuklash mumkin bo'lsin.
        pdfjsPromise = null;
        throw error;
      });
  }
  return pdfjsPromise;
}

/** PDF ni ochadi (fayl brauzer xotirasida, serverga ketmaydi). */
export async function openPdf(file: File): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  return pdfjs.getDocument({ data }).promise;
}

/**
 * PDF xotirasini va worker resurslarini bo'shatadi.
 * (pdf.js v6 da `destroy()` hujjatda emas, `loadingTask` da.)
 */
export function destroyPdf(doc: PDFDocumentProxy): void {
  void doc.loadingTask.destroy().catch(() => undefined);
}

/* --------------------------------- chizish -------------------------------- */

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Sahifani rasmga aylantirib bo’lmadi.'));
      },
      // WebP qo'llanmasa brauzer o'zi PNG qaytaradi — `blob.type` dan aniqlanadi.
      'image/webp',
      WEBP_QUALITY,
    );
  });
}

/** Bitta sahifani chizadi va siqilgan rasm qaytaradi. Canvas har holda bo'shatiladi. */
export async function renderPdfPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  signal: AbortSignal,
): Promise<Blob> {
  const page = await doc.getPage(pageNumber);
  const canvas = document.createElement('canvas');
  let renderTask: ReturnType<typeof page.render> | null = null;
  const onAbort = (): void => renderTask?.cancel();

  try {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(PDF_RENDER_MAX_WIDTH / base.width, PDF_RENDER_MAX_HEIGHT / base.height);
    const viewport = page.getViewport({ scale });
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));

    signal.addEventListener('abort', onAbort, { once: true });
    renderTask = page.render({ canvas, viewport });
    await renderTask.promise;
    if (signal.aborted) throw new DOMException('Bekor qilindi', 'AbortError');
    return await canvasToBlob(canvas);
  } finally {
    signal.removeEventListener('abort', onAbort);
    // Bitmap xotirasini darhol qaytarish (aks holda GC kutiladi).
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
  }
}

/* --------------------------------- yuklash -------------------------------- */

/** Butun importni to'xtatadigan xatolar (qolgan sahifalarni urinishning ma'nosi yo'q). */
export function isFatalImportError(error: unknown): boolean {
  if (!isApiError(error)) return false;
  if (error.code === 'STORAGE_NOT_CONFIGURED') return true;
  if (error.isAuthError) return true;
  return error.status === 403 || error.status === 404;
}

function isAbortError(error: unknown): boolean {
  if (isApiError(error)) return error.code === 'ABORTED';
  return error instanceof DOMException && error.name === 'AbortError';
}

async function uploadWithRetry(
  presentationId: string,
  file: File,
  signal: AbortSignal,
): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= UPLOAD_RETRIES; attempt += 1) {
    try {
      const { url } = await uploadPresentationAsset(presentationId, file, { signal });
      return url;
    } catch (error) {
      lastError = error;
      // Fatal yoki bekor qilingan bo'lsa qayta urinish befoyda.
      if (isFatalImportError(error) || isAbortError(error) || signal.aborted) throw error;
    }
  }
  throw lastError;
}

/* ------------------------------ sahifa holati ------------------------------ */

export type PdfPageState =
  | { state: 'pending' }
  | { state: 'rendering' }
  | { state: 'uploading' }
  | { state: 'done'; url: string }
  | { state: 'failed'; message: string }
  | { state: 'cancelled' };

function errorMessage(error: unknown): string {
  if (isApiError(error)) return errorText(error.code, error.message);
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'Noma’lum xato.';
}

export interface ImportPagesOptions {
  doc: PDFDocumentProxy;
  presentationId: string;
  /** 1 dan boshlanadigan sahifa raqamlari (qayta urinishda — faqat yiqilganlari). */
  pages: number[];
  signal: AbortSignal;
  onPageState: (page: number, state: PdfPageState) => void;
}

/**
 * Sahifalarni ketma-ket chizadi, `PDF_UPLOAD_CONCURRENCY` tagacha parallel yuklaydi.
 *
 * Bitta sahifa yiqilsa qolganlari davom etadi (qisman muvaffaqiyat) — sahifa `failed`
 * bo'lib belgilanadi. Fatal xato (`STORAGE_NOT_CONFIGURED`, sessiya tugashi, 403/404)
 * bo'lsa yangi sahifa boshlanmaydi, uchishdagilar to'xtatiladi va xato tashlanadi.
 * Tashqi `signal` bekor qilinsa qolgan sahifalar `cancelled` bo'ladi (xato tashlanmaydi).
 */
export async function importPdfPages({
  doc,
  presentationId,
  pages,
  signal,
  onPageState,
}: ImportPagesOptions): Promise<void> {
  const internal = new AbortController();
  const forwardAbort = (): void => internal.abort();
  if (signal.aborted) internal.abort();
  else signal.addEventListener('abort', forwardAbort, { once: true });

  const inFlight = new Set<Promise<void>>();
  let fatal: unknown = null;
  const started = new Set<number>();

  try {
    for (const pageNumber of pages) {
      while (inFlight.size >= PDF_UPLOAD_CONCURRENCY) {
        await Promise.race(inFlight);
      }
      if (internal.signal.aborted) break;

      started.add(pageNumber);
      onPageState(pageNumber, { state: 'rendering' });

      let blob: Blob;
      try {
        blob = await renderPdfPage(doc, pageNumber, internal.signal);
      } catch (error) {
        if (internal.signal.aborted || isAbortError(error)) {
          onPageState(pageNumber, { state: 'cancelled' });
          break;
        }
        onPageState(pageNumber, {
          state: 'failed',
          message: `Sahifani chizib bo’lmadi: ${errorMessage(error)}`,
        });
        continue;
      }

      const extension = blob.type === 'image/webp' ? 'webp' : 'png';
      const file = new File([blob], `sahifa-${pageNumber}.${extension}`, { type: blob.type });
      onPageState(pageNumber, { state: 'uploading' });

      const task: Promise<void> = uploadWithRetry(presentationId, file, internal.signal)
        .then((url) => onPageState(pageNumber, { state: 'done', url }))
        .catch((error: unknown) => {
          if (isFatalImportError(error)) {
            if (fatal === null) fatal = error;
            internal.abort();
            onPageState(pageNumber, { state: 'failed', message: errorMessage(error) });
          } else if (isAbortError(error) || internal.signal.aborted) {
            onPageState(pageNumber, { state: 'cancelled' });
          } else {
            onPageState(pageNumber, { state: 'failed', message: errorMessage(error) });
          }
        });
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    }

    await Promise.all(inFlight);
  } finally {
    signal.removeEventListener('abort', forwardAbort);
  }

  // Boshlanmay qolgan sahifalar (bekor qilish yoki fatal xato sababli).
  for (const pageNumber of pages) {
    if (!started.has(pageNumber)) onPageState(pageNumber, { state: 'cancelled' });
  }

  if (fatal !== null) throw fatal;
}

/** Muvaffaqiyatli sahifalardan `IMAGE` slaydlar (sahifa tartibida). `index` keyin qo'yiladi. */
export function buildPdfImageSlides(pageUrls: ReadonlyMap<number, string>): ImageSlide[] {
  return [...pageUrls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([page, url], index) => ({
      index,
      type: 'IMAGE',
      title: null,
      image_url: url,
      alt: `${page}-sahifa`,
      notes: null,
      source: { kind: 'PDF', page },
    }));
}
