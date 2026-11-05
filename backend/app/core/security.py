"""Xavfsizlik primitivlari: JWT, revocation, rate-limit, crypto-secure kodlar.

Qoidalar (AUDIT.md §C3, §C4):
  * JWT **faqat** `HS256`. Algoritm klient tokenidan HECH QACHON o'qilmaydi —
    `decode` ga har doim `algorithms=[settings.JWT_ALGORITHM]` beriladi
    (`alg: none` / `alg: RS256` confusion hujumi shu bilan yopiladi).
  * `access` 60 daqiqa, `refresh` 30 kun + `jti`. Har ikkisida `typ` maydoni bor,
    shuning uchun refresh tokenni access sifatida ishlatish mumkin emas.
  * `token_version` (`tv`) foydalanuvchi yozuvidagi qiymatga teng bo'lishi shart —
    rol o'zgarsa yoki hisob buzilsa `token_version` oshiriladi va BARCHA eski
    access tokenlar bir zumda kuchini yo'qotadi.
  * PIN / invite-code / ticket — `secrets` moduli (crypto-secure). `random` TAQIQLANADI.
  * Rate limit — Redis fixed-window counter, kalit `ratelimit:{scope}:{key}`
    (CONTRACTS.md §5).

Bu modul tarmoqqa chiqmaydi va DB ga tegmaydi — faqat toza funksiyalar + Redis.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Final, Literal

from jose import ExpiredSignatureError, JWTError, jwt
from pydantic import BaseModel
from redis.asyncio import Redis

from app.core.config import settings
from app.core.errors import AppError, rate_limited, unauthorized

# ---------------------------------------------------------------------------
# Konstantalar
# ---------------------------------------------------------------------------

ACCESS_TOKEN_TYPE: Final[str] = "access"  # noqa: S105 - token TURI, sir emas
REFRESH_TOKEN_TYPE: Final[str] = "refresh"  # noqa: S105 - token TURI, sir emas

TokenType = Literal["access", "refresh"]

#: Redis kalit shablonlari (CONTRACTS.md §5 + AUDIT.md §C4 blacklist).
RATE_LIMIT_KEY: Final[str] = "ratelimit:{scope}:{key}"
FAILURE_KEY: Final[str] = "ratelimit:{scope}:fail:{key}"
LOCKOUT_KEY: Final[str] = "ratelimit:{scope}:lock:{key}"
REVOKED_TOKEN_KEY: Final[str] = "revoked:token:{jti}"  # noqa: S105 - Redis kalit shabloni
OAUTH_STATE_KEY: Final[str] = "oauth:state:{state}"

#: `(limit, window_seconds)` juftliklari — AUDIT.md §C3 va §H2.
RATE_LIMIT_OAUTH_LOGIN: Final[tuple[int, int]] = (20, 60)
RATE_LIMIT_OAUTH_CALLBACK: Final[tuple[int, int]] = (20, 60)
RATE_LIMIT_REFRESH: Final[tuple[int, int]] = (30, 60)
#: Onboarding/join urinishlari: 10/daqiqa (AUDIT.md §C3).
RATE_LIMIT_ONBOARDING: Final[tuple[int, int]] = (10, 60)
RATE_LIMIT_JOIN: Final[tuple[int, int]] = (10, 60)
RATE_LIMIT_GROUP_CREATE: Final[tuple[int, int]] = (20, 60)

#: 5 xato invite-code dan keyin 5 daqiqa lockout (AUDIT.md §C3).
INVITE_MAX_FAILURES: Final[int] = 5
INVITE_LOCKOUT_SEC: Final[int] = 300
#: Xato hisoblagichining "eslab qolish" oynasi.
FAILURE_WINDOW_SEC: Final[int] = 600

#: Chalkashtirib yuborish mumkin bo'lgan belgilar (0/O, 1/I/L) olib tashlangan.
INVITE_ALPHABET: Final[str] = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
DIGITS: Final[str] = "0123456789"


def _now() -> datetime:
    return datetime.now(UTC)


# ---------------------------------------------------------------------------
# JWT
# ---------------------------------------------------------------------------


class TokenPayload(BaseModel):
    """Dekod qilingan va tasdiqlangan JWT tanasi."""

    sub: str
    typ: TokenType
    jti: str
    tv: int = 0
    role: str | None = None
    exp: int
    iat: int

    @property
    def user_id(self) -> uuid.UUID:
        """`sub` ni UUID ga aylantiradi; buzuq bo'lsa 401."""
        try:
            return uuid.UUID(self.sub)
        except (ValueError, AttributeError, TypeError) as exc:
            raise unauthorized("INVALID_TOKEN", "Token egasi aniqlanmadi.") from exc


class IssuedRefreshToken(BaseModel):
    """`create_refresh_token` natijasi — `refresh_tokens` jadvaliga yozish uchun."""

    token: str
    jti: str
    expires_at: datetime


def new_jti() -> str:
    """Token identifikatori (`refresh_tokens.jti` — `String(64)` ga sig'adi)."""
    return uuid.uuid4().hex


