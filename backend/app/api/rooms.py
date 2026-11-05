"""Xona (jonli dars) REST API — CONTRACTS.md §4 dagi 7 endpoint.

Eng muhim qoidalar:

* **PIN** — `secrets` bilan crypto-secure (AUDIT.md §C3). `uq_active_pin`
  partial unique sabab `IntegrityError` bo'lsa **yangi PIN bilan 5 martagacha
  retry** qilinadi (CONTRACTS.md §2.2). Sessiya `ENDED` bo'lgach PIN avtomatik
  bo'shaydi — index sharti `status <> 'ENDED'`.
* **Guruh tekshiruvi** — P-31 o'quvchisi P-30 sessiyasiga kira olmaydi:
  `403 NOT_IN_GROUP` (AUDIT.md §C2).
* **Bir martalik ticket** — JWT WS URL ga hech qachon tushmaydi (AUDIT.md §B3).
* **LiveKit** — o'quvchida `can_publish=False, can_publish_data=False`
  (AUDIT.md §F). Sirlar bo'lmasa aniq `AppError`, **import paytida yiqilmaydi**.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Final

from fastapi import APIRouter, Depends, status
from redis.asyncio import Redis
from sqlalchemy import Select, cast, func, literal, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.deps import get_current_user, get_redis, require_teacher
from app.core.errors import AppError, forbidden, not_found
from app.core.security import (
    check_lockout,
    check_rate_limit,
    clear_failures,
    generate_pin_code,
    register_failure,
)
from app.db.models import (
    ATTENDANCE_STATUS_ENUM,
    Attendance,
    AttendanceStatus,
    Group,
    GroupMember,
    LessonSession,
    Presentation,
    QuizAnswer,
    SessionStatus,
    User,
    UserRole,
)
from app.db.session import get_db
from app.schemas.room import (
    ConfusedStats,
    LiveKitTokenOut,
    Participant,
    PresentationBrief,
    RoomCreateIn,
    RoomEndOut,
    RoomJoinOut,
    RoomOut,
    RoomQuizStat,
    RoomReportOut,
    RoomReportRow,
    RoomStateOut,
    WsTicketOut,
    redact_slides_for_student,
)
from app.services.room_state import RoomState, issue_ticket

log = logging.getLogger("syncclass.api.rooms")

router = APIRouter()

#: PIN yaratishda `uq_active_pin` to'qnashuvi bo'lsa shuncha marta qayta urinamiz.
PIN_MAX_RETRIES: Final[int] = 5

#: Join urinishlari: 10/daqiqa, 5 xatodan keyin 5 daqiqa lockout (AUDIT.md §C3).
JOIN_SCOPE: Final[str] = "room_join"
JOIN_RATE_LIMIT: Final[int] = 10
JOIN_RATE_WINDOW_SEC: Final[int] = 60
JOIN_FAIL_LIMIT: Final[int] = 5
JOIN_LOCKOUT_SEC: Final[int] = 300


CurrentUser = Annotated[User, Depends(get_current_user)]
TeacherUser = Annotated[User, Depends(require_teacher)]
Db = Annotated[AsyncSession, Depends(get_db)]
RedisDep = Annotated[Redis, Depends(get_redis)]


# ===========================================================================
# Yordamchilar — `app/ws/routes.py` ham shulardan foydalanadi
# ===========================================================================


def join_url_for(pin_code: str) -> str:
    """QR kod payload'i ham shu URL (CONTRACTS.md §4)."""
    origin = settings.cors_origins[0] if settings.cors_origins else settings.FRONTEND_ORIGIN
    return f"{origin.rstrip('/')}/live/{pin_code}"


def livekit_room_name(session_id: str | uuid.UUID) -> str:
    return f"syncclass-{session_id}"


