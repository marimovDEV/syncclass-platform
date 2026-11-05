'use client';

/**
 * O'quvchilar paneli (o'qituvchi studiyasi).
 *
 * - Avatarlar + `PRESENT`/`LATE` holati (CONTRACTS.md §2 `attendance_status`).
 * - 👀 belgisi — `FOCUS_CHANGE` natijasi. AUDIT.md §F: bu **tavsiya xarakterida**,
 *   bahoga ta'sir qilmaydi va o'quvchiga ochiq aytilgan (`FocusNotice`).
 * - "Tushunmadim" foizi — `CONFUSED_PING` dan keladigan `{count, percentage}` radar halqasi.
 */

import * as React from 'react';
import { Eye, EyeOff, Users } from 'lucide-react';

import type { ConfusedState, Participant } from '@/types/api';
import { cn } from '@/lib/utils';
import { ATTENDANCE_STATUS_LABELS } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { UserAvatar } from '@/components/ui/avatar';
import { SimpleTooltip } from '@/components/ui/tooltip';
import type { LiveFocusEntry } from '@/store/useLiveRoom';

/** Chalg'igan belgisi shu muddat ichida "yangi" hisoblanadi. */
const FOCUS_FRESH_MS = 120_000;

export interface ParticipantsPanelProps {
  participants: Participant[];
  confused: ConfusedState;
  focus: Record<string, LiveFocusEntry>;
  className?: string;
}

/** Confused foizi — radar halqasi. */
function ConfusedRadar({ confused, total }: { confused: ConfusedState; total: number }) {
  const percentage = Math.min(100, Math.max(0, Math.round(confused.percentage)));
  const radius = 30;
  const circumference = 2 * Math.PI * radius;
  const alarming = percentage >= 30;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3">
      <div className="relative size-[72px] shrink-0">
        <svg viewBox="0 0 72 72" className="size-[72px] -rotate-90">
          <circle cx="36" cy="36" r={radius} className="fill-none stroke-fg/10" strokeWidth="6" />
          <circle
            cx="36"
            cy="36"
            r={radius}
            strokeWidth="6"
            strokeLinecap="round"
            className={cn('fill-none', alarming ? 'stroke-danger' : 'stroke-primary')}
            style={{
              strokeDasharray: circumference,
              // Animatsiyasiz (DESIGN_GLOW §5: faqat transform/opacity).
              strokeDashoffset: circumference * (1 - percentage / 100),
            }}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-xl" aria-hidden>
          🐢
        </span>
      </div>

      <div className="min-w-0">
        <p className="text-sm font-semibold text-fg">
          <span className="tabular-nums">{percentage}%</span> tushunmadi
        </p>
        <p className="text-xs text-muted">
          {confused.count} / {total} o&apos;quvchi (anonim, 30 s ichida)
        </p>
        {alarming ? (
          <p className="mt-1 text-xs font-medium text-danger">
            Sekinlashtirish yoki qayta tushuntirish tavsiya etiladi.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function ParticipantsPanel({
  participants,
  confused,
  focus,
  className,
}: ParticipantsPanelProps) {
  const sorted = React.useMemo(
    () => [...participants].sort((a, b) => a.full_name.localeCompare(b.full_name, 'uz')),
    [participants],
  );

  const distractedCount = React.useMemo(
    () =>
      sorted.filter((p) => {
        const entry = focus[p.student_id];
        return entry !== undefined && !entry.is_focused;
      }).length,
    [sorted, focus],
  );

  return (
    <aside
      className={cn('flex min-h-0 flex-col gap-3', className)}
      aria-label="O'quvchilar ro'yxati"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-fg">
          <Users className="size-4 text-muted" aria-hidden />
          O&apos;quvchilar
          <span className="tabular-nums text-muted">({sorted.length})</span>
        </p>
        {distractedCount > 0 ? (
          <SimpleTooltip content="Dars oynasidan 10 soniyadan ko'proq chiqib ketgan o'quvchilar">
            <Badge variant="outline" className="tabular-nums">
              <EyeOff aria-hidden />
              {distractedCount}
            </Badge>
          </SimpleTooltip>
        ) : null}
      </div>

      <ConfusedRadar confused={confused} total={Math.max(sorted.length, confused.count)} />

      {sorted.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted">
          Hali hech kim qo&apos;shilmadi. PIN ni ekranga chiqarib bering.
        </p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="flex flex-col gap-1 pr-2">
            {sorted.map((participant) => {
              const entry = focus[participant.student_id];
              const away = entry !== undefined && !entry.is_focused;
              const fresh = entry !== undefined && Date.now() - entry.updated_at < FOCUS_FRESH_MS;

              return (
                <li
                  key={participant.student_id}
                  className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors duration-150 hover:bg-surface-2"
                >
                  <UserAvatar
                    fullName={participant.full_name}
                    avatarUrl={participant.avatar_url}
                    className="size-8"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">
                    {participant.full_name}
                  </span>

                  {away ? (
                    <SimpleTooltip
                      content={`Tab almashdi: ${entry.tab_switches_count} marta. Bu faqat tavsiya — bahoga ta'sir qilmaydi.`}
                    >
                      <span
                        className={cn(
                          'flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium',
                          fresh ? 'bg-surface-2 text-fg' : 'bg-surface-2 text-muted',
                        )}
                      >
                        <Eye className="size-3" aria-hidden />
                        {entry.tab_switches_count}
                      </span>
                    </SimpleTooltip>
                  ) : null}

                  <Badge
                    variant={participant.status === 'LATE' ? 'neutral' : 'success'}
                    className="shrink-0"
                  >
                    {ATTENDANCE_STATUS_LABELS[participant.status]}
                  </Badge>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}
    </aside>
  );
}
