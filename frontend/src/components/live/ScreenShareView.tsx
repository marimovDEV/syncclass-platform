'use client';

/**
 * Ekran ulashish qobig'i: token olish, holatlar va LiveKit chunkini **lazy** yuklash.
 *
 * - LiveKit kodi `LiveKitStage` da (`next/dynamic`, `ssr:false`) — jonli xona sahifasining
 *   boshlang'ich yuki ~150 kB ga yengillashadi.
 * - AUDIT.md §F: o'quvchi **faqat subscribe** (`canPublish:false` serverda belgilanadi).
 * - LiveKit server manzili **tokendan** keladi (`LiveKitTokenOut.url`). Avval faqat
 *   `NEXT_PUBLIC_LIVEKIT_URL` ishlatilardi va u bo'sh bo'lsa ekran ulashish **jim** o'chib
 *   qolardi. Endi env faqat zaxira: server `url` bermasa ishlatiladi.
 * - `getDisplayMedia` brauzer "transient activation" talab qiladi, shuning uchun o'qituvchi
 *   tomonda LiveKit xonasi **oldindan** ulanib turadi va ulashish `toggleRef` orqali
 *   FloatingDock tugmasining klik zanjirida yoqiladi.
 */

import * as React from 'react';
import dynamic from 'next/dynamic';
import { MonitorUp } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import type { UserRole } from '@/types/api';
import { LIVEKIT_URL } from '@/lib/api';
import { queryKeys } from '@/lib/query';
import { createLiveKitToken } from '@/lib/resources';
import { cn } from '@/lib/utils';
import { LoadingState } from '@/components/shared/states';

const LiveKitStage = dynamic(() => import('@/components/live/LiveKitStage'), {
  ssr: false,
  loading: () => <LoadingState label="Video server yuklanmoqda…" />,
});

export interface ScreenShareViewProps {
  pin: string;
  role: UserRole;
  /** Serverdagi holat — `SCREEN_SHARE_STATE.is_sharing`. */
  isSharing: boolean;
  /** `SCREEN_SHARE_STATE` yuborish (faqat o'qituvchi). */
  onSharingChange?: (isSharing: boolean) => void;
  /** FloatingDock tugmasi shu ref orqali ulashishni yoqadi/o'chiradi. */
  toggleRef?: React.RefObject<((next: boolean) => void) | null>;
  className?: string;
}

export function ScreenShareView({
  pin,
  role,
  isSharing,
  onSharingChange,
  toggleRef,
  className,
}: ScreenShareViewProps) {
  const isTeacher = role === 'TEACHER' || role === 'ADMIN';

  const tokenQuery = useQuery({
    queryKey: [...queryKeys.room(pin), 'livekit-token'] as const,
    queryFn: () => createLiveKitToken(pin),
    enabled: isTeacher || isSharing,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  if (!isTeacher && !isSharing) return null;

  const token = tokenQuery.data?.token;
  const serverUrl = tokenQuery.data?.url || LIVEKIT_URL;

  if (token === undefined) {
    if (tokenQuery.isError) {
      return (
        <div
          className={cn(
            'flex min-h-32 items-center justify-center rounded-xl border border-danger/40 bg-danger/10 p-4 text-center text-sm text-fg',
            className,
          )}
        >
          Video serverga ulanib bo&apos;lmadi. Dars slaydlar bilan davom etadi.
        </div>
      );
    }
    return <LoadingState label="Video server bilan ulanmoqda…" className={className} />;
  }

  if (serverUrl.length === 0) {
    return (
      <div
        className={cn(
          'flex min-h-32 items-center justify-center rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted',
          className,
        )}
      >
        Video server manzili berilmadi — ekran ulashish hozircha mavjud emas.
      </div>
    );
  }

  return (
    <div
      className={cn(
        // `bg-black` — video letterbox (DESIGN_GLOW: ataylab qoladi).
        'relative flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-black',
        className,
      )}
    >
      <LiveKitStage
        serverUrl={serverUrl}
        token={token}
        canPublish={isTeacher}
        isSharing={isSharing}
        onSharingChange={onSharingChange}
        toggleRef={toggleRef}
      />

      {!isTeacher ? (
        // Video ustidagi yorliq — mavzuga mos qattiq chip (blur YO'Q: bitta blur qatlami dockda).
        // `bg-surface/90` + `text-fg` ikkala rejimda ham o'qiladi (qora/oq qattiq rang emas).
        <p className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1.5 rounded-lg border border-border bg-surface/90 px-2 py-1 text-[11px] text-fg">
          <MonitorUp className="size-3" aria-hidden />
          Faqat ko&apos;rish rejimi — mikrofon va kamera serverda o&apos;chirilgan
        </p>
      ) : null}
    </div>
  );
}
