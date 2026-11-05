'use client';

/**
 * Jonli dars xonasining YAGONA holat manbasi (CONTRACTS.md §8).
 *
 * Tamoyillar:
 * 1. **`seq` monotonik** (CONTRACTS.md §5, AUDIT.md §B5) — `event.seq <= seq` bo'lsa event
 *    butunlay **ignore** qilinadi. `seq` sakrab ketsa (`> seq + 1`) — uzilish belgilanadi,
 *    `useRoomSocket` serverdan qayta `ROOM_STATE_SYNC` oladi (AUDIT.md §B2).
 * 2. **Server — avtoritet.** `ROOM_STATE_SYNC` holatni to'liq qayta yozadi va `seq` ni tiklaydi.
 * 3. **Granulyar selektorlar.** Hech bir komponent butun store ga subscribe qilmaydi; lazer
 *    sekundiga ~40 marta yangilanadi, shuning uchun uni faqat `LaserOverlay` imperativ
 *    (`useLiveRoom.subscribe`) o'qiydi — React render siklidan tashqarida.
 * 4. **SSR xavfsiz** (AUDIT.md §G6) — faqat `'use client'`, boshlang'ich holat deterministik.
 *
 * ⚠️ `PONG` va `ERROR` — ulanishga xos javoblar (room broadcast emas, §5.3 da `seq: 0`),
 * shuning uchun `seq` ketma-ketligiga qo'shilmaydi.
 *
 * 🔴 v1.2 saboq (ikki qatlamli himoya):
 * - `seq` **har qanday** yangi broadcast uchun `switch` dan OLDIN yangilanadi. Avval har `case`
 *   o'zi yozardi: `case` siz qolgan event (`POLL_START`) `seq` ni yangilamas, keyingi kadr
 *   "uzilish" deb topilib BARCHA klientlar qayta ulanardi.
 * - `switch` oxirida `never` tekshiruvi: `WsServerEvent` ga yangi a'zo qo'shilib, bu yerda
 *   `case` yozilmasa — **kompilyatsiya xatosi**, jim xato emas.
 */

import { create } from 'zustand';

import type {
  ActiveOpen,
  ActivePoll,
  ActiveQuiz,
  CodeCursor,
  ConfusedState,
  OpenResultsData,
  OpenUpdateData,
  Participant,
  PollProgressData,
  PollResultsData,
  QuizProgressData,
  QuizResultsData,
  RoomEndOut,
  SessionStatus,
  SlideType,
  WsConnectionState,
  WsErrorData,
  WsServerEvent,
} from '@/types/api';

/* ========================================================================== */
/* Holat shakli                                                               */
/* ========================================================================== */

/** `FOCUS_CHANGE` natijasi — faqat o'qituvchi ekranida ishlatiladi (AUDIT.md §F). */
export interface LiveFocusEntry {
  is_focused: boolean;
  tab_switches_count: number;
  /** Oxirgi o'zgarish vaqti (`Date.now()`) — "👀 hozir chalg'igan" belgisi uchun. */
  updated_at: number;
}

/** Lazer nuqtasining oxirgi holati; `ts` — interpolyatsiya uchun (AUDIT.md §G4). */
export interface LiveLaser {
  x: number;
  y: number;
  drawing: boolean;
  ts: number;
}

/** `applyServerEvent` natijasi — `useRoomSocket` shunga qarab resync qiladi. */
export type ApplyResult = 'applied' | 'stale' | 'gap';

export interface LiveRoomState {
  /* --- ulanish --- */
  connection: WsConnectionState;
  /** Oxirgi qo'llangan server `seq`. 0 — hali hech narsa kelmagan. */
  seq: number;
  /** `seq` uzilishi sezilgan vaqt (`Date.now()`); resync qilingach `null`. */
  seqGapAt: number | null;
  /**
   * Serverdagi sessiya holati — `ROOM_STATE_SYNC.status` (CONTRACTS.md §13.2).
   * `null` — hali snapshot kelmagan (REST dagi holat ishlatiladi).
   */
  status: SessionStatus | null;
  /** Oxirgi `ROOM_STATE_SYNC` vaqti. */
  syncedAt: number | null;
  lastError: WsErrorData | null;
  sessionEnded: boolean;
  /** `POST /rooms/{pin}/end` natijasi — davomat yakuni (AUDIT.md §D3). */
  endSummary: RoomEndOut | null;

