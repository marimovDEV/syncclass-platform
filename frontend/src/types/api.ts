/**
 * SyncClass — frontend uchun YAGONA tip manbasi.
 *
 * Manba: `docs/CONTRACTS.md` §2 (ENUM lar), §3 (Slide), §4 (REST), §5 (WS), §7 (AI), §8.
 * Maydon nomlari kontraktdan BIR HARF ham farq qilmaydi (snake_case — backend bilan bir xil).
 *
 * ⛔ Bu faylga `any` yozilmaydi. Noma'lum JSON uchun `unknown` ishlatiladi.
 */

/* ========================================================================== */
/* 1. ENUM lar — CONTRACTS.md §2                                              */
/* ========================================================================== */

export type UserRole = 'TEACHER' | 'STUDENT' | 'ADMIN';

export type SessionStatus = 'LOBBY' | 'LIVE' | 'ENDED';

export type AttendanceStatus = 'PRESENT' | 'LATE' | 'ABSENT';

export type SubmissionStatus =
  | 'PENDING_AI'
  | 'READY_FOR_REVIEW'
  | 'AI_FAILED'
  | 'GRADED'
  | 'RESUBMIT_REQUIRED';

/** `backend/app/schemas/slide.py: SlideType` (v1.2 — CONTRACTS.md §16.1). */
export type SlideType = 'MARKDOWN' | 'CODE' | 'QUIZ' | 'IMAGE' | 'POLL' | 'OPEN';

export type BackupStatus = 'NONE' | 'QUEUED' | 'OK' | 'FAILED';

export type StorageKind = 'R2' | 'TELEGRAM';

/** CONTRACTS.md §3 — `CodeSlide.code_lang` ruxsat etilgan qiymatlari. */
export type CodeLang = 'python' | 'sql' | 'javascript' | 'html' | 'css' | 'bash';

export const USER_ROLES: readonly UserRole[] = ['TEACHER', 'STUDENT', 'ADMIN'] as const;
export const SESSION_STATUSES: readonly SessionStatus[] = ['LOBBY', 'LIVE', 'ENDED'] as const;
export const ATTENDANCE_STATUSES: readonly AttendanceStatus[] = [
  'PRESENT',
  'LATE',
  'ABSENT',
] as const;
export const SUBMISSION_STATUSES: readonly SubmissionStatus[] = [
  'PENDING_AI',
  'READY_FOR_REVIEW',
  'AI_FAILED',
  'GRADED',
  'RESUBMIT_REQUIRED',
] as const;
export const SLIDE_TYPES: readonly SlideType[] = [
  'MARKDOWN',
  'CODE',
  'QUIZ',
  'IMAGE',
  'POLL',
  'OPEN',
] as const;
export const CODE_LANGS: readonly CodeLang[] = [
  'python',
  'sql',
  'javascript',
  'html',
  'css',
  'bash',
] as const;

/* ========================================================================== */
/* 2. Xato formati — CONTRACTS.md §4                                          */
/* ========================================================================== */

