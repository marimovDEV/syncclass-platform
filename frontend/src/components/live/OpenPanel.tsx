'use client';

/**
 * Ochiq savol / so'z buluti (OPEN) — CONTRACTS.md §16.3.
 *
 * - **ANONIM:** hech bir event `student_id`/ism tashimaydi — bu yerda ham ism SO'RALMAYDI va
 *   ko'rsatilmaydi. Moderatsiya faqat `answer_id` (matn hashi) bilan.
 * - **XSS:** javob matni FAQAT React matni sifatida chiziladi. `innerHTML` /
 *   `dangerouslySetInnerHTML` bu faylda YO'Q va bo'lmasligi kerak.
 * - **O'qituvchi:** jonli bulut (`OPEN_UPDATE`, reconnect da `ROOM_STATE_SYNC.open_update`),
 *   har javob yonida "Yashirish" (`OPEN_HIDE`), "Yakunlash". Taymer tugaganda `OPEN_END` ni
 *   `TeacherStudio` avtomatik yuboradi (§16.5).
 * - **O'quvchi:** `maxLength={max_chars}`, qolgan belgilar sanog'i. Oxirgi javob yoziladi —
 *   qayta yuborish mumkin, lekin 1 javob / 2 s: klientda ham 2 s kutish (`RATE_LIMITED` ga
 *   deyarli yetib bormaydi), kelsa — xushmuomala xabar. Bulut faqat `OPEN_RESULTS` da.
 * - Faqat dizayn tokenlari; `prefers-reduced-motion` hurmat qilinadi.
 */

import * as React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CheckCircle2, Cloud, EyeOff, MessageSquareText, Play, Send, Square } from 'lucide-react';

import type {
  ActiveOpen,
  OpenResultsData,
  OpenSlide,
  OpenUpdateData,
  UserRole,
} from '@/types/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { TimerRing } from '@/components/live/TimerRing';
import { cloudLevel, formatTurnout } from '@/components/live/interactive';
import { useServerCountdown } from '@/hooks/useServerCountdown';

/** Server chegarasi: 1 javob / 2 s (§16.3). Klientda ham ushlanadi. */
const ANSWER_COOLDOWN_MS = 2_000;

/** `cloudLevel()` darajasi → o'lcham (rang emas — rang tokenlardan). */
const LEVEL_TEXT = ['text-sm', 'text-base', 'text-lg', 'text-xl', 'text-2xl'] as const;
const LEVEL_TONE = [
  'bg-fg/5 text-fg',
  'bg-fg/5 text-fg',
  'bg-primary/10 text-fg',
  'bg-primary/15 text-primary',
  'bg-primary/20 text-primary',
] as const;

interface CloudWord {
  /** React kaliti: o'qituvchida `answer_id`, natijada matnning o'zi. */
  key: string;
  text: string;
  count: number;
  answerId?: string;
}

/* ========================================================================== */
/* So'z buluti                                                                */
/* ========================================================================== */