  /* --- slayd --- */
  slideIndex: number;
  slideType: SlideType;
  /** Nechta `SLIDE_CHANGE` qo'llangani (lobbidan chiqish, `status` bilan birga). */
  slideChangeCount: number;

  /* --- jonli kod --- */
  code: string;
  codeRev: number;
  cursor: CodeCursor | null;

  /* --- odamlar --- */
  participants: Participant[];
  confused: ConfusedState;
  focus: Record<string, LiveFocusEntry>;

  /* --- quiz --- */
  activeQuiz: ActiveQuiz | null;
  quizProgress: QuizProgressData | null;
  quizResults: QuizResultsData | null;
  /** Shu klient javob bergan quiz (lokal, serverga bog'liq emas). */
  answeredQuizId: string | null;
  selectedOption: number | null;

  /* --- so'rovnoma (POLL, §16.3) --- */
  activePoll: ActivePoll | null;
  /** Jonli diagramma — FAQAT o'qituvchiga keladi (o'quvchida doim `null`). */
  pollProgress: PollProgressData | null;
  pollResults: PollResultsData | null;
  /** `POLL_RESULTS` da `slide_index` yo'q — natija qaysi slaydga tegishli ekanini shu saqlaydi. */
  pollResultsSlide: number | null;
  /** Shu klient ovoz bergan poll (lokal yoki `ALREADY_VOTED` dan). */
  votedPollId: string | null;
  myPollVote: number | null;

  /* --- ochiq savol (OPEN, §16.3) --- */
  activeOpen: ActiveOpen | null;
  /** Jonli javoblar — FAQAT o'qituvchiga (anonim, `answer_id` bilan). */
  openUpdate: OpenUpdateData | null;
  openResults: OpenResultsData | null;
  openResultsSlide: number | null;
  /** Shu klient javob yuborgan open (oxirgisi yoziladi — qayta yuborish mumkin). */
  answeredOpenId: string | null;
  myOpenAnswer: string | null;
  /** Server `RATE_LIMITED` qaytargan vaqt (1 javob / 2 s) — UI xushmuomala xabar beradi. */
  openRateLimitedAt: number | null;

  /* --- ekran va lazer --- */
  isSharing: boolean;
  screenShareRoom: string | null;
  laser: LiveLaser | null;

  /* --- amallar --- */
  setConnection: (connection: WsConnectionState) => void;
  applyServerEvent: (event: WsServerEvent) => ApplyResult;
  setLocalCode: (code: string, rev: number, cursor?: CodeCursor | null) => void;
  setLocalSlide: (slideIndex: number, slideType: SlideType) => void;
  markQuizAnswered: (quizId: string, selectedIndex: number) => void;
  clearQuizResults: () => void;
  markPollVoted: (pollId: string, selectedIndex: number) => void;
  markOpenAnswered: (openId: string, text: string) => void;
  clearSeqGap: () => void;
  setEndSummary: (summary: RoomEndOut) => void;
  resetRoom: () => void;
}

type LiveRoomData = Omit<
  LiveRoomState,
  | 'setConnection'
  | 'applyServerEvent'
  | 'setLocalCode'
  | 'setLocalSlide'
  | 'markQuizAnswered'
  | 'clearQuizResults'
  | 'markPollVoted'
  | 'markOpenAnswered'
  | 'clearSeqGap'
  | 'setEndSummary'
  | 'resetRoom'
>;

const EMPTY_PARTICIPANTS: Participant[] = [];
const EMPTY_FOCUS: Record<string, LiveFocusEntry> = {};
const ZERO_CONFUSED: ConfusedState = { count: 0, percentage: 0 };

