"""SyncClass ORM modellari — CONTRACTS.md §2 ning aynan amalga oshirilishi.

11 ta jadval: users, groups, group_members, presentations, lesson_sessions,
attendances, quiz_answers, homeworks, submissions, grade_audit_log, refresh_tokens.

ENUM lar PostgreSQL native tipida (`user_role`, `session_status`,
`attendance_status`, `submission_status`, `backup_status`, `storage_kind`).
`slide_type` DB da YO'Q — u `slides_data` JSONB ichida yashaydi va faqat
Pydantic darajasida validatsiya qilinadi (CONTRACTS.md §2, §3).
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy import (
    Enum as SAEnum,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, CreatedAtMixin, TimestampMixin

# ---------------------------------------------------------------------------
# ENUM lar (PG native; nom va qiymatlar kontraktdan bir harf ham farq qilmaydi)
# ---------------------------------------------------------------------------


class UserRole(str, enum.Enum):
    """PG enum: `user_role`. Yangi user HAR DOIM STUDENT (AUDIT.md §C1)."""

    TEACHER = "TEACHER"
    STUDENT = "STUDENT"
    ADMIN = "ADMIN"


class SessionStatus(str, enum.Enum):
    """PG enum: `session_status`."""

    LOBBY = "LOBBY"
    LIVE = "LIVE"
    ENDED = "ENDED"


class AttendanceStatus(str, enum.Enum):
    """PG enum: `attendance_status`. ABSENT — sessiya tugaganda reconciliation (AUDIT.md §D3)."""

    PRESENT = "PRESENT"
    LATE = "LATE"
    ABSENT = "ABSENT"


class SubmissionStatus(str, enum.Enum):
    """PG enum: `submission_status`. PENDING_AI → READY_FOR_REVIEW | AI_FAILED (AUDIT.md §E3)."""

    PENDING_AI = "PENDING_AI"
    READY_FOR_REVIEW = "READY_FOR_REVIEW"
    AI_FAILED = "AI_FAILED"
    GRADED = "GRADED"
    RESUBMIT_REQUIRED = "RESUBMIT_REQUIRED"


class BackupStatus(str, enum.Enum):
    """PG enum: `backup_status`. Telegram zahira best-effort (AUDIT.md §A2)."""

    NONE = "NONE"
    QUEUED = "QUEUED"
    OK = "OK"
    FAILED = "FAILED"


class StorageKind(str, enum.Enum):
    """PG enum: `storage_kind`. R2 — canonical, Telegram — arxiv (AUDIT.md §A1)."""

    R2 = "R2"
    TELEGRAM = "TELEGRAM"


def _pg_enum(py_enum: type[enum.Enum], name: str) -> SAEnum:
    """PG native ENUM: label lar sifatida `.value` ishlatiladi (nom emas).

    `create_type=False` — tiplar `0001_initial.py` da qo'lda yaratiladi,
    `create_table` ularni qayta yaratishga urinmasin.
    """
    return SAEnum(
        py_enum,
        name=name,
        native_enum=True,
        create_type=False,
        validate_strings=True,
        values_callable=lambda e: [m.value for m in e],
    )


USER_ROLE_ENUM = _pg_enum(UserRole, "user_role")
SESSION_STATUS_ENUM = _pg_enum(SessionStatus, "session_status")
ATTENDANCE_STATUS_ENUM = _pg_enum(AttendanceStatus, "attendance_status")
SUBMISSION_STATUS_ENUM = _pg_enum(SubmissionStatus, "submission_status")
BACKUP_STATUS_ENUM = _pg_enum(BackupStatus, "backup_status")
STORAGE_KIND_ENUM = _pg_enum(StorageKind, "storage_kind")

_UUID_PK = text("gen_random_uuid()")


# ---------------------------------------------------------------------------
# users
# ---------------------------------------------------------------------------


class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4, server_default=_UUID_PK
    )
    google_id: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    avatar_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    role: Mapped[UserRole] = mapped_column(
        USER_ROLE_ENUM, nullable=False, default=UserRole.STUDENT, server_default=text("'STUDENT'")
    )
    is_onboarded: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    # Rol o'zgarsa oshadi → eski access tokenlar kuchini yo'qotadi (AUDIT.md §C4).
    token_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    xp_points: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )

    owned_groups: Mapped[list[Group]] = relationship(
        back_populates="teacher", lazy="selectin", foreign_keys="Group.teacher_id"
    )
    memberships: Mapped[list[GroupMember]] = relationship(
        back_populates="student", lazy="selectin", cascade="all, delete-orphan"
    )
    presentations: Mapped[list[Presentation]] = relationship(
        back_populates="teacher", lazy="selectin"
    )
    refresh_tokens: Mapped[list[RefreshToken]] = relationship(
        back_populates="user", lazy="selectin", cascade="all, delete-orphan"
    )


# ---------------------------------------------------------------------------
# groups
# ---------------------------------------------------------------------------


class Group(TimestampMixin, Base):
    __tablename__ = "groups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(50), nullable=False, unique=True)
    course_title: Mapped[str] = mapped_column(String(150), nullable=False)
    invite_code: Mapped[str] = mapped_column(String(20), nullable=False, unique=True)
    teacher_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )

    teacher: Mapped[User | None] = relationship(
        back_populates="owned_groups", lazy="selectin", foreign_keys=[teacher_id]
    )
    members: Mapped[list[GroupMember]] = relationship(
        back_populates="group", lazy="selectin", cascade="all, delete-orphan"
    )


# ---------------------------------------------------------------------------
# group_members
# ---------------------------------------------------------------------------


class GroupMember(Base):
    """O'quvchi-guruh bog'lanishi. Join guard uchun asos (AUDIT.md §C2)."""

    __tablename__ = "group_members"
    __table_args__ = (
        UniqueConstraint("group_id", "student_id", name="uq_group_members_group_id_student_id"),
        Index("ix_group_members_student_id", "student_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    group_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("groups.id", ondelete="CASCADE"), nullable=False
    )
    student_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    group: Mapped[Group] = relationship(back_populates="members", lazy="selectin")
    student: Mapped[User] = relationship(back_populates="memberships", lazy="selectin")


# ---------------------------------------------------------------------------
# presentations
# ---------------------------------------------------------------------------


class Presentation(TimestampMixin, Base):
    """`slides_data` — CONTRACTS.md §3 dagi discriminated union massivi.

    Validatsiya API qatlamida Pydantic bilan bo'ladi (AUDIT.md §D5);
    `schema_version` kelajakdagi migratsiya uchun.
    """

    __tablename__ = "presentations"

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4, server_default=_UUID_PK
    )
    teacher_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    module_number: Mapped[int] = mapped_column(Integer, nullable=False)
    lesson_number: Mapped[int] = mapped_column(Integer, nullable=False)
    schema_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default=text("1")
    )
    slides_data: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )

    teacher: Mapped[User] = relationship(back_populates="presentations", lazy="selectin")


# ---------------------------------------------------------------------------
# lesson_sessions
# ---------------------------------------------------------------------------


class LessonSession(TimestampMixin, Base):
    """Jonli dars xonasi.

    `uq_active_pin` — PIN faqat FAOL sessiyalar orasida unikal (AUDIT.md §C3).
    Global UNIQUE bo'lsa 10^6 darsdan keyin PIN yaratish imkonsiz bo'ladi.
    """

    __tablename__ = "lesson_sessions"
    __table_args__ = (
        Index(
            "uq_active_pin",
            "pin_code",
            unique=True,
            postgresql_where=text("status <> 'ENDED'"),
        ),
        Index("ix_lesson_sessions_group_id_status", "group_id", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4, server_default=_UUID_PK
    )
    group_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("groups.id", ondelete="CASCADE"), nullable=False
    )
    presentation_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("presentations.id"), nullable=False
    )
    pin_code: Mapped[str] = mapped_column(String(6), nullable=False)
    current_slide_index: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    is_screen_sharing: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # LATE chegarasi kodga qotib qolmasin (AUDIT.md §D4).
    late_after_minutes: Mapped[int] = mapped_column(
        Integer, nullable=False, default=15, server_default=text("15")
    )
    status: Mapped[SessionStatus] = mapped_column(
        SESSION_STATUS_ENUM,
        nullable=False,
        default=SessionStatus.LOBBY,
        server_default=text("'LOBBY'"),
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    group: Mapped[Group] = relationship(lazy="selectin")
    presentation: Mapped[Presentation] = relationship(lazy="selectin")


# ---------------------------------------------------------------------------
# attendances
# ---------------------------------------------------------------------------


class Attendance(TimestampMixin, Base):
    __tablename__ = "attendances"
    __table_args__ = (
        UniqueConstraint("session_id", "student_id", name="uq_attendances_session_id_student_id"),
        Index("ix_attendances_student_id", "student_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("lesson_sessions.id", ondelete="CASCADE"), nullable=False
    )
    student_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[AttendanceStatus] = mapped_column(
        ATTENDANCE_STATUS_ENUM,
        nullable=False,
        default=AttendanceStatus.PRESENT,
        server_default=text("'PRESENT'"),
    )
    # Focus tracking — faqat tavsiya xarakterida, bahoga ta'sir qilmaydi (AUDIT.md §F).
    tab_switches_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    focus_lost_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    quiz_score: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    session: Mapped[LessonSession] = relationship(lazy="selectin")
    student: Mapped[User] = relationship(lazy="selectin")


# ---------------------------------------------------------------------------
# quiz_answers
# ---------------------------------------------------------------------------


class QuizAnswer(CreatedAtMixin, Base):
    """UNIQUE(session_id, slide_index, student_id) — XP ni ikki marta olish yo'q (AUDIT.md §D2)."""

    __tablename__ = "quiz_answers"
    __table_args__ = (
        UniqueConstraint(
            "session_id",
            "slide_index",
            "student_id",
            name="uq_quiz_answers_session_id_slide_index_student_id",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("lesson_sessions.id", ondelete="CASCADE"), nullable=False
    )
    slide_index: Mapped[int] = mapped_column(Integer, nullable=False)
    student_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    selected_index: Mapped[int] = mapped_column(Integer, nullable=False)
    is_correct: Mapped[bool] = mapped_column(Boolean, nullable=False)
    answer_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    xp_awarded: Mapped[int] = mapped_column(Integer, nullable=False)

    session: Mapped[LessonSession] = relationship(lazy="selectin")
    student: Mapped[User] = relationship(lazy="selectin")


# ---------------------------------------------------------------------------
# homeworks
# ---------------------------------------------------------------------------


class Homework(TimestampMixin, Base):
    __tablename__ = "homeworks"
    __table_args__ = (Index("ix_homeworks_group_id_deadline", "group_id", "deadline"),)

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4, server_default=_UUID_PK
    )
    group_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("groups.id", ondelete="CASCADE"), nullable=False
    )
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("lesson_sessions.id", ondelete="SET NULL"),
        nullable=True,
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    deadline: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    max_score: Mapped[int] = mapped_column(
        Integer, nullable=False, default=100, server_default=text("100")
    )
    # TAVSIYA etilgan jarima; avtomatik qo'llanmaydi (AUDIT.md §E2).
    ai_penalty_points: Mapped[int] = mapped_column(
        Integer, nullable=False, default=30, server_default=text("30")
    )
    allow_resubmit: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    created_by: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )

    group: Mapped[Group] = relationship(lazy="selectin")
    author: Mapped[User] = relationship(lazy="selectin")


