/**
 * Token saqlash qatlami.
 *
 * ⚠️ XAVFSIZLIK ESLATMASI (ataylab qilingan tanlov, AUDIT.md §C4 bilan bog'liq):
 * `refresh_token` `httpOnly` cookie da EMAS — `localStorage` da saqlanadi, chunki
 * Google OAuth callback tokenlarni URL hash (`#access=..&refresh=..`) orqali qaytaradi
 * va frontend domeni backend domenidan farq qilishi mumkin (cookie o'rnatib bo'lmaydi).
 *
 * Buning narxi: XSS bo'lsa token o'g'irlanadi. Shu sababli:
 *   1. `access_token` qisqa muddatli (60 min), `refresh` revoke qilinadi (`jti` DB da).
 *   2. Hech qachon `dangerouslySetInnerHTML` ishlatmaymiz, foydalanuvchi matni
 *      React orqali escape qilinadi.
 *   3. Rol o'zgarsa `token_version` oshadi va eski tokenlar kuchini yo'qotadi.
 * Keyingi versiyada backend `Set-Cookie` bilan `httpOnly` refresh ga o'tishi kerak.
 *
 * Bu modul `lib/api.ts` ↔ `lib/auth.ts` orasidagi aylanma importni oldini oladi.
 */

const ACCESS_KEY = 'syncclass.access_token';
const REFRESH_KEY = 'syncclass.refresh_token';

/** `localStorage` SSR da, private rejimda va bloklangan cookie da yo'q bo'lishi mumkin. */
function store(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Boshqa tab da logout/login bo'lganini bilish uchun event nomi. */
export const TOKENS_CHANGED_EVENT = 'syncclass:tokens-changed';

function emitChange(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(TOKENS_CHANGED_EVENT));
}

export function getAccessToken(): string | null {
  try {
    return store()?.getItem(ACCESS_KEY) ?? null;
  } catch {
    return null;
  }
}

export function getRefreshToken(): string | null {
  try {
    return store()?.getItem(REFRESH_KEY) ?? null;
  } catch {
    return null;
  }
}

export function setTokens(accessToken: string, refreshToken: string): void {
  try {
    const s = store();
    if (!s) return;
    s.setItem(ACCESS_KEY, accessToken);
    s.setItem(REFRESH_KEY, refreshToken);
  } catch {
    /* kvota yoki bloklangan storage — jim o'tamiz, sessiya shu tabda ishlaydi */
  }
  emitChange();
}

export function clearTokens(): void {
  try {
    const s = store();
    if (!s) return;
    s.removeItem(ACCESS_KEY);
    s.removeItem(REFRESH_KEY);
  } catch {
    /* ignore */
  }
  emitChange();
}

export function hasTokens(): boolean {
  return getAccessToken() !== null;
}