function initialState(): LiveRoomData {
  return {
    connection: 'idle',
    seq: 0,
    seqGapAt: null,
    status: null,
    syncedAt: null,
    lastError: null,
    sessionEnded: false,
    endSummary: null,
    slideIndex: 0,
    slideType: 'MARKDOWN',
    slideChangeCount: 0,
    code: '',
    codeRev: 0,
    cursor: null,
    participants: EMPTY_PARTICIPANTS,
    confused: ZERO_CONFUSED,
    focus: EMPTY_FOCUS,
    activeQuiz: null,
    quizProgress: null,
    quizResults: null,
    answeredQuizId: null,
    selectedOption: null,
    activePoll: null,
    pollProgress: null,
    pollResults: null,
    pollResultsSlide: null,
    votedPollId: null,
    myPollVote: null,
    activeOpen: null,
    openUpdate: null,
    openResults: null,
    openResultsSlide: null,
    answeredOpenId: null,
    myOpenAnswer: null,
    openRateLimitedAt: null,
    isSharing: false,
    screenShareRoom: null,
    laser: null,
  };
}

/** `STUDENT_JOINED` — takrorlanmasin (reconnect da qayta keladi). */
function upsertParticipant(list: Participant[], next: Participant): Participant[] {
  const index = list.findIndex((p) => p.student_id === next.student_id);
  if (index === -1) return [...list, next];
  const copy = list.slice();
  copy[index] = next;
  return copy;
}

/**
 * `ERROR` ni holatga aylantiradi. `ALREADY_VOTED` — "ovoz berildi" holati (masalan reconnect
 * dan keyin qayta bosilsa); `RATE_LIMITED` ochiq savolda — xushmuomala eslatma.
 */
function errorPatch(state: LiveRoomData, error: WsErrorData): Partial<LiveRoomData> {
  const patch: Partial<LiveRoomData> = { lastError: error };
  if (error.code === 'ALREADY_VOTED' && state.activePoll !== null) {
    patch.votedPollId = state.activePoll.poll_id;
  }
  if (error.code === 'RATE_LIMITED' && state.activeOpen !== null) {
    patch.openRateLimitedAt = Date.now();
  }
  return patch;
}

/* ========================================================================== */
/* Store                                                                      */
/* ========================================================================== */

