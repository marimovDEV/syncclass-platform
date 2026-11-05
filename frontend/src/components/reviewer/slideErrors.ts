import { isApiError } from '@/lib/api';
import { errorText } from '@/lib/format';

/**
 * `VALIDATION_ERROR` da backend sababni `ApiError.fields` ga yozadi:
 * `fields['slides_data.3.image_url'] = '...'`. Toastda umumiy "ma'lumot noto'g'ri"
 * emas, aynan qaysi slaydning qaysi maydoni ekanini ko'rsatish uchun shu yordamchi.
 */

/** Backend maydon nomi → o'qituvchiga tushunarli yorliq. */
const FIELD_LABELS: Record<string, string> = {
  image_url: 'rasm manzili',
  alt: 'alt matn',
  title: 'sarlavha',
  notes: 'eslatma',
  content: 'matn',
  question: 'savol',
  options: 'variantlar',
  correct_option: 'to’g’ri javob',
  duration_sec: 'vaqt',
  points: 'XP',
  max_chars: 'javob uzunligi',
  code_lang: 'til',
  starter_code: 'kod',
  source: 'manba',
  index: 'tartib raqami',
  type: 'slayd turi',
};

export interface SlideFieldError {
  /** 0 dan boshlanadigan slayd indeksi. */
  index: number;
  /** Backend maydon yo'li (`image_url`, `options.2` va h.k.). */
  field: string;
  message: string;
}

const SLIDE_FIELD_KEY = /^slides_data\.(\d+)(?:\.(.+))?$/;

/** `ApiError.fields` dan slaydga tegishli xatolarni ajratib oladi (tartib: indeks bo'yicha). */
export function slideFieldErrors(error: unknown): SlideFieldError[] {
  if (!isApiError(error)) return [];
  const result: SlideFieldError[] = [];
  for (const [key, message] of Object.entries(error.fields)) {
    const match = SLIDE_FIELD_KEY.exec(key);
    if (!match) continue;
    const index = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isFinite(index)) continue;
    result.push({ index, field: match[2] ?? '', message });
  }
  return result.sort((a, b) => a.index - b.index);
}

function fieldLabel(field: string): string {
  if (field.length === 0) return 'slayd';
  const head = field.split('.')[0] ?? field;
  return FIELD_LABELS[head] ?? field;
}

/** `4-slayd · rasm manzili: Tashqi URL ruxsat etilmaydi`. */
export function formatSlideFieldError(item: SlideFieldError): string {
  return `${item.index + 1}-slayd · ${fieldLabel(item.field)}: ${item.message}`;
}

/**
 * Saqlash xatosi uchun toast matni: slayd maydoni bo'lsa — aniq slayd va maydon,
 * aks holda `ERROR_CODE_LABELS` dagi matn.
 */
export function describeSaveError(error: unknown, fallback = 'Qayta urinib ko’ring.'): string {
  const fieldErrors = slideFieldErrors(error);
  if (fieldErrors.length > 0) {
    const shown = fieldErrors.slice(0, 3).map(formatSlideFieldError);
    const rest = fieldErrors.length - shown.length;
    return rest > 0 ? `${shown.join('\n')}\n…va yana ${rest} ta` : shown.join('\n');
  }
  if (isApiError(error)) return errorText(error.code, error.message);
  return fallback;
}
