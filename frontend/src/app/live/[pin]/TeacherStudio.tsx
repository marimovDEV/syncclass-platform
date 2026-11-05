'use client';

/**
 * O'qituvchi studiyasi (`>=1280px` — markazda slayd/IDE, o'ngda panel, pastda Floating Dock).
 *
 * Boshqaruv manbasi — faqat o'qituvchi (CONTRACTS.md §5: `SLIDE_CHANGE`, `LIVE_CODE_PATCH`,
 * `LASER_MOVE`, `SCREEN_SHARE_STATE`, `QUIZ_START`, `QUIZ_END`).
 * Yorliqlar `useHotkeys` orqali — Monaco/input ichida **ishlamaydi** (AUDIT.md §G1).
 */

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { Hash, LogOut, Users } from 'lucide-react';

import type { LiveCodePatchClientData, Slide } from '@/types/api';
import { isApiError } from '@/lib/api';
import { errorText } from '@/lib/format';
import { endRoom } from '@/lib/resources';
import { cn } from '@/lib/utils';
import { Badge, LiveBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { LoadingState } from '@/components/shared/states';
import { ConnectionBanner } from '@/components/live/ConnectionBanner';
import { FloatingDock } from '@/components/live/FloatingDock';
import { LaserOverlay } from '@/components/live/LaserOverlay';
import { LiveMonaco } from '@/components/live/LiveMonaco';
import { LobbyScreen } from '@/components/live/LobbyScreen';
import { OpenPanel } from '@/components/live/OpenPanel';
import { PollPanel } from '@/components/live/PollPanel';
import { createEndOnce, isSlideInteractiveLive } from '@/components/live/interactive';
import { ParticipantsPanel } from '@/components/live/ParticipantsPanel';
import { QuizModal } from '@/components/live/QuizModal';
import { ScreenShareView } from '@/components/live/ScreenShareView';
import { SlideRenderer } from '@/components/live/SlideRenderer';
import type { RoomSocket } from '@/hooks/useRoomSocket';
import { useAutoEnd } from '@/hooks/useAutoEnd';
import { useHotkeys } from '@/hooks/useHotkeys';
import {
  liveRoomActions,
  useLiveRoom,
  useActiveQuiz,
  useConfused,
  useFocusMap,
  useIsSharing,
  useLiveCode,
  useLiveCursor,
  useParticipants,
  useQuizProgress,
  useQuizResults,
  useActiveOpen,
  useActivePoll,
  useOpenResults,
  useOpenResultsSlide,
  useOpenUpdate,
  usePollProgress,
  usePollResults,
  usePollResultsSlide,
  useRoomStatus,
  useSlideIndex,
  useSyncedAt,
} from '@/store/useLiveRoom';
import type { LiveRoomInfo } from '@/app/live/[pin]/LiveRoomClient';

export interface TeacherStudioProps {
  pin: string;
  room: LiveRoomInfo;
  slides: Slide[];
  slidesLoading: boolean;
  socket: RoomSocket;
}

export function TeacherStudio({ pin, room, slides, slidesLoading, socket }: TeacherStudioProps) {

  const slideIndex = useSlideIndex();
  const code = useLiveCode();
  const cursor = useLiveCursor();
  const participants = useParticipants();
  const confused = useConfused();
  const focus = useFocusMap();
  const activeQuiz = useActiveQuiz();
  const quizResults = useQuizResults();
  const quizProgress = useQuizProgress();
  const activePoll = useActivePoll();
  const pollProgress = usePollProgress();
  const pollResults = usePollResults();
  const pollResultsSlide = usePollResultsSlide();
  const activeOpen = useActiveOpen();
  const openUpdate = useOpenUpdate();
  const openResults = useOpenResults();
  const openResultsSlide = useOpenResultsSlide();
  const isSharing = useIsSharing();
  const syncedAt = useSyncedAt();

  const wsStatus = useRoomStatus();
  const [lobby, setLobby] = React.useState(room.status === 'LOBBY');

  // CONTRACTS.md §13.2: `ROOM_STATE_SYNC.status` — server dars allaqachon `LIVE` desa
  // (masalan boshqa qurilmadan boshlangan, yoki reconnect), lobbida qotib qolinmaydi.
  React.useEffect(() => {
    if (wsStatus === 'LIVE') setLobby(false);
  }, [wsStatus]);
  const [laserActive, setLaserActive] = React.useState(false);
  const [codeMode, setCodeMode] = React.useState(false);
  // Darsni tugatish — qaytarib bo'lmaydigan amal (ABSENT reconciliation ishga tushadi),
  // shuning uchun slayd boshqaruvi yonidagi tugma tasdiq so'raydi.
  const [confirmEnd, setConfirmEnd] = React.useState(false);

  const shareToggleRef = React.useRef<((next: boolean) => void) | null>(null);

  const slide = slides[slideIndex] ?? null;
  const connected = socket.connection === 'open';
  const isCodeSlide = slide?.type === 'CODE';
  const isQuizSlide = slide?.type === 'QUIZ';
  const isPollSlide = slide?.type === 'POLL';
  const isOpenSlide = slide?.type === 'OPEN';
  const isInteractiveSlide = isQuizSlide || isPollSlide || isOpenSlide;

  /** Joriy slaydning interaktivi allaqachon ketyaptimi (dock tugmasi o'chadi). */
  const interactiveRunning = isSlideInteractiveLive(slide?.type ?? null, slideIndex, {
    quiz: activeQuiz,
    poll: activePoll,
    open: activeOpen,
  });

  // Slayd almashsa jonli kod rejimi avtomatik yopiladi.
  React.useEffect(() => {
    setCodeMode(false);
  }, [slideIndex]);

  /* ------------------------------ boshqaruvlar ----------------------------- */

  const gotoSlide = React.useCallback(
    (next: number) => {
      if (slides.length === 0) return;
      const target = Math.min(Math.max(0, next), slides.length - 1);
      if (target === slideIndex) return;
      const targetSlide = slides[target];
      if (targetSlide === undefined) return;

      if (socket.send('SLIDE_CHANGE', { slide_index: target })) {
        // Optimistik: server `SLIDE_CHANGE` ni `seq` bilan qaytarganda ustiga yoziladi.
        liveRoomActions.setLocalSlide(target, targetSlide.type);
      } else {
        toast.error('Aloqa yo‘q — slayd almashtirilmadi.');
      }
    },
    [slides, slideIndex, socket],
  );

  /**
   * Joriy slayd turiga qarab QUIZ / POLL / OPEN ni boshlaydi (`Q` yorlig'i va dock tugmasi).
   * Server savol, variantlar va muddatni slayd JSON idan o'zi o'qiydi — klient faqat
   * `slide_index` yuboradi (§16.3).
   */
  const startInteractive = React.useCallback(() => {
    if (slide === null || interactiveRunning) return;
    const payload = { slide_index: slideIndex };
    let sent = false;
    if (slide.type === 'QUIZ') sent = socket.send('QUIZ_START', payload);
    else if (slide.type === 'POLL') sent = socket.send('POLL_START', payload);
    else if (slide.type === 'OPEN') sent = socket.send('OPEN_START', payload);
    else return;
    if (!sent) toast.error('Aloqa yo‘q — savol boshlanmadi.');
  }, [slide, interactiveRunning, slideIndex, socket]);

  /*
   * §16.5: POLL/OPEN ni server o'zi yakunlamaydi — o'qituvchi klienti yuboradi.
   * `createEndOnce` — idempotent: "Yakunlash" tugmasi va taymer BIR XIL nusxani ishlatadi,
   * shuning uchun `*_END` ikki marta ketmaydi. `socket.send` barqaror (`useCallback`),
   * shuning uchun nusxa (va uning "yuborilganlar" to'plami) butun dars davomida yashaydi.
   */
  const sendWs = socket.send;
  const endPollOnce = React.useMemo(
    () => createEndOnce((pollId) => sendWs('POLL_END', { poll_id: pollId })),
    [sendWs],
  );
  const endOpenOnce = React.useMemo(
    () => createEndOnce((openId) => sendWs('OPEN_END', { open_id: openId })),
    [sendWs],
  );

  useAutoEnd({
    id: activePoll?.poll_id ?? null,
    endsAt: activePoll?.ends_at ?? null,
    enabled: connected,
    end: endPollOnce,
  });
  useAutoEnd({
    id: activeOpen?.open_id ?? null,
    endsAt: activeOpen?.ends_at ?? null,
    enabled: connected,
    end: endOpenOnce,
  });

  const endPollManually = React.useCallback(
    (pollId: string) => {
      if (!connected) {
        toast.error('Aloqa yo‘q — so‘rovnoma yakunlanmadi.');
        return;
      }
      endPollOnce(pollId);
    },
    [connected, endPollOnce],
  );

  const endOpenManually = React.useCallback(
    (openId: string) => {
      if (!connected) {
        toast.error('Aloqa yo‘q — savol yakunlanmadi.');
        return;
      }
      endOpenOnce(openId);
    },
    [connected, endOpenOnce],
  );

  const hideOpenAnswer = React.useCallback(
    (openId: string, answerId: string) => {
      if (!socket.send('OPEN_HIDE', { open_id: openId, answer_id: answerId })) {
        toast.error('Aloqa yo‘q — javob yashirilmadi.');
      }
    },
    [socket],
  );

  const endQuiz = React.useCallback(
    (quizId: string) => {
      if (!socket.send('QUIZ_END', { quiz_id: quizId })) {
        toast.error('Aloqa yo‘q — quiz yopilmadi.');
      }
    },
    [socket],
  );

  const toggleShare = React.useCallback(() => {
    const toggle = shareToggleRef.current;
    if (toggle === null) {
      toast.error('Video server hali ulanmadi. Bir lahzadan keyin urinib ko‘ring.');
      return;
    }
    // Klik zanjiri ichida chaqiriladi — `getDisplayMedia` ruxsati saqlanadi.
    toggle(!isSharing);
  }, [isSharing]);

  const handleSharingChange = React.useCallback(
    (next: boolean) => {
      socket.send('SCREEN_SHARE_STATE', { is_sharing: next });
    },
    [socket],
  );

  const toggleFullscreen = React.useCallback(() => {
    if (typeof document === 'undefined') return;
    if (document.fullscreenElement === null) {
      void document.documentElement.requestFullscreen().catch(() => undefined);
    } else {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, []);

  const localRevRef = React.useRef(0);

  const handlePatch = React.useCallback(
    (data: LiveCodePatchClientData) => {
      socket.send('LIVE_CODE_PATCH', data);
      // O'qituvchining o'z ekrani uchun optimistik ko'rinish (server echo keyin keladi).
      // `code_rev` monoton bo'lib qolishi uchun serverdagi oxirgi revdan oshiriladi.
      localRevRef.current = Math.max(localRevRef.current, useLiveRoom.getState().codeRev) + 1;
      liveRoomActions.setLocalCode(data.code, localRevRef.current, data.cursor ?? null);
    },
    [socket],
  );

  const endMutation = useMutation({
    mutationFn: () => endRoom(pin),
    onSuccess: (summary) => {
      toast.success('Dars tugatildi. Davomat yakunlandi.');
      // `RoomEndOut` sanoqlari — SERVER qiymati (ABSENT reconciliation, AUDIT.md §D3).
      // Yakun ekrani (`LiveRoomClient`) ularni ko'rsatadi va hisobotga havola beradi.
      setConfirmEnd(false);
      liveRoomActions.setEndSummary(summary);
    },
    onError: (error: unknown) => {
      toast.error(
        isApiError(error)
          ? errorText(error.code, error.message)
          : 'Darsni tugatib bo‘lmadi. Qayta urinib ko‘ring.',
      );
    },
  });

  /* -------------------------------- yorliqlar ------------------------------ */

  useHotkeys(
    {
      next: () => gotoSlide(slideIndex + 1),
      prev: () => gotoSlide(slideIndex - 1),
      laser: () => setLaserActive((value) => !value),
      code: () => {
        if (isCodeSlide) setCodeMode((value) => !value);
      },
      quiz: startInteractive,
      fullscreen: toggleFullscreen,
      escape: () => {
        setCodeMode(false);
        setLaserActive(false);
      },
    },
    { enabled: !lobby },
  );

  /* --------------------------------- lobби --------------------------------- */

  const startLesson = (): void => {
    const first = slides[0];
    if (first === undefined) {
      toast.error('Prezentatsiyada slayd yo‘q.');
      return;
    }
    if (socket.send('SLIDE_CHANGE', { slide_index: 0 })) {
      liveRoomActions.setLocalSlide(0, first.type);
      setLobby(false);
    } else {
      toast.error('Aloqa yo‘q — dars boshlanmadi.');
    }
  };

  const banner = (
    <ConnectionBanner
      connection={socket.connection}
      attempt={socket.attempt}
      ticketError={socket.ticketError}
      onReconnect={socket.reconnect}
    />
  );

  if (lobby) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-4 pt-3">{banner}</div>
        <LobbyScreen
          role="TEACHER"
          pinCode={room.pin_code}
          joinUrl={room.join_url}
          participants={participants}
          presentationTitle={room.presentation.title}
          slidesCount={room.presentation.slides_count}
          canStart={connected && slides.length > 0}
          onStart={startLesson}
          exitHref="/teacher"
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ------------------------------- yuqori ------------------------------ */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        {/*
          DESIGN_GLOW §1 — YAGONA yorqin LIVE nishoni. Faqat WS haqiqatan ochiq bo'lsa:
          aloqa uzilganda porlab turgan "Jonli" yolg'on bo'lardi (holatni banner aytadi).
        */}
        {connected ? <LiveBadge /> : null}
        <Badge variant="solid" className="tabular-nums">
          <Hash aria-hidden />
          {room.pin_code}
        </Badge>
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
          {room.presentation.title}
        </p>
        <Badge variant="neutral" className="tabular-nums">
          <Users aria-hidden />
          {participants.length}
        </Badge>
        {/* Darsni TUGATMASDAN chiqish (dock dagi "Yakunlash" dan farqli) — xona LIVE qoladi. */}
        <Button
          asChild
          variant="ghost"
          size="icon-sm"
          aria-label="Chiqish (dars tugamaydi)"
          title="Chiqish (dars tugamaydi)"
        >
          <Link href="/teacher">
            <LogOut aria-hidden />
          </Link>
        </Button>
      </header>

      <div className="shrink-0 px-4 pt-2">{banner}</div>

      {/* ------------------------------ asosiy ------------------------------ */}
      <div className="flex min-h-0 flex-1 flex-col split:flex-row studio:flex-row">
        <div className="relative flex min-h-0 flex-1 flex-col">
          {slidesLoading && slides.length === 0 ? (
            <LoadingState label="Slaydlar yuklanmoqda…" className="flex-1" />
          ) : codeMode && slide !== null && slide.type === 'CODE' ? (
            <div className="flex min-h-0 flex-1 flex-col p-3 studio:p-4">
              <LiveMonaco
                key={`monaco-${slideIndex}`}
                lang={slide.code_lang}
                slideIndex={slideIndex}
                initialCode={code.length > 0 ? code : slide.starter_code}
                serverCode={code}
                syncToken={syncedAt}
                onPatch={handlePatch}
                className="min-h-0 flex-1"
              />
            </div>
          ) : (
            <SlideRenderer
              slide={slide}
              liveCode={code}
              cursor={cursor}
              liveCodeActive={isCodeSlide && code.length > 0}
              revealQuizAnswer
              frame={interactiveRunning ? 'accent' : 'primary'}
              allowSelect
              interactive={
                slide?.type === 'POLL' ? (
                  <PollPanel
                    role="TEACHER"
                    slide={slide}
                    activePoll={activePoll}
                    progress={pollProgress}
                    results={pollResults}
                    resultsSlide={pollResultsSlide}
                    votedPollId={null}
                    myVote={null}
                    onStart={startInteractive}
                    onEnd={endPollManually}
                    disabled={!connected}
                  />
                ) : slide?.type === 'OPEN' ? (
                  <OpenPanel
                    role="TEACHER"
                    slide={slide}
                    activeOpen={activeOpen}
                    update={openUpdate}
                    results={openResults}
                    resultsSlide={openResultsSlide}
                    answeredOpenId={null}
                    myAnswer={null}
                    rateLimitedAt={null}
                    onStart={startInteractive}
                    onEnd={endOpenManually}
                    onHide={hideOpenAnswer}
                    disabled={!connected}
                  />
                ) : undefined
              }
            />
          )}

          {/* Lazer — faqat lazer rejimida hodisalarni ushlaydi (AUDIT.md §G4). */}
          <LaserOverlay
            mode="teacher"
            active={laserActive && !codeMode}
            onMove={(data) => socket.send('LASER_MOVE', data)}
          />

          {/* Floating Dock — pastda, markazda. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-3">
            <div className="max-w-full overflow-x-auto scrollbar-thin">
              <FloatingDock
                slideIndex={slideIndex}
                totalSlides={slides.length}
                laserActive={laserActive}
                codeActive={codeMode}
                isSharing={isSharing}
                canCode={isCodeSlide}
                canQuiz={isInteractiveSlide}
                quizRunning={interactiveRunning}
                // Video server manzili tokendan keladi (`LiveKitTokenOut.url`); tayyor
                // bo'lmasa `toggleShare` aniq xabar beradi.
                canShare
                onPrev={() => gotoSlide(slideIndex - 1)}
                onNext={() => gotoSlide(slideIndex + 1)}
                onToggleLaser={() => setLaserActive((value) => !value)}
                onToggleCode={() => {
                  if (isCodeSlide) setCodeMode((value) => !value);
                }}
                onStartQuiz={startInteractive}
                onToggleShare={toggleShare}
                onFullscreen={toggleFullscreen}
                onEnd={() => setConfirmEnd(true)}
                disabled={!connected || endMutation.isPending}
                // Modal (`DialogContent` — `.glass`) ochiq bo'lsa dock blursiz: bitta blur qatlami.
                solid={activeQuiz !== null || quizResults !== null || confirmEnd}
              />
            </div>
          </div>
        </div>

        {/* ------------------------------- o'ng panel ------------------------- */}
        <div className="hidden shrink-0 flex-col gap-3 border-t border-border p-3 split:flex split:w-72 split:border-l split:border-t-0 studio:flex studio:w-[25%] studio:max-w-sm studio:border-l studio:border-t-0">
          {/*
            LiveKit xonasi — YAGONA instansiya. Ulashish o'chiq bo'lsa ham **mount holatda**
            qoladi (`hidden`), aks holda tugma bosilganda ulanishni kutish kerak bo'lib,
            `getDisplayMedia` uchun klik ruxsati yo'qoladi. Ikkinchi instansiya ochilsa
            LiveKit bir xil identity bilan ikki ulanishni rad etadi — shuning uchun bitta.
          */}
          <div className={cn('flex min-h-0 flex-col', isSharing ? 'h-48' : 'hidden')}>
            <ScreenShareView
              pin={pin}
              role="TEACHER"
              isSharing={isSharing}
              onSharingChange={handleSharingChange}
              toggleRef={shareToggleRef}
            />
          </div>

          <ParticipantsPanel
            participants={participants}
            confused={confused}
            focus={focus}
            className="min-h-0 flex-1"
          />
        </div>
      </div>

      <Dialog open={confirmEnd} onOpenChange={setConfirmEnd}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Darsni tugatamizmi?</DialogTitle>
            <DialogDescription>
              Xona yopiladi, o&apos;quvchilar chiqariladi va davomat yakunlanadi (kelmaganlar{' '}
              <span className="font-medium">ABSENT</span> deb belgilanadi). Bu amalni qaytarib
              bo&apos;lmaydi.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmEnd(false)}>
              Bekor qilish
            </Button>
            <Button
              variant="danger"
              loading={endMutation.isPending}
              onClick={() => endMutation.mutate()}
            >
              Ha, tugatish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <QuizModal
        role="TEACHER"
        quiz={activeQuiz}
        results={quizResults}
        progress={quizProgress}
        answeredQuizId={null}
        selectedOption={null}
        onAnswer={() => undefined}
        onEnd={endQuiz}
        onCloseResults={liveRoomActions.clearQuizResults}
        participantCount={participants.length}
      />
    </div>
  );
}
