"""FastAPI dependency lari — barcha backend agentlari shu modulni ishlatadi.

Eksportlar:
  `get_redis`            — `request.app.state.redis` dagi umumiy Redis klienti
  `create_redis`         — WS/worker/skript kontekstida yangi klient
  `get_current_user`     — access token → tirik `User` (majburiy)
  `get_optional_user`    — token bo'lmasa `None` (majburiy emas)
  `require_teacher`      — `TEACHER` yoki `ADMIN`
  `require_admin`        — faqat `ADMIN`
  `require_onboarded`    — onboarding tugallangan bo'lishi shart

`get_current_user` qat'iy tekshiradi (AUDIT.md §C4):
  1. `Authorization: Bearer <access>` mavjudmi;
  2. imzo + muddat + `typ == "access"` (algoritm qat'iy `HS256`);
  3. `jti` Redis blacklistida yo'qmi;
  4. foydalanuvchi DB da bormi va `is_active` mi;
  5. `tv == users.token_version` mi — aks holda 401 (rol o'zgargan / majburiy logout).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.errors import AppError, forbidden, unauthorized
from app.core.security import (
    ACCESS_TOKEN_TYPE,
    TokenPayload,
    decode_token,
    ensure_not_revoked,
)
from app.db.models import User, UserRole
from app.db.session import get_db

#: `auto_error=False` — token yo'q bo'lsa Starlette o'zining 403 ini bermasin,
#: biz kontrakt formatidagi 401 ni qaytaramiz.
bearer_scheme = HTTPBearer(auto_error=False, scheme_name="BearerAccessToken")

BearerCreds = Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)]
DbSession = Annotated[AsyncSession, Depends(get_db)]


# ---------------------------------------------------------------------------
# Redis
# ---------------------------------------------------------------------------


def create_redis() -> Redis:
    """Yangi Redis klienti (`decode_responses=True`).

    `app.state.redis` yo'q joylarda ishlatiladi: WS handler lari, `arq` worker,
    skriptlar va testlar. Chaqiruvchi klientni o'zi yopadi (`await r.aclose()`).
    """
    return Redis.from_url(settings.REDIS_URL, decode_responses=True)


async def get_redis(request: Request) -> Redis:
    """`main.py` lifespan da yaratilgan umumiy klient."""
    redis: Redis | None = getattr(request.app.state, "redis", None)
    if redis is None:  # pragma: no cover - lifespan ishlamagan holat
        raise AppError(503, "REDIS_UNAVAILABLE", "Redis ulanmagan. Birozdan keyin urinib ko'ring.")
    return redis


RedisDep = Annotated[Redis, Depends(get_redis)]


# ---------------------------------------------------------------------------
# Foydalanuvchi
# ---------------------------------------------------------------------------


async def _load_active_user(db: AsyncSession, payload: TokenPayload) -> User:
    user = await db.scalar(select(User).where(User.id == payload.user_id))
    if user is None:
        raise unauthorized("USER_NOT_FOUND", "Foydalanuvchi topilmadi.")
    if not user.is_active:
        raise forbidden("USER_INACTIVE", "Hisob bloklangan.")
    if payload.tv != user.token_version:
        # Rol o'zgardi yoki barcha qurilmalardan chiqarildi (AUDIT.md §C4).
        raise unauthorized(
            "TOKEN_VERSION_MISMATCH",
            "Sessiya eskirgan. Qaytadan kiring.",
        )
    return user


async def get_current_user(
    db: DbSession,
    redis: RedisDep,
    credentials: BearerCreds = None,
) -> User:
    """Majburiy autentifikatsiya: `user: User = Depends(get_current_user)`."""
    if credentials is None or not credentials.credentials:
        raise unauthorized()
    if (credentials.scheme or "").lower() != "bearer":
        raise unauthorized("INVALID_AUTH_SCHEME", "Faqat Bearer sxemasi qabul qilinadi.")

    payload = decode_token(credentials.credentials, expected_type=ACCESS_TOKEN_TYPE)
    await ensure_not_revoked(redis, payload)
    return await _load_active_user(db, payload)


async def get_optional_user(
    db: DbSession,
    redis: RedisDep,
    credentials: BearerCreds = None,
) -> User | None:
    """Token bo'lmasa `None`. Token BOR, lekin yaroqsiz bo'lsa — 401 (jim o'tmaydi)."""
    if credentials is None or not credentials.credentials:
        return None
    return await get_current_user(db=db, redis=redis, credentials=credentials)


CurrentUser = Annotated[User, Depends(get_current_user)]
OptionalUser = Annotated[User | None, Depends(get_optional_user)]


# ---------------------------------------------------------------------------
# Rol guard lari
# ---------------------------------------------------------------------------


async def require_teacher(user: CurrentUser) -> User:
    """O'qituvchi amallari. `ADMIN` ham o'tadi (u yuqori huquqli)."""
    if user.role not in (UserRole.TEACHER, UserRole.ADMIN):
        raise forbidden("TEACHER_REQUIRED", "Bu amal faqat o'qituvchi uchun.")
    return user


async def require_admin(user: CurrentUser) -> User:
    """Faqat `ADMIN` (rol berish, hisobni bloklash)."""
    if user.role is not UserRole.ADMIN:
        raise forbidden("ADMIN_REQUIRED", "Bu amal faqat administrator uchun.")
    return user


async def require_onboarded(user: CurrentUser) -> User:
    """Onboarding tugallanmagan foydalanuvchini ilova ichiga qo'ymaydi."""
    if not user.is_onboarded:
        raise forbidden("ONBOARDING_REQUIRED", "Avval profilni to'ldiring.")
    return user


TeacherUser = Annotated[User, Depends(require_teacher)]
AdminUser = Annotated[User, Depends(require_admin)]
OnboardedUser = Annotated[User, Depends(require_onboarded)]


__all__ = [
    "AdminUser",
    "BearerCreds",
    "CurrentUser",
    "DbSession",
    "OnboardedUser",
    "OptionalUser",
    "RedisDep",
    "TeacherUser",
    "bearer_scheme",
    "create_redis",
    "get_current_user",
    "get_optional_user",
    "get_redis",
    "require_admin",
    "require_onboarded",
    "require_teacher",
]