export const useLiveRoom = create<LiveRoomState>()((set, get) => ({
  ...initialState(),

  setConnection: (connection) => set({ connection }),

  clearSeqGap: () => set({ seqGapAt: null }),

  /**
   * `POST /rooms/{pin}/end` muvaffaqiyatli — server `ENDED` qildi va ABSENT reconciliation
   * ni bajardi. `SESSION_ENDED` broadcastini kutmaymiz: REST javobining o'zi avtoritet.
   */
  setEndSummary: (summary) => set({ endSummary: summary, sessionEnded: true, status: 'ENDED' }),

  resetRoom: () => set(initialState()),

  setLocalSlide: (slideIndex, slideType) =>
    set((state) => ({
      slideIndex,
      slideType,
      slideChangeCount: state.slideChangeCount + 1,
    })),

  /** O'qituvchi o'zi yozgan kod — optimistik qo'llanadi (echo kutilmaydi). */
  setLocalCode: (code, rev, cursor = null) =>
    set((state) => (rev < state.codeRev ? state : { code, codeRev: rev, cursor })),

  markQuizAnswered: (quizId, selectedIndex) =>
    set({ answeredQuizId: quizId, selectedOption: selectedIndex }),

  clearQuizResults: () => set({ quizResults: null }),

  markPollVoted: (pollId, selectedIndex) => set({ votedPollId: pollId, myPollVote: selectedIndex }),

  markOpenAnswered: (openId, text) =>
    set({ answeredOpenId: openId, myOpenAnswer: text, openRateLimitedAt: null }),

  applyServerEvent: (event) => {
    // Ulanishga xos javoblar — `seq` tartibidan tashqarida (§5.3). Haqiqiy toraytirish:
    // quyidagi `switch` da `event` endi faqat broadcast a'zolarini o'z ichiga oladi.
    if (event.type === 'PONG') return 'applied';
    if (event.type === 'ERROR') {
      set((state) => errorPatch(state, event.data));
      return 'applied';
    }

    const state = get();

    // AUDIT.md §B5 — eski event tashlab yuboriladi.
    if (event.seq <= state.seq) return 'stale';

    // Uzilish: oraliq eventlar yo'qolgan. Qo'llaymiz, lekin resync so'raladi.
    const gap = state.seq > 0 && event.seq > state.seq + 1;

    // 🔴 `seq` HAR DOIM shu yerda yangilanadi — hech bir `case` uni unutib qo'ya olmaydi.
    set({ seq: event.seq });

    switch (event.type) {
      case 'ROOM_STATE_SYNC': {
        const data = event.data;
        const sameQuiz =
          data.active_quiz !== null && data.active_quiz.quiz_id === state.answeredQuizId;
        const samePoll =
          data.active_poll !== null && data.active_poll.poll_id === state.votedPollId;
        const sameOpen =
          data.active_open !== null && data.active_open.open_id === state.answeredOpenId;
        set({
          seqGapAt: null,
          syncedAt: Date.now(),
          status: data.status,
          // Snapshot `ENDED` desa — dars biz ulanmagan paytda tugagan.
          sessionEnded: data.status === 'ENDED',
          slideIndex: data.slide_index,
          slideType: data.slide_type,
          code: data.code,
          codeRev: data.code_rev,
          cursor: null,
          participants: data.participants,
          confused: data.confused,
          activeQuiz: data.active_quiz,
          isSharing: data.is_sharing,
          quizResults: null,
          quizProgress: null,
          answeredQuizId: sameQuiz ? state.answeredQuizId : null,
          selectedOption: sameQuiz ? state.selectedOption : null,
          // §16.3 K4: jonli diagramma/javoblar FAQAT o'qituvchi snapshotida bor
          // (o'quvchida maydon umuman yo'q → `undefined` → `null`).
          activePoll: data.active_poll,
          pollProgress: data.poll_progress ?? null,
          pollResults: null,
          pollResultsSlide: null,
          votedPollId: samePoll ? state.votedPollId : null,
          myPollVote: samePoll ? state.myPollVote : null,
          activeOpen: data.active_open,
          openUpdate: data.open_update ?? null,
          openResults: null,
          openResultsSlide: null,
          answeredOpenId: sameOpen ? state.answeredOpenId : null,
          myOpenAnswer: sameOpen ? state.myOpenAnswer : null,
          openRateLimitedAt: null,
        });
        // Snapshot — yangi baza: uzilish bo'lsa ham resync shart emas.
        return 'applied';
      }

      case 'SLIDE_CHANGE':
        set((s) => ({
          slideIndex: event.data.slide_index,
          slideType: event.data.slide_type,
          slideChangeCount: s.slideChangeCount + 1,
          laser: null,
        }));
        break;

      case 'LIVE_CODE_PATCH': {
        const data = event.data;
        // `code_rev` ham monotonik — eski patch ustiga yozilmaydi (AUDIT.md §B1).
        if (data.code_rev < state.codeRev) break;
        set({
          slideIndex: data.slide_index,
          code: data.code,
          codeRev: data.code_rev,
          cursor: data.cursor,
        });
        break;
      }

      case 'STUDENT_JOINED':
        set((s) => ({ participants: upsertParticipant(s.participants, event.data) }));
        break;

      case 'STUDENT_LEFT':
        set((s) => ({
          participants: s.participants.filter((p) => p.student_id !== event.data.student_id),
        }));
        break;

      case 'LASER_MOVE':
        set({
          laser: { x: event.data.x, y: event.data.y, drawing: event.data.drawing, ts: Date.now() },
        });
        break;

      case 'SCREEN_SHARE_STATE':
        set({ isSharing: event.data.is_sharing, screenShareRoom: event.data.room_name });
        break;

      case 'CONFUSED_PING':
        set({ confused: { count: event.data.confused_count, percentage: event.data.percentage } });
        break;

      case 'FOCUS_CHANGE':
        set((s) => ({
          focus: {
            ...s.focus,
            [event.data.student_id]: {
              is_focused: event.data.is_focused,
              tab_switches_count: event.data.tab_switches_count,
              updated_at: Date.now(),
            },
          },
        }));
        break;

      case 'QUIZ_START':
        set({
          activeQuiz: event.data,
          quizResults: null,
          quizProgress: null,
          answeredQuizId: null,
          selectedOption: null,
          slideIndex: event.data.slide_index,
          slideType: 'QUIZ',
        });
        break;

      case 'QUIZ_PROGRESS':
        set({ quizProgress: event.data });
        break;

      case 'QUIZ_RESULTS':
        set({ activeQuiz: null, quizProgress: null, quizResults: event.data });
        break;

      /* ------------------------------ POLL (§16.3) ---------------------------- */

      case 'POLL_START':
        // §16.5: yangi poll faol pollni ALMASHTIRADI.
        set({
          activePoll: event.data,
          pollProgress: null,
          pollResults: null,
          pollResultsSlide: null,
          votedPollId: null,
          myPollVote: null,
          slideIndex: event.data.slide_index,
          slideType: 'POLL',
        });
        break;

      case 'POLL_PROGRESS':
        set({ pollProgress: event.data });
        break;

      case 'POLL_RESULTS':
        set({
          activePoll: null,
          pollProgress: null,
          pollResults: event.data,
          pollResultsSlide: state.activePoll?.slide_index ?? state.slideIndex,
        });
        break;

      /* ------------------------------ OPEN (§16.3) ---------------------------- */

      case 'OPEN_START':
        set({
          activeOpen: event.data,
          openUpdate: null,
          openResults: null,
          openResultsSlide: null,
          answeredOpenId: null,
          myOpenAnswer: null,
          openRateLimitedAt: null,
          slideIndex: event.data.slide_index,
          slideType: 'OPEN',
        });
        break;

      case 'OPEN_UPDATE':
        set({ openUpdate: event.data });
        break;

      case 'OPEN_RESULTS':
        set({
          activeOpen: null,
          openUpdate: null,
          openResults: event.data,
          openResultsSlide: state.activeOpen?.slide_index ?? state.slideIndex,
          openRateLimitedAt: null,
        });
        break;

      case 'SESSION_ENDED':
        set({ sessionEnded: true, activeQuiz: null, activePoll: null, activeOpen: null, laser: null });
        break;

      default: {
        // Yangi `WsServerEvent` a'zosi shu yerga tushsa — KOMPILYATSIYA XATOSI.
        const unhandled: never = event;
        void unhandled;
        // Runtime da (`isWsServerEvent` allaqachon filtrlaydi) — `seq` yuqorida yangilangan.
        break;
      }
    }

    if (gap) set({ seqGapAt: Date.now() });
    return gap ? 'gap' : 'applied';
  },
}));