function WordCloud({
  words,
  onHide,
  disabled,
}: {
  words: readonly CloudWord[];
  /** Faqat o'qituvchida (jonli) — `OPEN_HIDE`. */
  onHide?: (answerId: string) => void;
  disabled: boolean;
}) {
  const reduceMotion = useReducedMotion() === true;
  const max = words.reduce((acc, word) => Math.max(acc, word.count), 0);

  if (words.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted">
        Hali javob yo&apos;q.
      </p>
    );
  }

  return (
    <ul className="flex flex-wrap items-center justify-center gap-2" aria-label="Javoblar buluti">
      <AnimatePresence initial={false}>
        {words.map((word) => {
          const level = cloudLevel(word.count, max);
          return (
            <motion.li
              key={word.key}
              layout={!reduceMotion}
              initial={reduceMotion ? false : { opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.18 }}
              className={cn(
                'flex max-w-full items-center gap-1.5 rounded-full px-3 py-1.5 font-medium',
                LEVEL_TEXT[level],
                LEVEL_TONE[level],
              )}
            >
              {/* XSS: faqat matn — React avtomatik escape qiladi. */}
              <span className="min-w-0 break-words">{word.text}</span>
              {word.count > 1 ? (
                <span className="shrink-0 text-xs tabular-nums text-muted">×{word.count}</span>
              ) : null}
              {onHide !== undefined && word.answerId !== undefined ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (word.answerId !== undefined) onHide(word.answerId);
                  }}
                  aria-label={`Yashirish: ${word.text}`}
                  title="Yashirish"
                  className={cn(
                    // >= 44px bosish maydoni (ko'rinishi kichik, maydoni katta).
                    '-my-2 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-full text-muted',
                    'transition-colors duration-fast hover:bg-danger/10 hover:text-danger',
                    'disabled:cursor-not-allowed disabled:opacity-40',
                  )}
                >
                  <EyeOff className="size-4" aria-hidden />
                </button>
              ) : null}
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}

/* ========================================================================== */
/* O'quvchi: javob shakli                                                     */
/* ========================================================================== */

function AnswerForm({
  open,
  answered,
  myAnswer,
  rateLimitedAt,
  expired,
  disabled,
  onAnswer,
}: {
  open: ActiveOpen;
  answered: boolean;
  myAnswer: string | null;
  rateLimitedAt: number | null;
  expired: boolean;
  disabled: boolean;
  onAnswer: (openId: string, text: string) => boolean;
}) {
  const [text, setText] = React.useState('');
  const [cooldownUntil, setCooldownUntil] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  const fieldId = React.useId();

  // Server `RATE_LIMITED` qaytarsa — kutish oynasi yangilanadi.
  React.useEffect(() => {
    if (rateLimitedAt !== null) setCooldownUntil(rateLimitedAt + ANSWER_COOLDOWN_MS);
  }, [rateLimitedAt]);

  React.useEffect(() => {
    if (cooldownUntil === null) return;
    const id = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= cooldownUntil) setCooldownUntil(null);
    }, 200);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const trimmed = text.trim();
  const remaining = open.max_chars - text.length;
  const cooling = cooldownUntil !== null && now < cooldownUntil;
  const rateLimitedRecently = rateLimitedAt !== null && cooling;
  const canSend = trimmed.length > 0 && !cooling && !expired && !disabled;

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canSend) return;
    if (onAnswer(open.open_id, trimmed)) {
      setCooldownUntil(Date.now() + ANSWER_COOLDOWN_MS);
      setNow(Date.now());
      setText('');
    }
  };

  if (expired) {
    return (
      <p className="rounded-xl border border-border bg-surface px-3 py-3 text-sm text-muted">
        Vaqt tugadi. {answered ? 'Javobingiz qabul qilingan.' : 'Bu savolga javob berilmadi.'} Natija
        tez orada ko&apos;rsatiladi.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      {answered && myAnswer !== null ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-xl border border-success/40 bg-success/10 px-3 py-2.5 text-sm text-fg"
        >
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <span className="min-w-0">
            <span className="font-medium">Javob yuborildi:</span>{' '}
            <span className="break-words">{myAnswer}</span>
            <span className="mt-0.5 block text-xs text-muted">
              O&apos;zgartirmoqchi bo&apos;lsangiz, qayta yuboring — oxirgisi hisoblanadi.
            </span>
          </span>
        </p>
      ) : null}

      <label htmlFor={fieldId} className="sr-only">
        Javobingiz
      </label>
      <Textarea
        id={fieldId}
        value={text}
        maxLength={open.max_chars}
        onChange={(event) => setText(event.target.value)}
        placeholder="Qisqa javob yozing…"
        disabled={disabled}
        rows={2}
        className="min-h-20 text-base"
        aria-describedby={`${fieldId}-hint`}
      />

      <div className="flex items-center justify-between gap-2">
        <p
          id={`${fieldId}-hint`}
          className={cn('text-xs tabular-nums', remaining <= 5 ? 'text-danger' : 'text-muted')}
        >
          {remaining} ta belgi qoldi · ismingiz ko&apos;rsatilmaydi
        </p>
        <Button type="submit" size="lg" disabled={!canSend} className="min-h-11 shrink-0">
          <Send aria-hidden />
          {answered ? 'Qayta yuborish' : 'Yuborish'}
        </Button>
      </div>

      {rateLimitedRecently ? (
        <p role="status" className="text-xs text-fg">
          Biroz sekinroq — 2 soniyada bitta javob yuborish mumkin. Bir lahzadan keyin qayta
          urinib ko&apos;ring.
        </p>
      ) : cooling ? (
        <p className="text-xs text-muted">Keyingi javobni 2 soniyadan keyin yuborish mumkin.</p>
      ) : null}
    </form>
  );
}

/* ========================================================================== */
/* Panel                                                                      */
/* ========================================================================== */

export interface OpenPanelProps {
  role: UserRole;
  slide: OpenSlide;
  activeOpen: ActiveOpen | null;
  /** Faqat o'qituvchida keladi. */
  update: OpenUpdateData | null;
  results: OpenResultsData | null;
  resultsSlide: number | null;
  answeredOpenId: string | null;
  myAnswer: string | null;
  rateLimitedAt: number | null;
  /** O'qituvchi: `OPEN_START{slide_index}`. */
  onStart?: () => void;
  /** O'qituvchi: idempotent `OPEN_END`. */
  onEnd?: (openId: string) => void;
  /** O'qituvchi: `OPEN_HIDE{open_id, answer_id}`. */
  onHide?: (openId: string, answerId: string) => void;
  /** O'quvchi: `OPEN_ANSWER` — yuborilgan bo'lsa `true`. */
  onAnswer?: (openId: string, text: string) => boolean;
  disabled?: boolean;
  compact?: boolean;
}

