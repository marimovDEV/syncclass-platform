/**
 * SyncClass REST klienti — CONTRACTS.md §4.
 *
 * - `apiFetch<T>()` — tiplangan so'rov, `Authorization: Bearer` avtomatik qo'shiladi.
 * - 401 → `POST /auth/refresh` → so'rov BIR MARTA qayta yuboriladi (takroriy halqa yo'q).
 * - Xato formati har doim `{ detail: { code, message, fields } }` → `ApiError`.
 * - `apiUpload<T>()` — multipart yuklash, progress bilan (XHR, chunki `fetch` da
 *   upload progress yo'q). AUDIT.md §A3: 25 MB hard cap klientda ham tekshiriladi.
 */

import type { ApiErrorDetail, TokenPairOut } from '@/types/api';
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from '@/lib/tokens';

/* --------------------------------- bazalar -------------------------------- */

const RAW_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';
const RAW_WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8000';

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * `NEXT_PUBLIC_API_URL` ikki xil berilishi mumkin:
 *   `http://localhost:8000`          → `/api/v1` qo'shiladi
 *   `http://localhost/api/v1`        → shundayligicha ishlatiladi (devops Dockerfile shunday beradi)
 */
export const API_BASE_URL: string = (() => {
  const base = stripTrailingSlash(RAW_API_URL);
  return base.endsWith('/api/v1') ? base : `${base}/api/v1`;
})();

/**
 * WS prefiksi. `ws://host/ws` berilsa shundayligicha, `ws://host` berilsa `/ws` qo'shiladi.
 * To'liq xona URL i uchun `wsRoomUrl()` dan foydalaning.
 */
export const WS_BASE_URL: string = (() => {
  const base = stripTrailingSlash(RAW_WS_URL);
  return base.endsWith('/ws') ? base : `${base}/ws`;
})();

export const LIVEKIT_URL: string = process.env.NEXT_PUBLIC_LIVEKIT_URL ?? '';

/**
 * CONTRACTS.md §5 — `wss://{host}/ws/room/{pin_code}?ticket={one_time_ticket}`.
 * Ticket ni `POST /rooms/{pin}/ws-ticket` beradi (30 s, bir martalik).
 */
export function wsRoomUrl(pinCode: string, ticket: string): string {
  return `${WS_BASE_URL}/room/${encodeURIComponent(pinCode)}?ticket=${encodeURIComponent(ticket)}`;
}

/* --------------------------------- ApiError ------------------------------- */

/** Backend qaytargan `detail` ni tashiydi. `code` bo'yicha UI shoxlanadi. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields: Record<string, string>;

  constructor(status: number, detail: ApiErrorDetail) {
    super(detail.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = detail.code;
    this.fields = detail.fields ?? {};
  }

  /** Tarmoq uzilgan / backend ko'tarilmagan holat. */
  static network(message = 'Serverga ulana olmadik. Internet aloqasini tekshiring.'): ApiError {
    return new ApiError(0, { code: 'NETWORK_ERROR', message });
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.code === 'UNAUTHORIZED';
  }

  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Noma'lum javob tanasidan `detail` ni ehtiyotkorlik bilan ajratib oladi. */
function parseErrorDetail(status: number, body: unknown): ApiErrorDetail {
  if (typeof body === 'object' && body !== null && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string') {
      return { code: `HTTP_${status}`, message: detail };
    }
    if (typeof detail === 'object' && detail !== null) {
      const d = detail as Partial<ApiErrorDetail>;
      if (typeof d.code === 'string' && typeof d.message === 'string') {
        return { code: d.code, message: d.message, fields: d.fields };
      }
    }
  }
  return { code: `HTTP_${status}`, message: `Server xatosi (${status}).` };
}

/* ------------------------------ refresh oqimi ----------------------------- */