/* ========================================================================== */
/* Granulyar selektorlar                                                      */
/* ========================================================================== */

export const useConnectionState = (): WsConnectionState => useLiveRoom((s) => s.connection);
export const useSlideIndex = (): number => useLiveRoom((s) => s.slideIndex);
export const useSlideType = (): SlideType => useLiveRoom((s) => s.slideType);
export const useSlideChangeCount = (): number => useLiveRoom((s) => s.slideChangeCount);
export const useLiveCode = (): string => useLiveRoom((s) => s.code);
export const useLiveCodeRev = (): number => useLiveRoom((s) => s.codeRev);
export const useLiveCursor = (): CodeCursor | null => useLiveRoom((s) => s.cursor);
export const useParticipants = (): Participant[] => useLiveRoom((s) => s.participants);
export const useParticipantCount = (): number => useLiveRoom((s) => s.participants.length);
export const useConfused = (): ConfusedState => useLiveRoom((s) => s.confused);
export const useFocusMap = (): Record<string, LiveFocusEntry> => useLiveRoom((s) => s.focus);
export const useActiveQuiz = (): ActiveQuiz | null => useLiveRoom((s) => s.activeQuiz);
export const useQuizProgress = (): QuizProgressData | null => useLiveRoom((s) => s.quizProgress);
export const useQuizResults = (): QuizResultsData | null => useLiveRoom((s) => s.quizResults);
export const useAnsweredQuizId = (): string | null => useLiveRoom((s) => s.answeredQuizId);
export const useSelectedOption = (): number | null => useLiveRoom((s) => s.selectedOption);
export const useActivePoll = (): ActivePoll | null => useLiveRoom((s) => s.activePoll);
export const usePollProgress = (): PollProgressData | null => useLiveRoom((s) => s.pollProgress);
export const usePollResults = (): PollResultsData | null => useLiveRoom((s) => s.pollResults);
export const usePollResultsSlide = (): number | null => useLiveRoom((s) => s.pollResultsSlide);
export const useVotedPollId = (): string | null => useLiveRoom((s) => s.votedPollId);
export const useMyPollVote = (): number | null => useLiveRoom((s) => s.myPollVote);
export const useActiveOpen = (): ActiveOpen | null => useLiveRoom((s) => s.activeOpen);
export const useOpenUpdate = (): OpenUpdateData | null => useLiveRoom((s) => s.openUpdate);
export const useOpenResults = (): OpenResultsData | null => useLiveRoom((s) => s.openResults);
export const useOpenResultsSlide = (): number | null => useLiveRoom((s) => s.openResultsSlide);
export const useAnsweredOpenId = (): string | null => useLiveRoom((s) => s.answeredOpenId);
export const useMyOpenAnswer = (): string | null => useLiveRoom((s) => s.myOpenAnswer);
export const useOpenRateLimitedAt = (): number | null => useLiveRoom((s) => s.openRateLimitedAt);
export const useIsSharing = (): boolean => useLiveRoom((s) => s.isSharing);
export const useScreenShareRoom = (): string | null => useLiveRoom((s) => s.screenShareRoom);
export const useSessionEnded = (): boolean => useLiveRoom((s) => s.sessionEnded);
export const useRoomStatus = (): SessionStatus | null => useLiveRoom((s) => s.status);
export const useEndSummary = (): RoomEndOut | null => useLiveRoom((s) => s.endSummary);
export const useSyncedAt = (): number | null => useLiveRoom((s) => s.syncedAt);
export const useLastWsError = (): WsErrorData | null => useLiveRoom((s) => s.lastError);

