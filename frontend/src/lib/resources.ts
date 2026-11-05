/**
 * CONTRACTS.md §4 dagi BARCHA REST endpointlar — tiplangan funksiyalar.
 *
 * Maqsad: har sahifada `apiFetch` yo'lini qo'lda yozmaslik (yo'l xatosi bo'lmasin).
 * `frontend-live` va `frontend-reviewer` ham shu funksiyalardan foydalanadi.
 */

import type {
  AdminUser,
  UserRole,
  AppealIn,
  AssetUploadOut,
  DownloadUrlOut,
  GradeIn,
  GroupBrief,
  GroupMemberOut,
  GroupOut,
  HomeworkCreateIn,
  HomeworkOut,
  LiveKitTokenOut,
  PresentationCreateIn,
  PresentationListItem,
  PresentationOut,
  PresentationUpdateIn,
  PptxImportOut,
  RoomCreateIn,
  RoomEndOut,
  RoomJoinOut,
  RoomOut,
  RoomReportOut,
  RoomStateOut,
  SubmissionCodeIn,
  SubmissionOut,
  SubmissionWithStudent,
  WsTicketOut,
} from '@/types/api';
import { API_BASE_URL, apiFetch, apiUpload, type UploadOptions } from '@/lib/api';

/* --------------------------------- groups --------------------------------- */

/** `GET /groups` — student: o'zi a'zo; teacher: o'zi egasi. */
export function getGroups(): Promise<GroupOut[]> {
  return apiFetch<GroupOut[]>('/groups');
}

/** `GET /groups/open` — onboarding dropdown. */
export function getOpenGroups(): Promise<GroupBrief[]> {
  return apiFetch<GroupBrief[]>('/groups/open');
}

/** `POST /groups` (TEACHER). */
export function createGroup(body: { name: string; course_title: string }): Promise<GroupOut> {
  return apiFetch<GroupOut>('/groups', { method: 'POST', body });
}

/** `GET /groups/{id}/members`. */
export function getGroupMembers(groupId: number): Promise<GroupMemberOut[]> {
  return apiFetch<GroupMemberOut[]>(`/groups/${groupId}/members`);
}

/** `GET /groups/{id}/attendance.csv` — yuklab olish uchun to'liq URL. */
export function groupAttendanceCsvUrl(groupId: number): string {
  return `${API_BASE_URL}/groups/${groupId}/attendance.csv`;
}

/* ----------------------------- presentations ------------------------------ */

export function getPresentations(): Promise<PresentationListItem[]> {
  return apiFetch<PresentationListItem[]>('/presentations');
}

export function getPresentation(id: string): Promise<PresentationOut> {
  return apiFetch<PresentationOut>(`/presentations/${id}`);
}

export function createPresentation(body: PresentationCreateIn): Promise<PresentationOut> {
  return apiFetch<PresentationOut>('/presentations', { method: 'POST', body });
}

export function updatePresentation(
  id: string,
  body: PresentationUpdateIn,
): Promise<PresentationOut> {
  return apiFetch<PresentationOut>(`/presentations/${id}`, { method: 'PATCH', body });
}

export function deletePresentation(id: string): Promise<void> {
  return apiFetch<void>(`/presentations/${id}`, { method: 'DELETE' });
}

/** `POST /presentations/{id}/assets` — slayd ichiga rasm (R2). */
export function uploadPresentationAsset(
  id: string,
  file: File,
  options?: UploadOptions,
): Promise<AssetUploadOut> {
  const formData = new FormData();
  formData.append('file', file);
  return apiUpload<AssetUploadOut>(`/presentations/${id}/assets`, formData, options);
}

/**
 * `POST /presentations/import/pptx` (TEACHER) — CONTRACTS.md §16.2. SAQLAMAYDI.
 *
 * Multipart, maydon nomi `file`. `apiUpload` (XHR) ishlatiladi: `Content-Type` ni
 * qo'lda QO'YMAYMIZ — brauzer `multipart/form-data; boundary=…` ni o'zi qo'yadi
 * (qo'lda yozilsa boundary yo'qoladi va server faylni o'qiy olmaydi).
 * 401 → refresh → bir marta qayta urinish ham shu yerda bor.
 *
 * Xatolar: `INVALID_PPTX`, `UNSAFE_PPTX`, `FILE_TOO_LARGE` (> 25 MB),
 * `UNSUPPORTED_EXTENSION`, `EMPTY_FILE` — `errorText()` da yorliqlari bor.
 * Natijani o'qituvchiga ko'rsatib, tasdiqlagach `createPresentation()` bilan saqlang.
 */
export function importPptx(file: File, options?: UploadOptions): Promise<PptxImportOut> {
  const formData = new FormData();
  formData.append('file', file);
  return apiUpload<PptxImportOut>('/presentations/import/pptx', formData, options);
}

/* ---------------------------------- rooms --------------------------------- */

/** `POST /rooms` (TEACHER) → PIN + QR payload. */
export function createRoom(body: RoomCreateIn): Promise<RoomOut> {
  return apiFetch<RoomOut>('/rooms', { method: 'POST', body });
}

/** `POST /rooms/{pin}/join` (STUDENT) — guruh tekshiruvi + davomat. */
export function joinRoom(pinCode: string): Promise<RoomJoinOut> {
  return apiFetch<RoomJoinOut>(`/rooms/${pinCode}/join`, { method: 'POST' });
}

/** `POST /rooms/{pin}/ws-ticket` — bir martalik 30 s ticket (AUDIT.md §B3). */
export function createWsTicket(pinCode: string): Promise<WsTicketOut> {
  return apiFetch<WsTicketOut>(`/rooms/${pinCode}/ws-ticket`, { method: 'POST' });
}