def _session_query(pin_code: str, *, include_ended: bool) -> Select[tuple[LessonSession]]:
    stmt = select(LessonSession).where(LessonSession.pin_code == pin_code)
    if not include_ended:
        stmt = stmt.where(LessonSession.status != SessionStatus.ENDED)
    # `uq_active_pin` sabab faol sessiya ko'pi bilan bitta; ENDED lar orasida
    # eng oxirgisi kerak bo'ladi.
    return stmt.order_by(LessonSession.started_at.desc()).limit(1)


async def load_session(
    db: AsyncSession, pin_code: str, *, include_ended: bool = False
) -> LessonSession:
    """PIN bo'yicha sessiya. Topilmasa `404 ROOM_NOT_FOUND`."""
    session = (
        await db.execute(_session_query(pin_code, include_ended=include_ended))
    ).scalar_one_or_none()
    if session is None:
        raise not_found("ROOM_NOT_FOUND", "Bunday PIN bilan faol dars topilmadi.")
    return session


async def is_group_member(db: AsyncSession, group_id: int, student_id: uuid.UUID) -> bool:
    found = (
        await db.execute(
            select(GroupMember.id).where(
                GroupMember.group_id == group_id, GroupMember.student_id == student_id
            )
        )
    ).scalar_one_or_none()
    return found is not None


async def resolve_room_role(
    db: AsyncSession, session: LessonSession, user: User
) -> UserRole:
    """Foydalanuvchining XONADAGI roli.

    * guruh egasi (yoki `ADMIN`) → `TEACHER`
    * guruh a'zosi → `STUDENT`
    * aks holda → `403 NOT_IN_GROUP` (AUDIT.md §C2)

    Diqqat: global `users.role == TEACHER` bo'lishi yetarli emas — o'qituvchi A
    o'qituvchi B ning darsini boshqara olmaydi.
    """
    group = session.group
    if group is not None and group.teacher_id == user.id:
        return UserRole.TEACHER
    if user.role is UserRole.ADMIN:
        return UserRole.TEACHER
    if await is_group_member(db, session.group_id, user.id):
        return UserRole.STUDENT
    raise forbidden("NOT_IN_GROUP", "Siz bu darsning guruhiga a'zo emassiz.")


def attendance_status_for(session: LessonSession, moment: datetime | None = None) -> AttendanceStatus:
    """`late_after_minutes` dan keyin kelgan — `LATE` (AUDIT.md §D4)."""
    now = moment or datetime.now(UTC)
    started = session.started_at
    if started.tzinfo is None:  # pragma: no cover - DB TIMESTAMPTZ qaytaradi
        started = started.replace(tzinfo=UTC)
    deadline = started + timedelta(minutes=session.late_after_minutes)
    return AttendanceStatus.PRESENT if now <= deadline else AttendanceStatus.LATE


async def upsert_attendance(
    db: AsyncSession, session: LessonSession, student_id: uuid.UUID
) -> AttendanceStatus:
    """Avto-davomat. `ON CONFLICT DO NOTHING` — birinchi kelish yozuvi saqlanadi.

    Commit chaqiruvchi zimmasida (CONTRACTS.md §2.3), lekin bu funksiya yozuvni
    o'qib ham qaytaradi, shuning uchun `flush` qiladi.
    """
    wanted = attendance_status_for(session)
    await db.execute(
        pg_insert(Attendance)
        .values(session_id=session.id, student_id=student_id, status=wanted)
        .on_conflict_do_nothing(index_elements=["session_id", "student_id"])
    )
    await db.flush()
    actual = (
        await db.execute(
            select(Attendance.status).where(
                Attendance.session_id == session.id, Attendance.student_id == student_id
            )
        )
    ).scalar_one()
    return actual


async def _guard_join_attempts(redis: Redis, user_id: uuid.UUID) -> None:
    """Brute-force himoyasi (AUDIT.md §C3): 10/daqiqa + 5 xatodan keyin lockout.

    Hisoblagichlar `app.core.security` da — auth-engineer bergan umumiy
    token-bucket (`ratelimit:{scope}:{key}`), takrorlanmaydi.
    """
    await check_lockout(redis, JOIN_SCOPE, str(user_id))
    await check_rate_limit(
        redis, JOIN_SCOPE, str(user_id), JOIN_RATE_LIMIT, JOIN_RATE_WINDOW_SEC
    )


