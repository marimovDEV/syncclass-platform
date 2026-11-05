/**
 * Xom slayd JSONB → `Slide[]` (CONTRACTS.md §3, §16.1).
 *
 * `POST /rooms/{pin}/join` javobidagi `slides` (§5.5) va `GET /presentations/{id}` dagi
 * `slides_data` — ikkisi ham shu sxemadagi massiv. Bu modul ularni **ishonchsiz ma'lumot**
 * sifatida qabul qiladi (§13.13): `type` diskriminatori yoki majburiy maydoni to'g'ri
 * kelmagan element tashlab yuboriladi (AUDIT.md §D5 — noto'g'ri slayd frontendni
 * yiqitmasligi kerak), qolgani `index` bo'yicha saralanadi.
 *
 * React ga bog'liq emas — izolyatsiyalangan mantiq testidan o'tadi.
 */

import type { CodeLang, ImageSource, Slide, SlideType } from '@/types/api';
import {
  CODE_LANGS,
  IMAGE_MAX_ALT_CHARS,
  IMAGE_MAX_URL_CHARS,
  OPEN_DEFAULT_MAX_CHARS,
  OPEN_MAX_MAX_CHARS,
  OPEN_MIN_MAX_CHARS,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  QUIZ_DEFAULT_POINTS,
  QUIZ_MAX_OPTIONS,
  QUIZ_MIN_OPTIONS,
  SLIDE_TYPES,
} from '@/types/api';

/* ========================================================================== */
/* Asset URL — backend `schemas/slide.py: parse_asset_url()` ning aynan nusxasi */
/* ========================================================================== */

const ASSET_PATH_RE =
  /^\/api\/v1\/presentations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/assets\/([^/?#]+)$/;

const ASSET_KEY_RE =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.(?:png|jpg|jpeg|gif|webp)$/;

/**
 * `image_url` FAQAT shu platformaning barqaror asset URL i bo'lsa `true` (§16.1):
 * `http(s)://host[:port]/api/v1/presentations/{uuid}/assets/{asset_key}`.
 *
 * Backend yozishda tekshiradi, lekin klient **unga ishonib qolmaydi**: `<img src>` ga
 * tashqi URL tushsa har o'quvchining brauzeri begona serverga so'rov yuboradi
 * (IP sizishi, kuzatuv). Rad etiladi: `javascript:`/`data:`, protokolsiz `//host`,
 * `user@host`, query/fragment, bo'shliq/boshqaruv belgilari, `\`, path traversal,
 * va URL normalizatsiyasi o'zgartiradigan har qanday yozuv.
 */
export function isAssetUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > IMAGE_MAX_URL_CHARS) return false;
  if (url.includes('\\')) return false;
  for (let i = 0; i < url.length; i += 1) {
    const code = url.charCodeAt(i);
    if (code < 0x21 || code === 0x7f) return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.host.length === 0 || parsed.username.length > 0 || parsed.password.length > 0) {
    return false;
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) return false;

  // `URL` `..`, `%2e`, katta harf va bo'sh `?` ni jim normalizatsiya qiladi. Python `urlsplit`
  // buni qilmaydi — shuning uchun xom satr normallashtirilgan shakl bilan AYNAN teng bo'lishi shart.
  if (url !== `${parsed.protocol}//${parsed.host}${parsed.pathname}`) return false;

  const match = ASSET_PATH_RE.exec(parsed.pathname);
  const key = match?.[1];
  return key !== undefined && ASSET_KEY_RE.test(key);
}

/* ========================================================================== */
/* Maydon yordamchilari                                                       */
/* ========================================================================== */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Backend `title`/`notes` ni har doim yuboradi (`null` bo'lishi mumkin) — tip `string | null`. */
function nullableStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function stringList(value: unknown, min: number, max: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter((item): item is string => typeof item === 'string');
  if (list.length !== value.length || list.length < min || list.length > max) return null;
  return list;
}

function parseImageSource(value: unknown): ImageSource | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  if (kind !== 'PDF' && kind !== 'PPTX' && kind !== 'UPLOAD') return null;
  const page =
    typeof value.page === 'number' && Number.isInteger(value.page) && value.page > 0
      ? value.page
      : null;
  return { kind, page };
}

