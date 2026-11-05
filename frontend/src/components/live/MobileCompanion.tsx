'use client';

/**
 * Mobile Companion (`<768px`) — CONTRACTS.md §9 breakpointi `companion:`.
 *
 * - Vertikal rejim, `100dvh` (`.h-dvh-screen`) va `env(safe-area-inset-bottom)` (`.pb-safe`)
 *   — AUDIT.md §G5.
 * - Slaydni **zoom** qilish mumkin (telefonda kod o'qish uchun).
 * - Pastda 4 ta katta tugma: **[Slayd] [🐢 Tushunmadim] [Savol/Quiz] [Vazifa]**.
 * - Monaco bu ekranda **yo'q** (AUDIT.md §G2) — kod `LiveCodeView` (Shiki) bilan.
 */

import * as React from 'react';
import Link from 'next/link';
import { BookOpen, HelpCircle, Minus, MonitorUp, Plus, Presentation } from 'lucide-react';

import type { ActiveQuiz, CodeCursor, Slide } from '@/types/api';
import { cn } from '@/lib/utils';
import { Badge, LiveBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfusedButton } from '@/components/live/ConfusedButton';
import { SlideRenderer } from '@/components/live/SlideRenderer';

type CompanionTab = 'slide' | 'quiz' | 'homework';

const ZOOM_MIN = 1;
const ZOOM_MAX = 2.2;
const ZOOM_STEP = 0.2;

export interface MobileCompanionProps {
  slide: Slide | null;
  liveCode: string;
  cursor: CodeCursor | null;
  slideIndex: number;
  totalSlides: number;
  activeQuiz: ActiveQuiz | null;
  /** POLL/OPEN jonli paneli (`PollPanel`/`OpenPanel`) — slayd o'rnida chiziladi. */
  interactive?: React.ReactNode;
  /** So'rovnoma yoki ochiq savol hozir ovoz/javob kutyaptimi. */
  interactiveActive?: boolean;
  isSharing: boolean;
  /** `CONFUSED_PING` yuborish. */
  onConfused: () => boolean;
  /** WS yopiq bo'lsa tugmalar o'chadi. */
  disabled?: boolean;
  /** Ulanish holati banneri. */
  banner?: React.ReactNode;
  /** AUDIT.md §F — ochiq ko'rinadigan focus eslatmasi. */
  focusNotice?: React.ReactNode;
  /** Ekran ulashish ko'rinishi (LiveKit). */
  screenShare?: React.ReactNode;
  /** WS ochiq — LIVE nishoni ko'rsatiladi (DESIGN_GLOW §1). */
  live?: boolean;
  /** Faol slayd ramkasi nuri (`SlideRenderer.frame`). */
  frame?: 'primary' | 'accent' | 'none';
  /**
   * Modal (`.glass`) ochiq — pastki panel blursiz qattiq fonga o'tadi (bitta blur qatlami,
   * DESIGN_GLOW §5). Telefonlarda ikki `backdrop-filter` ayniqsa qimmat.
   */
  solidNav?: boolean;
}