/** Bir vaqtda ko'p so'rov 401 olsa — refresh FAQAT bir marta ketadi. */
let refreshPromise: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  const refresh_token = getRefreshToken();
  if (!refresh_token) return false;

  if (refreshPromise) return refreshPromise;

  refreshPromise = (async (): Promise<boolean> => {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token }),
      });
      if (!response.ok) {
        clearTokens();
        return false;
      }
      const data = (await response.json()) as TokenPairOut;
      if (!data.access_token || !data.refresh_token) {
        clearTokens();
        return false;
      }
      setTokens(data.access_token, data.refresh_token);
      return true;
    } catch {
      // Tarmoq xatosi — tokenni o'chirmaymiz, keyingi urinishda qayta ko'riladi.
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/* --------------------------------- apiFetch ------------------------------- */

export interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  /** JSON ga aylantirilib yuboriladi (`FormData` bo'lsa shundayligicha ketadi). */
  body?: unknown;
  /** `?a=1&b=2` — `undefined`/`null` qiymatlar tashlab ketiladi. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** `Authorization` qo'shilmaydi (masalan `GET /auth/google/login`). */
  skipAuth?: boolean;
  /** Ichki: retry halqasini to'xtatish uchun. */
  _retried?: boolean;
}

function buildUrl(path: string, query?: ApiFetchOptions['query']): string {
  const url = `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * Asosiy so'rov funksiyasi.
 * @throws {ApiError} har qanday muvaffaqiyatsiz holatda.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { body, query, skipAuth, _retried, headers, ...rest } = options;

  const requestHeaders = new Headers(headers);
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;

  if (body !== undefined && !isFormData && !requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', 'application/json');
  }
  if (!requestHeaders.has('Accept')) {
    requestHeaders.set('Accept', 'application/json');
  }
  if (!skipAuth) {
    const token = getAccessToken();
    if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      ...rest,
      headers: requestHeaders,
      body: isFormData ? (body as FormData) : body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw ApiError.network();
  }

  // 401 → refresh → BIR MARTA qayta urinish.
  if (response.status === 401 && !skipAuth && !_retried) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return apiFetch<T>(path, { ...options, _retried: true });
    }
    clearTokens();
    throw new ApiError(401, {
      code: 'UNAUTHORIZED',
      message: 'Sessiya tugadi. Qaytadan kiring.',
    });
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    throw new ApiError(response.status, parseErrorDetail(response.status, parsed));
  }

  return parsed as T;
}

/* -------------------------------- apiUpload ------------------------------- */

export interface UploadOptions {
  /** 0..100 */
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

/**
 * Multipart yuklash (progress bilan). 401 bo'lsa refresh qilib bir marta qayta urinadi.
 * @throws {ApiError}
 */
export async function apiUpload<T>(
  path: string,
  formData: FormData,
  options: UploadOptions = {},
  _retried = false,
): Promise<T> {
  const token = getAccessToken();

  const result = await new Promise<{ status: number; text: string } | 'aborted'>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', buildUrl(path));
    xhr.setRequestHeader('Accept', 'application/json');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    if (options.onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          options.onProgress?.(Math.round((event.loaded / event.total) * 100));
        }
      };
    }

    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => reject(ApiError.network());
    xhr.ontimeout = () => reject(ApiError.network('Yuklash vaqti tugadi.'));
    xhr.onabort = () => resolve('aborted');

    if (options.signal) {
      if (options.signal.aborted) {
        xhr.abort();
      } else {
        options.signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
    }

    xhr.send(formData);
  });

  if (result === 'aborted') {
    throw new ApiError(0, { code: 'ABORTED', message: 'Yuklash bekor qilindi.' });
  }

  if (result.status === 401 && !_retried) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return apiUpload<T>(path, formData, options, true);
    clearTokens();
    throw new ApiError(401, { code: 'UNAUTHORIZED', message: 'Sessiya tugadi. Qaytadan kiring.' });
  }

  let parsed: unknown = null;
  if (result.text.length > 0) {
    try {
      parsed = JSON.parse(result.text) as unknown;
    } catch {
      parsed = null;
    }
  }

  if (result.status < 200 || result.status >= 300) {
    throw new ApiError(result.status, parseErrorDetail(result.status, parsed));
  }

  return parsed as T;
}