def _encode(payload: dict[str, object]) -> str:
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def create_access_token(
    *,
    user_id: uuid.UUID | str,
    role: str,
    token_version: int,
    expires_minutes: int | None = None,
) -> str:
    """Qisqa muddatli access token (default: `ACCESS_TOKEN_EXPIRE_MINUTES`)."""
    minutes = settings.ACCESS_TOKEN_EXPIRE_MINUTES if expires_minutes is None else expires_minutes
    issued = _now()
    expires = issued + timedelta(minutes=minutes)
    return _encode(
        {
            "sub": str(user_id),
            "typ": ACCESS_TOKEN_TYPE,
            "jti": new_jti(),
            "tv": int(token_version),
            "role": str(role),
            "iat": int(issued.timestamp()),
            "exp": int(expires.timestamp()),
        }
    )


def create_refresh_token(
    *,
    user_id: uuid.UUID | str,
    token_version: int,
    jti: str | None = None,
    expires_days: int | None = None,
) -> IssuedRefreshToken:
    """Uzoq muddatli refresh token. `jti` DB da ro'yxatga olinadi (revocation uchun)."""
    days = settings.REFRESH_TOKEN_EXPIRE_DAYS if expires_days is None else expires_days
    issued = _now()
    expires = issued + timedelta(days=days)
    token_id = jti or new_jti()
    token = _encode(
        {
            "sub": str(user_id),
            "typ": REFRESH_TOKEN_TYPE,
            "jti": token_id,
            "tv": int(token_version),
            "iat": int(issued.timestamp()),
            "exp": int(expires.timestamp()),
        }
    )
    return IssuedRefreshToken(token=token, jti=token_id, expires_at=expires)


def decode_token(token: str, *, expected_type: TokenType) -> TokenPayload:
    """Imzo + muddat + `typ` ni tekshiradi. Xato bo'lsa 401 `AppError`.

    Algoritm **ro'yxati qat'iy** (`[settings.JWT_ALGORITHM]`), ya'ni tokendagi
    `alg` sarlavhasi hech qanday ta'sir qilmaydi.
    """
    if not token or not isinstance(token, str):
        raise unauthorized("INVALID_TOKEN", "Token yuborilmadi.")
    try:
        raw = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
            options={"require_sub": True, "require_exp": True, "verify_aud": False},
        )
    except ExpiredSignatureError as exc:
        raise unauthorized("TOKEN_EXPIRED", "Token muddati tugagan.") from exc
    except JWTError as exc:
        raise unauthorized("INVALID_TOKEN", "Token yaroqsiz.") from exc

    try:
        payload = TokenPayload.model_validate(raw)
    except ValueError as exc:
        raise unauthorized("INVALID_TOKEN", "Token tarkibi yaroqsiz.") from exc

    if payload.typ != expected_type:
        raise unauthorized(
            "INVALID_TOKEN_TYPE",
            "Token turi mos emas (access/refresh almashtirilgan).",
        )
    return payload


def token_remaining_seconds(payload: TokenPayload) -> int:
    """Blacklist TTL si uchun: tokenning qolgan amal qilish muddati."""
    return max(1, payload.exp - int(_now().timestamp()))


# ---------------------------------------------------------------------------
# Revocation (Redis blacklist) — AUDIT.md §C4
# ---------------------------------------------------------------------------


async def revoke_token(redis: Redis, jti: str, ttl_seconds: int) -> None:
    """`jti` ni blacklist ga qo'yadi. TTL — tokenning qolgan muddati."""
    await redis.set(REVOKED_TOKEN_KEY.format(jti=jti), "1", ex=max(1, int(ttl_seconds)))


async def is_token_revoked(redis: Redis, jti: str) -> bool:
    return bool(await redis.exists(REVOKED_TOKEN_KEY.format(jti=jti)))


async def ensure_not_revoked(redis: Redis, payload: TokenPayload) -> None:
    """Blacklistda bo'lsa 401 `TOKEN_REVOKED`."""
    if await is_token_revoked(redis, payload.jti):
        raise unauthorized("TOKEN_REVOKED", "Token bekor qilingan. Qaytadan kiring.")


# ---------------------------------------------------------------------------
# Rate limiting (Redis fixed-window) — AUDIT.md §H2
# ---------------------------------------------------------------------------


async def check_rate_limit(
    redis: Redis,
    scope: str,
    key: str,
    limit: int,
    window: int,
    *,
    cost: int = 1,
) -> int:
    """Hisoblagichni oshiradi; chegaradan oshsa `429 RATE_LIMITED` ko'taradi.

    Qaytaradi: oynada qolgan urinishlar soni.
    `ttl` tekshiruvi — kalit TTL siz qolib ketmasligi uchun (har Redis versiyada ishlaydi).
    """
    redis_key = RATE_LIMIT_KEY.format(scope=scope, key=key)
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incrby(redis_key, cost)
        pipe.ttl(redis_key)
        count, ttl = await pipe.execute()
    if int(ttl) < 0:
        await redis.expire(redis_key, window)
    if int(count) > limit:
        raise rate_limited()
    return max(0, limit - int(count))


