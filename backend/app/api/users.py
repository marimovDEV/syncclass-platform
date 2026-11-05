"""ADMIN foydalanuvchi boshqaruvi ("adminka") — ro'yxat va rol berish.

Rol siyosati (AUDIT.md §C1): Google orqali kirgan yangi hisob — `STUDENT`.
O'qituvchi/administrator huquqini faqat `ADMIN` beradi (shu endpointlar).
Rol o'zgarganda `token_version` oshiriladi — foydalanuvchining BARCHA eski
tokenlari darhol kuchini yo'qotadi (AUDIT.md §C4), u qayta kirishi kerak.

Xavfsizlik qoidalari:
  * `ADMIN` o'z rolini o'zgartira olmaydi — tasodifan o'zini qulflab
    qo'ymasligi uchun (oxirgi adminni yo'qotish xavfi).
  * Bu modul faqat rol beradi; hisobni o'chirish yo'q (tarix saqlanadi).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import or_, select

from app.core.deps import DbSession, require_admin
from app.core.errors import bad_request, not_found
from app.db.models import User, UserRole

router = APIRouter()

AdminUser = Annotated[User, Depends(require_admin)]

#: Ro'yxat sahifasi uchun yuqori chegara — adminka jadval, eksport emas.
MAX_PAGE_SIZE = 200


class AdminUserOut(BaseModel):
    """Adminka ro'yxati elementi (guruhlarsiz — yengil)."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    full_name: str
    avatar_url: str | None = None
    role: UserRole
    is_active: bool
    is_onboarded: bool
    created_at: datetime
    #: Mahsulot qarori: parol ochiq saqlanadi va faqat shu ADMIN javobida
    #: qaytadi — o'quvchi unutsa admin aytib beradi. `None` — parol yo'q
    #: (faqat Google orqali kiradi).
    password_plain: str | None = None


class RoleUpdateIn(BaseModel):
    role: UserRole


class PasswordSetIn(BaseModel):
    password: str = Field(min_length=4, max_length=128)


@router.get("", response_model=list[AdminUserOut])
async def list_users(
    _admin: AdminUser,
    db: DbSession,
    query: str = Query(default="", max_length=120),
    limit: int = Query(default=MAX_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
) -> list[User]:
    """Foydalanuvchilar ro'yxati (faqat ADMIN). `query` — email/ism bo'yicha."""
    stmt = select(User).order_by(User.created_at.desc()).limit(limit)
    text = query.strip()
    if text:
        like = f"%{text}%"
        stmt = stmt.where(or_(User.email.ilike(like), User.full_name.ilike(like)))
    return list((await db.execute(stmt)).scalars().all())


@router.patch("/{user_id}/role", response_model=AdminUserOut)
async def set_role(
    user_id: uuid.UUID,
    data: RoleUpdateIn,
    admin: AdminUser,
    db: DbSession,
) -> User:
    """Rol berish (faqat ADMIN). O'z rolini o'zgartirish taqiqlangan."""
    if user_id == admin.id:
        raise bad_request("CANNOT_CHANGE_OWN_ROLE", "O'z rolingizni o'zgartira olmaysiz.")

    user = await db.get(User, user_id)
    if user is None:
        raise not_found("USER_NOT_FOUND", "Bunday foydalanuvchi yo'q.")

    if user.role is not data.role:
        user.role = data.role
        # Eski tokenlar (jumladan o'g'irlangan bo'lishi mumkinlari) darhol o'ladi.
        user.token_version += 1
        await db.commit()
        await db.refresh(user)
    return user


@router.put("/{user_id}/password", response_model=AdminUserOut)
async def set_password(
    user_id: uuid.UUID,
    data: PasswordSetIn,
    _admin: AdminUser,
    db: DbSession,
) -> User:
    """Parol o'rnatish/almashtirish (faqat ADMIN).

    `token_version` ATAYLAB oshirilmaydi: parol almashtirish — kirishni
    tiklash vositasi, mavjud sessiyalarni (masalan, darsdagi o'quvchini)
    uzish emas. Sessiyalarni uzish kerak bo'lsa rol oqimi yoki
    `logout all_devices` bor.
    """
    user = await db.get(User, user_id)
    if user is None:
        raise not_found("USER_NOT_FOUND", "Bunday foydalanuvchi yo'q.")

    user.password_plain = data.password
    await db.commit()
    await db.refresh(user)
    return user