def _presentation_brief(presentation: Presentation) -> PresentationBrief:
    slides = presentation.slides_data or []
    return PresentationBrief(
        id=presentation.id, title=presentation.title, slides_count=len(slides)
    )


def _slide_type_at(presentation: Presentation, index: int) -> str:
    slides = presentation.slides_data or []
    if 0 <= index < len(slides):
        return str(slides[index].get("type", "MARKDOWN"))
    return "MARKDOWN"


# ===========================================================================
# POST /rooms  — darsni boshlash
# ===========================================================================


@router.post("/rooms", response_model=RoomOut, status_code=status.HTTP_201_CREATED)
async def create_room(
    payload: RoomCreateIn, user: TeacherUser, db: Db, redis: RedisDep
) -> RoomOut:
    """Yangi xona: crypto-secure PIN + `uq_active_pin` da 5 martagacha retry."""
    group = (
        await db.execute(select(Group).where(Group.id == payload.group_id))
    ).scalar_one_or_none()
    if group is None:
        raise not_found("GROUP_NOT_FOUND", "Guruh topilmadi.")
    if group.teacher_id != user.id and user.role is not UserRole.ADMIN:
        raise forbidden("NOT_OWNER", "Bu guruh sizga tegishli emas.")

    presentation = (
        await db.execute(
            select(Presentation).where(Presentation.id == payload.presentation_id)
        )
    ).scalar_one_or_none()
    if presentation is None:
        raise not_found("PRESENTATION_NOT_FOUND", "Prezentatsiya topilmadi.")
    if presentation.teacher_id != user.id and user.role is not UserRole.ADMIN:
        raise forbidden("NOT_OWNER", "Bu prezentatsiya sizga tegishli emas.")

    # `rollback()` ORM obyektlarini expire qiladi va async kontekstda
    # lazy-refresh `MissingGreenlet` beradi — shuning uchun kerakli qiymatlar
    # retry tsiklidan OLDIN oddiy Python o'zgaruvchilariga ko'chiriladi.
    group_id = group.id
    brief = _presentation_brief(presentation)
    first_slide_type = _slide_type_at(presentation, 0)

    session: LessonSession | None = None
    for _attempt in range(PIN_MAX_RETRIES):
        candidate = LessonSession(
            group_id=group_id,
            presentation_id=brief.id,
            pin_code=generate_pin_code(),
            current_slide_index=0,
            status=SessionStatus.LOBBY,
        )
        db.add(candidate)
        try:
            await db.commit()
        except IntegrityError:
            # `uq_active_pin` to'qnashdi — PIN band. Rollback SHART (§2.3).
            await db.rollback()
            continue
        session = candidate
        break

    if session is None:
        raise AppError(
            status.HTTP_409_CONFLICT,
            "PIN_UNAVAILABLE",
            f"Bo'sh PIN topilmadi ({PIN_MAX_RETRIES} urinish). Qayta urinib ko'ring.",
        )

    # Redis Hash — yagona haqiqat manbasi (AUDIT.md §B2).
    await RoomState(redis, session.id).ensure(
        slide_index=0, slide_type=first_slide_type, code="", status=SessionStatus.LOBBY.value
    )

    log.info(
        "Xona yaratildi",
        extra={"extra_fields": {"session_id": str(session.id), "pin": session.pin_code}},
    )
    return RoomOut(
        session_id=session.id,
        pin_code=session.pin_code,
        join_url=join_url_for(session.pin_code),
        status=session.status,
        current_slide_index=session.current_slide_index,
        presentation=brief,
    )


# ===========================================================================
# POST /rooms/{pin}/join  — o'quvchi kirishi + avto-davomat
# ===========================================================================


