"""initial schema — CONTRACTS.md §2 (11 jadval)

Qo'lda yozilgan boshlang'ich migratsiya.

Tartib muhim:
  1. `pgcrypto` extension  → `gen_random_uuid()` UUID PK lar uchun.
  2. PG native ENUM tiplari → jadvallardan OLDIN (`create_type=False` bo'lgani
     uchun `create_table` ularni o'zi yaratmaydi).
  3. Jadvallar (FK bog'liqlik tartibida).
  4. Partial unique indekslar (`uq_active_pin`, `uq_latest_sub`) va oddiy indekslar.

`downgrade()` hammasini teskari tartibda tozalaydi — `alembic downgrade base`
dan keyin DB da SyncClass obyekti qolmaydi (ENUM tiplari ham).

Revision ID: 0001_initial
Revises: None
"""

from __future__ import annotations

from typing import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001_initial"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# --- PG native ENUM lar (nom va label lar CONTRACTS.md §2 dan) ------------
# `create_type=False`: tip DDL ni biz o'zimiz boshqaramiz, `create_table` emas.
user_role = postgresql.ENUM(
    "TEACHER", "STUDENT", "ADMIN", name="user_role", create_type=False
)
session_status = postgresql.ENUM(
    "LOBBY", "LIVE", "ENDED", name="session_status", create_type=False
)
attendance_status = postgresql.ENUM(
    "PRESENT", "LATE", "ABSENT", name="attendance_status", create_type=False
)
submission_status = postgresql.ENUM(
    "PENDING_AI",
    "READY_FOR_REVIEW",
    "AI_FAILED",
    "GRADED",
    "RESUBMIT_REQUIRED",
    name="submission_status",
    create_type=False,
)
backup_status = postgresql.ENUM(
    "NONE", "QUEUED", "OK", "FAILED", name="backup_status", create_type=False
)
storage_kind = postgresql.ENUM(
    "R2", "TELEGRAM", name="storage_kind", create_type=False
)

_ALL_ENUMS = (
    user_role,
    session_status,
    attendance_status,
    submission_status,
    backup_status,
    storage_kind,
)

_UUID_PK = sa.text("gen_random_uuid()")
_NOW = sa.text("now()")