/** `{ "detail": { "code": "...", "message": "...", "fields": {} } }` ning ichki qismi. */
export interface ApiErrorDetail {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export interface ApiErrorEnvelope {
  detail: ApiErrorDetail;
}

/* ========================================================================== */
/* 3. Slayd sxemasi — CONTRACTS.md §3 (discriminated union, `type` bo'yicha)   */
/* ========================================================================== */

/*
 * Maydonlar `backend/app/schemas/slide.py` bilan 1:1 (`extra="forbid"` — ortiqcha maydon 422).
 * Backend `dump_slides_data()` `exclude_none=False` bilan yozadi, ya'ni `title`/`notes`
 * javobda HAR DOIM bor (`null` bo'lishi mumkin) — shuning uchun `?:` emas, `| null`.
 */

export interface MarkdownSlide {
  index: number;
  type: 'MARKDOWN';
  title: string | null;
  content: string;
  notes: string | null;
}

export interface CodeSlide {
  index: number;
  type: 'CODE';
  title: string | null;
  code_lang: CodeLang;
  starter_code: string;
  notes: string | null;
}

/** Baholanadigan test. `notes` YO'Q (backend sxemasida yo'q, `extra="forbid"`). */
export interface QuizSlide {
  index: number;
  type: 'QUIZ';
  title: string | null;
  question: string;
  /** 2..6 variant. */
  options: string[];
  correct_option: number;
  /** 10..120 sekund. */
  duration_sec: number;
  /** 1..1000, default 100. */
  points: number;
}

/** `IMAGE.source` — rasm qayerdan kelgani (faqat UI yorlig'i, xavfsizlikka ta'siri yo'q). */
export interface ImageSource {
  kind: 'PDF' | 'PPTX' | 'UPLOAD';
  /** 1..10000; sahifa raqami ma'lum bo'lmasa `null`. */
  page: number | null;
}

/**
 * Rasm slaydi (PDF sahifasi va h.k.) — CONTRACTS.md §16.1.
 *
 * `image_url` — FAQAT shu platformaning barqaror asset URL i
 * (`.../api/v1/presentations/{id}/assets/{asset_key}`); tashqi URL, `javascript:`,
 * `data:` backendda 422 bilan rad etiladi. Shuning uchun `<img src>` ga qo'yish xavfsiz.
 * `alt` MAJBURIY (1..300) — ko'rishida nuqsoni bor o'quvchi uchun.
 */
export interface ImageSlide {
  index: number;
  type: 'IMAGE';
  title: string | null;
  image_url: string;
  alt: string;
  notes: string | null;
  source: ImageSource | null;
}

/**
 * So'rovnoma — BAHOLANMAYDI (§16.1). `correct_option`/`points` YO'Q va bo'lmaydi:
 * to'g'ri javob ham, XP ham yo'q. `notes` ham yo'q.
 */
export interface PollSlide {
  index: number;
  type: 'POLL';
  title: string | null;
  question: string;
  /** 2..6 variant. */
  options: string[];
  /** 10..300 sekund. */
  duration_sec: number;
}

/** Ochiq savol / so'z buluti (§16.1). Javoblar anonim. `notes` YO'Q. */
export interface OpenSlide {
  index: number;
  type: 'OPEN';
  title: string | null;
  question: string;
  /** 30..600 sekund. */
  duration_sec: number;
  /** 10..200, default 60 — javob shu uzunlikka qirqiladi. */
  max_chars: number;
}

export type Slide = MarkdownSlide | CodeSlide | QuizSlide | ImageSlide | PollSlide | OpenSlide;

/* --- Chegaralar — qiymatlar `backend/app/schemas/slide.py` dan --- */

/** Taqdimotda <= 100 slayd (§16.1). `index` 0 dan ketma-ket va unikal bo'lishi SHART. */
export const MAX_SLIDES = 100;
export const MAX_SLIDE_TITLE_CHARS = 255;
export const MAX_SLIDE_CONTENT_CHARS = 20_000;
export const MAX_SLIDE_NOTES_CHARS = 5_000;
export const MAX_QUESTION_CHARS = 1_000;
export const MAX_OPTION_CHARS = 300;

export const QUIZ_MIN_OPTIONS = 2;
export const QUIZ_MAX_OPTIONS = 6;
export const QUIZ_MIN_DURATION_SEC = 10;
export const QUIZ_MAX_DURATION_SEC = 120;
export const QUIZ_DEFAULT_POINTS = 100;
export const QUIZ_MAX_POINTS = 1_000;

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 6;
export const POLL_MIN_DURATION_SEC = 10;
export const POLL_MAX_DURATION_SEC = 300;

export const OPEN_MIN_DURATION_SEC = 30;
export const OPEN_MAX_DURATION_SEC = 600;
export const OPEN_MIN_MAX_CHARS = 10;
export const OPEN_MAX_MAX_CHARS = 200;
export const OPEN_DEFAULT_MAX_CHARS = 60;

export const IMAGE_MAX_ALT_CHARS = 300;
export const IMAGE_MAX_URL_CHARS = 600;
export const IMAGE_MAX_SOURCE_PAGE = 10_000;

/* ========================================================================== */
/* 4. Auth / users — CONTRACTS.md §4 (auth)                                   */
/* ========================================================================== */

/** `GET /groups/open` va `UserOut.groups` elementi. */
export interface GroupBrief {
  id: number;
  name: string;
  course_title: string;
}

export interface UserOut {
  id: string;
  email: string;
  full_name: string;
  avatar_url: string | null;
  role: UserRole;
  is_onboarded: boolean;
  xp_points: number;
  groups: GroupBrief[];
}

/** `GET /auth/google/login` → `{authorize_url}`. */
export interface GoogleLoginOut {
  authorize_url: string;
}

/** `POST /auth/refresh` → `{access_token, refresh_token, token_type}`. */
export interface TokenPairOut {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

export interface RefreshIn {
  refresh_token: string;
}

/**
 * `POST /auth/onboarding`.
 * ⚠️ CONTRACTS.md §4: `role` maydoni serverda O'QILMAYDI — shuning uchun bu tipda yo'q.
 * `group_id` yoki `invite_code` — bittasi beriladi.
 */
export interface OnboardingIn {
  full_name: string;
  group_id?: number;
  invite_code?: string;
}

/* ========================================================================== */
/* 5. Groups — CONTRACTS.md §4 (groups) + §2 `groups` modeli                   */
/* ========================================================================== */

export interface GroupOut {
  id: number;
  name: string;
  course_title: string;
  invite_code: string;
  teacher_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** `GET /groups/{id}/members`. */
export interface GroupMemberOut {
  student_id: string;
  full_name: string;
  email: string;
  avatar_url: string | null;
  xp_points: number;
  joined_at: string;
}

/* ========================================================================== */
/* 6. Presentations — CONTRACTS.md §4 (presentations) + §2 `presentations`      */
/* ========================================================================== */

export interface PresentationOut {
  id: string;
  teacher_id: string;
  title: string;
  module_number: number;
  lesson_number: number;
  schema_version: number;
  slides_data: Slide[];
  /** Backend `computed_field` — har doim keladi (`len(slides_data)`). */
  slides_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * `GET /presentations` ro'yxati elementi — backend `PresentationBrief`.
 * DIQQAT: yengil ko'rinish, `slides_data` KELMAYDI (yuzlab slaydni ro'yxatda
 * tashimaslik uchun) — to'liq deck faqat `GET /presentations/{id}` da.
 */
export interface PresentationListItem {
  id: string;
  title: string;
  module_number: number;
  lesson_number: number;
  schema_version: number;
  slides_count: number;
  updated_at: string;
}

/** `RoomOut.presentation` — qisqartirilgan ko'rinish. */
export interface PresentationBrief {
  id: string;
  title: string;
  slides_count: number;
}

export interface PresentationCreateIn {
  title: string;
  module_number: number;
  lesson_number: number;
  slides_data?: Slide[];
}

export interface PresentationUpdateIn {
  title?: string;
  module_number?: number;
  lesson_number?: number;
  slides_data?: Slide[];
}

/** `POST /presentations/{id}/assets` → `{url}`. */
/**
 * `POST /presentations/import/pptx` javobi — `backend/app/schemas/presentation.py: PptxImportOut`.
 *
 * ⚠️ SAQLAMAYDI: o'qituvchi oldindan ko'radi, tasdiqlagach alohida `POST /presentations`.
 * `slides` — faqat MARKDOWN (PPTX dan faqat matn olinadi). `warnings` — o'zbekcha,
 * nima yo'qolgani (dizayn, rasm, animatsiya) ochiq aytiladi; UI ularni ko'rsatishi SHART.
 */
export interface PptxImportOut {
  slides: Slide[];
  warnings: string[];
  /** O'tkazib yuborilgan rasmlar soni (>= 0). */
  skipped_images: number;
}

/** `MAX_UPLOAD_MB` bilan bir xil (§16.2: PPTX <= 25 MB). */
export const MAX_PPTX_MB = 25;

export interface AssetUploadOut {
  url: string;
}

/* ========================================================================== */
/* 7. Rooms — CONTRACTS.md §4 (rooms)                                         */
/* ========================================================================== */

export interface RoomCreateIn {
  group_id: number;
  presentation_id: string;
}

/** `POST /rooms` va `GET /rooms/{pin}` javobi. */
export interface RoomOut {
  session_id: string;
  pin_code: string;
  join_url: string;
  status: SessionStatus;
  current_slide_index: number;
  presentation: PresentationBrief;
}

/**
 * `POST /rooms/{pin}/join` javobi (STUDENT) — CONTRACTS.md §5.5 yakuniy sxemasi.
 * Maydonlar `backend/app/schemas/room.py: RoomJoinOut` bilan 1:1.
 */
export interface RoomJoinOut {
  session_id: string;
  pin_code: string;
  status: SessionStatus;
  current_slide_index: number;
  is_screen_sharing: boolean;
  attendance_status: AttendanceStatus;
  late_after_minutes: number;
  group_id: number;
  group_name: string;
  presentation: PresentationBrief;
  /**
   * Prezentatsiya slaydlari (§3) — birinchi render uchun; keyin holat faqat WS orqali keladi.
   *
   * 🔴 O'quvchi slayd matnini FAQAT shu yerdan oladi: §4 dagi barcha `presentations`
   * endpointlari `teacher_id == current_user.id` guard bilan, ya'ni o'quvchida
   * `GET /presentations/{id}` → **403** (CONTRACTS.md §13.1).
   * O'qituvchi esa `getPresentation()` dan oladi (egasi, builder bilan bir manba).
   *
   * ⚠️ Backend bu massivni xom JSONB sifatida yuboradi va TARTIBNI KAFOLATLAMAYDI —
   * ishlatishdan oldin `index` bo'yicha saralang.
   */
  slides: Slide[];
}

/** `POST /rooms/{pin}/ws-ticket` → bir martalik 30 sekundlik ticket. */
export interface WsTicketOut {
  ticket: string;
}

/**
 * `GET /rooms/{pin}` javobi — `ROOM_STATE_SYNC` ning REST oynasi (WS ishlamagan holat
 * uchun zaxira). `backend/app/schemas/room.py: RoomStateOut` bilan 1:1.
 *
 * ⚠️ Bu `RoomOut` EMAS: `RoomOut` faqat `POST /rooms` javobi. Ikkisini aralashtirish
 * `join_url` ni `undefined` qilib QR/lobbi havolasini buzgan edi (§13 auditi).
 */
export interface RoomStateOut {
  session_id: string;
  pin_code: string;
  /**
   * Lobbi QR kodi va ulashish havolasi — MANBA faqat server.
   * Klientda `window.location.origin` dan qurilmaydi: o'qituvchi `localhost` da
   * ochsa QR ham `localhost` ko'rsatadi va boshqa qurilmadagi o'quvchi kira olmaydi.
   */
  join_url: string;
  /**
   * Xona qaysi prezentatsiya bilan ishlayotgani — MANBA faqat server.
   *
   * `POST /rooms` javobini keshlash YARAMAYDI (`join_url` dagi bilan bir xil sabab):
   * reconnect yoki sahifani yangilashdan keyin kesh yo'q, prezentatsiya esa aynan
   * o'sha paytda kerak. `presentation.id` bo'lmasa o'qituvchi `getPresentation(id)` ni
   * ham chaqira olmaydi, ya'ni o'z slaydlarini butunlay yo'qotadi (o'quvchida slaydlar
   * `RoomJoinOut.slides` dan keladi, o'qituvchida — boshqa manba yo'q).
   */
  presentation: PresentationBrief;
  status: SessionStatus;
  seq: number;
  slide_index: number;
  slide_type: SlideType;
  code: string;
  code_rev: number;
  is_sharing: boolean;
  active_quiz: ActiveQuiz | null;
  /** §16.3 — faqat `POLL_START` dagi ommaviy maydonlar (jonli taqsimot YO'Q). */
  active_poll: ActivePoll | null;
  /** §16.3 — faqat `OPEN_START` dagi ommaviy maydonlar (javoblar YO'Q). */
  active_open: ActiveOpen | null;
  participants: Participant[];
  confused: ConfusedState;
}

/**
 * `POST /rooms/{pin}/end` (TEACHER) javobi — `ENDED` + ABSENT reconciliation natijasi.
 * `backend/app/schemas/room.py: RoomEndOut` bilan 1:1.
 *
 * Sanoqlar darsni yakunlash ekranida ko'rsatiladi (AUDIT.md §D3 — `ABSENT` aynan
 * shu reconciliation da qo'yiladi).
 */
export interface RoomEndOut {
  session_id: string;
  status: SessionStatus;
  ended_at: string;
  present_count: number;
  late_count: number;
  absent_count: number;
}

/**
 * `POST /rooms/{pin}/livekit-token`.
 * `backend/app/schemas/room.py: LiveKitTokenOut` bilan 1:1.
 *
 * AUDIT.md §F: o'quvchida `can_publish=false` va `can_publish_data=false` —
 * o'quvchi texnik jihatdan efirga chiqara OLMAYDI (server tokenda cheklaydi).
 */
export interface LiveKitTokenOut {
  token: string;
  /** LiveKit server manzili — ulanish uchun shundan foydalaniladi. */
  url: string;
  room_name: string;
  identity: string;
  can_publish: boolean;
  can_publish_data: boolean;
}

/**
 * `GET /rooms/{pin}/report` qatori — `backend/app/schemas/room.py: RoomReportRow` bilan 1:1.
 *
 * ⚠️ `avatar_url` YO'Q — backend hisobotda yubormaydi (ism bilan ko'rsatiladi).
 */
export interface RoomReportRow {
  student_id: string;
  full_name: string;
  status: AttendanceStatus;
  joined_at: string | null;
  tab_switches_count: number;
  focus_lost_seconds: number;
  quiz_score: number;
  answers_count: number;
  correct_count: number;
}

/**
 * Dars hisobotidagi quiz statistikasi — `quiz_answers` jadvalidan.
 *
 * Bu `confused_peaks` dan farqli: HAQIQIY, saqlanadigan ma'lumot (§12.2 da
 * confused tarixi ataylab saqlanmaydi, quiz javoblari esa saqlanadi).
 * `distribution` indekslari slaydning `options` tartibiga mos.
 */
export interface RoomQuizStat {
  slide_index: number;
  answered: number;
  correct: number;
  avg_answer_ms: number;
  distribution: number[];
}

/**
 * `GET /rooms/{pin}/report` (TEACHER) — `backend/app/schemas/room.py: RoomReportOut` bilan 1:1.
 *
 * ⚠️ `presentation` YO'Q (backend yubormaydi) — sarlavhada `group_name` ishlatiladi.
 * ⚠️ Qatorlar `students` da (`rows` emas).
 */
export interface RoomReportOut {
  session_id: string;
  pin_code: string;
  status: SessionStatus;
  group_id: number;
  group_name: string;
  started_at: string;
  ended_at: string | null;
  present_count: number;
  late_count: number;
  absent_count: number;
  students: RoomReportRow[];
  quizzes: RoomQuizStat[];
}

/* ========================================================================== */
/* 8. Homeworks / submissions — CONTRACTS.md §4 (homeworks) + §2              */
/* ========================================================================== */

export interface HomeworkOut {
  id: string;
  group_id: number;
  session_id: string | null;
  title: string;
  description: string;
  /** ISO-8601, TIMESTAMPTZ (UTC). UI da `Asia/Tashkent` ga o'giriladi. */
  deadline: string;
  max_score: number;
  ai_penalty_points: number;
  allow_resubmit: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;