# ---------------------------------------------------------------------------
# submissions
# ---------------------------------------------------------------------------


class Submission(TimestampMixin, Base):
    """Topshiriq javobi.

    `uq_latest_sub` — har (homework, student) uchun faqat BITTA `is_latest`
    yozuv bo'lishi mumkin (AUDIT.md §D1). Yangi urinish yozilganda eskisi
    `is_latest=false` ga o'tkazilishi SHART, aks holda IntegrityError.
    """

    __tablename__ = "submissions"
    __table_args__ = (
        UniqueConstraint(
            "homework_id",
            "student_id",
            "attempt_no",
            name="uq_submissions_homework_id_student_id_attempt_no",
        ),
        Index(
            "uq_latest_sub",
            "homework_id",
            "student_id",
            unique=True,
            postgresql_where=text("is_latest"),
        ),
        Index("ix_submissions_student_id", "student_id"),
        Index("ix_submissions_status", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4, server_default=_UUID_PK
    )
    homework_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("homeworks.id", ondelete="CASCADE"), nullable=False
    )
    student_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    attempt_no: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default=text("1")
    )
    is_latest: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )

    # --- Storage (gibrid: R2 canonical, Telegram zahira — AUDIT.md §A1) ---
    storage_primary: Mapped[StorageKind] = mapped_column(
        STORAGE_KIND_ENUM, nullable=False, default=StorageKind.R2, server_default=text("'R2'")
    )
    r2_object_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    tg_file_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    tg_message_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tg_backup_status: Mapped[BackupStatus] = mapped_column(
        BACKUP_STATUS_ENUM,
        nullable=False,
        default=BackupStatus.NONE,
        server_default=text("'NONE'"),
    )

    # --- Fayl metama'lumotlari ---
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    content_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    # Jami <= EXTRACT_MAX_TOTAL_CHARS, har fayl <= EXTRACT_MAX_FILE_CHARS (AUDIT.md §A3/§D6).
    extracted_files: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    extract_truncated: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )

    # --- AI Pre-Grader natijasi (hech qachon avtomatik ball kamaytirmaydi) ---
    ai_suspected: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    ai_confidence_percent: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    ai_review_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_evidence: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    # CONTRACTS.md §12.1 — §7 `AiVerdict.strengths` / `.issues` saqlanadigan joy.
    # Bularsiz AI faqat tanqid qilardi: o'quvchining kuchli tomonlari UI ga yetib
    # bormasdi, bu AUDIT §E2 (adolatli, qurilish xarakteridagi baholash) ga qarshi.
    ai_strengths: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    ai_issues: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    ai_injection_suspected: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    suggested_score: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # --- O'qituvchi bahosi ---
    final_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    penalty_applied: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    teacher_comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    student_appeal: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[SubmissionStatus] = mapped_column(
        SUBMISSION_STATUS_ENUM,
        nullable=False,
        default=SubmissionStatus.PENDING_AI,
        server_default=text("'PENDING_AI'"),
    )
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    graded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    homework: Mapped[Homework] = relationship(lazy="selectin")
    student: Mapped[User] = relationship(lazy="selectin")


