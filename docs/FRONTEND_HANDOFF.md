# Frontend Handoff — `frontend-core` → `frontend-live` / `frontend-reviewer`

> Poydevor tayyor va tekshirilgan: `tsc --noEmit` 0 xato, `npm run build` 0 xato,
> `next lint` 0 ogohlantirish. Kodda `any`, `TODO`, `mock` **yo'q**.
> Bu ro'yxat — eksportlar xaritasi. Tafsilot kerak bo'lsa faylning o'zini o'qing.

## Paketlar allaqachon o'rnatilgan (`npm install` qayta kerak emas)
`next 15.5.28` · `react 19.3.1` · `@tanstack/react-query 5.105.3` · `zustand 5.0.16` ·
`framer-motion 12.43.0` · `tailwindcss 3.4.19` · `typescript 5.9.3` ·
`shiki 4.6.0` · `@monaco-editor/react 4.7.0` · `livekit-client 2.23.0` ·
`@livekit/components-react 2.9.24` · `@livekit/components-styles 1.2.0` ·
`canvas-confetti 1.9.4` · `qrcode.react 4.2.0` · `html5-qrcode 2.3.8` ·
`react-markdown 10.1.0` · `remark-gfm 4.0.1` · `react-dropzone 20.1.4` ·
11× `@radix-ui/*` · `sonner 2.0.8` · `lucide-react 1.67.0`

## `@/types/api`
**WS (eng muhim):** `WS_PROTOCOL_VERSION`, `WsEnvelope<T>`, **`WsServerEvent`**, **`WsClientEvent`**,
`WsServerEventType`, `WsClientEventType`, `WsConnectionState` (`'idle'|'connecting'|'open'|'reconnecting'|'closed'|'error'`).
`WsServerEvent` envelope'ni **o'z ichiga oladi** (`v`, `type`, `seq`, `ts`, `data`) — ya'ni
`JSON.parse` → `isWsServerEvent()` → `switch (event.type)` → `event.data` to'g'ri tiplanadi.
`WsClientEvent` da `seq`/`ts` **yo'q** (serverda qo'yiladi).
Yordamchilar: `isWsServerEvent(v): v is WsServerEvent`, `wsClientFrame<T>(type, data)`,
`WS_SERVER_EVENT_TYPES`, `WS_TEACHER_ONLY_EVENTS`, `WS_STUDENT_ONLY_EVENTS`, `WS_TEACHER_ONLY_SERVER_EVENTS`.
Payload tiplari: `Participant`, `ConfusedState`, `CodeCursor`, `ActiveQuiz`, `RoomStateSyncData`,
`SlideChangeServerData`, `LiveCodePatchServerData`, `LaserMoveData`, `ScreenShareStateServerData`,
`ConfusedPingServerData`, `FocusChangeServerData`, `QuizProgressData`, `QuizLeaderboardRow`,
`QuizResultsData`, `SessionEndedData`, `WsErrorData`, + klient tomoni `*ClientData` lar.
**Slide:** `MarkdownSlide | CodeSlide | QuizSlide = Slide` (discriminated union) + `QUIZ_*` doimiylari.
**DTO:** `UserOut`, `GroupBrief`, `GroupOut`, `GroupMemberOut`, `PresentationOut`, `PresentationBrief`,
`PresentationCreateIn/UpdateIn`, `RoomOut`, `RoomJoinOut`, `WsTicketOut`, `LiveKitTokenOut`,
`RoomReportOut/Row`, `HomeworkOut`, `HomeworkCreateIn`, `ExtractedFile`, `AiEvidence`, `AiVerdict`,
`SubmissionOut`, `SubmissionWithStudent`, `GradeIn`, `AppealIn`, `DownloadUrlOut`, `ApiErrorDetail`.
**Doimiylar:** `MAX_UPLOAD_MB(25)`, `MAX_CODE_CHARS(20000)`, `LIVE_CODE_THROTTLE_MS(50)`,
`WS_HEARTBEAT_SEC(25)`, `LASER_THROTTLE_MS(25)`, `CONFUSED_COOLDOWN_MS(30000)`,
`FOCUS_GRACE_MS(10000)`, **`AI_RED_FLAG_THRESHOLD(70)`**.

## `@/lib/api`
`apiFetch<T>(path, {body?, query?, skipAuth?})`, `apiUpload<T>(path, formData, {onProgress?, signal?})`,
**`wsRoomUrl(pinCode, ticket): string`** ← jonli xona WS URL ini SHU beradi (env formatini normalizatsiya qiladi),
`ApiError` (`code`, `status`, `fields`, `isAuthError`, `isNetworkError`), `isApiError(e)`,
`API_BASE_URL`, `WS_BASE_URL`, `LIVEKIT_URL`.
401 → `/auth/refresh` → so'rov **bir marta** qayta yuboriladi; parallel 401 lar bitta refresh promise ni bo'lishadi.

## `@/lib/resources` — §4 ning hammasi tiplangan funksiya sifatida
rooms: `createRoom({group_id, presentation_id})`, `joinRoom(pin)`, **`createWsTicket(pin)`**, `getRoom(pin)`,
`endRoom(pin)`, `createLiveKitToken(pin)`, `getRoomReport(pin)`
presentations: `getPresentations`, `getPresentation(id)`, `createPresentation`, `updatePresentation(id, body)`,
`deletePresentation(id)`, `uploadPresentationAsset(id, file, options?)`
homeworks: `getHomeworks(groupId?)`, `getHomework(id)`, `createHomework`, `submitHomeworkFile`,
`submitHomeworkCode`, `getHomeworkSubmissions(homeworkId)`, `getSubmission(id)`,
`getSubmissionDownloadUrl(id)`, `gradeSubmission(id, GradeIn)`, `appealSubmission(id, {text})`
groups: `getGroups`, `getOpenGroups`, `createGroup`, `getGroupMembers(id)`, `groupAttendanceCsvUrl(id)`

