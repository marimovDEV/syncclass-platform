"""Auth DTO lari (CONTRACTS.md §4 `auth`).

⚠️ XAVFSIZLIK: `OnboardingIn` da `role` maydoni **umuman yo'q** (AUDIT.md §C1).
Pydantic noma'lum maydonlarni jim tashlab ketadi (`extra="ignore"` — default),
shuning uchun `{"role": "TEACHER"}` yuborilsa so'rov **rad etilmaydi**, lekin
rol ham **o'zgarmaydi**: u serverda allowlist bo'yicha hal qilinadi.
`extra="forbid"` ataylab qo'yilmagan — DoD §I5 "e'tiborga olinmaydi" deydi, "422" emas.
"""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import inspect as sa_inspect

from app.db.models import User, UserRole
from app.schemas.group import GroupBrief


class GoogleLoginOut(BaseModel):
    """`GET /auth/google/login` → Google ga yo'naltirish havolasi."""

    authorize_url: str


class TokenPair(BaseModel):
    """`POST /auth/refresh` javobi (callback da fragment ko'rinishida beriladi)."""

    access_token: str
    refresh_token: str
    token_type: Literal["bearer"] = "bearer"  # noqa: S105 - OAuth sxema nomi


class DevLoginIn(BaseModel):
    """Faqat dev muhitida tezkor kirish uchun."""

    email: str = Field(default="teacher@syncclass.local", max_length=255)


class RefreshIn(BaseModel):
    refresh_token: str = Field(min_length=10, max_length=4096)


class LogoutIn(BaseModel):
    """Refresh token majburiy emas: access token bilan ham chiqish mumkin,
    bunda shu qurilmaning refresh i bo'lmasa hech narsa revoke qilinmaydi."""

    refresh_token: str | None = Field(default=None, max_length=4096)
    #: `true` bo'lsa `token_version` oshiriladi → BARCHA qurilmalardan chiqarish.
    all_devices: bool = False


class LogoutOut(BaseModel):
    status: Literal["ok"] = "ok"
    revoked: int = 0


class OnboardingIn(BaseModel):
    """`POST /auth/onboarding`. `group_id` va `invite_code` — ikkisidan BIRI."""

    full_name: str = Field(min_length=2, max_length=255)
    group_id: int | None = Field(default=None, ge=1)
    invite_code: str | None = Field(default=None, min_length=3, max_length=20)

    @field_validator("full_name")
    @classmethod
    def _clean_name(cls, v: str) -> str:
        cleaned = " ".join(v.split())
        if len(cleaned) < 2:
            raise ValueError("Ism juda qisqa")
        return cleaned

    @field_validator("invite_code")
    @classmethod
    def _clean_code(cls, v: str | None) -> str | None:
        if v is None:
            return None
        cleaned = v.strip().upper()
        return cleaned or None

    @model_validator(mode="after")
    def _only_one_target(self) -> OnboardingIn:
        if self.group_id is not None and self.invite_code is not None:
            raise ValueError("group_id va invite_code dan faqat bittasini yuboring")
        return self


class UserOut(BaseModel):
    """CONTRACTS.md §4: `{id, email, full_name, avatar_url, role, is_onboarded, xp_points, groups}`."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    full_name: str
    avatar_url: str | None = None
    role: UserRole
    is_onboarded: bool
    xp_points: int
    groups: list[GroupBrief] = Field(default_factory=list)

    @classmethod
    def from_user(cls, user: User) -> UserOut:
        """`User` dan DTO yasaydi.

        Guruhlar: o'qituvchi/admin uchun — o'zi egasi bo'lgan guruhlar,
        o'quvchi uchun — a'zo bo'lgan guruhlar. Barcha relationship lar
        `lazy="selectin"` bo'lgani uchun qo'shimcha `await` kerak emas.
        """
        unloaded = sa_inspect(user).unloaded
        collected: dict[int, GroupBrief] = {}
        if user.role in (UserRole.TEACHER, UserRole.ADMIN) and "owned_groups" not in unloaded:
            for group in user.owned_groups:
                collected[group.id] = GroupBrief.model_validate(group)
        if "memberships" not in unloaded:
            for membership in user.memberships:
                if "group" in sa_inspect(membership).unloaded:
                    continue
                group = membership.group
                if group is not None:
                    collected[group.id] = GroupBrief.model_validate(group)
        return cls(
            id=user.id,
            email=user.email,
            full_name=user.full_name,
            avatar_url=user.avatar_url,
            role=user.role,
            is_onboarded=user.is_onboarded,
            xp_points=user.xp_points,
            groups=sorted(collected.values(), key=lambda g: g.name),
        )


__all__ = [
    "GoogleLoginOut",
    "GroupBrief",
    "LogoutIn",
    "LogoutOut",
    "OnboardingIn",
    "RefreshIn",
    "TokenPair",
    "UserOut",
]