@router.post("/rooms/{pin_code}/join", response_model=RoomJoinOut)
async def join_room(
    pin_code: str, user: CurrentUser, db: Db, redis: RedisDep
) -> RoomJoinOut:
    """Guruh tekshiruvi → avto-davomat (`PRESENT`/`LATE`) → to'liq kontekst.

    P-31 o'quvchisi P-30 sessiyasiga kira olmaydi → `403 NOT_IN_GROUP`.
    """
    await _guard_join_attempts(redis, user.id)
    try:
        session = await load_session(db, pin_code)
        room_role = await resolve_room_role(db, session, user)
    except AppError:
        # Xato PIN / begona guruh — brute-force hisoblagichi oshadi.
        await register_failure(
            redis,
            JOIN_SCOPE,
            str(user.id),
            max_failures=JOIN_FAIL_LIMIT,
            lockout_sec=JOIN_LOCKOUT_SEC,
        )
        raise
    await clear_failures(redis, JOIN_SCOPE, str(user.id))

    group = session.group
    presentation = session.presentation

    if room_role is UserRole.STUDENT:
        attendance_status = await upsert_attendance(db, session, user.id)
        await db.commit()
        # Xonada o'tirganlar Redis `members` HASH ida; `STUDENT_JOINED` eventi
        # WS ulanishida yuboriladi (REST join hali socket ochmaydi).
    else:
        attendance_status = AttendanceStatus.PRESENT

    return RoomJoinOut(
        session_id=session.id,
        pin_code=session.pin_code,
        status=session.status,
        current_slide_index=session.current_slide_index,
        is_screen_sharing=session.is_screen_sharing,
        attendance_status=attendance_status,
        late_after_minutes=session.late_after_minutes,
        group_id=group.id,
        group_name=group.name,
        presentation=_presentation_brief(presentation),
        # O'quvchiga quiz javoblari KETMAYDI (AUDIT.md §G3): aks holda bir
        # marta kirish butun darsning javoblarini beradi. O'qituvchi esa
        # prezentatsiyaning egasi — unga to'liq massiv ketadi.
        slides=(
            redact_slides_for_student(presentation.slides_data or [])
            if room_role is UserRole.STUDENT
            else list(presentation.slides_data or [])
        ),
    )


# ===========================================================================
# POST /rooms/{pin}/ws-ticket  — bir martalik 30 s ticket
# ===========================================================================


@router.post("/rooms/{pin_code}/ws-ticket", response_model=WsTicketOut)
async def create_ws_ticket(
    pin_code: str, user: CurrentUser, db: Db, redis: RedisDep
) -> WsTicketOut:
    """JWT WS URL ga hech qachon tushmaydi (AUDIT.md §B3)."""
    session = await load_session(db, pin_code)
    await resolve_room_role(db, session, user)
    ticket = await issue_ticket(redis, user.id)
    return WsTicketOut(ticket=ticket)


# ===========================================================================
# GET /rooms/{pin}  — joriy holat (REST fallback)
# ===========================================================================


@router.get("/rooms/{pin_code}", response_model=RoomStateOut)
async def get_room(pin_code: str, user: CurrentUser, db: Db, redis: RedisDep) -> RoomStateOut:
    """WS ishlamagan holat uchun zaxira: `ROOM_STATE_SYNC` ning REST oynasi."""
    session = await load_session(db, pin_code)
    await resolve_room_role(db, session, user)

    state = RoomState(redis, session.id)
    snapshot = await state.snapshot()
    if not snapshot.exists:
        # Redis bo'shagan (restart/TTL) — DB dagi holatdan tiklaymiz.
        await state.ensure(
            slide_index=session.current_slide_index,
            slide_type=_slide_type_at(session.presentation, session.current_slide_index),
            status=session.status.value,
        )
        snapshot = await state.snapshot()

    return RoomStateOut(
        session_id=session.id,
        pin_code=session.pin_code,
        join_url=join_url_for(session.pin_code),
        presentation=_presentation_brief(session.presentation),
        status=session.status,
        seq=snapshot.seq,
        slide_index=snapshot.slide_index,
        slide_type=snapshot.slide_type,
        code=snapshot.code,
        code_rev=snapshot.code_rev,
        is_sharing=snapshot.is_sharing,
        active_quiz=snapshot.active_quiz,
        active_poll=snapshot.active_poll,
        active_open=snapshot.active_open,
        participants=[Participant.model_validate(p) for p in snapshot.participants],
        confused=ConfusedStats(
            count=snapshot.confused.count, percentage=snapshot.confused.percentage
        ),
    )