export function OpenPanel({
  role,
  slide,
  activeOpen,
  update,
  results,
  resultsSlide,
  answeredOpenId,
  myAnswer,
  rateLimitedAt,
  onStart,
  onEnd,
  onHide,
  onAnswer,
  disabled = false,
  compact = false,
}: OpenPanelProps) {
  const isTeacher = role === 'TEACHER' || role === 'ADMIN';

  const live = activeOpen !== null && activeOpen.slide_index === slide.index ? activeOpen : null;
  const ownResults = live === null && results !== null && resultsSlide === slide.index ? results : null;

  const { remainingMs, ratio, expired } = useServerCountdown(
    live?.ends_at ?? null,
    live?.duration_sec ?? slide.duration_sec,
  );

  const liveUpdate = live !== null && update !== null && update.open_id === live.open_id ? update : null;

  const liveWords: CloudWord[] = React.useMemo(
    () =>
      (liveUpdate?.answers ?? []).map((answer) => ({
        key: answer.answer_id,
        text: answer.text,
        count: answer.count,
        answerId: answer.answer_id,
      })),
    [liveUpdate],
  );

  const resultWords: CloudWord[] = React.useMemo(
    () =>
      (ownResults?.answers ?? []).map((answer, index) => ({
        key: `${index}-${answer.text}`,
        text: answer.text,
        count: answer.count,
      })),
    [ownResults],
  );

  return (
    <section
      className={cn('mx-auto flex w-full max-w-3xl flex-col gap-4', compact ? 'px-3 py-4' : 'px-6 py-8')}
      aria-label="Ochiq savol"
    >
      <div className="flex items-start gap-3">
        {live !== null ? (
          <TimerRing ratio={ratio} remainingMs={remainingMs} size={compact ? 'sm' : 'md'} />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <Badge variant="neutral">
              <MessageSquareText aria-hidden />
              Ochiq savol
            </Badge>
            <Badge variant="outline">Anonim</Badge>
            {live !== null && isTeacher ? (
              <Badge variant="neutral" className="tabular-nums">
                {formatTurnout(liveUpdate?.answered ?? 0, liveUpdate?.total ?? 0, 'javob')}
              </Badge>
            ) : null}
          </div>
          {typeof slide.title === 'string' && slide.title.length > 0 ? (
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">{slide.title}</p>
          ) : null}
          <h2
            className={cn(
              'break-words font-semibold leading-snug tracking-tight text-fg',
              compact ? 'text-lg' : 'text-2xl studio:text-3xl',
            )}
          >
            {live?.question ?? slide.question}
          </h2>
        </div>
      </div>

      {isTeacher ? (
        live !== null ? (
          <>
            <WordCloud
              words={liveWords}
              disabled={disabled}
              onHide={(answerId) => onHide?.(live.open_id, answerId)}
            />
            <p className="text-xs text-muted">
              Javoblar anonim. Nomaqbulini «yashirish» tugmasi bilan olib tashlang — u yakuniy bulutga
              ham tushmaydi.{expired ? ' Vaqt tugadi — natija avtomatik yuboriladi.' : ''}
            </p>
            <Button variant="primary" size="lg" block disabled={disabled} onClick={() => onEnd?.(live.open_id)}>
              <Square aria-hidden />
              Yakunlash va bulutni ko&apos;rsatish
            </Button>
          </>
        ) : (
          <>
            {ownResults !== null ? (
              <CloudResults words={resultWords} />
            ) : (
              <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted">
                O&apos;quvchilar {slide.max_chars} belgigacha qisqa javob yozadi. Javoblar
                anonim — ismlar hech kimga ko&apos;rinmaydi.
              </p>
            )}
            <Button
              variant={ownResults !== null ? 'secondary' : 'primary'}
              size="lg"
              block
              disabled={disabled}
              onClick={onStart}
            >
              <Play aria-hidden />
              {ownResults !== null ? 'Qayta boshlash' : 'Ochiq savolni boshlash'}
            </Button>
          </>
        )
      ) : live !== null ? (
        <AnswerForm
          key={live.open_id}
          open={live}
          answered={answeredOpenId === live.open_id}
          myAnswer={answeredOpenId === live.open_id ? myAnswer : null}
          rateLimitedAt={rateLimitedAt}
          expired={expired}
          disabled={disabled}
          onAnswer={(openId, text) => onAnswer?.(openId, text) ?? false}
        />
      ) : ownResults !== null ? (
        <CloudResults words={resultWords} />
      ) : (
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted">
          O&apos;qituvchi savolni boshlaganda shu yerda javob yozasiz. Javobingiz anonim.
        </p>
      )}
    </section>
  );
}

function CloudResults({ words }: { words: readonly CloudWord[] }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-fg">
        <Cloud className="size-4 text-muted" aria-hidden />
        So&apos;z buluti
      </p>
      <WordCloud words={words} disabled />
    </div>
  );
}
