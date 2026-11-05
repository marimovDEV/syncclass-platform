'use client';

/**
 * LiveKit ga bog'liq qism — **alohida chunk**.
 *
 * `livekit-client` + `@livekit/components-react` ~150 kB. Jonli xona sahifasi ularni
 * boshlang'ich yukda tashimasligi uchun bu fayl `ScreenShareView` dan `next/dynamic`
 * (`ssr:false`) bilan yuklanadi.
 *
 * AUDIT.md §F: o'quvchi **faqat subscribe** qiladi — buni server token idagi
 * `canPublish:false` kafolatlaydi (CONTRACTS.md §4 `POST /rooms/{pin}/livekit-token`),
 * bu yerda hech qanday publish chaqirig'i yo'q.
 */

import * as React from 'react';
import { Track } from 'livekit-client';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  VideoTrack,
  useRoomContext,
  useTracks,
} from '@livekit/components-react';
import { MonitorOff } from 'lucide-react';

import { toast } from '@/components/ui/toast';

export interface LiveKitStageProps {
  /** LiveKit server manzili — `LiveKitTokenOut.url` dan (manba server). */
  serverUrl: string;
  token: string;
  /** O'qituvchimi (ulashishni yoqish huquqi faqat unda). */
  canPublish: boolean;
  isSharing: boolean;
  onSharingChange?: (isSharing: boolean) => void;
  /** Tashqi tugma (FloatingDock) shu ref orqali ulashishni yoqadi/o'chiradi. */
  toggleRef?: React.RefObject<((next: boolean) => void) | null>;
}

/** `room.localParticipant` ni tashqi tugmaga bog'laydi (klik ruxsati saqlanadi). */
function ScreenShareBridge({
  toggleRef,
  onSharingChange,
}: {
  toggleRef?: React.RefObject<((next: boolean) => void) | null>;
  onSharingChange?: (isSharing: boolean) => void;
}) {
  const room = useRoomContext();
  const onSharingChangeRef = React.useRef(onSharingChange);
  onSharingChangeRef.current = onSharingChange;

  React.useEffect(() => {
    if (toggleRef === undefined) return;

    toggleRef.current = (next: boolean) => {
      void room.localParticipant
        .setScreenShareEnabled(next, { audio: true })
        .then(() => {
          onSharingChangeRef.current?.(next);
        })
        .catch(() => {
          onSharingChangeRef.current?.(false);
          toast.error('Ekran ulashilmadi. Brauzer ruxsatini tekshiring.');
        });
    };

    return () => {
      toggleRef.current = null;
    };
  }, [room, toggleRef]);

  return null;
}

/** Ekran trekini ko'rsatadi (o'qituvchi uchun lokal preview ham shu). */
function ScreenStage({ isSharing }: { isSharing: boolean }) {
  const tracks = useTracks([Track.Source.ScreenShare], { onlySubscribed: false });
  const track = tracks[0];

  if (track === undefined) {
    return (
      // Oqim yo'q — bu VIDEO emas, UI holati: qora letterbox o'rniga mavzuga mos yuza.
      // (`text-fg` qora fon ustida yorug' rejimda o'qilmasdi — shuning uchun fon ham token.)
      <div className="flex min-h-40 flex-1 flex-col items-center justify-center gap-2 bg-surface-2 p-6 text-center">
        <MonitorOff className="size-6 text-muted" aria-hidden />
        <p className="text-sm text-muted">
          {isSharing
            ? 'Ekran oqimi kutilmoqda…'
            : "Hozir ekran ulashilmayapti. O'qituvchi yoqqanda shu yerda paydo bo'ladi."}
        </p>
      </div>
    );
  }

  return (
    <VideoTrack
      trackRef={track}
      // `bg-black` — video letterbox (DESIGN_GLOW: ataylab qoladi, bu oqlangan).
      className="h-full w-full bg-black object-contain"
      // Psixologik to'siq (AUDIT.md §F) — xavfsizlik emas.
      onContextMenu={(event) => event.preventDefault()}
    />
  );
}

/**
 * DIQQAT: modul darajasida, komponent ichida EMAS. `useLiveKitRoom` ning connect
 * effekti `onError` ga bog'langan (deps ichida) — inline arrow har renderda yangi
 * bo'lib, har WS-event renderida `room.connect()` qayta chaqirilar va konsol
 * "already connected to room" bilan to'lib sahifa qotib qolardi.
 */
function handleRoomError(): void {
  toast.error('Video serverda xatolik yuz berdi.');
}

export default function LiveKitStage({
  serverUrl,
  token,
  canPublish,
  isSharing,
  onSharingChange,
  toggleRef,
}: LiveKitStageProps) {
  return (
    <LiveKitRoom
      serverUrl={serverUrl}
      token={token}
      connect
      video={false}
      audio={false}
      className="flex min-h-0 flex-1 flex-col"
      onError={handleRoomError}
    >
      <RoomAudioRenderer />
      {canPublish ? (
        <ScreenShareBridge toggleRef={toggleRef} onSharingChange={onSharingChange} />
      ) : null}
      <ScreenStage isSharing={isSharing} />
    </LiveKitRoom>
  );
}
