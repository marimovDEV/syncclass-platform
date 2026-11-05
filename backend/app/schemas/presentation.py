"""Prezentatsiya DTO lari — CONTRACTS.md §2 (`presentations`) + §4 (`/presentations`).

`slides_data` HAR DOIM `schemas/slide.py` dagi discriminated union dan o'tadi:
  * `PresentationCreate` / `PresentationUpdate` — yozishdan oldin (AUDIT.md §D5);
  * `PresentationOut` — o'qishda ham, ya'ni bazaga qo'lda tiqilgan nosoz deck
    jimgina frontendga ketmaydi.

`PresentationBrief` ataylab `slides_data` ni qaytarmaydi — ro'yxat endpointi
yuzlab slaydni JSON ga aylantirib o'tirmasligi uchun (`slides_count` yetarli).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, computed_field

from app.schemas.slide import MAX_SLIDES, SlideList

#: `presentations.schema_version` ning joriy qiymati (kelajakdagi migratsiya uchun).
SCHEMA_VERSION = 1

MAX_TITLE_CHARS = 255
MAX_MODULE_NUMBER = 999
MAX_LESSON_NUMBER = 999


class PresentationBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=MAX_TITLE_CHARS)
    module_number: int = Field(ge=1, le=MAX_MODULE_NUMBER)
    lesson_number: int = Field(ge=1, le=MAX_LESSON_NUMBER)


class PresentationCreate(PresentationBase):
    """`POST /presentations`. `teacher_id` TANADAN O'QILMAYDI — tokendan olinadi."""

    slides_data: SlideList = Field(default_factory=list)


class PresentationUpdate(BaseModel):
    """`PATCH /presentations/{id}` — faqat yuborilgan maydonlar o'zgaradi.

    `exclude_unset=True` bilan ishlatish SHART, aks holda yuborilmagan maydon
    `None` bo'lib bazani buzadi.
    """

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=MAX_TITLE_CHARS)
    module_number: int | None = Field(default=None, ge=1, le=MAX_MODULE_NUMBER)
    lesson_number: int | None = Field(default=None, ge=1, le=MAX_LESSON_NUMBER)
    slides_data: SlideList | None = Field(default=None, max_length=MAX_SLIDES)


class PresentationOut(PresentationBase):
    """To'liq prezentatsiya (tekshirilgan deck bilan)."""

    model_config = ConfigDict(from_attributes=True, extra="ignore")

    id: uuid.UUID
    teacher_id: uuid.UUID
    schema_version: int = SCHEMA_VERSION
    slides_data: SlideList = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    @computed_field  # type: ignore[prop-decorator]
    @property
    def slides_count(self) -> int:
        return len(self.slides_data)


class PresentationBrief(BaseModel):
    """`GET /presentations` ro'yxati uchun yengil ko'rinish."""

    model_config = ConfigDict(from_attributes=True, extra="ignore")

    id: uuid.UUID
    title: str
    module_number: int
    lesson_number: int
    schema_version: int = SCHEMA_VERSION
    slides_count: int = 0
    updated_at: datetime


class PptxImportOut(BaseModel):
    """`POST /presentations/import/pptx` javobi (CONTRACTS.md §16.2). SAQLAMAYDI.

    `slides` — faqat MARKDOWN slaydlar (PPTX dan faqat matn olinadi); o'qituvchi
    oldindan ko'rib, tasdiqlagach alohida `POST /presentations` bilan saqlaydi.
    `warnings` — o'zbekcha, nima yo'qolgani ochiq aytiladi. `skipped_images` —
    o'tkazib yuborilgan rasmlar soni.
    """

    slides: SlideList = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    skipped_images: int = Field(default=0, ge=0)


class AssetOut(BaseModel):
    """`POST /presentations/{id}/assets` javobi — kontrakt bo'yicha aynan `{url}`."""

    url: str


def brief_from_row(row: Any, slides_count: int) -> PresentationBrief:
    """ORM yozuvi + alohida hisoblangan slayd soni → `PresentationBrief`."""
    return PresentationBrief(
        id=row.id,
        title=row.title,
        module_number=row.module_number,
        lesson_number=row.lesson_number,
        schema_version=row.schema_version,
        slides_count=slides_count,
        updated_at=row.updated_at,
    )


__all__ = [
    "SCHEMA_VERSION",
    "AssetOut",
    "PptxImportOut",
    "PresentationBase",
    "PresentationBrief",
    "PresentationCreate",
    "PresentationOut",
    "PresentationUpdate",
    "brief_from_row",
]