async def reset_rate_limit(redis: Redis, scope: str, key: str) -> None:
    """Testlar va muvaffaqiyatli amaldan keyin hisoblagichni tozalash."""
    await redis.delete(RATE_LIMIT_KEY.format(scope=scope, key=key))


# ---------------------------------------------------------------------------
# Lockout (brute-force) — AUDIT.md §C3
# ---------------------------------------------------------------------------


async def check_lockout(redis: Redis, scope: str, key: str) -> None:
    """Qulf qo'yilgan bo'lsa `429` — hisoblagichni ham oshirmaydi."""
    if await redis.exists(LOCKOUT_KEY.format(scope=scope, key=key)):
        raise rate_limited(
            "Juda ko'p xato urinish. Bir necha daqiqadan keyin qayta urinib ko'ring."
        )


async def register_failure(
    redis: Redis,
    scope: str,
    key: str,
    *,
    max_failures: int = INVITE_MAX_FAILURES,
    lockout_sec: int = INVITE_LOCKOUT_SEC,
    window: int = FAILURE_WINDOW_SEC,
) -> int:
    """Xato urinishni yozadi; `max_failures` ga yetganda qulf qo'yadi.

    Qaytaradi: oynadagi jami xato soni.
    """
    fail_key = FAILURE_KEY.format(scope=scope, key=key)
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incr(fail_key)
        pipe.ttl(fail_key)
        failures, ttl = await pipe.execute()
    if int(ttl) < 0:
        await redis.expire(fail_key, window)
    if int(failures) >= max_failures:
        await redis.set(LOCKOUT_KEY.format(scope=scope, key=key), "1", ex=lockout_sec)
        await redis.delete(fail_key)
    return int(failures)


async def clear_failures(redis: Redis, scope: str, key: str) -> None:
    """Muvaffaqiyatli urinishdan keyin xato hisoblagichini tozalaydi."""
    await redis.delete(
        FAILURE_KEY.format(scope=scope, key=key),
        LOCKOUT_KEY.format(scope=scope, key=key),
    )


# ---------------------------------------------------------------------------
# Crypto-secure generatorlar
# ---------------------------------------------------------------------------


def generate_pin_code(length: int = 6) -> str:
    """Dars xonasi PIN i — 6 xonali, `secrets` (AUDIT.md §C3)."""
    return "".join(secrets.choice(DIGITS) for _ in range(length))


def generate_invite_code(length: int = 8) -> str:
    """Guruh invite-code i — chalkashmaydigan alifbo, `String(20)` ga sig'adi."""
    return "".join(secrets.choice(INVITE_ALPHABET) for _ in range(length))


def generate_ws_ticket() -> str:
    """WS uchun bir martalik ticket (AUDIT.md §B3)."""
    return secrets.token_urlsafe(32)


def generate_oauth_state() -> str:
    """OAuth CSRF `state`."""
    return secrets.token_urlsafe(32)


def constant_time_compare(left: str, right: str) -> bool:
    """Timing-safe solishtirish (PIN/invite/ticket uchun)."""
    return secrets.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


# ---------------------------------------------------------------------------
# Rol siyosati — AUDIT.md §C1
# ---------------------------------------------------------------------------


def is_allowlisted_teacher(email: str) -> bool:
    """Email `TEACHER_EMAIL_ALLOWLIST` da bormi.

    Bu YAGONA avtomatik yo'l `TEACHER` bo'lish uchun; ikkinchi yo'l — mavjud
    `ADMIN` qo'lda beradi. Klient yuborgan `role` hech qachon o'qilmaydi.
    """
    if not email:
        return False
    normalized = email.strip().lower()
    return normalized in {e.strip().lower() for e in settings.TEACHER_EMAIL_ALLOWLIST}


__all__ = [
    "ACCESS_TOKEN_TYPE",
    "FAILURE_KEY",
    "INVITE_ALPHABET",
    "INVITE_LOCKOUT_SEC",
    "INVITE_MAX_FAILURES",
    "LOCKOUT_KEY",
    "OAUTH_STATE_KEY",
    "RATE_LIMIT_GROUP_CREATE",
    "RATE_LIMIT_JOIN",
    "RATE_LIMIT_KEY",
    "RATE_LIMIT_OAUTH_CALLBACK",
    "RATE_LIMIT_OAUTH_LOGIN",
    "RATE_LIMIT_ONBOARDING",
    "RATE_LIMIT_REFRESH",
    "REFRESH_TOKEN_TYPE",
    "REVOKED_TOKEN_KEY",
    "AppError",
    "IssuedRefreshToken",
    "TokenPayload",
    "TokenType",
    "check_lockout",
    "check_rate_limit",
    "clear_failures",
    "constant_time_compare",
    "create_access_token",
    "create_refresh_token",
    "decode_token",
    "ensure_not_revoked",
    "generate_invite_code",
    "generate_oauth_state",
    "generate_pin_code",
    "generate_ws_ticket",
    "is_allowlisted_teacher",
    "is_token_revoked",
    "new_jti",
    "register_failure",
    "reset_rate_limit",
    "revoke_token",
    "token_remaining_seconds",
]
