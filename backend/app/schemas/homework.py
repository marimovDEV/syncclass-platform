"""Uy ishi va topshiriq javoblari uchun Pydantic sxemalari (CONTRACTS.md §4).

Nomlar frontend `src/types/api.ts` dagi `SubmissionOut` bilan bir xil bo'lishi
shart — maydon nomlari DB ustunlari bilan 1:1 (CONTRACTS.md §2).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.db.models import BackupStatus, StorageKind, SubmissionStatus

# --- Uy ishi ---------------------------------------------------------------


class HomeworkCreate(BaseModel):
    """`POST /homeworks` (TEACHER)."""

    group_id: int
    session_id: uuid.UUID | None = None
    title: str = Field(min_length=3, max_length=255)
    description: str = Field(min_length=1, max_length=20_000)
    deadline: datetime
    max_score: int = Field(default=100, ge=1, le=1000)
    ai_penalty_points: int = Field(default=30, ge=0, le=1000)
    allow_resubmit: bool = True


class HomeworkOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    group_id: int
    session_id: uuid.UUID | None
    title: str
    description: str
    deadline: datetime
    max_score: int
    ai_penalty_points: int
    allow_resubmit: bool
    created_by: uuid.UUID
    created_at: datetime
    # Ro'yxatda qulay bo'lishi uchun qo'shimcha, hisoblangan maydonlar.
    submissions_count: int = 0
    my_submission_id: uuid.UUID | None = None
    my_status: SubmissionStatus | None = None


# --- Topshirish ------------------------------------------------------------


class SubmissionCodeIn(BaseModel):
    """`POST /homeworks/{id}/submit` ning JSON varianti (fayl yuklamasdan)."""

    code: str = Field(min_length=1, max_length=400_000)
    file_name: str = Field(default="solution.py", max_length=255)


class ExtractedFileOut(BaseModel):
    """`submissions.extracted_files` elementi (frontend fayl daraxti uchun)."""

    path: str
    content: str = ""
    chars: int = 0
    truncated: bool = False


class SubmissionOut(BaseModel):
    """Topshiriq javobi — o'quvchi ham, o'qituvchi ham shu shaklni oladi.

    `penalty_applied` faqat `POST /submissions/{id}/grade` da o'zgaradi
    (AUDIT.md §E2) — AI xulosasi hech qachon ball kamaytirmaydi.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    homework_id: uuid.UUID
    student_id: uuid.UUID
    attempt_no: int
    is_latest: bool
    storage_primary: StorageKind
    tg_backup_status: BackupStatus

    file_name: str
    file_size_bytes: int
    content_sha256: str
    extracted_files: list[ExtractedFileOut]
    extract_truncated: bool

    ai_suspected: bool
    ai_confidence_percent: int
    ai_review_summary: str | None
    ai_evidence: list[dict[str, Any]]
    ai_injection_suspected: bool
    #: AI xulosasining ikki tomoni (CONTRACTS.md §12.1). DB da `JSONB NOT NULL
    #: DEFAULT '[]'` — hech qachon `None` emas, shuning uchun `Optional` emas.
    #: "Kuchli tomonlar" bloki bularsiz bo'sh qolar edi.
    ai_strengths: list[str] = Field(default_factory=list)
    ai_issues: list[str] = Field(default_factory=list)
    suggested_score: int | None

    final_score: int | None
    penalty_applied: int
    teacher_comment: str | None
    student_appeal: str | None
    status: SubmissionStatus
    submitted_at: datetime
    graded_at: datetime | None
    #: `AppealNotice` e'tiroz qachon yozilganini `updated_at` dan ko'rsatadi.
    created_at: datetime
    updated_at: datetime

    # Hisoblangan maydonlar — serverda to'ldiriladi, klient hisoblamaydi.
    #: `submitted_at > homeworks.deadline` (CONTRACTS.md §11.1). Faqat
    #: ma'lumot: ball avtomatik tushmaydi, `penalty_applied` ga ta'sir qilmaydi.
    is_late: bool = False
    student_name: str | None = None
    student_avatar_url: str | None = None


class SubmissionWithStudent(BaseModel):
    """`GET /homeworks/{id}/submissions` elementi (CONTRACTS.md §4 nomi).

    Yengil ko'rinish: `extracted_files` va AI dalillari yuborilmaydi (ro'yxat
    uchun og'ir). O'quvchi so'rasa `suggested_score` bo'sh qaytadi.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    homework_id: uuid.UUID
    student_id: uuid.UUID
    student_name: str | None = None
    student_avatar_url: str | None = None
    attempt_no: int
    is_latest: bool
    file_name: str
    file_size_bytes: int
    status: SubmissionStatus
    ai_suspected: bool
    ai_confidence_percent: int
    suggested_score: int | None
    final_score: int | None
    penalty_applied: int
    tg_backup_status: BackupStatus
    extract_truncated: bool
    submitted_at: datetime
    graded_at: datetime | None
    #: Hisoblangan: `submitted_at > homeworks.deadline` (CONTRACTS.md §11.1).
    is_late: bool = False


# --- Baholash --------------------------------------------------------------


class GradeIn(BaseModel):
    """`POST /submissions/{id}/grade` (TEACHER).

    🔴 `penalty_applied` FAQAT shu yerdan keladi — o'qituvchi kiritgan qiymat.
    AI tavsiyasi avtomatik qo'llanmaydi (AUDIT.md §E2).
    """

    final_score: int = Field(ge=0, le=1000)
    penalty_applied: int = Field(default=0, ge=0, le=1000)
    teacher_comment: str | None = Field(default=None, max_length=10_000)
    status: Literal["GRADED", "RESUBMIT_REQUIRED"] = "GRADED"

    @field_validator("teacher_comment")
    @classmethod
    def _strip_comment(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None


class AppealIn(BaseModel):
    """`POST /submissions/{id}/appeal` (STUDENT) — AI bayrog'iga e'tiroz."""

    text: str = Field(min_length=3, max_length=4_000)

    @field_validator("text")
    @classmethod
    def _strip_text(cls, v: str) -> str:
        return v.strip()


class DownloadUrlOut(BaseModel):
    """`GET /submissions/{id}/download-url`."""

    url: str
    expires_in: int
    storage: StorageKind


__all__ = [
    "AppealIn",
    "DownloadUrlOut",
    "ExtractedFileOut",
    "GradeIn",
    "HomeworkCreate",
    "HomeworkOut",
    "SubmissionCodeIn",
    "SubmissionOut",
    "SubmissionWithStudent",
]
