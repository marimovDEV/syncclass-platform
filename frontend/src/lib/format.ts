/**
 * Formatlash — AUDIT.md §H5: DB da `TIMESTAMPTZ` (UTC), UI da `Asia/Tashkent`.
 *
 * `Intl` API ishlatiladi (qo'shimcha kutubxona yo'q, vaqt zonasi qat'iy).
 */

export const APP_TIMEZONE = 'Asia/Tashkent';
export const APP_LOCALE = 'uz-UZ';

function toDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const dateTimeFormatter = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: APP_TIMEZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateFormatter = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: APP_TIMEZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const timeFormatter = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: APP_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const longDateFormatter = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: APP_TIMEZONE,
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** `03.11.2026, 18:40` (Toshkent vaqti). */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = toDate(value);
  return date ? dateTimeFormatter.format(date) : '—';
}

/** `03.11.2026`. */
export function formatDate(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = toDate(value);
  return date ? dateFormatter.format(date) : '—';
}

/** `18:40`. */
export function formatTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = toDate(value);
  return date ? timeFormatter.format(date) : '—';
}

/** `3-noyabr 2026` uslubidagi uzun ko'rinish. */
export function formatLongDate(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = toDate(value);
  return date ? longDateFormatter.format(date) : '—';
}

/** `datetime-local` input uchun Toshkent vaqtidagi `YYYY-MM-DDTHH:mm`. */
export function toLocalInputValue(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '';
  const date = toDate(value);
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/* ------------------------------ deadline oqimi ---------------------------- */

export interface TimeLeft {
  /** Muddat o'tib ketgan. */
  expired: boolean;
  totalMs: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** `2 kun 4 soat` / `18 daq 20 son` / `Muddat o'tdi`. */
  text: string;
  /** < 6 soat qolgan — UI da ogohlantirish rangi. */
  urgent: boolean;
}

const EMPTY_TIME_LEFT: TimeLeft = {
  expired: true,
  totalMs: 0,
  days: 0,
  hours: 0,
  minutes: 0,
  seconds: 0,
  text: 'Muddat ko’rsatilmagan',
  urgent: false,
};

/** Deadline gacha qolgan vaqt (o'zbekcha matn bilan). */
export function timeLeft(
  deadline: string | number | Date | null | undefined,
  now: number = Date.now(),
): TimeLeft {
  if (deadline === null || deadline === undefined) return EMPTY_TIME_LEFT;
  const date = toDate(deadline);
  if (!date) return EMPTY_TIME_LEFT;

  const totalMs = date.getTime() - now;
  if (totalMs <= 0) {
    return {
      expired: true,
      totalMs: 0,
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      text: 'Muddat o’tdi',
      urgent: false,
    };
  }

  const totalSeconds = Math.floor(totalMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  let text: string;
  if (days > 0) text = `${days} kun ${hours} soat`;
  else if (hours > 0) text = `${hours} soat ${minutes} daq`;
  else if (minutes > 0) text = `${minutes} daq ${seconds} son`;
  else text = `${seconds} son`;

  return {
    expired: false,
    totalMs,
    days,
    hours,
    minutes,
    seconds,
    text,
    urgent: totalMs < 6 * 3_600_000,
  };
}

/** Quiz taymeri uchun `mm:ss`. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/* --------------------------------- boshqa --------------------------------- */

/** `1.4 MB`, `812 KB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const unit = units[exponent] ?? 'B';
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

/** `1 250` → `1 250` (ming ajratgich bilan). */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(APP_LOCALE).format(value);
}

/** `12 daqiqa oldin`, `3 kun oldin`. */
export function formatRelative(
  value: string | number | Date | null | undefined,
  now: number = Date.now(),
): string {
  if (value === null || value === undefined) return '—';
  const date = toDate(value);
  if (!date) return '—';

  const diffMs = now - date.getTime();
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;

  if (abs < minute) return 'hozir';
  if (abs < hour) {
    const n = Math.floor(abs / minute);
    return diffMs > 0 ? `${n} daqiqa oldin` : `${n} daqiqadan keyin`;
  }
  if (abs < day) {
    const n = Math.floor(abs / hour);
    return diffMs > 0 ? `${n} soat oldin` : `${n} soatdan keyin`;
  }
  if (abs < 30 * day) {
    const n = Math.floor(abs / day);
    return diffMs > 0 ? `${n} kun oldin` : `${n} kundan keyin`;
  }
  return formatDate(date);
}

/* ------------------------- kontrakt enum lari → matn ---------------------- */

import type { AttendanceStatus, SessionStatus, SubmissionStatus, UserRole } from '@/types/api';

export const ROLE_LABELS: Record<UserRole, string> = {
  TEACHER: 'O’qituvchi',
  STUDENT: 'O’quvchi',
  ADMIN: 'Administrator',
};

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  LOBBY: 'Kutish xonasi',
  LIVE: 'Jonli',
  ENDED: 'Tugadi',
};

export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  PRESENT: 'Keldi',
  LATE: 'Kechikdi',
  ABSENT: 'Kelmadi',
};