# ===========================================================================
# POST /rooms/{pin}/end  — ENDED + ABSENT reconciliation
# ===========================================================================


@router.post("/rooms/{pin_code}/end", response_model=RoomEndOut)
async def end_room(
    pin_code: str, user: TeacherUser, db: Db, redis: RedisDep
) -> RoomEndOut:
    """Sessiyani yopadi va **ABSENT reconciliation** qiladi (AUDIT.md §D3).

    Guruhda bor, lekin davomatda yozuvi yo'q har bir o'quvchiga `ABSENT`.
    `status` o'tishi atomar (`WHERE status <> 'ENDED' RETURNING id`) —
    ikki marta chaqirilsa ikkinchisi 409 beradi, ma'lumot buzilmaydi.
    """
    session = await load_session(db, pin_code)
    if await resolve_room_role(db, session, user) is not UserRole.TEACHER:
        raise forbidden("NOT_OWNER", "Darsni faqat uning o'qituvchisi yakunlaydi.")

    state = RoomState(redis, session.id)
    snapshot = await state.snapshot()

    ended_at = datetime.now(UTC)
    closed = (
        await db.execute(
            update(LessonSession)
            .where(LessonSession.id == session.id, LessonSession.status != SessionStatus.ENDED)
            .values(
                status=SessionStatus.ENDED,
                ended_at=ended_at,
                current_slide_index=snapshot.slide_index
                if snapshot.exists
                else session.current_slide_index,
                is_screen_sharing=False,
            )
            .returning(LessonSession.id)
        )
    ).scalar_one_or_none()
    if closed is None:
        await db.rollback()
        raise AppError(
            status.HTTP_409_CONFLICT, "SESSION_ALREADY_ENDED", "Bu dars allaqachon yakunlangan."
        )

    # ABSENT reconciliation (AUDIT.md §D3) — bitta `INSERT ... SELECT`.
    # `ON CONFLICT DO NOTHING` sabab allaqachon kelganlarning `PRESENT`/`LATE`
    # statusi TEGILMAYDI; faqat guruhda bor-u davomatda yo'qlar `ABSENT` bo'ladi.
    absent_rows = select(
        literal(session.id).label("session_id"),
        GroupMember.student_id.label("student_id"),
        cast(literal(AttendanceStatus.ABSENT.value), ATTENDANCE_STATUS_ENUM).label("status"),
    ).where(GroupMember.group_id == session.group_id)
    await db.execute(
        pg_insert(Attendance)
        .from_select(["session_id", "student_id", "status"], absent_rows)
        .on_conflict_do_nothing(index_elements=["session_id", "student_id"])
    )
    await db.commit()

    counts = dict(
        (
            await db.execute(
                select(Attendance.status, func.count())
                .where(Attendance.session_id == session.id)
                .group_by(Attendance.status)
            )
        ).all()
    )

    # `SESSION_ENDED` → RoomManager hamma socketni yopadi, keyin holat o'chadi.
    await state.session_ended()
    # POLL/OPEN natijalari xona HASH idan alohida va dars tugagach 24 soat
    # saqlanadi (CONTRACTS.md §16.3). DB ga yozilmaydi.
    await state.retain_interactive()
    await state.destroy()
    log.info("Dars yakunlandi", extra={"extra_fields": {"session_id": str(session.id)}})

    return RoomEndOut(
        session_id=session.id,
        status=SessionStatus.ENDED,
        ended_at=ended_at,
        present_count=int(counts.get(AttendanceStatus.PRESENT, 0)),
        late_count=int(counts.get(AttendanceStatus.LATE, 0)),
        absent_count=int(counts.get(AttendanceStatus.ABSENT, 0)),
    )


