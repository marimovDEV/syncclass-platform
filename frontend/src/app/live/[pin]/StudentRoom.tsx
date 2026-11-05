'use client';

/**
 * O'quvchi xonasi. `<768px` da **Mobile Companion**, kattaroq ekranda slayd + yon panel.
 *
 * O'quvchi hech narsani boshqarmaydi: faqat `CONFUSED_PING`, `FOCUS_CHANGE`, `QUIZ_ANSWER`
 * yuboradi (CONTRACTS.md §5). Monaco bu ekranda **yo'q** (AUDIT.md §G2), lazer `lerp` bilan
 * silliqlanadi (§G4), focus kuzatuvi ochiq e'lon qilinadi (§F).
 */

import * as React from 'react';
import Link from 'next/link';
import { Hash, LogOut, Users } from 'lucide-react';

import type { Slide } from '@/types/api';
import { cn } from '@/lib/utils';
import { Badge, LiveBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/shared/states';
import { XpBadge } from '@/components/shared/XpBadge';
import { useSession } from '@/lib/auth';
import { ConnectionBanner, FocusNotice } from '@/components/live/ConnectionBanner';
import { ConfusedButton } from '@/components/live/ConfusedButton';
import { LaserOverlay } from '@/components/live/LaserOverlay';
import { LobbyScreen } from '@/components/live/LobbyScreen';
import { MobileCompanion } from '@/components/live/MobileCompanion';
import { OpenPanel } from '@/components/live/OpenPanel';
import { PollPanel } from '@/components/live/PollPanel';
import { isSlideInteractiveLive } from '@/components/live/interactive';
import { QuizModal } from '@/components/live/QuizModal';
import { ScreenShareView } from '@/components/live/ScreenShareView';
import { SlideRenderer } from '@/components/live/SlideRenderer';
import { useFocusTracker } from '@/hooks/useFocusTracker';
import type { RoomSocket } from '@/hooks/useRoomSocket';
import {
  liveRoomActions,
  useActiveQuiz,
  useAnsweredQuizId,
  useIsSharing,
  useLiveCode,
  useLiveCursor,
  useParticipantCount,
  useParticipants,
  useQuizResults,
  useSelectedOption,
  useActiveOpen,
  useActivePoll,
  useAnsweredOpenId,
  useMyOpenAnswer,
  useMyPollVote,
  useOpenRateLimitedAt,
  useOpenResults,
  useOpenResultsSlide,
  usePollResults,
  usePollResultsSlide,
  useVotedPollId,
  useRoomStatus,
  useSlideChangeCount,
  useSlideIndex,
} from '@/store/useLiveRoom';
import type { LiveRoomInfo } from '@/app/live/[pin]/LiveRoomClient';

/** `companion:` breakpoint (<768px) ni JS da aniqlash — ikki daraxt bir vaqtda mount bo'lmasin. */
function useIsCompanion(): boolean {
  const [compact, setCompact] = React.useState(false);

  React.useEffect(() => {
    const mql = window.matchMedia('(max-width: 767px)');
    const sync = (): void => setCompact(mql.matches);
    sync();
    mql.addEventListener('change', sync);
    return () => mql.removeEventListener('change', sync);
  }, []);

  return compact;
}

export interface StudentRoomProps {
  pin: string;
  room: LiveRoomInfo;
  slides: Slide[];
  slidesLoading: boolean;
  /**
   * `POST /rooms/{pin}/join` javobida `slides` kelmadi (CONTRACTS.md §5.5), lekin
   * prezentatsiyada slayd bor — ya'ni slayd matni mavjud emas. Jonli kod, quiz va ekran
   * ulashish baribir ishlaydi, shuning uchun UI yiqilmaydi, faqat izoh ko'rsatiladi.
   */
  slidesUnavailable: boolean;
  socket: RoomSocket;
}

export function StudentRoom({
  pin,
  room,
  slides,
  slidesLoading,
  slidesUnavailable,
  socket,
}: StudentRoomProps) {
  const { user } = useSession();
  const compact = useIsCompanion();

  const slideIndex = useSlideIndex();
  const slideChangeCount = useSlideChangeCount();
  const wsStatus = useRoomStatus();
  const code = useLiveCode();
  const cursor = useLiveCursor();
  const participantCount = useParticipantCount();
  const participants = useParticipants();
  const activeQuiz = useActiveQuiz();
  const quizResults = useQuizResults();
  const answeredQuizId = useAnsweredQuizId();
  const selectedOption = useSelectedOption();
  const activePoll = useActivePoll();
  const pollResults = usePollResults();
  const pollResultsSlide = usePollResultsSlide();
  const votedPollId = useVotedPollId();
  const myPollVote = useMyPollVote();
  const activeOpen = useActiveOpen();
  const openResults = useOpenResults();
  const openResultsSlide = useOpenResultsSlide();
  const answeredOpenId = useAnsweredOpenId();
  const myOpenAnswer = useMyOpenAnswer();
  const openRateLimitedAt = useOpenRateLimitedAt();
  const isSharing = useIsSharing();

  const connected = socket.connection === 'open';
  const slide = slides[slideIndex] ?? null;

  /* --------------------------- focus tracker (§F) -------------------------- */

  const sendFocus = React.useCallback(
    (isFocused: boolean) => {
      socket.send('FOCUS_CHANGE', { is_focused: isFocused });
    },
    [socket],
  );

  const focusState = useFocusTracker({ enabled: connected, onChange: sendFocus });

  /* ------------------------------- amallar -------------------------------- */

  const sendConfused = React.useCallback((): boolean => socket.send('CONFUSED_PING', {}), [socket]);

  const answerQuiz = React.useCallback(
    (quizId: string, selectedIndex: number, timeMs: number) => {
      if (socket.send('QUIZ_ANSWER', { quiz_id: quizId, selected_index: selectedIndex, time_ms: timeMs })) {
        liveRoomActions.markQuizAnswered(quizId, selectedIndex);
      }
    },
    [socket],
  );

  /** `POLL_VOTE` — bir o'quvchi, bir ovoz. Takror bo'lsa server `ALREADY_VOTED` → store shu holatga o'tadi. */
  const votePoll = React.useCallback(
    (pollId: string, selectedIndex: number) => {
      if (socket.send('POLL_VOTE', { poll_id: pollId, selected_index: selectedIndex })) {
        liveRoomActions.markPollVoted(pollId, selectedIndex);
      }
    },
    [socket],
  );

  /** `OPEN_ANSWER` — oxirgisi yoziladi; 1 javob / 2 s (`RATE_LIMITED`). Yuborilgan bo'lsa `true`. */
  const answerOpen = React.useCallback(
    (openId: string, text: string): boolean => {
      const sent = socket.send('OPEN_ANSWER', { open_id: openId, text });
      if (sent) liveRoomActions.markOpenAnswered(openId, text);
      return sent;
    },
    [socket],
  );

  /* -------------------------------- bo'laklar ------------------------------ */

  /** POLL/OPEN slayd uchun jonli panel (desktop va mobil bir xil komponent). */
  const interactivePanel = (compactPanel: boolean): React.ReactNode =>
    slide?.type === 'POLL' ? (
      <PollPanel
        role="STUDENT"
        slide={slide}
        activePoll={activePoll}
        progress={null}
        results={pollResults}
        resultsSlide={pollResultsSlide}
        votedPollId={votedPollId}
        myVote={myPollVote}
        onVote={votePoll}
        disabled={!connected}
        compact={compactPanel}
      />
    ) : slide?.type === 'OPEN' ? (
      <OpenPanel
        role="STUDENT"
        slide={slide}
        activeOpen={activeOpen}
        update={null}
        results={openResults}
        resultsSlide={openResultsSlide}
        answeredOpenId={answeredOpenId}
        myAnswer={myOpenAnswer}
        rateLimitedAt={openRateLimitedAt}
        onAnswer={answerOpen}
        disabled={!connected}
        compact={compactPanel}
      />
    ) : undefined;

  /** Hozir ovoz/javob kutayotgan interaktiv bormi (mobilda slayd tabiga o'tish uchun). */
  const interactiveActive = activePoll !== null || activeOpen !== null;

  /** Joriy slaydning interaktivi hozir javob kutyaptimi — ramka firuza nurga o'tadi. */
  const slideInteractiveLive = isSlideInteractiveLive(slide?.type ?? null, slideIndex, {
    quiz: activeQuiz,
    poll: activePoll,
    open: activeOpen,
  });
  const slideFrame = slideInteractiveLive ? 'accent' : 'primary';

  /** Quiz modali (`.glass`) ochiqmi — mobil pastki panel shu paytda blursiz bo'ladi. */
  const modalOpen = activeQuiz !== null || quizResults !== null;

  const banner = (
    <ConnectionBanner
      connection={socket.connection}
      attempt={socket.attempt}
      ticketError={socket.ticketError}
      onReconnect={socket.reconnect}
    />
  );

  const slidesNotice = slidesUnavailable ? (
    <p className="rounded-xl border border-border bg-surface-2 px-3 py-2 text-xs text-fg">
      Slayd matni server tomonidan berilmadi. Jonli kod, quiz va ekran ulashish ishlashda davom
      etadi — o&apos;qituvchi ekranini kuzatib boring.
    </p>
  ) : null;

  const focusNotice = <FocusNotice reportedAway={focusState.reportedAway} />;

  const screenShare = (
    <ScreenShareView pin={pin} role="STUDENT" isSharing={isSharing} className="min-h-40" />
  );

  const quizModal = (
    <QuizModal
      role="STUDENT"
      quiz={activeQuiz}
      results={quizResults}
      progress={null}
      answeredQuizId={answeredQuizId}
      selectedOption={selectedOption}
      onAnswer={answerQuiz}
      onEnd={() => undefined}
      onCloseResults={liveRoomActions.clearQuizResults}
      participantCount={participantCount}
    />
  );

  /* --------------------------------- lobби --------------------------------- */

  /*
   * Lobbi sharti (CONTRACTS.md §13.2). Ikkala signal ham kerak:
   * - `status` faqat `ROOM_STATE_SYNC` snapshotida keladi (ulanish paytida), shuning uchun
   *   WS uzilmagan holda dars boshlansa o'quvchi buni `SLIDE_CHANGE` dan biladi.
   * - O'qituvchi o'quvchining WS i uzilgan paytda darsni boshlasa, reconnect da `SLIDE_CHANGE`
   *   kelmaydi — o'shanda snapshotdagi `status: 'LIVE'` lobbidan chiqaradi.
   * Snapshot hali kelmagan bo'lsa (`null`) — `join` javobidagi holat ishlatiladi.
   */
  const inLobby = (wsStatus ?? room.status) === 'LOBBY' && slideChangeCount === 0;

  if (inLobby) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-4 pt-3">{banner}</div>
        <LobbyScreen
          role="STUDENT"
          pinCode={room.pin_code}
          joinUrl={room.join_url}
          participants={participants}
          presentationTitle={room.presentation.title}
          slidesCount={room.presentation.slides_count}
          exitHref="/dashboard"
        />
        {quizModal}
      </div>
    );
  }

  /* ------------------------------ mobil rejim ------------------------------ */

  if (compact) {
    return (
      <>
        <MobileCompanion
          slide={slide}
          liveCode={code}
          cursor={cursor}
          slideIndex={slideIndex}
          totalSlides={slides.length}
          activeQuiz={activeQuiz}
          interactive={interactivePanel(true)}
          interactiveActive={interactiveActive}
          live={connected}
          frame={slideFrame}
          solidNav={modalOpen}
          isSharing={isSharing}
          onConfused={sendConfused}
          disabled={!connected}
          banner={
            <>
              {banner}
              {slidesNotice}
            </>
          }
          focusNotice={focusNotice}
          screenShare={screenShare}
        />
        {quizModal}
      </>
    );
  }

  /* ----------------------------- desktop rejim ----------------------------- */

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        {/* DESIGN_GLOW §1 — yagona yorqin LIVE nishoni; faqat WS ochiq bo'lsa. */}
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
          {participantCount}
        </Badge>
        {user !== null ? <XpBadge xp={user.xp_points} size="sm" animateOnChange /> : null}
        {/* Darsdan chiqish — xona ochiq qoladi, PIN bilan qayta kirish mumkin. */}
        <Button
          asChild
          variant="ghost"
          size="icon-sm"
          aria-label="Darsdan chiqish"
          title="Darsdan chiqish"
        >
          <Link href="/dashboard">
            <LogOut aria-hidden />
          </Link>
        </Button>
      </header>

      <div className="shrink-0 space-y-2 px-4 pt-2">
        {banner}
        {slidesNotice}
      </div>

      <div className="flex min-h-0 flex-1 flex-col split:flex-row studio:flex-row">
        <div className="relative flex min-h-0 flex-1 flex-col">
          {isSharing ? (
            <div className="flex min-h-0 flex-1 flex-col p-3">{screenShare}</div>
          ) : slidesLoading && slides.length === 0 && !slidesUnavailable ? (
            <LoadingState label="Slaydlar yuklanmoqda…" className="flex-1" />
          ) : (
            <SlideRenderer
              slide={slide}
              liveCode={code}
              cursor={cursor}
              liveCodeActive={slide?.type === 'CODE' && code.length > 0}
              interactive={interactivePanel(false)}
              frame={slideFrame}
            />
          )}

          {/* O'qituvchi lazeri — `lerp` bilan silliqlanadi (AUDIT.md §G4). */}
          <LaserOverlay mode="student" />
        </div>

        <aside
          className={cn(
            'flex shrink-0 flex-col gap-3 border-t border-border p-3',
            'split:w-64 split:border-l split:border-t-0 studio:w-72 studio:border-l studio:border-t-0',
          )}
        >
          {focusNotice}

          <ConfusedButton onPing={sendConfused} disabled={!connected} size="xl" />

          <p className="text-xs text-muted">
            🐢 tugmasi <span className="font-medium text-fg">anonim</span>: o&apos;qituvchi faqat
            umumiy foizni ko&apos;radi, kim bosganini ko&apos;rmaydi.
          </p>

          <div className="mt-auto rounded-xl border border-border bg-surface p-3 text-xs text-muted">
            <p className="font-medium text-fg">Slayd {slideIndex + 1}</p>
            <p className="mt-0.5">
              {slides.length > 0 ? `Jami ${slides.length} slayd` : 'Slaydlar ro‘yxati mavjud emas'}
            </p>
            {focusState.reportedAway ? (
              <p className="mt-1.5 font-medium text-fg">
                Dars oynasidan chiqib ketdingiz ({focusState.awaySeconds} s).
              </p>
            ) : null}
          </div>
        </aside>
      </div>

      {quizModal}
    </div>
  );
}
