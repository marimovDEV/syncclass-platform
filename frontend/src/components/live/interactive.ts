/**
 * POLL / OPEN uchun sof yordamchilar (CONTRACTS.md §16.3, §16.5).
 *
 * React ga bog'liq emas — izolyatsiyalangan mantiq testidan o'tadi.
 */

/**
 * 0..100 oralig'idagi butun foiz. **Hech qachon 100 dan oshmaydi va 0 ga bo'linmaydi.**
 *
 * §16.5: `POLL_PROGRESS.total` = xonadagi HOZIRGI o'quvchilar, ovoz berganlar emas.
 * Ovoz bergan o'quvchi chiqib ketsa `voted > total` bo'ladi — shuning uchun maxraj
 * `max(part, total)`: 5 ovoz / 3 kishi → 100%, 167% emas.
 */
export function safePercent(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total)) return 0;
  const safePart = Math.max(0, part);
  const denominator = Math.max(safePart, total);
  if (denominator <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((safePart / denominator) * 100)));
}

/** Bitta variantning ovozlar ichidagi ulushi (`sum(distribution)` ga nisbatan). */
export function shareOf(count: number, distribution: readonly number[]): number {
  const sum = distribution.reduce((acc, value) => acc + Math.max(0, value), 0);
  return safePercent(count, sum);
}

/**
 * "Ishtirok" yorlig'i. `"2/0"` yoki `"5/3"` kabi ma'nosiz kasr KO'RSATILMAYDI:
 * - `total > 0` va `count <= total` → `"12/30"`
 * - aks holda → `"12 ta ovoz"` (xona bo'sh yoki ovoz berganlar chiqib ketgan).
 */
export function formatTurnout(count: number, total: number, noun: string): string {
  const safeCount = Math.max(0, Math.floor(count));
  if (total > 0 && safeCount <= total) return `${safeCount}/${total}`;
  return `${safeCount} ta ${noun}`;
}

/**
 * Idempotent yakunlovchi: har bir `id` uchun yuborish **bir martagina** muvaffaqiyatli
 * bo'ladi. O'qituvchining "Yakunlash" tugmasi va `ends_at` taymeri BIR XIL nusxani
 * ishlatadi — ikkalasi ham ishga tushsa `*_END` ikki marta ketmaydi.
 *
 * `send` `false` qaytarsa (WS yopiq) — `id` belgilanmaydi, keyingi urinish (reconnect
 * dan keyin) yana yuboradi.
 */
export function createEndOnce(send: (id: string) => boolean): (id: string) => boolean {
  const sent = new Set<string>();
  return (id: string): boolean => {
    if (sent.has(id)) return false;
    const ok = send(id);
    if (ok) sent.add(id);
    return ok;
  };
}

/**
 * So'z buluti uchun o'lcham darajasi (0..4). `count` eng kattasiga nisbatan;
 * shu darajaga mos Tailwind klassi komponentda tanlanadi (rang emas, faqat o'lcham).
 */
export function cloudLevel(count: number, maxCount: number): 0 | 1 | 2 | 3 | 4 {
  if (maxCount <= 0 || count <= 0) return 0;
  const ratio = Math.min(1, count / maxCount);
  if (ratio >= 0.85) return 4;
  if (ratio >= 0.6) return 3;
  if (ratio >= 0.35) return 2;
  if (ratio >= 0.15) return 1;
  return 0;
}

/** Taymer tugagach `*_END` dan oldingi kichik kutish — oxirgi soniyadagi ovozlar yo'lda qolmasin. */
export const AUTO_END_GRACE_MS = 1_500;

/** Interaktivning slaydga bog'lanishi uchun yetarli minimal shakl (`ActiveQuiz/Poll/Open`). */
interface SlideBound {
  slide_index: number;
}

/**
 * Joriy slaydning interaktivi (QUIZ / POLL / OPEN) HOZIR javob kutyaptimi.
 *
 * Faol slayd ramkasi shunga qarab nur rangini tanlaydi (DESIGN_GLOW §1): `true` → firuza
 * `accent` (LIVE nishoni va taymer bilan bir xil "hozir sodir bo'lyapti" rangi),
 * `false` → `primary`. Interaktiv BOSHQA slaydga tegishli bo'lsa — `false`.
 */
export function isSlideInteractiveLive(
  slideType: string | null,
  slideIndex: number,
  active: { quiz: SlideBound | null; poll: SlideBound | null; open: SlideBound | null },
): boolean {
  switch (slideType) {
    case 'QUIZ':
      return active.quiz !== null && active.quiz.slide_index === slideIndex;
    case 'POLL':
      return active.poll !== null && active.poll.slide_index === slideIndex;
    case 'OPEN':
      return active.open !== null && active.open.slide_index === slideIndex;
    default:
      return false;
  }
}