# ===========================================================================
# POST /rooms/{pin}/livekit-token
# ===========================================================================


@router.post("/rooms/{pin_code}/livekit-token", response_model=LiveKitTokenOut)
async def create_livekit_token(
    pin_code: str, user: CurrentUser, db: Db
) -> LiveKitTokenOut:
    """`canPublish = (role == TEACHER)` (AUDIT.md §F).

    O'quvchi texnik jihatdan efirga chiqara olmaydi: `can_publish=False` va
    `can_publish_data=False`. Bu "kamerani bloklash" da'vosining haqiqatda
    bajarilishi mumkin bo'lgan versiyasi.
    """
    if not settings.LIVEKIT_API_KEY or not settings.LIVEKIT_API_SECRET:
        raise AppError(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "LIVEKIT_NOT_CONFIGURED",
            "Ekran ulashish sozlanmagan: LIVEKIT_API_KEY/LIVEKIT_API_SECRET bo'sh.",
        )
    try:
        from livekit.api import AccessToken, VideoGrants
    except ImportError:  # pragma: no cover - paket yo'q bo'lsa ham API yiqilmaydi
        raise AppError(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "LIVEKIT_NOT_CONFIGURED",
            "`livekit-api` kutubxonasi o'rnatilmagan.",
        ) from None

    session = await load_session(db, pin_code)
    room_role = await resolve_room_role(db, session, user)
    can_publish = room_role is UserRole.TEACHER
    room_name = livekit_room_name(session.id)

    token = (
        AccessToken(settings.LIVEKIT_API_KEY, settings.LIVEKIT_API_SECRET)
        .with_identity(str(user.id))
        .with_name(user.full_name)
        .with_ttl(timedelta(hours=4))
        .with_grants(
            VideoGrants(
                room_join=True,
                room=room_name,
                can_publish=can_publish,
                can_publish_data=can_publish,
                can_subscribe=True,
            )
        )
        .to_jwt()
    )
    return LiveKitTokenOut(
        token=token,
        url=settings.LIVEKIT_URL,
        room_name=room_name,
        identity=str(user.id),
        can_publish=can_publish,
        can_publish_data=can_publish,
    )


# ===========================================================================
# GET /rooms/{pin}/report  — davomat + quiz + focus
# ===========================================================================


