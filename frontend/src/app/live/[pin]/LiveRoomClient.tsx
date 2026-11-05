'use client';

/**
 * Jonli xonaning klient ildizi: auth guard → xonaga kirish → WS ulanish → rol bo'yicha
 * tarmoqlanish (`TeacherStudio` / `StudentRoom`).
 *
 * Oqim (CONTRACTS.md §4, §5.5):
 * - STUDENT: `POST /rooms/{pin}/join` (guruh tekshiruvi + davomat) → `RoomJoinOut`.
 *   Slaydlar **shu javobdan** olinadi (`slides` — §3 sxemasidagi xom JSONB massivi).
 *   Qo'shimcha so'rov yo'q va `GET /presentations/{id}` ning 403 i (ownership guard) tegmaydi.
 * - TEACHER: `GET /rooms/{pin}` → `RoomOut`, slaydlar `GET /presentations/{id}` dan
 *   (`slides_data` — builder bilan bir xil manba, o'qituvchi egasi, 200 keladi).
 *
 * `slides` xom JSONB bo'lgani uchun `parseSlides()` ni o'tadi: `type` diskriminatori va
 * majburiy maydonlari to'g'ri kelmagan element **tashlab yuboriladi** (AUDIT.md §D5 — noto'g'ri
 * slayd frontendni yiqitmasligi kerak), qolgani `index` bo'yicha saralanadi.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { MotionConfig } from 'framer-motion';
import { PartyPopper } from 'lucide-react';

import type { PresentationBrief, SessionStatus, Slide } from '@/types/api';
import { isApiError } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { errorText } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import { getPresentation, getRoom, joinRoom } from '@/lib/resources';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { LiveShell } from '@/components/shared/AppShell';
import { ErrorState, LoadingState } from '@/components/shared/states';
import { parseSlides } from '@/components/live/slides';
import { useRoomSocket } from '@/hooks/useRoomSocket';
import {
  liveRoomActions,
  useLiveRoom,
  useEndSummary,
  useLastWsError,
  useSessionEnded,
} from '@/store/useLiveRoom';
import { StudentRoom } from '@/app/live/[pin]/StudentRoom';
import { TeacherStudio } from '@/app/live/[pin]/TeacherStudio';

/**
 * Panel o'zi holat sifatida ko'rsatadigan xato bo'lsa `true` (ustiga toast kerak emas):
 * - `ALREADY_VOTED` → `PollPanel` "Ovoz berildi" holatiga o'tadi;
 * - `RATE_LIMITED` — FAQAT ochiq savol faol bo'lsa (`OpenPanel` "biroz sekinroq" deydi).
 *   Boshqa joyda kelgan `RATE_LIMITED` toast bo'lib chiqadi.
 */
function isHandledInline(code: string): boolean {
  if (code === 'ALREADY_VOTED') return true;
  return code === 'RATE_LIMITED' && useLiveRoom.getState().activeOpen !== null;
}

/** Ikki endpointdan keladigan umumiy xona ma'lumoti. */
export interface LiveRoomInfo {
  session_id: string;
  pin_code: string;
  status: SessionStatus;
  current_slide_index: number;
  presentation: PresentationBrief;
  join_url: string;
}

