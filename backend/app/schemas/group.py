"""Guruh DTO lari (CONTRACTS.md §4 `groups`).

`GroupBrief` — `UserOut.groups` va `GET /groups/open` uchun umumiy minimal shakl.
Boshqa agentlar ham shu nomdan foydalanadi (frontend `types/api.ts` bilan 1:1).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import inspect as sa_inspect

from app.db.models import Group


class GroupBrief(BaseModel):
    """Onboarding dropdown va `UserOut.groups` uchun: `{id, name, course_title}`."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    course_title: str


class GroupCreate(BaseModel):
    """`POST /groups` (TEACHER). `invite_code` serverda generatsiya qilinadi —
    klient yuborgan har qanday kod e'tiborga olinmaydi."""

    name: str = Field(min_length=2, max_length=50)
    course_title: str = Field(min_length=2, max_length=150)

    @field_validator("name", "course_title")
    @classmethod
    def _strip(cls, v: str) -> str:
        cleaned = " ".join(v.split())
        if not cleaned:
            raise ValueError("Bo'sh bo'lishi mumkin emas")
        return cleaned


class GroupOut(BaseModel):
    """To'liq guruh ma'lumoti. `invite_code` faqat guruh egasiga/adminga ko'rsatiladi."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    course_title: str
    invite_code: str | None = None
    teacher_id: uuid.UUID | None = None
    teacher_name: str | None = None
    is_active: bool = True
    members_count: int = 0

    @classmethod
    def from_group(
        cls,
        group: Group,
        *,
        members_count: int | None = None,
        reveal_invite_code: bool = False,
    ) -> GroupOut:
        """Yuklanmagan relationship larga TEGMAYDI.

        Async sessiyada `lazy="selectin"` relationship faqat SELECT paytida
        yuklanadi; yangi `flush` qilingan obyektda u bo'sh bo'ladi va unga
        murojaat `MissingGreenlet` beradi. Shuning uchun `unloaded` tekshiriladi.
        """
        unloaded = sa_inspect(group).unloaded
        teacher_name: str | None = None
        if "teacher" not in unloaded and group.teacher is not None:
            teacher_name = group.teacher.full_name
        if members_count is None:
            members_count = 0 if "members" in unloaded else len(group.members)
        return cls(
            id=group.id,
            name=group.name,
            course_title=group.course_title,
            invite_code=group.invite_code if reveal_invite_code else None,
            teacher_id=group.teacher_id,
            teacher_name=teacher_name,
            is_active=group.is_active,
            members_count=members_count,
        )


class GroupMemberOut(BaseModel):
    """`GET /groups/{id}/members` elementi."""

    model_config = ConfigDict(from_attributes=True)

    student_id: uuid.UUID
    full_name: str
    email: str
    avatar_url: str | None = None
    xp_points: int = 0
    joined_at: datetime


__all__ = ["GroupBrief", "GroupCreate", "GroupMemberOut", "GroupOut"]