/**
 * `GET /rooms/{pin}` — `ROOM_STATE_SYNC` ning REST oynasi (WS zaxirasi).
 * ⚠️ `RoomOut` EMAS, `RoomStateOut` qaytaradi (`RoomOut` — faqat `POST /rooms`).
 */
export function getRoom(pinCode: string): Promise<RoomStateOut> {
  return apiFetch<RoomStateOut>(`/rooms/${pinCode}`);
}

/** `POST /rooms/{pin}/end` (TEACHER) — `ENDED` + ABSENT reconciliation sanoqlari. */
export function endRoom(pinCode: string): Promise<RoomEndOut> {
  return apiFetch<RoomEndOut>(`/rooms/${pinCode}/end`, { method: 'POST' });
}

/** `POST /rooms/{pin}/livekit-token` — `canPublish = (role === TEACHER)`. */
export function createLiveKitToken(pinCode: string): Promise<LiveKitTokenOut> {
  return apiFetch<LiveKitTokenOut>(`/rooms/${pinCode}/livekit-token`, { method: 'POST' });
}

/** `GET /rooms/{pin}/report` (TEACHER). */
export function getRoomReport(pinCode: string): Promise<RoomReportOut> {
  return apiFetch<RoomReportOut>(`/rooms/${pinCode}/report`);
}

/* -------------------------------- homeworks ------------------------------- */

/** `GET /homeworks?group_id=`. */
export function getHomeworks(groupId?: number): Promise<HomeworkOut[]> {
  return apiFetch<HomeworkOut[]>('/homeworks', {
    query: groupId === undefined ? undefined : { group_id: groupId },
  });
}

export function getHomework(id: string): Promise<HomeworkOut> {
  return apiFetch<HomeworkOut>(`/homeworks/${id}`);
}

/** `POST /homeworks` (TEACHER). */
export function createHomework(body: HomeworkCreateIn): Promise<HomeworkOut> {
  return apiFetch<HomeworkOut>('/homeworks', { method: 'POST', body });
}

/** `POST /homeworks/{id}/submit` — multipart `file`. */
export function submitHomeworkFile(
  homeworkId: string,
  file: File,
  options?: UploadOptions,
): Promise<SubmissionOut> {
  const formData = new FormData();
  formData.append('file', file);
  return apiUpload<SubmissionOut>(`/homeworks/${homeworkId}/submit`, formData, options);
}

/** `POST /homeworks/{id}/submit` — JSON `{code, file_name}` (ichki muharrir). */
export function submitHomeworkCode(
  homeworkId: string,
  body: SubmissionCodeIn,
): Promise<SubmissionOut> {
  return apiFetch<SubmissionOut>(`/homeworks/${homeworkId}/submit`, { method: 'POST', body });
}

export interface HomeworkSubmissionsParams {
  /**
   * `?only_latest=` — backend default `true` (har o'quvchidan faqat `is_latest` yozuv).
   * Barcha urinishlar tarixi kerak bo'lsa `false` uzating — klient tomonda
   * filtrlash kerak emas.
   */
  only_latest?: boolean;
}

/**
 * `GET /homeworks/{id}/submissions[?only_latest=]`.
 *
 * O'quvchi ham chaqirishi mumkin — backend javobni o'zining submissionlari bilan
 * cheklaydi. 403 kelsa UI yiqilmaydi (chaqiruvchi tomonda `EmptyState`).
 */
export function getHomeworkSubmissions(
  homeworkId: string,
  params?: HomeworkSubmissionsParams,
): Promise<SubmissionWithStudent[]> {
  return apiFetch<SubmissionWithStudent[]>(`/homeworks/${homeworkId}/submissions`, {
    query: params?.only_latest === undefined ? undefined : { only_latest: params.only_latest },
  });
}

export function getSubmission(id: string): Promise<SubmissionOut> {
  return apiFetch<SubmissionOut>(`/submissions/${id}`);
}

/** `GET /submissions/{id}/download-url` — R2 presigned (fallback Telegram). */
export function getSubmissionDownloadUrl(id: string): Promise<DownloadUrlOut> {
  return apiFetch<DownloadUrlOut>(`/submissions/${id}/download-url`);
}

/** `POST /submissions/{id}/grade` (TEACHER) — audit log yoziladi. */
export function gradeSubmission(id: string, body: GradeIn): Promise<SubmissionOut> {
  return apiFetch<SubmissionOut>(`/submissions/${id}/grade`, { method: 'POST', body });
}

/** `POST /submissions/{id}/appeal` (STUDENT) — AUDIT.md §E2. */
export function appealSubmission(id: string, body: AppealIn): Promise<SubmissionOut> {
  return apiFetch<SubmissionOut>(`/submissions/${id}/appeal`, { method: 'POST', body });
}

/* ------------------------------ adminka ----------------------------------- */

/** `GET /users` (faqat ADMIN) — foydalanuvchilar ro'yxati, email/ism qidiruvi. */
export function listUsers(query = ''): Promise<AdminUser[]> {
  const qs = query.trim().length > 0 ? `?query=${encodeURIComponent(query.trim())}` : '';
  return apiFetch<AdminUser[]>(`/users${qs}`);
}

/** `PATCH /users/{id}/role` (faqat ADMIN). Rol o'zgarsa foydalanuvchi qayta kiradi. */
export function setUserRole(id: string, role: UserRole): Promise<AdminUser> {
  return apiFetch<AdminUser>(`/users/${id}/role`, { method: 'PATCH', body: { role } });
}

/** `PUT /users/{id}/password` (faqat ADMIN) — parol o'rnatish/almashtirish. */
export function setUserPassword(id: string, password: string): Promise<AdminUser> {
  return apiFetch<AdminUser>(`/users/${id}/password`, { method: 'PUT', body: { password } });
}
