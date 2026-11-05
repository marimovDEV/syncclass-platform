"""Guruhlar API — CONTRACTS.md §4 `groups`.

Endpointlar:
  `GET  /groups`                      — student: a'zo bo'lgan; teacher: egasi bo'lgan; admin: hammasi
  `GET  /groups/open`                 — onboarding dropdown: `{id, name, course_title}`
  `POST /groups`                      — TEACHER (invite-code serverda, crypto-secure)
  `GET  /groups/{id}/members`         — guruh egasi, admin yoki shu guruh a'zosi
  `GET  /groups/{id}/attendance.csv`  — guruh egasi/admin, streaming CSV

Ownership guard (AUDIT.md §C2): o'qituvchi A o'qituvchi B ning guruhiga tegmaydi.
"""

from __future__ import annotations

import csv
import io
import logging
from collections.abc import AsyncIterator

from fastapi import APIRouter, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, DbSession, RedisDep, TeacherUser
from app.core.errors import conflict, forbidden, not_found
from app.core.security import (
    RATE_LIMIT_GROUP_CREATE,
    check_rate_limit,
    generate_invite_code,
)
from app.db.models import Attendance, Group, GroupMember, LessonSession, User, UserRole
from app.db.session import AsyncSessionLocal
from app.schemas.group import GroupBrief, GroupCreate, GroupMemberOut, GroupOut

log = logging.getLogger("syncclass.groups")

router = APIRouter()

#: `uq_groups_invite_code` ga urilib qolsa yangi kod bilan qayta urinish soni.
INVITE_CODE_RETRIES = 5

CSV_HEADER = (
    "session_id",
    "pin_code",
    "started_at",
    "student_email",
    "student_name",
    "status",
    "joined_at",
    "tab_switches_count",
    "focus_lost_seconds",
    "quiz_score",
)


# ---------------------------------------------------------------------------
# Yordamchilar
# ---------------------------------------------------------------------------


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def _get_group_or_404(db: AsyncSession, group_id: int) -> Group:
    group = await db.scalar(select(Group).where(Group.id == group_id))
    if group is None:
        raise not_found("GROUP_NOT_FOUND", "Bunday guruh topilmadi.")
    return group


def _is_owner_or_admin(user: User, group: Group) -> bool:
    if user.role is UserRole.ADMIN:
        return True
    return user.role is UserRole.TEACHER and group.teacher_id == user.id


async def _assert_can_manage(user: User, group: Group) -> None:
    """Faqat guruh egasi (o'qituvchi) yoki admin."""
    if not _is_owner_or_admin(user, group):
        raise forbidden("NOT_GROUP_OWNER", "Bu guruh sizga tegishli emas.")


async def _assert_can_view(db: AsyncSession, user: User, group: Group) -> None:
    """Ega/admin, yoki shu guruhning a'zosi bo'lgan o'quvchi."""
    if _is_owner_or_admin(user, group):
        return
    member = await db.scalar(
        select(GroupMember.id).where(
            GroupMember.group_id == group.id, GroupMember.student_id == user.id
        )
    )
    if member is None:
        raise forbidden("NOT_IN_GROUP", "Siz bu guruh a'zosi emassiz.")


# ---------------------------------------------------------------------------
# GET /groups
# ---------------------------------------------------------------------------


@router.get("", response_model=list[GroupOut], summary="Mening guruhlarim")
async def list_my_groups(db: DbSession, user: CurrentUser) -> list[GroupOut]:
    if user.role is UserRole.ADMIN:
        stmt = select(Group).order_by(Group.name)
    elif user.role is UserRole.TEACHER:
        stmt = select(Group).where(Group.teacher_id == user.id).order_by(Group.name)
    else:
        stmt = (
            select(Group)
            .join(GroupMember, GroupMember.group_id == Group.id)
            .where(GroupMember.student_id == user.id)
            .order_by(Group.name)
        )
    groups = (await db.scalars(stmt)).unique().all()
    return [
        GroupOut.from_group(g, reveal_invite_code=_is_owner_or_admin(user, g)) for g in groups
    ]


# ---------------------------------------------------------------------------
# GET /groups/open
# ---------------------------------------------------------------------------


@router.get("/open", response_model=list[GroupBrief], summary="Onboarding uchun faol guruhlar")
async def list_open_groups(db: DbSession, user: CurrentUser) -> list[GroupBrief]:
    """Onboarding dropdown. Autentifikatsiya talab qiladi (OAuth dan keyin token bor),
    lekin `is_onboarded` shart emas — aks holda onboarding qulflanib qolardi."""
    groups = (
        await db.scalars(
            select(Group).where(Group.is_active.is_(True)).order_by(Group.name)
        )
    ).all()
    return [GroupBrief.model_validate(g) for g in groups]


# ---------------------------------------------------------------------------
# POST /groups
# ---------------------------------------------------------------------------


