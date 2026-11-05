"""Uy ishi va topshiriq javoblari — CONTRACTS.md §4 (`homeworks` bo'limi).

Yo'llar `main.py` da `prefix="/api/v1"` bilan ulanadi, shuning uchun bu yerda
`/homeworks...` va `/submissions...` deb boshlanadi.

🔴 QIZIL CHIZIQ (AUDIT.md §E2): `penalty_applied` FAQAT
`POST /submissions/{id}/grade` da, o'qituvchi yuborgan qiymatdan yoziladi.
AI xulosasi (`ai_suspected`, `ai_confidence_percent`, `suggested_score`)
hech qachon avtomatik ball kamaytirmaydi. Har bir baho o'zgarishi
`grade_audit_log` ga yoziladi (AUDIT.md §D7).

ZERO-DISK (AUDIT.md §A3): `submit` oqimida `UploadFile` ishlatilmaydi —
`request.stream()` ustida `upload_guard` RAM ga oqitadi, `/tmp` ga hech narsa
yozilmaydi. Buni `scripts/verify_zero_disk.sh` tekshiradi.

KO'RINISH QOIDASI (kontrakt v1.1.1):
`GET /homeworks/{id}/submissions` va `GET /submissions/{id}` o'quvchiga ham
ochiq, lekin **majburiy** `student_id = current_user.id` filtri bilan.
O'quvchi AI xulosasini (sabab + dalil) ko'radi — e'tiroz huquqi uchun shart —
lekin `suggested_score` ni ko'rmaydi va `status != GRADED` bo'lsa
`final_score` `null` qaytadi.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request, Response, status
from pydantic import ValidationError
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.deps import get_current_user, require_teacher
from app.core.errors import bad_request, conflict, forbidden, not_found
from app.db.models import (
    BackupStatus,
    GradeAuditLog,
    Group,
    GroupMember,
    Homework,
    LessonSession,
    StorageKind,
    Submission,
    SubmissionStatus,
    User,
    UserRole,
)
from app.db.session import get_db
from app.schemas.homework import (
    AppealIn,
    DownloadUrlOut,
    GradeIn,
    HomeworkCreate,
    HomeworkOut,
    SubmissionCodeIn,
    SubmissionOut,
    SubmissionWithStudent,
)
from app.services import r2_storage, tg_storage
from app.services.upload_guard import (
    assert_allowed_extension,
    file_extension,
    is_multipart,
    sanitize_file_name,
    stream_upload,
    upload_slot,
)
from app.services.zip_extractor import (
    ExtractResult,
    extract_async,
    single_file_result_async,
)

log = logging.getLogger("syncclass.homeworks")

router = APIRouter()

#: Telegram proxy havolasining amal qilish muddati (sekund) — tokenli so'rov.
TELEGRAM_URL_TTL_SEC = 300

#: JSON (`{code, file_name}`) varianti uchun tana chegarasi.
_JSON_BODY_LIMIT = 2 * 1024 * 1024


# ---------------------------------------------------------------------------
# Yordamchilar
# ---------------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(UTC)


def _is_privileged(user: User) -> bool:
    return user.role == UserRole.ADMIN


async def _get_homework(db: AsyncSession, homework_id: uuid.UUID) -> Homework:
    hw = await db.scalar(select(Homework).where(Homework.id == homework_id))
    if hw is None:
        raise not_found("HOMEWORK_NOT_FOUND", "Uy ishi topilmadi.")
    return hw


async def _get_group(db: AsyncSession, group_id: int) -> Group:
    group = await db.scalar(select(Group).where(Group.id == group_id))
    if group is None:
        raise not_found("GROUP_NOT_FOUND", "Guruh topilmadi.")
    return group


async def _is_member(db: AsyncSession, group_id: int, student_id: uuid.UUID) -> bool:
    found = await db.scalar(
        select(GroupMember.id).where(
            GroupMember.group_id == group_id,
            GroupMember.student_id == student_id,
        )
    )
    return found is not None


def _is_group_teacher(user: User, group: Group) -> bool:
    return group.teacher_id == user.id or _is_privileged(user)


async def _access_kind(
    db: AsyncSession, user: User, group_id: int
) -> Literal["teacher", "student"]:
    """Foydalanuvchining guruhga nisbatan roli; aks holda `403 NOT_IN_GROUP`."""
    group = await _get_group(db, group_id)
    if _is_group_teacher(user, group):
        return "teacher"
    if await _is_member(db, group_id, user.id):
        return "student"
    raise forbidden("NOT_IN_GROUP", "Siz bu guruhga tegishli emassiz.")


def _compute_is_late(sub: Submission, deadline: datetime | None = None) -> bool:
    """`is_late = submitted_at > homeworks.deadline` (CONTRACTS.md §11.1).

    Migratsiya kerak emas — bu hisoblangan maydon. `deadline` berilmasa
    `Submission.homework` relationship (`lazy="selectin"`) dan olinadi.
    DIQQAT: faqat ma'lumot — `penalty_applied` ga ta'sir qilmaydi, ball
    avtomatik tushmaydi (AUDIT.md §E2 tamoyili).
    """
    if deadline is None:
        homework = getattr(sub, "homework", None)
        deadline = getattr(homework, "deadline", None)
    submitted_at = getattr(sub, "submitted_at", None)
    if deadline is None or submitted_at is None:
        return False
    return submitted_at > deadline


def _serialize_submission(
    sub: Submission, *, for_student: bool, deadline: datetime | None = None
) -> SubmissionOut:
    """`SubmissionOut` yasaydi; o'quvchi uchun ichki maydonlar yashiriladi.

    O'quvchi AI xulosasini ko'radi (AUDIT.md §E2 — e'tiroz huquqi), lekin
    `suggested_score` ni ko'rmaydi; baho faqat `GRADED` bo'lganda ochiladi.
    """
    student = getattr(sub, "student", None)
    out = SubmissionOut.model_validate(sub)
    out.student_name = getattr(student, "full_name", None)
    out.student_avatar_url = getattr(student, "avatar_url", None)
    out.is_late = _compute_is_late(sub, deadline)
    if for_student:
        out.suggested_score = None
        if sub.status != SubmissionStatus.GRADED:
            out.final_score = None
    return out


def _brief(
    sub: Submission, *, for_student: bool, deadline: datetime | None = None
) -> SubmissionWithStudent:
    student = getattr(sub, "student", None)
    brief = SubmissionWithStudent.model_validate(sub)
    brief.student_name = getattr(student, "full_name", None)
    brief.student_avatar_url = getattr(student, "avatar_url", None)
    brief.is_late = _compute_is_late(sub, deadline)
    if for_student:
        brief.suggested_score = None
        if sub.status != SubmissionStatus.GRADED:
            brief.final_score = None
    return brief


async def _get_submission(db: AsyncSession, submission_id: uuid.UUID) -> Submission:
    sub = await db.scalar(select(Submission).where(Submission.id == submission_id))
    if sub is None:
        raise not_found("SUBMISSION_NOT_FOUND", "Topshiriq javobi topilmadi.")
    return sub


async def _submission_access(
    db: AsyncSession, user: User, sub: Submission
) -> tuple[Homework, Literal["teacher", "student"]]:
    """O'qituvchi — o'z guruhidagilarni; o'quvchi — FAQAT o'zinikini."""
    hw = await _get_homework(db, sub.homework_id)
    kind = await _access_kind(db, user, hw.group_id)
    if kind == "student" and sub.student_id != user.id:
        raise forbidden("NOT_OWNER", "Bu topshiriq javobi sizga tegishli emas.")
    return hw, kind


# ---------------------------------------------------------------------------
# 1. POST /homeworks  (TEACHER)
# ---------------------------------------------------------------------------


@router.post("/homeworks", response_model=HomeworkOut, status_code=status.HTTP_201_CREATED)
async def create_homework(
    payload: HomeworkCreate,
    db: AsyncSession = Depends(get_db),
    teacher: User = Depends(require_teacher),
) -> HomeworkOut:
    """Uy ishi yaratish. Faqat guruh o'qituvchisi (yoki ADMIN)."""
    group = await _get_group(db, payload.group_id)
    if not _is_group_teacher(teacher, group):
        raise forbidden("NOT_OWNER", "Bu guruh sizga tegishli emas.")

    if payload.session_id is not None:
        session_group = await db.scalar(
            select(LessonSession.group_id).where(LessonSession.id == payload.session_id)
        )
        if session_group is None:
            raise not_found("SESSION_NOT_FOUND", "Dars sessiyasi topilmadi.")
        if session_group != payload.group_id:
            raise bad_request(
                "SESSION_GROUP_MISMATCH",
                "Dars sessiyasi boshqa guruhga tegishli.",
                session_id=str(payload.session_id),
            )

    hw = Homework(
        group_id=payload.group_id,
        session_id=payload.session_id,
        title=payload.title.strip(),
        description=payload.description.strip(),
        deadline=payload.deadline,
        max_score=payload.max_score,
        ai_penalty_points=payload.ai_penalty_points,
        allow_resubmit=payload.allow_resubmit,
        created_by=teacher.id,
    )
    db.add(hw)
    await db.commit()
    return HomeworkOut.model_validate(hw)


# ---------------------------------------------------------------------------
# 2. GET /homeworks?group_id=
# ---------------------------------------------------------------------------


@router.get("/homeworks", response_model=list[HomeworkOut])
async def list_homeworks(
    group_id: int | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[HomeworkOut]:
    """O'quvchi — a'zo guruhlari; o'qituvchi — o'zi egasi bo'lgan guruhlar."""
    if user.role in (UserRole.TEACHER, UserRole.ADMIN):
        owned = select(Group.id).where(Group.teacher_id == user.id)
        if _is_privileged(user):
            owned = select(Group.id)
        stmt = select(Homework).where(Homework.group_id.in_(owned))
        is_teacher_view = True
    else:
        member_groups = select(GroupMember.group_id).where(GroupMember.student_id == user.id)
        stmt = select(Homework).where(Homework.group_id.in_(member_groups))
        is_teacher_view = False

    if group_id is not None:
        await _access_kind(db, user, group_id)
        stmt = stmt.where(Homework.group_id == group_id)

    stmt = stmt.order_by(Homework.deadline.desc())
    homeworks = list((await db.scalars(stmt)).all())
    if not homeworks:
        return []

    hw_ids = [hw.id for hw in homeworks]
    counts: dict[uuid.UUID, int] = {}
    mine: dict[uuid.UUID, Submission] = {}

    if is_teacher_view:
        rows = await db.execute(
            select(Submission.homework_id, func.count())
            .where(Submission.homework_id.in_(hw_ids), Submission.is_latest.is_(True))
            .group_by(Submission.homework_id)
        )
        counts = {hw_id: int(total) for hw_id, total in rows.all()}
    else:
        subs = await db.scalars(
            select(Submission).where(
                Submission.homework_id.in_(hw_ids),
                Submission.student_id == user.id,
                Submission.is_latest.is_(True),
            )
        )
        mine = {s.homework_id: s for s in subs.all()}

    result: list[HomeworkOut] = []
    for hw in homeworks:
        item = HomeworkOut.model_validate(hw)
        item.submissions_count = counts.get(hw.id, 0)
        own = mine.get(hw.id)
        if own is not None:
            item.my_submission_id = own.id
            item.my_status = own.status
        result.append(item)
    return result


# ---------------------------------------------------------------------------
# 3. GET /homeworks/{id}
# ---------------------------------------------------------------------------


@router.get("/homeworks/{homework_id}", response_model=HomeworkOut)
async def get_homework(
    homework_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> HomeworkOut:
    hw = await _get_homework(db, homework_id)
    kind = await _access_kind(db, user, hw.group_id)
    item = HomeworkOut.model_validate(hw)
    if kind == "teacher":
        item.submissions_count = int(
            await db.scalar(
                select(func.count())
                .select_from(Submission)
                .where(Submission.homework_id == hw.id, Submission.is_latest.is_(True))
            )
            or 0
        )
    else:
        own = await db.scalar(
            select(Submission).where(
                Submission.homework_id == hw.id,
                Submission.student_id == user.id,
                Submission.is_latest.is_(True),
            )
        )
        if own is not None:
            item.my_submission_id = own.id
            item.my_status = own.status
    return item


# ---------------------------------------------------------------------------
# 4. POST /homeworks/{id}/submit
# ---------------------------------------------------------------------------


async def _read_payload(request: Request) -> tuple[Any, str, str, int, str]:
    """So'rov tanasini RAM ga oqitadi.

    Qaytaradi: `(buf, file_name, sha256, size, content_type)`.
    Ikki variant (CONTRACTS.md §4): multipart `file` **yoki** JSON `{code, file_name}`.
    """
    if is_multipart(request):
        up = await stream_upload(request, settings.max_upload_bytes, field_name="file")
        raw_name = up.form_fields.get("file_name") or up.file_name
        file_name = sanitize_file_name(raw_name, default="solution.zip")
        if up.size == 0:
            raise bad_request("EMPTY_FILE", "Bo'sh fayl yuborildi.")
        return (
            up.buf,
            file_name,
            up.sha256,
            up.size,
            up.content_type or "application/octet-stream",
        )

    raw = await stream_upload(request, _JSON_BODY_LIMIT)
    try:
        payload = json.loads(raw.data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise bad_request(
            "INVALID_BODY",
            "So'rov tanasi multipart fayl ham, to'g'ri JSON ham emas.",
        ) from exc
    try:
        code_in = SubmissionCodeIn.model_validate(payload)
    except ValidationError as exc:
        raise bad_request(
            "VALIDATION_ERROR",
            "Yuborilgan ma'lumot to'g'ri emas.",
            errors=exc.errors(include_url=False),
        ) from exc

    data = code_in.code.encode("utf-8")
    if len(data) > settings.max_upload_bytes:
        raise bad_request("FILE_TOO_LARGE", "Kod juda uzun.")
    file_name = sanitize_file_name(code_in.file_name, default="solution.py")
    return (
        io.BytesIO(data),
        file_name,
        hashlib.sha256(data).hexdigest(),
        len(data),
        "text/plain; charset=utf-8",
    )


async def _insert_submission(
    db: AsyncSession,
    *,
    homework_id: uuid.UUID,
    student_id: uuid.UUID,
    file_name: str,
    size: int,
    sha256: str,
    extraction: ExtractResult,
    r2_key: str | None,
    backup_status: BackupStatus,
) -> Submission:
    """`is_latest` almashtirish + `attempt_no` — CONTRACTS.md §2.2.

    `uq_latest_sub` partial unique sabab, INSERT dan OLDIN bir tranzaksiyada
    eski yozuvlar `is_latest=false` ga o'tkaziladi. Parallel upload race
    bo'lishi mumkin → `IntegrityError` da 3 marta retry.
    """
    last_error: IntegrityError | None = None
    for attempt in range(3):
        try:
            next_no = int(
                await db.scalar(
                    select(func.coalesce(func.max(Submission.attempt_no), 0)).where(
                        Submission.homework_id == homework_id,
                        Submission.student_id == student_id,
                    )
                )
                or 0
            ) + 1

            await db.execute(
                update(Submission)
                .where(
                    Submission.homework_id == homework_id,
                    Submission.student_id == student_id,
                    Submission.is_latest.is_(True),
                )
                .values(is_latest=False)
            )

            sub = Submission(
                homework_id=homework_id,
                student_id=student_id,
                attempt_no=next_no,
                is_latest=True,
                storage_primary=StorageKind.R2,
                r2_object_key=r2_key,
                tg_backup_status=backup_status,
                file_name=file_name,
                file_size_bytes=size,
                content_sha256=sha256,
                extracted_files=extraction.as_jsonb(),
                extract_truncated=extraction.truncated,
                status=SubmissionStatus.PENDING_AI,
                submitted_at=_now(),
            )
            db.add(sub)
            await db.commit()
            return sub
        except IntegrityError as exc:
            # `uq_submissions_homework_id_student_id_attempt_no` yoki
            # `uq_latest_sub` — ikkisi ham parallel urinish belgisi.
            last_error = exc
            await db.rollback()
            log.warning(
                "submission race (urinish %d/3) homework=%s student=%s",
                attempt + 1,
                homework_id,
                student_id,
            )
    raise conflict(
        "SUBMISSION_RACE",
        "Bir vaqtda bir nechta yuklash aniqlandi. Qayta urinib ko'ring.",
    ) from last_error


@router.post(
    "/homeworks/{homework_id}/submit",
    response_model=SubmissionOut,
    status_code=status.HTTP_201_CREATED,
)
async def submit_homework(
    homework_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SubmissionOut:
    """Topshiriq javobini yuborish (multipart `file` yoki JSON `{code, file_name}`).

    Oqim: validatsiya → RAM ga oqim → zip extraction → R2 upload →
    DB yozuv (`attempt_no`, eski `is_latest=false`) → Telegram zahira navbati →
    AI grading navbati → `SubmissionOut`.
    """
    hw = await _get_homework(db, homework_id)
    if not await _is_member(db, hw.group_id, user.id):
        raise forbidden(
            "NOT_IN_GROUP", "Topshiriqni faqat guruh o'quvchisi yuborishi mumkin."
        )

    previous = await db.scalar(
        select(Submission).where(
            Submission.homework_id == hw.id,
            Submission.student_id == user.id,
            Submission.is_latest.is_(True),
        )
    )
    if (
        previous is not None
        and not hw.allow_resubmit
        and previous.status != SubmissionStatus.RESUBMIT_REQUIRED
    ):
        raise conflict(
            "RESUBMIT_NOT_ALLOWED",
            "Bu uy ishi uchun qayta topshirish yoqilmagan.",
        )

    # R2 — canonical manba. Sirlar yo'q bo'lsa aniq xato (import paytida emas).
    missing = r2_storage.missing_config()
    if missing:
        raise r2_storage.storage_not_configured(missing)

    async with upload_slot():
        buf, file_name, sha256, size, content_type = await _read_payload(request)
        ext = assert_allowed_extension(file_name)

        if ext == ".zip":
            extraction = await extract_async(buf)
        else:
            extraction = await single_file_result_async(file_name, buf.getvalue())

        r2_key = r2_storage.build_submission_key(
            hw.id, user.id, (previous.attempt_no + 1) if previous else 1, file_name
        )
        await r2_storage.upload_bytes(r2_key, buf, content_type, file_name=file_name)

    eligible = tg_storage.is_enabled() and tg_storage.fits_telegram(size)
    backup_status = BackupStatus.QUEUED if eligible else BackupStatus.NONE

    sub = await _insert_submission(
        db,
        homework_id=hw.id,
        student_id=user.id,
        file_name=file_name,
        size=size,
        sha256=sha256,
        extraction=extraction,
        r2_key=r2_key,
        backup_status=backup_status,
    )

    if eligible and not await tg_storage.enqueue_telegram_backup(str(sub.id)):
        sub.tg_backup_status = BackupStatus.FAILED
        await db.commit()

    # AI pre-grader (`ai-grader-engineer` ning `grade_submission` taski).
    # Navbat yiqilsa submission `PENDING_AI` da qoladi — worker cron'i
    # 10 daqiqadan oshganlarni qayta navbatga qo'yadi (AUDIT.md §E3).
    if not await tg_storage.enqueue_ai_grading(str(sub.id)):
        log.warning("grade_submission navbatga tushmadi: %s", sub.id)

    await db.refresh(sub)
    return _serialize_submission(sub, for_student=True, deadline=hw.deadline)


# ---------------------------------------------------------------------------
# 5. GET /homeworks/{id}/submissions
# ---------------------------------------------------------------------------


@router.get("/homeworks/{homework_id}/submissions", response_model=list[SubmissionWithStudent])
async def list_submissions(
    homework_id: uuid.UUID,
    only_latest: bool = Query(default=True),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[SubmissionWithStudent]:
    """O'qituvchi — barcha javoblar; o'quvchi — FAQAT o'zining javoblari.

    Kontrakt v1.1.1: o'quvchiga `403` berilmaydi, lekin so'rov majburiy
    `student_id = current_user.id` filtri bilan bajariladi.
    """
    hw = await _get_homework(db, homework_id)
    kind = await _access_kind(db, user, hw.group_id)

    stmt = select(Submission).where(Submission.homework_id == hw.id)
    if kind == "student":
        stmt = stmt.where(Submission.student_id == user.id)
    if only_latest:
        stmt = stmt.where(Submission.is_latest.is_(True))
    stmt = stmt.order_by(Submission.submitted_at.desc())

    rows = list((await db.scalars(stmt)).all())
    return [
        _brief(s, for_student=kind == "student", deadline=hw.deadline) for s in rows
    ]


# ---------------------------------------------------------------------------
# 6. GET /submissions/{id}
# ---------------------------------------------------------------------------


@router.get("/submissions/{submission_id}", response_model=SubmissionOut)
async def get_submission(
    submission_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SubmissionOut:
    """O'quvchi faqat o'zining javobini, o'qituvchi o'z guruhidagilarni ko'radi."""
    sub = await _get_submission(db, submission_id)
    hw, kind = await _submission_access(db, user, sub)
    return _serialize_submission(sub, for_student=kind == "student", deadline=hw.deadline)


# ---------------------------------------------------------------------------
# 7. GET /submissions/{id}/download-url
# ---------------------------------------------------------------------------


@router.get("/submissions/{submission_id}/download-url", response_model=DownloadUrlOut)
async def submission_download_url(
    submission_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DownloadUrlOut:
    """R2 presigned havola; R2 bo'lmasa Telegram zahirasi uchun proxy havola.

    DIQQAT: Telegram `getFile` havolasi ichida bot token bo'ladi, shuning
    uchun u brauzerga BERILMAYDI — `/submissions/{id}/download` orqali
    server o'zi uzatadi.
    """
    sub = await _get_submission(db, submission_id)
    await _submission_access(db, user, sub)

    if sub.r2_object_key and r2_storage.is_configured():
        url = await r2_storage.presigned_url(sub.r2_object_key, settings.R2_PRESIGN_TTL_SEC)
        return DownloadUrlOut(
            url=url, expires_in=settings.R2_PRESIGN_TTL_SEC, storage=StorageKind.R2
        )

    if sub.tg_file_id and tg_storage.is_configured():
        base = settings.BACKEND_PUBLIC_URL.rstrip("/")
        return DownloadUrlOut(
            url=f"{base}/api/v1/submissions/{sub.id}/download",
            expires_in=TELEGRAM_URL_TTL_SEC,
            storage=StorageKind.TELEGRAM,
        )

    raise not_found(
        "FILE_UNAVAILABLE",
        "Fayl hozircha yuklab olinmaydi (saqlash xizmati javob bermayapti).",
    )


# ---------------------------------------------------------------------------
# 7b. GET /submissions/{id}/download — Telegram zahirasi uchun proxy
# ---------------------------------------------------------------------------


@router.get("/submissions/{submission_id}/download")
async def submission_download(
    submission_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Faylni server orqali uzatadi (RAM ≤ 20 MB, diskka yozilmaydi).

    Bu `download-url` ning Telegram tarmog'i uchun juftligi: bot tokenini
    oshkor qilmaslik uchun zarur.
    """
    sub = await _get_submission(db, submission_id)
    await _submission_access(db, user, sub)

    if sub.r2_object_key and r2_storage.is_configured():
        buf = await r2_storage.download_bytes(sub.r2_object_key)
    elif sub.tg_file_id and tg_storage.is_configured():
        buf = await tg_storage.download_file_bytes(sub.tg_file_id)
    else:
        raise not_found("FILE_UNAVAILABLE", "Fayl yuklab olinmaydi.")

    ext = file_extension(sub.file_name)
    media_type = "application/zip" if ext == ".zip" else "application/octet-stream"
    return Response(
        content=buf.getvalue(),
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{sub.file_name}"'},
    )


# ---------------------------------------------------------------------------
# 8. POST /submissions/{id}/grade  (TEACHER)
# ---------------------------------------------------------------------------


@router.post("/submissions/{submission_id}/grade", response_model=SubmissionOut)
async def grade_submission(
    submission_id: uuid.UUID,
    payload: GradeIn,
    db: AsyncSession = Depends(get_db),
    teacher: User = Depends(require_teacher),
) -> SubmissionOut:
    """Baho qo'yish — `penalty_applied` YOZILADIGAN YAGONA joy (AUDIT.md §E2).

    Har o'zgarish `grade_audit_log` ga yoziladi (AUDIT.md §D7): eski/yangi
    ball, eski/yangi jarima, sabab (o'qituvchi izohi).
    """
    sub = await _get_submission(db, submission_id)
    hw = await _get_homework(db, sub.homework_id)
    group = await _get_group(db, hw.group_id)
    if not _is_group_teacher(teacher, group):
        raise forbidden("NOT_OWNER", "Bu guruh sizga tegishli emas.")

    if payload.final_score > hw.max_score:
        raise bad_request(
            "SCORE_OUT_OF_RANGE",
            f"Ball {hw.max_score} dan oshmasligi kerak.",
            max_score=hw.max_score,
        )
    if payload.penalty_applied > hw.max_score:
        raise bad_request(
            "PENALTY_OUT_OF_RANGE",
            f"Jarima {hw.max_score} dan oshmasligi kerak.",
            max_score=hw.max_score,
        )

    old_score = sub.final_score
    old_penalty = sub.penalty_applied

    sub.final_score = payload.final_score
    sub.penalty_applied = payload.penalty_applied
    sub.teacher_comment = payload.teacher_comment
    sub.status = SubmissionStatus(payload.status)
    sub.graded_at = _now()

    db.add(
        GradeAuditLog(
            submission_id=sub.id,
            actor_id=teacher.id,
            old_score=old_score,
            new_score=payload.final_score,
            old_penalty=old_penalty,
            new_penalty=payload.penalty_applied,
            reason=payload.teacher_comment,
        )
    )
    await db.commit()
    await db.refresh(sub)
    return _serialize_submission(sub, for_student=False, deadline=hw.deadline)


# ---------------------------------------------------------------------------
# 9. POST /submissions/{id}/appeal  (STUDENT)
# ---------------------------------------------------------------------------


@router.post("/submissions/{submission_id}/appeal", response_model=SubmissionOut)
async def appeal_submission(
    submission_id: uuid.UUID,
    payload: AppealIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SubmissionOut:
    """O'quvchi e'tirozi (AUDIT.md §E2) — AI bayrog'i yoki baho bo'yicha."""
    sub = await _get_submission(db, submission_id)
    hw, kind = await _submission_access(db, user, sub)
    if kind != "student" or sub.student_id != user.id:
        raise forbidden("STUDENT_ONLY", "E'tirozni faqat o'quvchining o'zi yuboradi.")

    sub.student_appeal = payload.text
    await db.commit()
    await db.refresh(sub)
    return _serialize_submission(sub, for_student=True, deadline=hw.deadline)


__all__ = ["router"]