export function LiveRoomClient({ pin }: { pin: string }) {
  const router = useRouter();
  const { user, role, isLoading, isPending, isAuthenticated } = useSession();
  const isTeacher = role === 'TEACHER' || role === 'ADMIN';

  /* ------------------------------- auth guard ------------------------------ */

  React.useEffect(() => {
    if (isLoading || isPending) return;
    if (!isAuthenticated) {
      router.replace(`/login?next=${encodeURIComponent(`/live/${pin}`)}`);
      return;
    }
    if (user !== null && !user.is_onboarded) router.replace('/onboarding');
  }, [isLoading, isPending, isAuthenticated, user, router, pin]);

  /* ---------------------- store ni xona bo'yicha tozalash ------------------- */

  React.useEffect(() => {
    liveRoomActions.resetRoom();
    return () => liveRoomActions.resetRoom();
  }, [pin]);

  /* ------------------------------ xonaga kirish ---------------------------- */

  const teacherRoom = useQuery({
    queryKey: queryKeys.room(pin),
    queryFn: () => getRoom(pin),
    enabled: isAuthenticated && isTeacher && pin.length > 0,
    retry: 1,
    staleTime: 30_000,
  });

  const studentJoin = useMutation({ mutationFn: () => joinRoom(pin) });
  const studentJoinRef = React.useRef(studentJoin.mutate);
  studentJoinRef.current = studentJoin.mutate;

  const shouldJoin = isAuthenticated && !isTeacher && pin.length > 0;
  React.useEffect(() => {
    if (!shouldJoin) return;
    studentJoinRef.current();
  }, [shouldJoin, pin]);

  const room: LiveRoomInfo | null = React.useMemo(() => {
    if (isTeacher) {
      const data = teacherRoom.data;
      if (data === undefined) return null;
      return {
        session_id: data.session_id,
        pin_code: data.pin_code,
        status: data.status,
        // `RoomStateOut` da maydon nomi `slide_index` (`current_slide_index` — faqat `RoomJoinOut`).
        current_slide_index: data.slide_index,
        presentation: data.presentation,
        join_url: data.join_url,
      };
    }
    const data = studentJoin.data;
    if (data === undefined) return null;
    return {
      session_id: data.session_id,
      pin_code: data.pin_code,
      status: data.status,
      current_slide_index: data.current_slide_index,
      presentation: data.presentation,
      // O'quvchiga `join_url` kerak emas (QR ni o'qituvchi ko'rsatadi).
      join_url: `/live/${data.pin_code}`,
    };
  }, [isTeacher, teacherRoom.data, studentJoin.data]);

  /* -------------------------------- slaydlar ------------------------------- */

  // O'qituvchi yo'li: prezentatsiya egasi, `slides_data` to'liq keladi.
  // O'quvchi uchun bu so'rov YUBORILMAYDI — slaydlar `join` javobida bor (§5.5).
  const presentationId = room?.presentation.id ?? '';
  const presentation = useQuery({
    queryKey: queryKeys.presentation(presentationId),
    queryFn: () => getPresentation(presentationId),
    enabled: isTeacher && presentationId.length > 0,
    staleTime: 5 * 60_000,
    retry: (failureCount, error) => {
      // 4xx — qayta urinish befoyda (ownership guard).
      if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
      return failureCount < 1;
    },
  });

  const slides: Slide[] = React.useMemo(() => {
    if (isTeacher) return parseSlides(presentation.data?.slides_data);
    return parseSlides(studentJoin.data?.slides);
  }, [isTeacher, presentation.data, studentJoin.data]);

  const slidesLoading = isTeacher ? presentation.isPending : studentJoin.isPending;

  /**
   * Slayd matni yo'q holati. O'qituvchida — `GET /presentations/{id}` 4xx qaytardi.
   * O'quvchida — `join` javobida `slides` kelmadi (eski backend), lekin prezentatsiyada
   * slayd bor. Ikki holatda ham UI yiqilmaydi: jonli kod, quiz va ekran ulashish ishlaydi.
   */
  const slidesUnavailable = isTeacher
    ? presentation.isError && isApiError(presentation.error) && presentation.error.status >= 400
    : !studentJoin.isPending &&
      studentJoin.data !== undefined &&
      slides.length === 0 &&
      room !== null &&
      room.presentation.slides_count > 0;

  /* ---------------------------------- WS ----------------------------------- */

  const socket = useRoomSocket({ pin, enabled: room !== null });
  const sessionEnded = useSessionEnded();
  const endSummary = useEndSummary();

  // CONTRACTS.md §5 `ERROR{code,message}` — masalan `FORBIDDEN_EVENT`. Jim yutilmaydi.
  const lastWsError = useLastWsError();
  React.useEffect(() => {
    if (lastWsError === null) return;
    // Bu kodlar panel ichida holat sifatida ko'rsatiladi (§16.3) — ustiga toast kerak emas.
    if (isHandledInline(lastWsError.code)) return;
    toast.error(errorText(lastWsError.code, lastWsError.message));
  }, [lastWsError]);

  /* ------------------------------- holatlar -------------------------------- */

  if (isLoading || isPending || !isAuthenticated) {
    return (
      <LiveShell>
        <LoadingState label="Sessiya tekshirilmoqda…" className="flex-1" />
      </LiveShell>
    );
  }

  const joinError = isTeacher ? teacherRoom.error : studentJoin.error;
  if (joinError !== null && joinError !== undefined) {
    return (
      <LiveShell>
        <div className="flex flex-1 flex-col items-center justify-center p-6">
          <ErrorState
            error={joinError}
            title="Xonaga kirib bo‘lmadi"
            onRetry={() => {
              if (isTeacher) void teacherRoom.refetch();
              else studentJoin.mutate();
            }}
          />
          <Button variant="ghost" className="mt-4" onClick={() => router.push(isTeacher ? '/teacher' : '/dashboard')}>
            Bosh sahifaga qaytish
          </Button>
        </div>
      </LiveShell>
    );
  }

  if (room === null) {
    return (
      <LiveShell>
        <LoadingState label="Xonaga kirmoqdamiz…" className="flex-1" />
      </LiveShell>
    );
  }

  if (sessionEnded || room.status === 'ENDED') {
    return (
      <LiveShell>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <PartyPopper className="size-10 text-primary" aria-hidden />
          <h1 className="text-xl font-semibold text-fg">Dars tugadi</h1>
          <p className="max-w-sm text-sm text-muted">
            Rahmat! Davomat va quiz natijalari saqlandi.
          </p>

          {/*
            `RoomEndOut` — SERVER sanoqlari. Klientda hisoblanmaydi: `ABSENT` faqat server
            reconciliation da qo'yiladi (AUDIT.md §D3), jonli ro'yxat esa faqat ulanganlarni biladi.
          */}
          {isTeacher && endSummary !== null ? (
            <dl
              className="mt-2 grid w-full max-w-sm grid-cols-3 gap-2"
              aria-label="Davomat yakuni"
            >
              <div className="rounded-xl border border-border bg-surface p-3">
                <dt className="text-xs text-muted">Keldi</dt>
                <dd className="text-2xl font-semibold tabular-nums text-success">
                  {endSummary.present_count}
                </dd>
              </div>
              <div className="rounded-xl border border-border bg-surface p-3">
                <dt className="text-xs text-muted">Kechikdi</dt>
                <dd className="text-2xl font-semibold tabular-nums text-fg">
                  {endSummary.late_count}
                </dd>
              </div>
              <div className="rounded-xl border border-border bg-surface p-3">
                <dt className="text-xs text-muted">Kelmadi</dt>
                <dd className="text-2xl font-semibold tabular-nums text-danger">
                  {endSummary.absent_count}
                </dd>
              </div>
            </dl>
          ) : null}

          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {isTeacher ? (
              <Button onClick={() => router.push(`/teacher/sessions/${room.pin_code}/report`)}>
                Hisobotni ko&apos;rish
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => router.push(isTeacher ? '/teacher' : '/dashboard')}>
              Bosh sahifa
            </Button>
          </div>
        </div>
      </LiveShell>
    );
  }

  return (
    <LiveShell>
      {/*
        `prefers-reduced-motion` (DESIGN_GLOW §5): xonadagi BARCHA framer-motion komponentlari
        (slayd o'tishi, lobbi "pop", quiz, diagramma, bulut) shu sozlamani meros oladi —
        `transform`/`layout` harakati o'chadi, glow (statik `box-shadow`) esa qoladi.
      */}
      <MotionConfig reducedMotion="user">
      {isTeacher ? (
        <TeacherStudio
          pin={pin}
          room={room}
          slides={slides}
          slidesLoading={slidesLoading}
          socket={socket}
        />
      ) : (
        <StudentRoom
          pin={pin}
          room={room}
          slides={slides}
          slidesLoading={slidesLoading}
          slidesUnavailable={slidesUnavailable}
          socket={socket}
        />
      )}
      </MotionConfig>
    </LiveShell>
  );
}