/* ========================================================================== */
/* Slayd                                                                      */
/* ========================================================================== */

/** Bitta xom elementni sxema bo'yicha tekshiradi; mos kelmasa `null`. */
export function parseSlide(raw: unknown): Slide | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.index !== 'number' || !Number.isInteger(raw.index) || raw.index < 0) return null;

  const type = str(raw.type);
  if (type === null || !(SLIDE_TYPES as readonly string[]).includes(type)) return null;

  const index = raw.index;
  const title = nullableStr(raw.title);

  const slideType = type as SlideType;

  switch (slideType) {
    case 'MARKDOWN': {
      const content = str(raw.content);
      if (content === null) return null;
      return { index, type: 'MARKDOWN', title, content, notes: nullableStr(raw.notes) };
    }

    case 'CODE': {
      const lang = str(raw.code_lang);
      const starter = str(raw.starter_code);
      if (lang === null || starter === null) return null;
      if (!(CODE_LANGS as readonly string[]).includes(lang)) return null;
      return {
        index,
        type: 'CODE',
        title,
        code_lang: lang as CodeLang,
        starter_code: starter,
        notes: nullableStr(raw.notes),
      };
    }

    case 'QUIZ': {
      const question = str(raw.question);
      const options = stringList(raw.options, QUIZ_MIN_OPTIONS, QUIZ_MAX_OPTIONS);
      const duration = positiveNumber(raw.duration_sec);
      if (question === null || options === null || duration === null) return null;
      if (typeof raw.correct_option !== 'number') return null;
      return {
        index,
        type: 'QUIZ',
        title,
        question,
        options,
        correct_option: raw.correct_option,
        duration_sec: duration,
        points: positiveNumber(raw.points) ?? QUIZ_DEFAULT_POINTS,
      };
    }

    case 'IMAGE': {
      // Klient ham tekshiradi — backend qatlamiga ishonib qolinmaydi (§16.1).
      if (!isAssetUrl(raw.image_url)) return null;
      const alt = str(raw.alt);
      if (alt === null || alt.trim().length === 0 || alt.length > IMAGE_MAX_ALT_CHARS) return null;
      return {
        index,
        type: 'IMAGE',
        title,
        image_url: raw.image_url,
        alt,
        notes: nullableStr(raw.notes),
        source: parseImageSource(raw.source),
      };
    }

    case 'POLL': {
      const question = str(raw.question);
      const options = stringList(raw.options, POLL_MIN_OPTIONS, POLL_MAX_OPTIONS);
      const duration = positiveNumber(raw.duration_sec);
      if (question === null || options === null || duration === null) return null;
      return { index, type: 'POLL', title, question, options, duration_sec: duration };
    }

    case 'OPEN': {
      const question = str(raw.question);
      const duration = positiveNumber(raw.duration_sec);
      if (question === null || duration === null) return null;
      const rawMax = positiveNumber(raw.max_chars) ?? OPEN_DEFAULT_MAX_CHARS;
      const maxChars = Math.min(OPEN_MAX_MAX_CHARS, Math.max(OPEN_MIN_MAX_CHARS, Math.floor(rawMax)));
      return { index, type: 'OPEN', title, question, duration_sec: duration, max_chars: maxChars };
    }

    default: {
      // `SlideType` ga yangi tur qo'shilib, bu yerda `case` yozilmasa — kompilyatsiya xatosi.
      const unhandled: never = slideType;
      void unhandled;
      return null;
    }
  }
}

/** Xom massivni tozalab, `index` bo'yicha saralaydi. Buzuq elementlar tashlanadi. */
export function parseSlides(raw: unknown): Slide[] {
  if (!Array.isArray(raw)) return [];
  const parsed: Slide[] = [];
  for (const item of raw) {
    const slide = parseSlide(item);
    if (slide !== null) parsed.push(slide);
  }
  return parsed.sort((a, b) => a.index - b.index);
}