  /* --- Serverda HISOBLANGAN maydonlar (ro'yxatda qulaylik uchun) --- */

  /** Shu vazifaga tushgan topshiriqlar soni (o'qituvchi ro'yxati uchun). */
  submissions_count: number;
  /**
   * So'rov yuborgan o'quvchining OXIRGI topshirig'i (`is_latest`) — yo'q bo'lsa `null`.
   * Shu ikki maydon borligi uchun o'quvchi dashboardi har vazifa bo'yicha alohida
   * `GET /homeworks/{id}/submissions` chaqirmaydi (N+1 so'rov yo'q, 403 xavfi yo'q).
   */
  my_submission_id: string | null;
  my_status: SubmissionStatus | null;
}

export interface HomeworkCreateIn {
  group_id: number;
  title: string;
  description: string;
  deadline: string;
  max_score?: number;
  ai_penalty_points?: number;
  allow_resubmit?: boolean;
  session_id?: string;
}

/**
 * `submissions.extracted_files` JSONB elementi — CONTRACTS.md §11.2 (yakuniy sxema):
 * `[{"path": "src/main.py", "content": "...", "chars": 1234, "truncated": false}]`
 *
 * `path` — normalizatsiyalangan POSIX yo'l (FileTree shundan quriladi).
 * `truncated` — SHU fayl qirqilganmi; umumiy bayroq `SubmissionOut.extract_truncated`.
 * ⚠️ Backend `size_bytes` ni HECH QACHON yubormaydi (§12.3).
 */
export interface ExtractedFile {
  path: string;
  content: string;
  chars: number;
  truncated: boolean;
}

/** CONTRACTS.md §7 — `AiEvidence`. */
export interface AiEvidence {
  file: string;
  line_start: number;
  line_end: number;
  reason: string;
}

/** CONTRACTS.md §7 — `AiVerdict` (backenddan kelgan to'liq xulosa). */
export interface AiVerdict {
  ai_suspected: boolean;
  /** 0..100 */
  ai_confidence_percent: number;
  injection_suspected: boolean;
  /** O'zbekcha, 3-6 gap. */
  summary: string;
  strengths: string[];
  issues: string[];
  evidence: AiEvidence[];
  /** 0..max_score, clamp qilingan. */
  suggested_score: number;
  /** TAVSIYA — avtomatik qo'llanmaydi (AUDIT.md §E2). */
  recommended_penalty: number;
}

/**
 * `GET /submissions/{id}` — TO'LIQ ko'rinish (o'quvchi ham, o'qituvchi ham shu shaklni oladi).
 *
 * ⚠️ `r2_object_key`, `tg_file_id`, `tg_message_id` ATAYLAB yo'q: bular ichki storage
 * kalitlari, brauzerga chiqmaydi. Faylni olish uchun `GET /submissions/{id}/download-url`.
 */
export interface SubmissionOut {
  id: string;
  homework_id: string;
  student_id: string;
  /** Serverda to'ldiriladigan hisoblangan maydon (tekis shakl — ichma-ich obyekt emas). */
  student_name: string | null;
  student_avatar_url: string | null;
  attempt_no: number;
  is_latest: boolean;
  storage_primary: StorageKind;
  tg_backup_status: BackupStatus;
  file_name: string;
  file_size_bytes: number;
  content_sha256: string;
  extracted_files: ExtractedFile[];
  extract_truncated: boolean;
  ai_suspected: boolean;
  ai_confidence_percent: number;
  ai_review_summary: string | null;
  ai_evidence: AiEvidence[];
  /**
   * CONTRACTS.md §12.1 — `submissions.ai_strengths JSONB` (migratsiya `0002`).
   * O'quvchining kuchli tomonlari UI ga yetib borishi uchun saqlanadi
   * (AUDIT.md §E2: baholash adolatli va qurilish xarakterida bo'lsin).
   */
  ai_strengths: string[];
  /** CONTRACTS.md §12.1 — `submissions.ai_issues JSONB` (migratsiya `0002`). */
  ai_issues: string[];
  ai_injection_suspected: boolean;
  suggested_score: number | null;
  final_score: number | null;
  penalty_applied: number;
  teacher_comment: string | null;
  student_appeal: string | null;
  status: SubmissionStatus;
  submitted_at: string;
  graded_at: string | null;
  created_at: string;
  updated_at: string;
  /**
   * CONTRACTS.md §11.1 — HISOBLANGAN maydon: `submitted_at > homeworks.deadline`.
   * Migratsiya kerak emas, serverda hisoblanadi.
   *
   * ⚠️ Faqat MA'LUMOT: kechikkan ish qabul qilinadi, ball AVTOMATIK tushmaydi va
   * `penalty_applied` ga ta'sir qilmaydi — jazoni o'qituvchi hal qiladi.
   * UI: "Kechikdi" nishoni (`Badge variant="accent"`).
   */
  is_late: boolean;
}

/**
 * `GET /homeworks/{id}/submissions` elementi — YENGIL ro'yxat modeli.
 *
 * `SubmissionOut` dan meros OLMAYDI: backend bu yerda og'ir maydonlarni ataylab
 * yubormaydi — `extracted_files`, `ai_evidence`, `ai_review_summary`, `ai_strengths`,
 * `ai_issues`, `teacher_comment`, `student_appeal`, `storage_primary`,
 * `content_sha256`, `created_at`, `updated_at` bu tipda YO'Q.
 *
 * To'liq ma'lumot kerak bo'lsa → `getSubmission(id)` (`SubmissionOut`).
 * Maydonlar `backend/app/schemas/homework.py: SubmissionWithStudent` bilan 1:1.
 */
export interface SubmissionWithStudent {
  id: string;
  homework_id: string;
  student_id: string;
  student_name: string | null;
  student_avatar_url: string | null;
  attempt_no: number;
  is_latest: boolean;
  file_name: string;
  file_size_bytes: number;
  status: SubmissionStatus;
  ai_suspected: boolean;
  ai_confidence_percent: number;
  suggested_score: number | null;
  final_score: number | null;
  penalty_applied: number;
  tg_backup_status: BackupStatus;
  extract_truncated: boolean;
  submitted_at: string;
  graded_at: string | null;
  /** CONTRACTS.md §11.1 — hisoblangan; ball avtomatik tushmaydi. */
  is_late: boolean;
}

/** `POST /homeworks/{id}/submit` — JSON varianti (ichki kod muharriri). */
export interface SubmissionCodeIn {
  code: string;
  file_name: string;
}

/**
 * `GET /submissions/{id}/download-url` → `{url, expires_in, storage}`.
 *
 * `storage === 'R2'` → `url` to'g'ridan-to'g'ri R2 presigned havolasi.
 * `storage === 'TELEGRAM'` → `url` SERVER PROXY ga ishora qiladi
 * (bot token brauzerga hech qachon chiqmaydi).
 */
export interface DownloadUrlOut {
  url: string;
  expires_in: number;
  storage: StorageKind;
}

/** `POST /submissions/{id}/grade` (TEACHER). */
export interface GradeIn {
  final_score: number;
  penalty_applied: number;
  teacher_comment: string;
  status: SubmissionStatus;
}

/** `POST /submissions/{id}/appeal` (STUDENT). */
export interface AppealIn {
  text: string;
}

/* ========================================================================== */
/* 9. WebSocket protokoli v1 — CONTRACTS.md §5                                */
/* ========================================================================== */

export const WS_PROTOCOL_VERSION = 1 as const;

/**
 * Umumiy envelope. Server → klient yo'nalishida `seq` va `ts` har doim bor.
 * Aniq tiplangan ish uchun `WsServerEvent` / `WsClientEvent` union laridan foydalaning.
 */
export interface WsEnvelope<T = unknown> {
  v: typeof WS_PROTOCOL_VERSION;
  type: string;
  seq: number;
  ts: number;
  data: T;
}

/** Server tomonidan yuborilgan envelope (seq — room bo'yicha monotonik). */
interface ServerFrame<TType extends string, TData> {
  v: typeof WS_PROTOCOL_VERSION;
  type: TType;
  seq: number;
  ts: number;
  data: TData;
}

/** Klient yuboradigan envelope — `seq`/`ts` ni server qo'yadi. */
interface ClientFrame<TType extends string, TData> {
  v: typeof WS_PROTOCOL_VERSION;
  type: TType;
  data: TData;
}

/* --------------------------- data payload lari ---------------------------- */

/** `ROOM_STATE_SYNC.participants[]` va `STUDENT_JOINED.data`. */
export interface Participant {
  student_id: string;
  full_name: string;
  avatar_url: string | null;
  status: AttendanceStatus;
}

export interface ConfusedState {
  count: number;
  percentage: number;
}

export interface CodeCursor {
  line: number;
  col: number;
}

/**
 * `QUIZ_START.data` — ayni shu shakl `ROOM_STATE_SYNC.active_quiz` da ham keladi.
 *
 * Backend `QUIZ_START` ni `ActiveQuiz.to_event_data()` orqali REDAKSIYA qiladi:
 * `correct_option` va ichki `started_at_ms` yuborilmaydi. Tip ataylab shu
 * redaksiyalangan shaklda — qo'shimcha maydonlar bo'lsa ham ULARGA TAYANMAYMIZ
 * (to'g'ri javob klientga chiqmasligi kerak; tekshirish serverda).
 */
export interface ActiveQuiz {
  quiz_id: string;
  slide_index: number;
  question: string;
  options: string[];
  duration_sec: number;
  /** Server bergan ISO vaqt — klient taymeri FAQAT ko'rsatish uchun (AUDIT.md §G3). */
  ends_at: string;
}

export interface RoomStateSyncData {
  /**
   * CONTRACTS.md §13.2 — sessiya holati snapshotda.
   * Klient lobbi↔dars o'tishini taxminga (`slideChangeCount`) emas, SHUNGA bog'laydi:
   * aks holda qayta ulangan o'quvchi, o'qituvchi slaydni almashtirmasa,
   * dars ketayotganda ham lobbida qotib qolardi.
   */
  status: SessionStatus;
  slide_index: number;
  code_rev: number;
  code: string;
  slide_type: SlideType;
  is_sharing: boolean;
  active_quiz: ActiveQuiz | null;
  /** §16.3 — HAMMAGA: faqat ommaviy maydonlar (`POLL_START` dagi kabi). */
  active_poll: ActivePoll | null;
  /** §16.3 — HAMMAGA: faqat ommaviy maydonlar (`OPEN_START` dagi kabi). */
  active_open: ActiveOpen | null;
  participants: Participant[];
  confused: ConfusedState;
  /**
   * §16.3 K4 — FAQAT O'QITUVCHI snapshotida bor (o'quvchida maydon umuman YO'Q).
   * Shakli `POLL_PROGRESS.data` bilan aynan bir xil; faol poll bo'lmasa `null`.
   * Qayta ulangan o'qituvchi jonli diagrammani shu orqali tiklaydi
   * (alohida `POLL_PROGRESS` ishlamaydi — §5.3, `seq <= last_seq` tashlanadi).
   */
  poll_progress?: PollProgressData | null;
  /** §16.3 K4 — FAQAT O'QITUVCHIDA. Shakli `OPEN_UPDATE.data` bilan bir xil; yo'q bo'lsa `null`. */
  open_update?: OpenUpdateData | null;
}

export interface StudentLeftData {
  student_id: string;
}

export interface SlideChangeServerData {
  slide_index: number;
  slide_type: SlideType;
}

export interface LiveCodePatchServerData {
  slide_index: number;
  code_rev: number;
  code: string;
  cursor: CodeCursor | null;
}

/** 0..1 ga normalizatsiya qilingan koordinatalar. */
export interface LaserMoveData {
  x: number;
  y: number;
  drawing: boolean;
}

export interface ScreenShareStateServerData {
  is_sharing: boolean;
  room_name: string;
}

export interface ConfusedPingServerData {
  confused_count: number;
  percentage: number;
}

export interface FocusChangeServerData {
  student_id: string;
  is_focused: boolean;
  tab_switches_count: number;
}

export interface QuizProgressData {
  quiz_id: string;
  answered: number;
  total: number;
}

export interface QuizLeaderboardRow {
  student_id: string;
  full_name: string;
  xp: number;
  answer_ms: number;
}

export interface QuizResultsData {
  quiz_id: string;
  correct_option: number;
  /**
   * Har variant bo'yicha javob soni. Uzunligi HAR DOIM `options.length` ga teng
   * (javob bo'lmasa ham nollar bilan) — diagramma yiqilmaydi.
   */
  distribution: number[];
  /**
   * CONTRACTS.md §13.3 — variant MATNLARI. Tartibi `distribution` indekslariga
   * AYNAN mos (`distribution[i]` ↔ `options[i]`), chunki ikkisi ham bitta
   * `slide.options` dan kelib chiqadi.
   *
   * Nega kerak: reconnect `QUIZ_START` va `QUIZ_RESULTS` orasiga tushsa, klientda
   * faqat `distribution` bo'lib natija "A varianti / B varianti" bo'lib chiqardi.
   */
  options: string[];
  leaderboard: QuizLeaderboardRow[];
}

/* --------------------- v1.2 POLL / OPEN — CONTRACTS.md §16.3 ------------------- */
/*
 * Maydonlar `backend/app/ws/routes.py` (`_start_poll`/`_start_open`) va
 * `services/room_state.py` dagi Lua quruvchilaridan (`poll_progress`, `open_update`,
 * `_LUA_POLL_END`, `_LUA_OPEN_END`) olingan. QUIZ_* yo'li bilan ATAYLAB aralashtirilmagan.
 */

/** `POLL_START.data` — ayni shu shakl `ROOM_STATE_SYNC.active_poll` da ham keladi. */
export interface ActivePoll {
  poll_id: string;
  slide_index: number;
  question: string;
  options: string[];
  duration_sec: number;
  /** Server bergan ISO vaqt — klient taymeri FAQAT ko'rsatish uchun (AUDIT.md §G3). */
  ends_at: string;
}

/**
 * `POLL_PROGRESS.data` — FAQAT O'QITUVCHIGA (jonli diagramma).
 * O'quvchi natijani faqat yakunda (`POLL_RESULTS`) ko'radi — olomonga ergashish yo'q.
 */
export interface PollProgressData {
  poll_id: string;
  /** Ovoz bergan o'quvchilar soni. */
  voted: number;
  /**
   * Xonadagi HOZIRGI o'quvchilar soni (§16.5) — ovoz berganlar EMAS.
   * ⚠️ `voted > total` bo'lishi MUMKIN: ovoz bergan o'quvchi keyin xonadan chiqsa
   * `total` kamayadi, ovozi esa qoladi. Foizni hisoblashda `min(voted, total)` yoki
   * `max(voted, total)` ga bo'ling — 100% dan oshib ketmasin.
   */
  total: number;
  /** Har variant bo'yicha ovozlar; uzunligi `options.length` ga teng. */
  distribution: number[];
}

/** `POLL_RESULTS.data` — HAMMAGA, yakunda. */
export interface PollResultsData {
  poll_id: string;
  /** Tartibi `distribution` indekslariga AYNAN mos. */
  options: string[];
  distribution: number[];
  /** = `sum(distribution)`, ya'ni ovoz berganlar soni (§16.5) — `POLL_PROGRESS.total` dan FARQLI. */
  total: number;
}

/** `OPEN_START.data` — ayni shu shakl `ROOM_STATE_SYNC.active_open` da ham keladi. */
export interface ActiveOpen {
  open_id: string;
  slide_index: number;
  question: string;
  duration_sec: number;
  ends_at: string;
  /** Javob shu uzunlikka serverda qirqiladi. */
  max_chars: number;
}

/**
 * `OPEN_UPDATE` dagi bitta javob (moderatsiya uchun `answer_id` bilan).
 * ANONIM: `student_id`/ism HECH QACHON kelmaydi (o'qituvchiga ham).
 * `text` — serverda tozalangan, kichik harfli. UI uni FAQAT matn sifatida chizadi
 * (`dangerouslySetInnerHTML` TAQIQLANGAN — XSS).
 */
export interface OpenAnswerRow {
  /** Normallashtirilgan matn hashi — `student_id` dan kelib chiqmaydi. */
  answer_id: string;
  text: string;
  count: number;
}

/** `OPEN_UPDATE.data` — FAQAT O'QITUVCHIGA. Yashirilgan javoblar chiqarilgan; `count` bo'yicha kamayuvchi. */
export interface OpenUpdateData {
  open_id: string;
  /** Javob bergan o'quvchilar soni. */
  answered: number;
  /** Xonadagi hozirgi o'quvchilar soni; `answered > total` bo'lishi mumkin (`PollProgressData.total` ga qarang). */
  total: number;
  answers: OpenAnswerRow[];
}

/** `OPEN_RESULTS` dagi so'z buluti elementi — `answer_id` SIZ. */
export interface OpenWordCount {
  text: string;
  count: number;
}

/** `OPEN_RESULTS.data` — HAMMAGA, yakunda (so'z buluti; yashirilganlar chiqarilgan). */
export interface OpenResultsData {
  open_id: string;
  answers: OpenWordCount[];
}

export interface SessionEndedData {
  session_id: string;
}

export type PongData = Record<string, never>;

export interface WsErrorData {
  code: string;
  message: string;
}

/* ------------------------- Server → Klient (union) ------------------------ */

export type WsRoomStateSyncEvent = ServerFrame<'ROOM_STATE_SYNC', RoomStateSyncData>;
export type WsStudentJoinedEvent = ServerFrame<'STUDENT_JOINED', Participant>;
export type WsStudentLeftEvent = ServerFrame<'STUDENT_LEFT', StudentLeftData>;
export type WsSlideChangeServerEvent = ServerFrame<'SLIDE_CHANGE', SlideChangeServerData>;
export type WsLiveCodePatchServerEvent = ServerFrame<'LIVE_CODE_PATCH', LiveCodePatchServerData>;
export type WsLaserMoveServerEvent = ServerFrame<'LASER_MOVE', LaserMoveData>;
export type WsScreenShareStateServerEvent = ServerFrame<
  'SCREEN_SHARE_STATE',
  ScreenShareStateServerData
>;
export type WsConfusedPingServerEvent = ServerFrame<'CONFUSED_PING', ConfusedPingServerData>;
export type WsFocusChangeServerEvent = ServerFrame<'FOCUS_CHANGE', FocusChangeServerData>;
export type WsQuizStartServerEvent = ServerFrame<'QUIZ_START', ActiveQuiz>;
export type WsQuizProgressEvent = ServerFrame<'QUIZ_PROGRESS', QuizProgressData>;
export type WsQuizResultsEvent = ServerFrame<'QUIZ_RESULTS', QuizResultsData>;
export type WsSessionEndedEvent = ServerFrame<'SESSION_ENDED', SessionEndedData>;
export type WsPongEvent = ServerFrame<'PONG', PongData>;
export type WsErrorEvent = ServerFrame<'ERROR', WsErrorData>;
// v1.2 — CONTRACTS.md §16.3
export type WsPollStartServerEvent = ServerFrame<'POLL_START', ActivePoll>;
export type WsPollProgressEvent = ServerFrame<'POLL_PROGRESS', PollProgressData>;
export type WsPollResultsEvent = ServerFrame<'POLL_RESULTS', PollResultsData>;
export type WsOpenStartServerEvent = ServerFrame<'OPEN_START', ActiveOpen>;
export type WsOpenUpdateEvent = ServerFrame<'OPEN_UPDATE', OpenUpdateData>;
export type WsOpenResultsEvent = ServerFrame<'OPEN_RESULTS', OpenResultsData>;

/** CONTRACTS.md §5 — Server → Klient. `type` bo'yicha discriminated union. */
export type WsServerEvent =
  | WsRoomStateSyncEvent
  | WsStudentJoinedEvent
  | WsStudentLeftEvent
  | WsSlideChangeServerEvent
  | WsLiveCodePatchServerEvent
  | WsLaserMoveServerEvent
  | WsScreenShareStateServerEvent
  | WsConfusedPingServerEvent
  | WsFocusChangeServerEvent
  | WsQuizStartServerEvent
  | WsQuizProgressEvent
  | WsQuizResultsEvent
  | WsPollStartServerEvent
  | WsPollProgressEvent
  | WsPollResultsEvent
  | WsOpenStartServerEvent
  | WsOpenUpdateEvent
  | WsOpenResultsEvent
  | WsSessionEndedEvent
  | WsPongEvent
  | WsErrorEvent;

export type WsServerEventType = WsServerEvent['type'];

/* ------------------------- Klient → Server (union) ----------------------- */

export interface SlideChangeClientData {
  slide_index: number;
}

export interface LiveCodePatchClientData {
  slide_index: number;
  /** <= MAX_CODE_CHARS (20000), 50 ms throttle. */
  code: string;
  cursor?: CodeCursor;
}

export interface ScreenShareStateClientData {
  is_sharing: boolean;
}

/** Anonim, 30 s cooldown. */
export type ConfusedPingClientData = Record<string, never>;

export interface FocusChangeClientData {
  is_focused: boolean;
}

export interface QuizStartClientData {
  slide_index: number;
}

export interface QuizEndClientData {
  quiz_id: string;
}

export interface QuizAnswerClientData {
  quiz_id: string;
  selected_index: number;
  /** Serverda qayta hisoblanadi — bu faqat telemetriya (AUDIT.md §G3). */
  time_ms: number;
}

export type PingClientData = Record<string, never>;

/* v1.2 — `backend/app/ws/protocol.py` (`PollStartIn` … `OpenEndIn`), `extra="forbid"`. */

/**
 * `POLL_START` / `OPEN_START` (TEACHER) — faqat `slide_index`: savol, variantlar va
 * muddat SERVERDA slayd JSON idan o'qiladi, klient matniga ishonilmaydi.
 */
export interface InteractiveStartClientData {
  slide_index: number;
}

export interface PollVoteClientData {
  poll_id: string;
  /** Diapazon serverda tekshiriladi → `INVALID_OPTION`. */
  selected_index: number;
}

export interface PollEndClientData {
  poll_id: string;
}

export interface OpenAnswerClientData {
  open_id: string;
  /**
   * Server tozalaydi va `max_chars` ga QIRQADI. `ANSWER_TOO_LONG` faqat xom matn
   * `min(4 * max_chars, 1000)` dan oshsa (`openRawLimit()`). 1 javob / 2 s (`RATE_LIMITED`).
   */
  text: string;
}

export interface OpenHideClientData {
  open_id: string;
  answer_id: string;
}

export interface OpenEndClientData {
  open_id: string;
}

export type WsSlideChangeClientEvent = ClientFrame<'SLIDE_CHANGE', SlideChangeClientData>;
export type WsLiveCodePatchClientEvent = ClientFrame<'LIVE_CODE_PATCH', LiveCodePatchClientData>;
export type WsLaserMoveClientEvent = ClientFrame<'LASER_MOVE', LaserMoveData>;
export type WsScreenShareStateClientEvent = ClientFrame<
  'SCREEN_SHARE_STATE',
  ScreenShareStateClientData
>;
export type WsQuizStartClientEvent = ClientFrame<'QUIZ_START', QuizStartClientData>;
export type WsQuizEndClientEvent = ClientFrame<'QUIZ_END', QuizEndClientData>;
export type WsConfusedPingClientEvent = ClientFrame<'CONFUSED_PING', ConfusedPingClientData>;
export type WsFocusChangeClientEvent = ClientFrame<'FOCUS_CHANGE', FocusChangeClientData>;
export type WsQuizAnswerClientEvent = ClientFrame<'QUIZ_ANSWER', QuizAnswerClientData>;
export type WsPingClientEvent = ClientFrame<'PING', PingClientData>;
export type WsPollStartClientEvent = ClientFrame<'POLL_START', InteractiveStartClientData>;
export type WsPollVoteClientEvent = ClientFrame<'POLL_VOTE', PollVoteClientData>;
export type WsPollEndClientEvent = ClientFrame<'POLL_END', PollEndClientData>;
export type WsOpenStartClientEvent = ClientFrame<'OPEN_START', InteractiveStartClientData>;
export type WsOpenAnswerClientEvent = ClientFrame<'OPEN_ANSWER', OpenAnswerClientData>;
export type WsOpenHideClientEvent = ClientFrame<'OPEN_HIDE', OpenHideClientData>;
export type WsOpenEndClientEvent = ClientFrame<'OPEN_END', OpenEndClientData>;

/** CONTRACTS.md §5 — Klient → Server. `type` bo'yicha discriminated union. */
export type WsClientEvent =
  | WsSlideChangeClientEvent
  | WsLiveCodePatchClientEvent
  | WsLaserMoveClientEvent
  | WsScreenShareStateClientEvent
  | WsQuizStartClientEvent
  | WsQuizEndClientEvent
  | WsConfusedPingClientEvent
  | WsFocusChangeClientEvent
  | WsQuizAnswerClientEvent
  | WsPollStartClientEvent
  | WsPollVoteClientEvent
  | WsPollEndClientEvent
  | WsOpenStartClientEvent
  | WsOpenAnswerClientEvent
  | WsOpenHideClientEvent
  | WsOpenEndClientEvent
  | WsPingClientEvent;

export type WsClientEventType = WsClientEvent['type'];

/** Faqat TEACHER yuborishi mumkin (STUDENT yuborsa → `ERROR{code:"FORBIDDEN_EVENT"}`). */
export const WS_TEACHER_ONLY_EVENTS: readonly WsClientEventType[] = [
  'SLIDE_CHANGE',
  'LIVE_CODE_PATCH',
  'LASER_MOVE',
  'SCREEN_SHARE_STATE',
  'QUIZ_START',
  'QUIZ_END',
  'POLL_START',
  'POLL_END',
  'OPEN_START',
  'OPEN_HIDE',
  'OPEN_END',
] as const;

/** Faqat STUDENT yuboradi (`protocol.py: STUDENT_EVENTS`). */
export const WS_STUDENT_ONLY_EVENTS: readonly WsClientEventType[] = [
  'CONFUSED_PING',
  'FOCUS_CHANGE',
  'QUIZ_ANSWER',
  'POLL_VOTE',
  'OPEN_ANSWER',
] as const;

/**
 * Faqat TEACHER qabul qiladi (`protocol.py: TEACHER_ONLY_AUDIENCE`).
 * POLL_PROGRESS / OPEN_UPDATE: jonli taqsimot va moderatsiya ro'yxati — o'quvchi
 * natijani faqat yakunda (`*_RESULTS`) ko'radi.
 */
export const WS_TEACHER_ONLY_SERVER_EVENTS: readonly WsServerEventType[] = [
  'CONFUSED_PING',
  'FOCUS_CHANGE',
  'QUIZ_PROGRESS',
  'POLL_PROGRESS',
  'OPEN_UPDATE',
] as const;

/* ------------------------------ WS yordamchi ------------------------------ */

/** WS ulanish holati — `useLiveRoom.connection` uchun (CONTRACTS.md §8). */
export type WsConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

/**
 * Noma'lum JSON ni `WsServerEvent` ga toraytiruvchi type guard.
 * Protokol versiyasi va `type` tekshiriladi; `data` shakli serverga ishoniladi.
 */
export function isWsServerEvent(value: unknown): value is WsServerEvent {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Partial<WsEnvelope>;
  if (frame.v !== WS_PROTOCOL_VERSION) return false;
  if (typeof frame.type !== 'string') return false;
  if (typeof frame.seq !== 'number' || typeof frame.ts !== 'number') return false;
  return (WS_SERVER_EVENT_TYPES as readonly string[]).includes(frame.type);
}

export const WS_SERVER_EVENT_TYPES: readonly WsServerEventType[] = [
  'ROOM_STATE_SYNC',
  'STUDENT_JOINED',
  'STUDENT_LEFT',
  'SLIDE_CHANGE',
  'LIVE_CODE_PATCH',
  'LASER_MOVE',
  'SCREEN_SHARE_STATE',
  'CONFUSED_PING',
  'FOCUS_CHANGE',
  'QUIZ_START',
  'QUIZ_PROGRESS',
  'QUIZ_RESULTS',
  // v1.2 — bu ro'yxatda bo'lmasa `isWsServerEvent()` kadrni JIM tashlab yuboradi.
  'POLL_START',
  'POLL_PROGRESS',
  'POLL_RESULTS',
  'OPEN_START',
  'OPEN_UPDATE',
  'OPEN_RESULTS',
  'SESSION_ENDED',
  'PONG',
  'ERROR',
] as const;

/** `protocol.py: OPEN_RAW_HARD_CAP`. */
export const OPEN_RAW_HARD_CAP = 1000;

/**
 * `protocol.py: open_raw_limit()` — `ANSWER_TOO_LONG` chegarasi: `min(4 * max_chars, 1000)`.
 * Input `maxLength` ni `max_chars` ga qo'yish yetarli; bu faqat klient tomonda oldindan
 * rad etish uchun (server baribir qirqadi).
 */
export function openRawLimit(maxChars: number): number {
  return Math.min(4 * maxChars, OPEN_RAW_HARD_CAP);
}

/** Klient event ini envelope ga o'rab beradi (`v` ni qo'lda yozish shart emas). */
export function wsClientFrame<T extends WsClientEvent>(
  type: T['type'],
  data: T['data'],
): WsClientEvent {
  return { v: WS_PROTOCOL_VERSION, type, data } as WsClientEvent;
}

/* ========================================================================== */
/* 10. Doimiylar — CONTRACTS.md §1 dagi frontendga tegishli limitlar           */
/* ========================================================================== */

/** `MAX_UPLOAD_MB=25`. */
export const MAX_UPLOAD_MB = 25;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
/** `MAX_CODE_CHARS=20000`. */
export const MAX_CODE_CHARS = 20_000;
/** `LIVE_CODE_THROTTLE_MS=50`. */
export const LIVE_CODE_THROTTLE_MS = 50;
/** `WS_HEARTBEAT_SEC=25`. */
export const WS_HEARTBEAT_SEC = 25;
/** AUDIT.md §G4 — lazer uchun teacher tomondagi throttle. */
export const LASER_THROTTLE_MS = 25;
/** CONTRACTS.md §5 — `CONFUSED_PING` cooldown. */
export const CONFUSED_COOLDOWN_MS = 30_000;
/** AUDIT.md §F — focus tracker grace period. */
export const FOCUS_GRACE_MS = 10_000;
/** AUDIT.md §E2 — bundan past ishonchda qizil bayroq KO'RSATILMAYDI. */
export const AI_RED_FLAG_THRESHOLD = 70;

/* ------------------------------ adminka (§ADMIN) --------------------------- */

/** `GET /users` elementi — backend `AdminUserOut` (faqat ADMIN ko'radi). */
export interface AdminUser {
  id: string;
  email: string;
  full_name: string;
  avatar_url: string | null;
  role: UserRole;
  is_active: boolean;
  is_onboarded: boolean;
  created_at: string;
  /** Ochiq parol (mahsulot qarori — o'quvchi unutsa admin aytib beradi).
   *  `null` — parol qo'yilmagan (faqat Google orqali kiradi). */
  password_plain: string | null;
}