def upgrade() -> None:
    bind = op.get_bind()

    # 1) gen_random_uuid() uchun kerak.
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")

    # 2) ENUM tiplari.
    for pg_enum in _ALL_ENUMS:
        pg_enum.create(bind, checkfirst=True)

    # 3) users
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False, server_default=_UUID_PK),
        sa.Column("google_id", sa.String(length=255), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("full_name", sa.String(length=255), nullable=False),
        sa.Column("avatar_url", sa.Text(), nullable=True),
        sa.Column("role", user_role, nullable=False, server_default=sa.text("'STUDENT'")),
        sa.Column("is_onboarded", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("token_version", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("xp_points", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.PrimaryKeyConstraint("id", name="pk_users"),
        sa.UniqueConstraint("google_id", name="uq_users_google_id"),
        sa.UniqueConstraint("email", name="uq_users_email"),
    )

    # 4) groups
    op.create_table(
        "groups",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(length=50), nullable=False),
        sa.Column("course_title", sa.String(length=150), nullable=False),
        sa.Column("invite_code", sa.String(length=20), nullable=False),
        sa.Column("teacher_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.PrimaryKeyConstraint("id", name="pk_groups"),
        sa.ForeignKeyConstraint(
            ["teacher_id"], ["users.id"], name="fk_groups_teacher_id_users", ondelete="SET NULL"
        ),
        sa.UniqueConstraint("name", name="uq_groups_name"),
        sa.UniqueConstraint("invite_code", name="uq_groups_invite_code"),
    )

    # 5) group_members
    op.create_table(
        "group_members",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("group_id", sa.Integer(), nullable=False),
        sa.Column("student_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.PrimaryKeyConstraint("id", name="pk_group_members"),
        sa.ForeignKeyConstraint(
            ["group_id"], ["groups.id"], name="fk_group_members_group_id_groups", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["student_id"],
            ["users.id"],
            name="fk_group_members_student_id_users",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint(
            "group_id", "student_id", name="uq_group_members_group_id_student_id"
        ),
    )
    op.create_index("ix_group_members_student_id", "group_members", ["student_id"])

    # 6) presentations
    op.create_table(
        "presentations",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False, server_default=_UUID_PK),
        sa.Column("teacher_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("module_number", sa.Integer(), nullable=False),
        sa.Column("lesson_number", sa.Integer(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column(
            "slides_data",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.PrimaryKeyConstraint("id", name="pk_presentations"),
        sa.ForeignKeyConstraint(
            ["teacher_id"], ["users.id"], name="fk_presentations_teacher_id_users"
        ),
    )

    # 7) lesson_sessions
    op.create_table(
        "lesson_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False, server_default=_UUID_PK),
        sa.Column("group_id", sa.Integer(), nullable=False),
        sa.Column("presentation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("pin_code", sa.String(length=6), nullable=False),
        sa.Column(
            "current_slide_index", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "is_screen_sharing", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        sa.Column(
            "late_after_minutes", sa.Integer(), nullable=False, server_default=sa.text("15")
        ),
        sa.Column("status", session_status, nullable=False, server_default=sa.text("'LOBBY'")),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.PrimaryKeyConstraint("id", name="pk_lesson_sessions"),
        sa.ForeignKeyConstraint(
            ["group_id"],
            ["groups.id"],
            name="fk_lesson_sessions_group_id_groups",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["presentation_id"],
            ["presentations.id"],
            name="fk_lesson_sessions_presentation_id_presentations",
        ),
    )
    # PIN faqat FAOL sessiyalar orasida unikal (AUDIT.md §C3).
    op.create_index(
        "uq_active_pin",
        "lesson_sessions",
        ["pin_code"],
        unique=True,
        postgresql_where=sa.text("status <> 'ENDED'"),
    )
    op.create_index(
        "ix_lesson_sessions_group_id_status", "lesson_sessions", ["group_id", "status"]
    )

    # 8) attendances
    op.create_table(
        "attendances",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("session_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("student_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "status", attendance_status, nullable=False, server_default=sa.text("'PRESENT'")
        ),
        sa.Column(
            "tab_switches_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "focus_lost_seconds", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column("quiz_score", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.PrimaryKeyConstraint("id", name="pk_attendances"),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["lesson_sessions.id"],
            name="fk_attendances_session_id_lesson_sessions",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["student_id"], ["users.id"], name="fk_attendances_student_id_users", ondelete="CASCADE"
        ),
        sa.UniqueConstraint(
            "session_id", "student_id", name="uq_attendances_session_id_student_id"
        ),
    )
    op.create_index("ix_attendances_student_id", "attendances", ["student_id"])

    # 9) quiz_answers  (AUDIT.md §D2 — XP ni ikki marta olishning oldini oladi)
    op.create_table(
        "quiz_answers",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("session_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("slide_index", sa.Integer(), nullable=False),
        sa.Column("student_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("selected_index", sa.Integer(), nullable=False),
        sa.Column("is_correct", sa.Boolean(), nullable=False),
        sa.Column("answer_ms", sa.Integer(), nullable=False),
        sa.Column("xp_awarded", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.PrimaryKeyConstraint("id", name="pk_quiz_answers"),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["lesson_sessions.id"],
            name="fk_quiz_answers_session_id_lesson_sessions",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["student_id"],
            ["users.id"],
            name="fk_quiz_answers_student_id_users",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint(
            "session_id",
            "slide_index",
            "student_id",
            name="uq_quiz_answers_session_id_slide_index_student_id",
        ),
    )

    # 10) homeworks
    op.create_table(
        "homeworks",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False, server_default=_UUID_PK),
        sa.Column("group_id", sa.Integer(), nullable=False),
        sa.Column("session_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("deadline", sa.DateTime(timezone=True), nullable=False),
        sa.Column("max_score", sa.Integer(), nullable=False, server_default=sa.text("100")),
        sa.Column(
            "ai_penalty_points", sa.Integer(), nullable=False, server_default=sa.text("30")
        ),
        sa.Column("allow_resubmit", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.PrimaryKeyConstraint("id", name="pk_homeworks"),
        sa.ForeignKeyConstraint(
            ["group_id"], ["groups.id"], name="fk_homeworks_group_id_groups", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["lesson_sessions.id"],
            name="fk_homeworks_session_id_lesson_sessions",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name="fk_homeworks_created_by_users"
        ),
    )
    op.create_index("ix_homeworks_group_id_deadline", "homeworks", ["group_id", "deadline"])

    # 11) submissions
    op.create_table(
        "submissions",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False, server_default=_UUID_PK),
        sa.Column("homework_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("student_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("attempt_no", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column("is_latest", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column(
            "storage_primary", storage_kind, nullable=False, server_default=sa.text("'R2'")
        ),
        sa.Column("r2_object_key", sa.String(length=512), nullable=True),
        sa.Column("tg_file_id", sa.String(length=255), nullable=True),
        sa.Column("tg_message_id", sa.Integer(), nullable=True),
        sa.Column(
            "tg_backup_status", backup_status, nullable=False, server_default=sa.text("'NONE'")
        ),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        # AUDIT.md §D10 — INTEGER emas, BIGINT.
        sa.Column("file_size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("content_sha256", sa.String(length=64), nullable=False),
        sa.Column(
            "extracted_files",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "extract_truncated", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        sa.Column("ai_suspected", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "ai_confidence_percent", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column("ai_review_summary", sa.Text(), nullable=True),
        sa.Column(
            "ai_evidence",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "ai_injection_suspected",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("suggested_score", sa.Integer(), nullable=True),
        sa.Column("final_score", sa.Integer(), nullable=True),
        sa.Column("penalty_applied", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("teacher_comment", sa.Text(), nullable=True),
        sa.Column("student_appeal", sa.Text(), nullable=True),
        sa.Column(
            "status", submission_status, nullable=False, server_default=sa.text("'PENDING_AI'")
        ),
        sa.Column(
            "submitted_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW
        ),
        sa.Column("graded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.PrimaryKeyConstraint("id", name="pk_submissions"),
        sa.ForeignKeyConstraint(
            ["homework_id"],
            ["homeworks.id"],
            name="fk_submissions_homework_id_homeworks",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["student_id"], ["users.id"], name="fk_submissions_student_id_users", ondelete="CASCADE"
        ),
        sa.UniqueConstraint(
            "homework_id",
            "student_id",
            "attempt_no",
            name="uq_submissions_homework_id_student_id_attempt_no",
        ),
    )
    # Har (homework, student) uchun faqat BITTA joriy urinish (AUDIT.md §D1).
    op.create_index(
        "uq_latest_sub",
        "submissions",
        ["homework_id", "student_id"],
        unique=True,
        postgresql_where=sa.text("is_latest"),
    )
    op.create_index("ix_submissions_student_id", "submissions", ["student_id"])
    op.create_index("ix_submissions_status", "submissions", ["status"])

    # 12) grade_audit_log  (AUDIT.md §D7)
    op.create_table(
        "grade_audit_log",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("submission_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("actor_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("old_score", sa.Integer(), nullable=True),
        sa.Column("new_score", sa.Integer(), nullable=True),
        sa.Column("old_penalty", sa.Integer(), nullable=True),
        sa.Column("new_penalty", sa.Integer(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.PrimaryKeyConstraint("id", name="pk_grade_audit_log"),
        sa.ForeignKeyConstraint(
            ["submission_id"],
            ["submissions.id"],
            name="fk_grade_audit_log_submission_id_submissions",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["actor_id"], ["users.id"], name="fk_grade_audit_log_actor_id_users"
        ),
    )

    # 13) refresh_tokens  (AUDIT.md §C4)
    op.create_table(
        "refresh_tokens",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("jti", sa.String(length=64), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_NOW),
        sa.PrimaryKeyConstraint("id", name="pk_refresh_tokens"),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_refresh_tokens_user_id_users", ondelete="CASCADE"
        ),
        sa.UniqueConstraint("jti", name="uq_refresh_tokens_jti"),
    )


def downgrade() -> None:
    bind = op.get_bind()

    op.drop_table("refresh_tokens")
    op.drop_table("grade_audit_log")

    op.drop_index("ix_submissions_status", table_name="submissions")
    op.drop_index("ix_submissions_student_id", table_name="submissions")
    op.drop_index("uq_latest_sub", table_name="submissions")
    op.drop_table("submissions")

    op.drop_index("ix_homeworks_group_id_deadline", table_name="homeworks")
    op.drop_table("homeworks")

    op.drop_table("quiz_answers")

    op.drop_index("ix_attendances_student_id", table_name="attendances")
    op.drop_table("attendances")

    op.drop_index("ix_lesson_sessions_group_id_status", table_name="lesson_sessions")
    op.drop_index("uq_active_pin", table_name="lesson_sessions")
    op.drop_table("lesson_sessions")

    op.drop_table("presentations")

    op.drop_index("ix_group_members_student_id", table_name="group_members")
    op.drop_table("group_members")

    op.drop_table("groups")
    op.drop_table("users")

    # ENUM tiplari jadvallardan KEYIN o'chiriladi (ular hali ishlatilayotgan bo'lmasin).
    for pg_enum in reversed(_ALL_ENUMS):
        pg_enum.drop(bind, checkfirst=True)

    # `pgcrypto` ATAYLAB o'chirilmaydi: u DB darajasidagi umumiy resurs va
    # boshqa sxemalar ham ishlatishi mumkin.