export const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = {
  PENDING_AI: 'AI tekshiruvida',
  READY_FOR_REVIEW: 'Tekshirishga tayyor',
  AI_FAILED: 'AI tekshiruvi bo’lmadi',
  GRADED: 'Baholandi',
  RESUBMIT_REQUIRED: 'Qayta topshirish talab qilinadi',
};

/**
 * `ApiError.code` / WS `ERROR.data.code` → o'zbekcha matn.
 *
 * Manba: CONTRACTS.md §5.1 (realtime-engineer kodning o'zidan yig'gan TO'LIQ ro'yxat) +
 * §11.1 / §16.2 dagi kodlar. Bu yerda yo'q kod UI ga XOM holda chiqadi — yangi kod
 * qo'shilsa shu yerga ham yorliq yozilsin.
 */
export const ERROR_CODE_LABELS: Record<string, string> = {
  /* --- Klient (frontend o'zi beradi) --- */
  NETWORK_ERROR: 'Serverga ulana olmadik. Internet aloqasini tekshiring.',
  ABORTED: 'Amal bekor qilindi.',
  MISSING_TOKENS: 'Kirish ma’lumotlari kelmadi. Qaytadan kiring.',

  /* --- Auth --- */
  UNAUTHORIZED: 'Sessiya tugadi. Qaytadan kiring.',
  INVALID_AUTH_SCHEME: 'Avtorizatsiya formati noto’g’ri. Qaytadan kiring.',
  INVALID_TOKEN: 'Sessiya yaroqsiz. Qaytadan kiring.',
  INVALID_TOKEN_TYPE: 'Sessiya yaroqsiz. Qaytadan kiring.',
  TOKEN_EXPIRED: 'Sessiya muddati tugadi. Qaytadan kiring.',
  TOKEN_REVOKED: 'Sessiya bekor qilingan. Qaytadan kiring.',
  TOKEN_VERSION_MISMATCH: 'Hisobingiz huquqlari o’zgardi. Qaytadan kiring.',
  USER_NOT_FOUND: 'Foydalanuvchi topilmadi.',
  USER_INACTIVE: 'Hisobingiz faol emas. Administratorga murojaat qiling.',
  TEACHER_REQUIRED: 'Bu amal faqat o’qituvchi uchun.',
  ADMIN_REQUIRED: 'Bu amal faqat administrator uchun.',
  ONBOARDING_REQUIRED: 'Avval profilingizni to’ldiring.',
  INVALID_OAUTH_STATE: 'Kirish sessiyasi eskirdi. Qaytadan urinib ko’ring.',
  RATE_LIMITED: 'Juda tez-tez urinyapsiz. Biroz kutib, qayta urinib ko’ring.',
  INVALID_CREDENTIALS: 'Email yoki parol noto’g’ri.',
  EMAIL_TAKEN: 'Bu email allaqachon ro’yxatdan o’tgan. «Kirish» bo’limidan kiring.',
  INVALID_CODE: 'Kod noto’g’ri. Qaytadan tekshirib yozing.',
  CODE_EXPIRED: 'Kod muddati o’tgan. Qaytadan ro’yxatdan o’ting.',
  EMAIL_SEND_FAILED: 'Kod yuborib bo’lmadi. Email manzilini tekshirib, qayta urinib ko’ring.',

  /* --- OAuth callback (#error=...) --- */
  GOOGLE_DENIED: 'Google orqali kirishga ruxsat berilmadi.',
  GOOGLE_AUTH_FAILED: 'Google orqali kirib bo’lmadi. Qayta urinib ko’ring.',
  EMAIL_MISSING: 'Google akkauntida email topilmadi.',
  EMAIL_NOT_VERIFIED: 'Google akkauntingizdagi email tasdiqlanmagan.',

  /* --- Guruh / xona --- */
  NOT_IN_GROUP: 'Siz bu dars guruhiga a’zo emassiz.',
  NOT_GROUP_OWNER: 'Bu guruh sizga tegishli emas.',
  GROUP_NAME_TAKEN: 'Bunday nomli guruh allaqachon bor.',
  INVALID_INVITE_CODE: 'Taklif kodi noto’g’ri.',
  ROOM_NOT_FOUND: 'Bunday PIN bilan faol dars topilmadi.',
  ROOM_ENDED: 'Dars allaqachon tugagan.',
  ROOM_NOT_LIVE: 'Dars hali boshlanmagan.',

  /* --- WS ulanish --- */
  INVALID_TICKET: 'Darsga ulanish muddati o’tdi. Qayta ulanilmoqda…',
  FORBIDDEN: 'Bu darsga kirish huquqingiz yo’q.',

  /* --- WS protokol (odatda dastur xatosi — foydalanuvchiga umumiy matn) --- */
  BAD_JSON: 'Serverga noto’g’ri xabar yuborildi. Sahifani yangilang.',
  BAD_ENVELOPE: 'Serverga noto’g’ri xabar yuborildi. Sahifani yangilang.',
  BAD_PAYLOAD: 'Yuborilgan ma’lumot yaroqsiz.',
  UNSUPPORTED_VERSION: 'Ilova eskirgan. Sahifani yangilang.',
  UNKNOWN_EVENT: 'Ilova eskirgan. Sahifani yangilang.',
  PAYLOAD_TOO_LARGE: 'Xabar hajmi juda katta.',
  FORBIDDEN_EVENT: 'Bu amal uchun ruxsatingiz yo’q.',

  /* --- Quiz --- */
  NOT_A_QUIZ: 'Bu slayd test emas.',
  QUIZ_NOT_ACTIVE: 'Test hozir faol emas.',
  QUIZ_CLOSED: 'Test vaqti tugadi — javob qabul qilinmadi.',
  ALREADY_ANSWERED: 'Siz bu testga allaqachon javob bergansiz.',

  /* --- So'rovnoma / ochiq savol (§16.3) --- */
  ALREADY_VOTED: 'Siz allaqachon ovoz bergansiz.',
  POLL_NOT_ACTIVE: 'So’rovnoma faol emas yoki vaqti tugagan.',
  OPEN_NOT_ACTIVE: 'Savol faol emas yoki vaqti tugagan.',
  INVALID_OPTION: 'Bunday variant yo’q.',
  ANSWER_TOO_LONG: 'Javob juda uzun. Qisqaroq yozing.',
  NOT_A_POLL: 'Bu slayd so’rovnoma emas.',
  NOT_AN_OPEN: 'Bu slayd ochiq savol emas.',

  /* --- Kontent --- */
  NOT_OWNER: 'Bu taqdimot sizga tegishli emas.',
  PRESENTATION_IN_USE: 'Taqdimot jonli darsda ishlatilmoqda — hozir o’zgartirib bo’lmaydi.',
  PRESENTATION_NOT_FOUND: 'Taqdimot topilmadi.',
  ASSET_NOT_FOUND: 'Rasm topilmadi.',
  INVALID_PPTX: 'Fayl PowerPoint (.pptx) taqdimoti emas yoki buzilgan.',
  UNSAFE_PPTX: 'Fayl xavfsizlik tekshiruvidan o’tmadi. PDF ga eksport qilib yuklang.',
  STORAGE_NOT_CONFIGURED: 'Rasm saqlash xizmati sozlanmagan. Administratorga murojaat qiling.',

  /* --- Fayl --- */
  EMPTY_FILE: 'Fayl bo’sh.',
  FILE_TOO_LARGE: 'Fayl hajmi juda katta (maksimal 25 MB).',
  UNSUPPORTED_EXTENSION: 'Bu fayl turi qabul qilinmaydi.',
  ENCRYPTED_ZIP: 'Parolli arxiv qabul qilinmaydi.',
  ZIP_BOMB_DETECTED: 'Arxiv xavfsizlik tekshiruvidan o’tmadi.',
  DEADLINE_PASSED: 'Topshirish muddati o’tdi.',
  RESUBMIT_NOT_ALLOWED: 'Bu vazifani qayta topshirib bo’lmaydi.',
  STORAGE_UNAVAILABLE: 'Fayl saqlash xizmati vaqtincha ishlamayapti. Keyinroq urinib ko’ring.',
  FILE_UNAVAILABLE: 'Fayl hozircha yuklab olinmaydi. Keyinroq urinib ko’ring.',

  /*
   * --- Backend haqiqatda yuboradi, lekin §5.1 ro'yxatida YO'Q (backend kodini grep qilib topildi) ---
   * `VALIDATION_ERROR` da tafsilot `ApiError.fields` da keladi
   * (masalan `fields['slides_data.3.image_url']` — IMAGE slayd nega rad etilgani).
   */
  VALIDATION_ERROR: 'Yuborilgan ma’lumotlar noto’g’ri.',
  INVALID_SLIDES: 'Slaydlar ro’yxati yaroqsiz.',
  EMPTY_PATCH: 'Saqlash uchun hech qanday o’zgarish yo’q.',
  NOT_FOUND: 'Topilmadi.',
  GROUP_NOT_FOUND: 'Guruh topilmadi.',
  HOMEWORK_NOT_FOUND: 'Vazifa topilmadi.',
  SUBMISSION_NOT_FOUND: 'Topshiriq topilmadi.',
  SESSION_NOT_FOUND: 'Dars sessiyasi topilmadi.',
  STUDENT_ONLY: 'Bu amal faqat o’quvchi uchun.',
  INVITE_CODE_COLLISION: 'Taklif kodi yaratilmadi. Qayta urinib ko’ring.',
  INVALID_OAUTH_REQUEST: 'Kirish so’rovi noto’g’ri. Qaytadan urinib ko’ring.',
  OAUTH_NOT_CONFIGURED: 'Google orqali kirish hali sozlanmagan. Administratorga murojaat qiling.',
  TOKEN_OWNER_MISMATCH: 'Sessiya yaroqsiz. Qaytadan kiring.',
};

/** Xato kodi bo'yicha matn; topilmasa serverning `message` i qaytadi. */
export function errorText(code: string, fallback: string): string {
  return ERROR_CODE_LABELS[code] ?? fallback;
}
