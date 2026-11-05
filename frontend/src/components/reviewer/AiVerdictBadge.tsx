'use client';

import * as React from 'react';
import { AlertTriangle, Eye, ShieldAlert } from 'lucide-react';

import type { AiEvidence } from '@/types/api';
import { AI_RED_FLAG_THRESHOLD } from '@/types/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { SimpleTooltip } from '@/components/ui/tooltip';

/**
 * AI nishoni uchun minimal shakl.
 *
 * To'liq `SubmissionOut` da `ai_evidence` va `ai_injection_suspected` bor;
 * ro'yxat modeli `SubmissionWithStudent` **yengil** (CONTRACTS.md §4) — unda
 * dalillar yuborilmaydi. Shuning uchun bu maydonlar ixtiyoriy: `undefined`
 * "dalil yo'q" degani EMAS, "hali ma'lum emas" degani.
 */
export interface AiFlagSource {
  ai_suspected: boolean;
  ai_confidence_percent: number;
  /** To'liq ko'rinishda bor; ro'yxat modelida `undefined`. */
  ai_evidence?: readonly AiEvidence[];
  /** To'liq ko'rinishda bor; ro'yxat modelida `undefined`. */
  ai_injection_suspected?: boolean;
}

/**
 * AUDIT.md §E2 — flag FAQAT dalil TASDIQLANGANDA ko'rsatiladi.
 * Dalil ro'yxati kelmagan bo'lsa (`undefined`) ham `false` qaytadi:
 * tasdiqlanmagan dalil bilan ayblash yo'q.
 */
export function hasAiFlag(source: AiFlagSource): boolean {
  return source.ai_suspected && (source.ai_evidence?.length ?? 0) > 0;
}

/**
 * AUDIT.md §E2 — qizil bayroq faqat: dalil bor **va** ishonch `>= 70%`.
 * Undan past bo'lsa sariq "ko'rib chiqish tavsiya etiladi".
 */
export function isAiRedFlag(source: AiFlagSource): boolean {
  return hasAiFlag(source) && source.ai_confidence_percent >= AI_RED_FLAG_THRESHOLD;
}

export interface AiVerdictBadgeProps {
  submission: AiFlagSource;
  /** Ishonch foizini yonida ko'rsatish. */
  showPercent?: boolean;
  className?: string;
}

/**
 * Jadval va navbat uchun ixcham AI belgisi.
 *
 * - dalil ro'yxati bor va bo'sh → hech narsa ko'rsatilmaydi;
 * - dalil bor va ishonch `>= 70%` → qizil "AI gumoni";
 * - dalil bor, ishonch past → sariq "Ko'rib chiqish";
 * - dalil ro'yxati **kelmagan** (yengil ro'yxat modeli) → faqat sariq
 *   "Ko'rib chiqish" (qizil bayroq HECH QACHON tasdiqlanmagan dalil bilan chiqmaydi).
 */
export function AiVerdictBadge({ submission, showPercent = true, className }: AiVerdictBadgeProps) {
  const evidenceKnown = submission.ai_evidence !== undefined;
  const flagged = hasAiFlag(submission);
  const red = isAiRedFlag(submission);
  // Ro'yxatda dalil yuborilmaydi: gumon bor, lekin hali tasdiqlanmagan.
  const unverified = !evidenceKnown && submission.ai_suspected;

  if (!flagged && !unverified && submission.ai_injection_suspected !== true) return null;

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      {flagged || unverified ? (
        <SimpleTooltip
          content={
            unverified
              ? 'AI gumon qildi. To’liq xulosa va dalillar tekshiruv sahifasida — bu ehtimollik, isbot emas.'
              : red
                ? 'AI yordamida yozilgan bo’lishi mumkin — bu ehtimollik, isbot emas.'
                : `Ishonch ${AI_RED_FLAG_THRESHOLD}% dan past — faqat ko’rib chiqish tavsiya etiladi.`
          }
        >
          <span className="inline-flex">
            <Badge variant={red ? 'danger' : 'accent'}>
              {red ? <AlertTriangle aria-hidden /> : <Eye aria-hidden />}
              {red ? 'AI gumoni' : 'Ko’rib chiqish'}
              {showPercent ? (
                <span className="tabular-nums">{submission.ai_confidence_percent}%</span>
              ) : null}
            </Badge>
          </span>
        </SimpleTooltip>
      ) : null}

      {submission.ai_injection_suspected === true ? (
        <SimpleTooltip content="Kodda tekshiruv tizimining promptini buzishga urinish aniqlandi.">
          <span className="inline-flex">
            <Badge variant="danger">
              <ShieldAlert aria-hidden />
              Injection
            </Badge>
          </span>
        </SimpleTooltip>
      ) : null}
    </span>
  );
}