# ---------------------------------------------------------------------------
# grade_audit_log
# ---------------------------------------------------------------------------


class GradeAuditLog(CreatedAtMixin, Base):
    """Baho o'zgarishi izi — o'qituvchi bahoni qayta yozsa iz qoladi (AUDIT.md §D7)."""

    __tablename__ = "grade_audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    submission_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("submissions.id", ondelete="CASCADE"), nullable=False
    )
    actor_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    old_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    new_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    old_penalty: Mapped[int | None] = mapped_column(Integer, nullable=True)
    new_penalty: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    submission: Mapped[Submission] = relationship(lazy="selectin")
    actor: Mapped[User] = relationship(lazy="selectin")


# ---------------------------------------------------------------------------
# refresh_tokens
# ---------------------------------------------------------------------------


class RefreshToken(CreatedAtMixin, Base):
    """Refresh token `jti` reyestri — logout/revocation uchun (AUDIT.md §C4)."""

    __tablename__ = "refresh_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    jti: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped[User] = relationship(back_populates="refresh_tokens", lazy="selectin")


__all__ = [
    "ATTENDANCE_STATUS_ENUM",
    "BACKUP_STATUS_ENUM",
    "SESSION_STATUS_ENUM",
    "STORAGE_KIND_ENUM",
    "SUBMISSION_STATUS_ENUM",
    "USER_ROLE_ENUM",
    "Attendance",
    "AttendanceStatus",
    "BackupStatus",
    "GradeAuditLog",
    "Group",
    "GroupMember",
    "Homework",
    "LessonSession",
    "Presentation",
    "QuizAnswer",
    "RefreshToken",
    "SessionStatus",
    "StorageKind",
    "Submission",
    "SubmissionStatus",
    "User",
    "UserRole",
]