## `@/lib/query`
`makeQueryClient()`, `queryKeys` — `me, groups, openGroups, groupMembers(id), presentations,
presentation(id), homeworks(groupId?), homework(id), homeworkSubmissions(homeworkId),
submission(id), room(pin), roomReport(pin)`. **Invalidatsiya uchun faqat shu kalitlar.**

## `@/lib/auth` / `@/lib/tokens`
`useSession(): Session` — `{user, isLoading, isAuthenticated, role, isTeacher, isStudent, isAdmin, refetch, logout}`.
`getAccessToken()`, `setTokens(a, r)`, `clearTokens()`, `hasTokens()`, `TOKENS_CHANGED_EVENT`.

## `@/lib/format` (Asia/Tashkent)
`formatDateTime`, `formatDate`, `formatTime`, `toLocalInputValue` (deadline picker),
`timeLeft(deadline)` → `{expired, totalMs, text, urgent, ...}`, **`formatCountdown(ms)`** (`mm:ss`, quiz taymeri),
`formatBytes`, `formatNumber`, `formatRelative`,
`ROLE_LABELS`, `SESSION_STATUS_LABELS`, `ATTENDANCE_STATUS_LABELS`, `SUBMISSION_STATUS_LABELS`,
`ERROR_CODE_LABELS`, `errorText(code, fallback)`, `APP_TIMEZONE`, `APP_LOCALE`.

## `@/lib/utils`
`cn(...)`, `clamp(v,min,max)`, **`sleep(ms)`** (reconnect backoff), `initials(fullName)`,
`fileExtension(fileName)`, `uid(prefix?)`.

## `@/components/ui/*` (17 ta, shadcn uslubida)
`Button` (`variant: primary|secondary|outline|ghost|danger|success|accent|link`, `size: sm|md|lg|xl|icon|icon-sm`, `block`, `loading`, `asChild`) ·
`Input`/`Textarea` (`invalid`) · `Label` (`required`) ·
`Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter` ·
`Badge` (`variant: neutral|primary|accent|danger|success|outline|solid`) ·
`Dialog, DialogTrigger, DialogContent (hideClose), DialogHeader, DialogFooter, DialogTitle, DialogDescription` ·
`DropdownMenu*` · **`Avatar, AvatarImage, AvatarFallback, UserAvatar({fullName, avatarUrl})`** ←
ParticipantsPanel uchun tayyor · `Progress` (`value` 0..100, `tone`) · `Tabs*` · `Skeleton` ·
`TooltipProvider, Tooltip, TooltipTrigger, TooltipContent, SimpleTooltip({content, side})` —
**`TooltipProvider` allaqachon `QueryProvider` ichida, qayta o'ramang** ·
`Select*` · `Separator` · `ScrollArea, ScrollBar` · `Toaster` (layout da) + **`toast`** (`.success/.error/.info`).

## `@/components/shared/*`
**`AppShell({children, requireAuth?, allowRoles?, width?, hideNav?, title?, subtitle?, actions?})`** —
auth guard + onboarding redirect + rol guard **ichida**, har sahifada takrorlash kerak emas.
**`LiveShell({children})`** (shu faylda) — menyusiz, `100dvh`, `overflow-hidden` → **jonli dars sahifasi uchun**.
`TopBar`, `ThemeToggle` + **`useTheme(): {preference, setPreference, mounted}`** (Monaco temasi uchun),
`QueryProvider`, `LoadingState`, `EmptyState`, `ErrorState`, `describeError(error)`,
`CountdownBadge({deadline, tickMs?, prefix?})`, `XpBadge({xp, size?, animateOnChange?})`.

## Dizayn tokenlari (Tailwind sinflari)
Rang: `bg-bg`, `bg-surface`, `border-border`, `text-fg`, `text-muted`, `bg-primary`/`text-primary-fg`,
`bg-accent`, `bg-danger`, `bg-success`, `ring-ring`.
Breakpoint: **`companion:`** (<768) · **`split:`** (768–1279) · **`studio:`** (≥1280).
Davomiylik: `duration-fast(150ms)`, `duration(180ms)`, `duration-slow(220ms)`.
Animatsiya: `animate-fade-in`, `animate-slide-up`, `animate-pop-in`, `animate-shimmer`.
Utilita: **`.pb-safe`** (`env(safe-area-inset-bottom)`), **`.h-dvh-screen`/`.min-h-dvh-screen`** (`100dvh`),
**`.no-select`** (o'quvchi kodi uchun), **`.glass`** (Floating Dock), `.scrollbar-thin`.
Dark mode ikki yo'l bilan ishlaydi; `prefers-reduced-motion` global hurmat qilinadi;
`focus-visible` halqasi `globals.css` da hamma interaktiv elementga qo'yilgan.

## Marshrutlar — `CONTRACTS.md` §10 ga qarang (route group to'qnashuvi tuzatilgan)
`/live/[pin]` → frontend-live · `/teacher/<...>` → frontend-reviewer (`teacher/page.tsx` dan tashqari).