@router.post(
    "",
    response_model=GroupOut,
    status_code=status.HTTP_201_CREATED,
    summary="Yangi guruh (TEACHER)",
)
async def create_group(
    payload: GroupCreate,
    request: Request,
    db: DbSession,
    redis: RedisDep,
    teacher: TeacherUser,
) -> GroupOut:
    limit, window = RATE_LIMIT_GROUP_CREATE
    await check_rate_limit(redis, "group_create", _client_ip(request), limit, window)

    existing = await db.scalar(select(Group.id).where(Group.name == payload.name))
    if existing is not None:
        raise conflict("GROUP_NAME_TAKEN", "Bu nomli guruh allaqachon bor.")

    last_error: IntegrityError | None = None
    for _ in range(INVITE_CODE_RETRIES):
        group = Group(
            name=payload.name,
            course_title=payload.course_title,
            invite_code=generate_invite_code(),
            teacher_id=teacher.id,
        )
        db.add(group)
        try:
            await db.flush()
        except IntegrityError as exc:
            # `uq_groups_invite_code` to'qnashuvi — yangi kod bilan qayta urinamiz.
            # Davom etishdan OLDIN rollback SHART (CONTRACTS.md §2.3).
            await db.rollback()
            last_error = exc
            if "uq_groups_name" in str(exc.orig):
                raise conflict("GROUP_NAME_TAKEN", "Bu nomli guruh allaqachon bor.") from exc
            continue
        await db.commit()
        return GroupOut.from_group(group, members_count=0, reveal_invite_code=True)

    log.error("Invite-code yaratib bo'lmadi: %s", last_error)
    raise conflict("INVITE_CODE_COLLISION", "Taklif kodi yaratilmadi. Qayta urinib ko'ring.")


# ---------------------------------------------------------------------------
# GET /groups/{group_id}/members
# ---------------------------------------------------------------------------


@router.get(
    "/{group_id}/members",
    response_model=list[GroupMemberOut],
    summary="Guruh a'zolari",
)
async def list_members(group_id: int, db: DbSession, user: CurrentUser) -> list[GroupMemberOut]:
    group = await _get_group_or_404(db, group_id)
    await _assert_can_view(db, user, group)

    rows = (
        await db.execute(
            select(
                User.id,
                User.full_name,
                User.email,
                User.avatar_url,
                User.xp_points,
                GroupMember.joined_at,
            )
            .join(GroupMember, GroupMember.student_id == User.id)
            .where(GroupMember.group_id == group_id)
            .order_by(User.full_name)
        )
    ).all()
    return [
        GroupMemberOut(
            student_id=row.id,
            full_name=row.full_name,
            email=row.email,
            avatar_url=row.avatar_url,
            xp_points=row.xp_points,
            joined_at=row.joined_at,
        )
        for row in rows
    ]


# ---------------------------------------------------------------------------
# GET /groups/{group_id}/attendance.csv
# ---------------------------------------------------------------------------


async def _stream_attendance_csv(group_id: int) -> AsyncIterator[str]:
    """CSV ni qator-qator chiqaradi.

    MUHIM: FastAPI 0.106+ da `Depends(get_db)` sessiyasi javob YUBORILISHIDAN
    OLDIN yopiladi. Shuning uchun stream generatori O'ZINING sessiyasini
    ochadi (`AsyncSessionLocal`) va `stream` bilan server-side kursordan o'qiydi —
    100 ta dars x 30 o'quvchi ham xotiraga to'liq yuklanmaydi.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")

    def flush() -> str:
        value = buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)
        return value

    writer.writerow(CSV_HEADER)
    yield flush()

    stmt = (
        select(
            LessonSession.id,
            LessonSession.pin_code,
            LessonSession.started_at,
            User.email,
            User.full_name,
            Attendance.status,
            Attendance.joined_at,
            Attendance.tab_switches_count,
            Attendance.focus_lost_seconds,
            Attendance.quiz_score,
        )
        .join(Attendance, Attendance.session_id == LessonSession.id)
        .join(User, User.id == Attendance.student_id)
        .where(LessonSession.group_id == group_id)
        .order_by(LessonSession.started_at.desc(), User.full_name)
    )

    async with AsyncSessionLocal() as session:
        result = await session.stream(stmt.execution_options(yield_per=200))
        async for row in result:
            writer.writerow(
                [
                    str(row.id),
                    row.pin_code,
                    row.started_at.isoformat() if row.started_at else "",
                    row.email,
                    row.full_name,
                    row.status.value if row.status is not None else "",
                    row.joined_at.isoformat() if row.joined_at else "",
                    row.tab_switches_count,
                    row.focus_lost_seconds,
                    row.quiz_score,
                ]
            )
            yield flush()


@router.get("/{group_id}/attendance.csv", summary="Davomat eksporti (CSV, streaming)")
async def export_attendance_csv(
    group_id: int, db: DbSession, user: CurrentUser
) -> StreamingResponse:
    group = await _get_group_or_404(db, group_id)
    await _assert_can_manage(user, group)

    safe_name = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in group.name)
    return StreamingResponse(
        _stream_attendance_csv(group_id),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="attendance_{safe_name}.csv"',
            "Cache-Control": "no-store",
        },
    )


# ---------------------------------------------------------------------------
# Boshqa agentlar uchun yordamchi (rooms/homeworks guard lari)
# ---------------------------------------------------------------------------


async def is_group_member(db: AsyncSession, group_id: int, student_id: object) -> bool:
    """`403 NOT_IN_GROUP` guard i uchun (AUDIT.md §C2)."""
    found = await db.scalar(
        select(func.count())
        .select_from(GroupMember)
        .where(GroupMember.group_id == group_id, GroupMember.student_id == student_id)
    )
    return bool(found)