export function MobileCompanion({
  slide,
  liveCode,
  cursor,
  slideIndex,
  totalSlides,
  activeQuiz,
  interactive,
  interactiveActive = false,
  isSharing,
  onConfused,
  disabled = false,
  banner,
  focusNotice,
  screenShare,
  live = false,
  frame = 'none',
  solidNav = false,
}: MobileCompanionProps) {
  const [tab, setTab] = React.useState<CompanionTab>('slide');
  const [zoom, setZoom] = React.useState(1);

  // Savol ochilsa o'quvchi darhol quiz tabiga o'tadi.
  React.useEffect(() => {
    if (activeQuiz !== null) setTab('quiz');
  }, [activeQuiz]);

  // So'rovnoma / ochiq savol slaydning o'zida — boshlanganda slayd tabiga qaytamiz
  // va zoom ni tiklaymiz (tugmalar to'liq o'lchamda, >= 44px bosiladigan bo'lsin).
  React.useEffect(() => {
    if (!interactiveActive) return;
    setTab('slide');
    setZoom(1);
  }, [interactiveActive]);

  return (
    <div className="flex h-dvh-screen flex-col overflow-hidden bg-bg">
      <header className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          {live ? <LiveBadge /> : null}
          <Badge variant="primary" className="tabular-nums">
            Slayd {totalSlides === 0 ? slideIndex + 1 : `${slideIndex + 1}/${totalSlides}`}
          </Badge>
          {isSharing ? (
            <Badge variant="danger">
              <MonitorUp aria-hidden />
              Ekran ulashildi
            </Badge>
          ) : null}
          {tab === 'slide' ? (
            <span className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Kichraytirish"
                disabled={zoom <= ZOOM_MIN}
                onClick={() => setZoom((z) => Math.max(ZOOM_MIN, Number((z - ZOOM_STEP).toFixed(2))))}
              >
                <Minus aria-hidden />
              </Button>
              <span className="w-10 text-center text-xs tabular-nums text-muted">
                {Math.round(zoom * 100)}%
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Kattalashtirish"
                disabled={zoom >= ZOOM_MAX}
                onClick={() => setZoom((z) => Math.min(ZOOM_MAX, Number((z + ZOOM_STEP).toFixed(2))))}
              >
                <Plus aria-hidden />
              </Button>
            </span>
          ) : null}
        </div>
        {banner}
        {focusNotice}
      </header>

      <main className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        {tab === 'slide' ? (
          <div
            // Zoom — barmoq bilan ham, tugma bilan ham.
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: 'top left',
              width: `${100 / zoom}%`,
              touchAction: 'pan-x pan-y pinch-zoom',
            }}
          >
            {isSharing && screenShare !== undefined ? (
              <div className="flex min-h-48 flex-col p-3">{screenShare}</div>
            ) : null}
            <SlideRenderer
              slide={slide}
              liveCode={liveCode}
              cursor={cursor}
              liveCodeActive={slide?.type === 'CODE' && liveCode.length > 0}
              interactive={interactive}
              frame={frame}
              compact
            />
          </div>
        ) : tab === 'quiz' ? (
          <div className="flex flex-col gap-3 p-4">
            <h2 className="text-base font-semibold text-fg">Savol / Quiz</h2>
            {interactiveActive ? (
              <Button variant="primary" size="lg" block className="min-h-12" onClick={() => setTab('slide')}>
                <Presentation aria-hidden />
                Ochiq savolga o&apos;tish
              </Button>
            ) : null}
            {activeQuiz === null ? (
              <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted">
                Hozir ochiq savol yo&apos;q. O&apos;qituvchi quizni boshlaganda oyna avtomatik
                ochiladi va taymer ishga tushadi.
              </p>
            ) : (
              <p className="rounded-xl border border-primary/40 bg-primary/10 p-4 text-sm text-fg">
                <span className="font-medium">Savol ochiq:</span> {activeQuiz.question}
              </p>
            )}
            <p className="text-xs text-muted">
              Tezroq javob bergan ko&apos;proq XP oladi. Vaqt serverda hisoblanadi.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 p-4">
            <h2 className="text-base font-semibold text-fg">Vazifalar</h2>
            <p className="text-sm text-muted">
              Darsdan keyin beriladigan vazifalar va topshirgan ishlaringiz alohida bo&apos;limda.
            </p>
            <Button asChild variant="secondary" size="lg" block>
              <Link href="/homeworks">
                <BookOpen aria-hidden />
                Vazifalarni ochish
              </Link>
            </Button>
          </div>
        )}
      </main>

      <nav
        aria-label="Dars boshqaruvi"
        className={cn(
          'grid shrink-0 grid-cols-4 items-stretch gap-1 border-t border-border px-2 pb-safe pt-2',
          solidNav ? 'bg-surface' : 'glass',
        )}
      >
        <CompanionTabButton
          active={tab === 'slide'}
          label="Slayd"
          onClick={() => setTab('slide')}
          icon={<Presentation aria-hidden />}
        />

        <div className="flex items-end justify-center">
          <ConfusedButton onPing={onConfused} disabled={disabled} size="xl" className="h-14" />
        </div>

        <CompanionTabButton
          active={tab === 'quiz'}
          label="Savol"
          highlight={activeQuiz !== null || interactiveActive}
          onClick={() => setTab('quiz')}
          icon={<HelpCircle aria-hidden />}
        />

        <CompanionTabButton
          active={tab === 'homework'}
          label="Vazifa"
          onClick={() => setTab('homework')}
          icon={<BookOpen aria-hidden />}
        />
      </nav>
    </div>
  );
}

function CompanionTabButton({
  active,
  label,
  icon,
  onClick,
  highlight = false,
}: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  highlight?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex h-14 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium transition-colors duration-150',
        active ? 'bg-primary/10 text-primary' : 'text-muted',
        '[&_svg]:size-5',
      )}
    >
      {icon}
      {label}
      {highlight && !active ? (
        <span className="absolute right-3 top-2 size-2 rounded-full bg-danger" aria-hidden />
      ) : null}
    </button>
  );
}
