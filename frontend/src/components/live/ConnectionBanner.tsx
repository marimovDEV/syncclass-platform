'use client';

/**
 * WS ulanish holati bannerlari — `WsConnectionState` (CONTRACTS.md §8).
 *
 * Backend hali javob bermasligi mumkin, shuning uchun UI **chidamli**: har bir holat
 * uchun aniq o'zbekcha matn va (kerak bo'lsa) qo'lda qayta ulanish tugmasi bor.
 */

import * as React from 'react';
import { CloudOff, Loader2, RefreshCw, WifiOff } from 'lucide-react';

import type { WsConnectionState } from '@/types/api';
import type { ApiError } from '@/lib/api';
import { errorText } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export interface ConnectionBannerProps {
  connection: WsConnectionState;
  attempt: number;
  ticketError: ApiError | null;
  onReconnect: () => void;
  className?: string;
}

interface BannerContent {
  tone: 'info' | 'warn' | 'danger';
  icon: React.ReactNode;
  title: string;
  description: string;
  retry: boolean;
}

function describeConnection(
  connection: WsConnectionState,
  attempt: number,
  ticketError: ApiError | null,
): BannerContent | null {
  switch (connection) {
    case 'open':
      return null;
    case 'idle':
    case 'connecting':
      return {
        tone: 'info',
        icon: <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />,
        title: 'Serverga ulanmoqda…',
        description: 'Dars holati yuklanmoqda. Bu bir necha soniya olishi mumkin.',
        retry: false,
      };
    case 'reconnecting':
      return {
        tone: 'warn',
        icon: <WifiOff className="size-4" aria-hidden />,
        title: 'Aloqa uzildi, qayta ulanmoqda…',
        description:
          attempt > 1
            ? `${attempt}-urinish. Ulangach slayd, kod va quiz holati avtomatik tiklanadi.`
            : 'Ulangach slayd, kod va quiz holati avtomatik tiklanadi.',
        retry: true,
      };
    case 'error':
      return {
        tone: 'danger',
        icon: <CloudOff className="size-4" aria-hidden />,
        title: 'Xonaga ulanib bo‘lmadi',
        description:
          ticketError === null
            ? 'Server javob bermadi. Birozdan keyin qayta urinib ko‘ring.'
            : errorText(ticketError.code, ticketError.message),
        retry: true,
      };
    case 'closed':
      return {
        tone: 'info',
        icon: <CloudOff className="size-4" aria-hidden />,
        title: 'Ulanish yopildi',
        description: 'Dars tugagan bo‘lishi mumkin. Qayta ulanish uchun tugmani bosing.',
        retry: true,
      };
  }
}

const TONE_CLASS: Record<BannerContent['tone'], string> = {
  info: 'border-border bg-surface text-fg',
  // `accent` endi LIVE rangi (firuza) — ogohlantirish uchun emas: neytral yuza, ma'noni matn beradi.
  warn: 'border-border bg-surface-2 text-fg',
  danger: 'border-danger/40 bg-danger/10 text-fg',
};

export function ConnectionBanner({
  connection,
  attempt,
  ticketError,
  onReconnect,
  className,
}: ConnectionBannerProps) {
  const content = describeConnection(connection, attempt, ticketError);
  if (content === null) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-center gap-3 rounded-xl border px-3 py-2 text-sm shadow-soft',
        TONE_CLASS[content.tone],
        className,
      )}
    >
      <span className="shrink-0 text-muted">{content.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="font-medium">{content.title}</span>
        <span className="ml-1.5 text-muted">{content.description}</span>
      </span>
      {content.retry ? (
        <Button variant="outline" size="sm" onClick={onReconnect} className="shrink-0">
          <RefreshCw aria-hidden />
          Qayta ulanish
        </Button>
      ) : null}
    </div>
  );
}

/**
 * O'quvchi ekranida **ochiq ko'rinadigan** eslatma — AUDIT.md §F majburiy qarori.
 * Yashirin kuzatuv qilinmaydi: o'quvchi nima kuzatilayotganini biladi.
 */
export function FocusNotice({
  reportedAway,
  className,
}: {
  reportedAway: boolean;
  className?: string;
}) {
  return (
    <p
      className={cn(
        'flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs',
        reportedAway
          ? 'border-border bg-surface-2 text-fg'
          : 'border-border bg-surface text-muted',
        className,
      )}
    >
      <span aria-hidden>👀</span>
      <span>
        <span className="font-medium text-fg">Dars rejimi:</span> tab almashinishi
        o&apos;qituvchiga ko&apos;rinadi. Bu bahoga ta&apos;sir qilmaydi.
      </span>
    </p>
  );
}