@router.get("/rooms/{pin_code}/report", response_model=RoomReportOut)
async def get_room_report(pin_code: str, user: TeacherUser, db: Db) -> RoomReportOut:
    """O'qituvchi hisoboti. Focus ma'lumoti **faqat tavsiya** (AUDIT.md §F)."""
    session = await load_session(db, pin_code, include_ended=True)
    if await resolve_room_role(db, session, user) is not UserRole.TEACHER:
        raise forbidden("NOT_OWNER", "Hisobot faqat darsning o'qituvchisi uchun.")

    rows = (
        await db.execute(
            select(Attendance, User)
            .join(User, User.id == Attendance.student_id)
            .where(Attendance.session_id == session.id)
            .order_by(User.full_name)
        )
    ).all()

    answer_counts = dict(
        (
            await db.execute(
                select(
                    QuizAnswer.student_id,
                    func.count().label("total"),
                )
                .where(QuizAnswer.session_id == session.id)
                .group_by(QuizAnswer.student_id)
            )
        ).all()
    )
    correct_counts = dict(
        (
            await db.execute(
                select(QuizAnswer.student_id, func.count())
                .where(QuizAnswer.session_id == session.id, QuizAnswer.is_correct.is_(True))
                .group_by(QuizAnswer.student_id)
            )
        ).all()
    )

    students: list[RoomReportRow] = []
    tally = {AttendanceStatus.PRESENT: 0, AttendanceStatus.LATE: 0, AttendanceStatus.ABSENT: 0}
    for attendance, student in rows:
        tally[attendance.status] = tally.get(attendance.status, 0) + 1
        students.append(
            RoomReportRow(
                student_id=student.id,
                full_name=student.full_name,
                status=attendance.status,
                joined_at=attendance.joined_at,
                tab_switches_count=attendance.tab_switches_count,
                focus_lost_seconds=attendance.focus_lost_seconds,
                quiz_score=attendance.quiz_score,
                answers_count=int(answer_counts.get(student.id, 0)),
                correct_count=int(correct_counts.get(student.id, 0)),
            )
        )

    quizzes = await _quiz_stats(db, session)

    return RoomReportOut(
        session_id=session.id,
        pin_code=session.pin_code,
        status=session.status,
        group_id=session.group_id,
        group_name=session.group.name,
        started_at=session.started_at,
        ended_at=session.ended_at,
        present_count=tally[AttendanceStatus.PRESENT],
        late_count=tally[AttendanceStatus.LATE],
        absent_count=tally[AttendanceStatus.ABSENT],
        students=students,
        quizzes=quizzes,
    )


async def _quiz_stats(db: AsyncSession, session: LessonSession) -> list[RoomQuizStat]:
    """Har QUIZ slaydi uchun javob taqsimoti va o'rtacha tezlik."""
    slides: list[dict[str, Any]] = list(session.presentation.slides_data or [])
    options_by_index = {
        int(s.get("index", i)): len(s.get("options") or [])
        for i, s in enumerate(slides)
        if s.get("type") == "QUIZ"
    }
    if not options_by_index:
        return []

    raw = (
        await db.execute(
            select(
                QuizAnswer.slide_index,
                QuizAnswer.selected_index,
                func.count().label("total"),
                func.avg(QuizAnswer.answer_ms).label("avg_ms"),
            )
            .where(QuizAnswer.session_id == session.id)
            .group_by(QuizAnswer.slide_index, QuizAnswer.selected_index)
        )
    ).all()

    buckets: dict[int, dict[str, Any]] = {}
    for slide_index, selected, total, avg_ms in raw:
        bucket = buckets.setdefault(
            int(slide_index),
            {"distribution": [0] * options_by_index.get(int(slide_index), 0),
             "answered": 0, "ms_sum": 0.0},
        )
        if 0 <= int(selected) < len(bucket["distribution"]):
            bucket["distribution"][int(selected)] += int(total)
        bucket["answered"] += int(total)
        bucket["ms_sum"] += float(avg_ms or 0) * int(total)

    correct_option_by_index = {
        int(s.get("index", i)): int(s.get("correct_option", -1))
        for i, s in enumerate(slides)
        if s.get("type") == "QUIZ"
    }

    stats: list[RoomQuizStat] = []
    for slide_index in sorted(buckets):
        bucket = buckets[slide_index]
        answered = int(bucket["answered"])
        correct_option = correct_option_by_index.get(slide_index, -1)
        distribution: list[int] = bucket["distribution"]
        correct = (
            distribution[correct_option]
            if 0 <= correct_option < len(distribution)
            else 0
        )
        stats.append(
            RoomQuizStat(
                slide_index=slide_index,
                answered=answered,
                correct=correct,
                avg_answer_ms=int(bucket["ms_sum"] / answered) if answered else 0,
                distribution=distribution,
            )
        )
    return stats


__all__ = [
    "JOIN_RATE_LIMIT",
    "PIN_MAX_RETRIES",
    "attendance_status_for",
    "generate_pin_code",
    "is_group_member",
    "join_url_for",
    "livekit_room_name",
    "load_session",
    "resolve_room_role",
    "router",
    "upsert_attendance",
]