/** Amallar — render dan tashqarida chaqirish uchun barqaror havolalar. */
export const liveRoomActions = {
  setConnection: (connection: WsConnectionState): void =>
    useLiveRoom.getState().setConnection(connection),
  applyServerEvent: (event: WsServerEvent): ApplyResult =>
    useLiveRoom.getState().applyServerEvent(event),
  setLocalCode: (code: string, rev: number, cursor?: CodeCursor | null): void =>
    useLiveRoom.getState().setLocalCode(code, rev, cursor),
  setLocalSlide: (slideIndex: number, slideType: SlideType): void =>
    useLiveRoom.getState().setLocalSlide(slideIndex, slideType),
  markQuizAnswered: (quizId: string, selectedIndex: number): void =>
    useLiveRoom.getState().markQuizAnswered(quizId, selectedIndex),
  clearQuizResults: (): void => useLiveRoom.getState().clearQuizResults(),
  markPollVoted: (pollId: string, selectedIndex: number): void =>
    useLiveRoom.getState().markPollVoted(pollId, selectedIndex),
  markOpenAnswered: (openId: string, text: string): void =>
    useLiveRoom.getState().markOpenAnswered(openId, text),
  clearSeqGap: (): void => useLiveRoom.getState().clearSeqGap(),
  setEndSummary: (summary: RoomEndOut): void => useLiveRoom.getState().setEndSummary(summary),
  resetRoom: (): void => useLiveRoom.getState().resetRoom(),
} as const;
