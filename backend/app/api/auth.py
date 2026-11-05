"""Auth API — CONTRACTS.md §4 dagi 6 ta endpoint.

Xavfsizlik tamoyillari (AUDIT.md §C):
  * Google OAuth2 Authorization Code flow. `state` Redis da 10 daqiqa yashaydi
    va bir marta ishlatiladi (CSRF).
  * `id_token` Google JWKS bilan `google-auth` orqali tekshiriladi (`aud`, `iss`,
    `exp`, imzo). `email_verified != true` bo'lsa kirish rad etiladi.
  * Yangi foydalanuvchi HAR DOIM `STUDENT`. `TEACHER` faqat
    `TEACHER_EMAIL_ALLOWLIST` bo'yicha yoki `ADMIN` qo'lda berganda.
  * `POST /auth/onboarding` dagi `role` maydoni O'QILMAYDI (schemada yo'q).
  * Refresh token rotatsiya qilinadi; ishlatilgan `jti` revoke bo'ladi va
    revoke qilingan tokenni qayta ishlatish urinishi — o'g'irlik belgisi deb
    qabul qilinib, foydalanuvchining BARCHA refresh tokenlari bekor qilinadi.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Query, Request, Response, status
from fastapi.responses import RedirectResponse
from google.auth import exceptions as google_exceptions
from google.auth import transport as google_transport
from google.oauth2 import id_token as google_id_token
from redis.asyncio import Redis
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.deps import BearerCreds, CurrentUser, DbSession, OptionalUser, RedisDep
from app.core.errors import bad_request, forbidden, not_found, unauthorized
from app.core.security import (
    ACCESS_TOKEN_TYPE,
    OAUTH_STATE_KEY,
    RATE_LIMIT_OAUTH_CALLBACK,
    RATE_LIMIT_OAUTH_LOGIN,
    RATE_LIMIT_ONBOARDING,
    RATE_LIMIT_REFRESH,
    REFRESH_TOKEN_TYPE,
    check_lockout,
    check_rate_limit,
    clear_failures,
    create_access_token,
    create_refresh_token,
    decode_token,
    ensure_not_revoked,
    generate_oauth_state,
    is_allowlisted_teacher,
    register_failure,
    revoke_token,
    token_remaining_seconds,
)
from app.db.models import Group, GroupMember, RefreshToken, User, UserRole
from app.schemas.auth import (
    DevLoginIn,
    GoogleLoginOut,
    LogoutIn,
    LogoutOut,
    OnboardingIn,
    RefreshIn,
    TokenPair,
    UserOut,
)

log = logging.getLogger("syncclass.auth")

router = APIRouter()

GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"  # noqa: S105 - URL, sir emas
GOOGLE_SCOPES = "openid email profile"
OAUTH_STATE_TTL_SEC = 600

#: Google id_token ni berishi mumkin bo'lgan `iss` qiymatlari.
GOOGLE_ISSUERS = ("accounts.google.com", "https://accounts.google.com")


# ---------------------------------------------------------------------------
# Yordamchilar
# ---------------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(UTC)


def _client_ip(request: Request) -> str:
    """Rate-limit kaliti uchun IP. Reverse-proxy ortida `X-Forwarded-For`."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _frontend_origin() -> str:
    origins = settings.cors_origins
    return (origins[0] if origins else settings.FRONTEND_ORIGIN).rstrip("/")


def _callback_redirect(**fragment: str) -> RedirectResponse:
    """`FRONTEND_ORIGIN/auth/callback#...` ga 302 (CONTRACTS.md §4)."""
    return RedirectResponse(
        url=f"{_frontend_origin()}/auth/callback#{urlencode(fragment)}",
        status_code=status.HTTP_302_FOUND,
    )


async def _issue_pair(db: AsyncSession, user: User) -> TokenPair:
    """Access + refresh yaratadi va `refresh_tokens` ga `jti` yozadi.

    `commit` chaqiruvchida (CONTRACTS.md §2.3).
    """
    access = create_access_token(
        user_id=user.id, role=user.role.value, token_version=user.token_version
    )
    issued = create_refresh_token(user_id=user.id, token_version=user.token_version)
    db.add(RefreshToken(jti=issued.jti, user_id=user.id, expires_at=issued.expires_at))
    return TokenPair(access_token=access, refresh_token=issued.token)


def _assert_usable(user: User, token_version: int) -> None:
    """Refresh oqimi uchun `get_current_user` dagi tekshiruvlarning aynan o'zi."""
    if not user.is_active:
        raise forbidden("USER_INACTIVE", "Hisob bloklangan.")
    if token_version != user.token_version:
        raise unauthorized("TOKEN_VERSION_MISMATCH", "Sessiya eskirgan. Qaytadan kiring.")


async def _revoke_row(redis: Redis, row: RefreshToken) -> None:
    """DB da `revoked_at` + Redis blacklist (ikki qatlamli)."""
    row.revoked_at = _now()
    ttl = int((row.expires_at - _now()).total_seconds())
    await revoke_token(redis, row.jti, max(1, ttl))


async def _reload_user(db: AsyncSession, user_id: uuid.UUID) -> User:
    """Guruh a'zoliklari o'zgargandan keyin `selectin` relationship larni yangilash."""
    db.expire_all()
    user = await db.scalar(select(User).where(User.id == user_id))
    if user is None:  # pragma: no cover - bir tranzaksiyada o'chib ketgan holat
        raise not_found("USER_NOT_FOUND", "Foydalanuvchi topilmadi.")
    return user


# ---------------------------------------------------------------------------
# POST /auth/dev-login (faqat APP_ENV=development)
# ---------------------------------------------------------------------------


@router.post(
    "/dev-login",
    response_model=TokenPair,
    summary="Lokal dev: bir klikda kirish",
)
async def dev_login(data: DevLoginIn, db: DbSession) -> TokenPair:
    if not settings.is_dev:
        raise not_found("NOT_FOUND", "Faqat development muhitida mavjud.")

    email = data.email.strip().lower()
    user = await db.scalar(select(User).where(User.email == email))
    if user is None:
        is_teacher = is_allowlisted_teacher(email) or "teacher" in email
        user = User(
            email=email,
            google_id=f"dev_{uuid.uuid4().hex[:12]}",
            full_name="O'qituvchi (Dev)" if is_teacher else "O'quvchi (Dev)",
            role=UserRole.TEACHER if is_teacher else UserRole.STUDENT,
            is_onboarded=True,
            is_active=True,
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)

    tokens = await _issue_pair(db, user)
    await db.commit()
    return tokens


# ---------------------------------------------------------------------------
# GET /auth/google/login
# ---------------------------------------------------------------------------


@router.get("/google/login", response_model=GoogleLoginOut, summary="Google ga yo'naltirish havolasi")
async def google_login(request: Request, redis: RedisDep) -> GoogleLoginOut:
    if not settings.GOOGLE_CLIENT_ID:
        raise bad_request("OAUTH_NOT_CONFIGURED", "Google OAuth sozlanmagan.")

    limit, window = RATE_LIMIT_OAUTH_LOGIN
    await check_rate_limit(redis, "oauth_login", _client_ip(request), limit, window)

    state = generate_oauth_state()
    await redis.set(
        OAUTH_STATE_KEY.format(state=state),
        f"{_frontend_origin()}/auth/callback",
        ex=OAUTH_STATE_TTL_SEC,
    )
    params = {
        "client_id": settings.GOOGLE_CLIENT_ID,
        "redirect_uri": settings.GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": GOOGLE_SCOPES,
        "state": state,
        "access_type": "online",
        "include_granted_scopes": "true",
        "prompt": "select_account",
    }
    return GoogleLoginOut(authorize_url=f"{GOOGLE_AUTH_ENDPOINT}?{urlencode(params)}")


# ---------------------------------------------------------------------------
# GET /auth/google/callback
# ---------------------------------------------------------------------------


async def _exchange_code(code: str) -> dict[str, object]:
    """Authorization code → tokenlar. Tarmoq xatosi `None` emas, exception beradi."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(
            GOOGLE_TOKEN_ENDPOINT,
            data={
                "code": code,
                "client_id": settings.GOOGLE_CLIENT_ID,
                "client_secret": settings.GOOGLE_CLIENT_SECRET,
                "redirect_uri": settings.GOOGLE_REDIRECT_URI,
                "grant_type": "authorization_code",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if response.status_code != 200:
        raise ValueError(f"google_token_exchange_failed: {response.status_code}")
    return response.json()


class _HttpxResponse(google_transport.Response):
    """`google.auth` kutayotgan minimal javob obyekti."""

    def __init__(self, response: httpx.Response) -> None:
        self._response = response

    @property
    def status(self) -> int:
        return self._response.status_code

    @property
    def headers(self) -> dict[str, str]:
        return dict(self._response.headers)

    @property
    def data(self) -> bytes:
        return self._response.content


class _HttpxTransport(google_transport.Request):
    """`google-auth` uchun transport.

    `google.auth.transport.requests` moduli `requests` paketini talab qiladi,
    u esa `requirements.txt` da yo'q. Shuning uchun loyihada allaqachon bor
    `httpx` ustiga mos keladigan transport yozilgan — JWKS sertifikatlarini
    shu orqali oladi. Sinxron: `verify_oauth2_token` ni threadpool da chaqiramiz.
    """

    def __call__(
        self,
        url: str,
        method: str = "GET",
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
        timeout: float | None = 20.0,
        **kwargs: object,
    ) -> _HttpxResponse:
        response = httpx.request(
            method,
            url,
            content=body,
            headers=headers,
            timeout=timeout or 20.0,
            follow_redirects=True,
        )
        return _HttpxResponse(response)


async def _verify_id_token(raw_id_token: str) -> dict[str, object]:
    """Google JWKS bilan imzo/aud/iss/exp tekshiruvi (sinxron kutubxona → threadpool)."""
    claims = await run_in_threadpool(
        google_id_token.verify_oauth2_token,
        raw_id_token,
        _HttpxTransport(),
        settings.GOOGLE_CLIENT_ID,
    )
    if claims.get("iss") not in GOOGLE_ISSUERS:
        raise ValueError("bad_issuer")
    if not claims.get("sub"):
        raise ValueError("missing_sub")
    return claims


async def _upsert_google_user(db: AsyncSession, claims: dict[str, object]) -> User:
    """Google profilidan foydalanuvchi yaratadi yoki topadi.

    Rol siyosati (AUDIT.md §C1): yangi hisob — `STUDENT`; allowlistdagi email
    `TEACHER` bo'ladi. Mavjud hisob allowlistga qo'shilgan bo'lsa roli
    ko'tariladi va `token_version` oshiriladi (eski tokenlar kuchini yo'qotadi).
    """
    google_id = str(claims["sub"])
    email = str(claims.get("email", "")).strip().lower()
    full_name = str(claims.get("name") or email.split("@")[0] or "Foydalanuvchi")[:255]
    avatar_url = claims.get("picture")

    user = await db.scalar(select(User).where(User.google_id == google_id))
    if user is None and email:
        # Seed/eski hisob: email bor, lekin google_id hali bog'lanmagan.
        user = await db.scalar(select(User).where(User.email == email))
        if user is not None:
            user.google_id = google_id

    if user is None:
        user = User(
            google_id=google_id,
            email=email,
            full_name=full_name,
            avatar_url=str(avatar_url) if avatar_url else None,
            role=UserRole.TEACHER if is_allowlisted_teacher(email) else UserRole.STUDENT,
            is_onboarded=False,
        )
        db.add(user)
        try:
            await db.flush()
        except IntegrityError:
            # Parallel callback: boshqa so'rov shu hisobni allaqachon yaratdi.
            await db.rollback()
            user = await db.scalar(select(User).where(User.google_id == google_id))
            if user is None:
                raise
    else:
        if avatar_url:
            user.avatar_url = str(avatar_url)
        if user.role is UserRole.STUDENT and is_allowlisted_teacher(user.email):
            user.role = UserRole.TEACHER
            user.token_version += 1
            log.info("Allowlist bo'yicha TEACHER berildi: %s", user.email)
        await db.flush()

    if not user.is_active:
        raise forbidden("USER_INACTIVE", "Hisob bloklangan.")
    return user


@router.get("/google/callback", summary="Google callback → frontend ga 302")
async def google_callback(
    request: Request,
    db: DbSession,
    redis: RedisDep,
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
) -> Response:
    limit, window = RATE_LIMIT_OAUTH_CALLBACK
    await check_rate_limit(redis, "oauth_callback", _client_ip(request), limit, window)

    if error:
        return _callback_redirect(error="GOOGLE_DENIED")
    if not code or not state:
        raise bad_request("INVALID_OAUTH_REQUEST", "`code` va `state` majburiy.")

    # `state` bir martalik: GETDEL — qayta ishlatish (replay) mumkin emas.
    stored = await redis.getdel(OAUTH_STATE_KEY.format(state=state))
    if stored is None:
        raise bad_request("INVALID_OAUTH_STATE", "Kirish seansi eskirgan. Qaytadan urinib ko'ring.")

    try:
        tokens = await _exchange_code(code)
        raw_id_token = tokens.get("id_token")
        if not raw_id_token:
            raise ValueError("missing_id_token")
        claims = await _verify_id_token(str(raw_id_token))
    except (httpx.HTTPError, google_exceptions.GoogleAuthError, ValueError) as exc:
        # `TransportError` (JWKS olinmadi) `ValueError` EMAS — shuning uchun
        # `GoogleAuthError` ham tutiladi, aks holda 500 chiqadi.
        log.warning("Google OAuth muvaffaqiyatsiz: %s", exc)
        return _callback_redirect(error="GOOGLE_AUTH_FAILED")

    if not claims.get("email"):
        return _callback_redirect(error="EMAIL_MISSING")
    if claims.get("email_verified") is not True:
        return _callback_redirect(error="EMAIL_NOT_VERIFIED")

    user = await _upsert_google_user(db, claims)
    pair = await _issue_pair(db, user)
    await db.commit()

    return _callback_redirect(access=pair.access_token, refresh=pair.refresh_token)


# ---------------------------------------------------------------------------
# POST /auth/refresh
# ---------------------------------------------------------------------------


@router.post("/refresh", response_model=TokenPair, summary="Refresh token rotatsiyasi")
async def refresh_tokens(
    payload: RefreshIn,
    request: Request,
    db: DbSession,
    redis: RedisDep,
) -> TokenPair:
    limit, window = RATE_LIMIT_REFRESH
    await check_rate_limit(redis, "auth_refresh", _client_ip(request), limit, window)

    claims = decode_token(payload.refresh_token, expected_type=REFRESH_TOKEN_TYPE)
    await ensure_not_revoked(redis, claims)

    row = await db.scalar(select(RefreshToken).where(RefreshToken.jti == claims.jti))
    if row is None:
        raise unauthorized("TOKEN_REVOKED", "Token bekor qilingan. Qaytadan kiring.")
    if row.revoked_at is not None:
        # Revoke qilingan tokenning qayta ishlatilishi — o'g'irlik belgisi.
        # Himoya choralari: shu foydalanuvchining barcha faol refresh lari bekor qilinadi.
        await db.execute(
            update(RefreshToken)
            .where(RefreshToken.user_id == row.user_id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=_now())
        )
        await db.commit()
        log.warning("Revoke qilingan refresh qayta ishlatildi: user=%s", row.user_id)
        raise unauthorized("TOKEN_REVOKED", "Token bekor qilingan. Qaytadan kiring.")
    if row.expires_at <= _now():
        raise unauthorized("TOKEN_EXPIRED", "Token muddati tugagan.")

    user = await db.scalar(select(User).where(User.id == row.user_id))
    if user is None:
        raise unauthorized("USER_NOT_FOUND", "Foydalanuvchi topilmadi.")
    _assert_usable(user, claims.tv)

    await _revoke_row(redis, row)
    pair = await _issue_pair(db, user)
    await db.commit()
    return pair


# ---------------------------------------------------------------------------
# POST /auth/logout
# ---------------------------------------------------------------------------


@router.post("/logout", response_model=LogoutOut, summary="Refresh tokenni bekor qilish")
async def logout(
    payload: LogoutIn,
    db: DbSession,
    redis: RedisDep,
    user: OptionalUser = None,
    credentials: BearerCreds = None,
) -> LogoutOut:
    revoked = 0

    if payload.refresh_token:
        claims = decode_token(payload.refresh_token, expected_type=REFRESH_TOKEN_TYPE)
        row = await db.scalar(select(RefreshToken).where(RefreshToken.jti == claims.jti))
        if row is not None and row.revoked_at is None:
            if user is not None and row.user_id != user.id:
                raise forbidden("TOKEN_OWNER_MISMATCH", "Token boshqa foydalanuvchiga tegishli.")
            await _revoke_row(redis, row)
            revoked += 1

    if user is None and not payload.refresh_token:
        raise unauthorized()

    if user is not None:
        # Joriy access token ham darhol kuchini yo'qotsin (qolgan muddatiga blacklist).
        if credentials is not None and credentials.credentials:
            access_claims = decode_token(credentials.credentials, expected_type=ACCESS_TOKEN_TYPE)
            await revoke_token(redis, access_claims.jti, token_remaining_seconds(access_claims))
        if payload.all_devices:
            result = await db.execute(
                update(RefreshToken)
                .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
                .values(revoked_at=_now())
            )
            revoked += int(result.rowcount or 0)
            user.token_version += 1

    await db.commit()
    return LogoutOut(revoked=revoked)


# ---------------------------------------------------------------------------
# GET /auth/me
# ---------------------------------------------------------------------------


@router.get("/me", response_model=UserOut, summary="Joriy foydalanuvchi")
async def me(user: CurrentUser) -> UserOut:
    return UserOut.from_user(user)


# ---------------------------------------------------------------------------
# POST /auth/onboarding
# ---------------------------------------------------------------------------


async def _join_group(db: AsyncSession, user: User, group: Group) -> None:
    """A'zolikni idempotent qo'shadi (`ON CONFLICT DO NOTHING` — §2.2 uslubi)."""
    await db.execute(
        pg_insert(GroupMember)
        .values(group_id=group.id, student_id=user.id)
        .on_conflict_do_nothing(constraint="uq_group_members_group_id_student_id")
    )


@router.post("/onboarding", response_model=UserOut, summary="Profilni to'ldirish va guruhga qo'shilish")
async def onboarding(
    payload: OnboardingIn,
    db: DbSession,
    redis: RedisDep,
    user: CurrentUser,
) -> UserOut:
    """⚠️ So'rovdagi `role` maydoni O'QILMAYDI — `OnboardingIn` da bunday maydon yo'q."""
    rate_key = str(user.id)
    await check_lockout(redis, "onboarding", rate_key)
    limit, window = RATE_LIMIT_ONBOARDING
    await check_rate_limit(redis, "onboarding", rate_key, limit, window)

    user.full_name = payload.full_name
    user.is_onboarded = True

    group: Group | None = None
    if payload.group_id is not None:
        group = await db.scalar(
            select(Group).where(Group.id == payload.group_id, Group.is_active.is_(True))
        )
        if group is None:
            raise not_found("GROUP_NOT_FOUND", "Bunday guruh topilmadi.")
    elif payload.invite_code is not None:
        group = await db.scalar(
            select(Group).where(
                Group.invite_code == payload.invite_code, Group.is_active.is_(True)
            )
        )
        if group is None:
            # Brute-force himoyasi: 5 xatodan keyin 5 daqiqa qulf (AUDIT.md §C3).
            await register_failure(redis, "onboarding", rate_key)
            raise bad_request("INVALID_INVITE_CODE", "Taklif kodi topilmadi.")
        await clear_failures(redis, "onboarding", rate_key)

    # O'qituvchi/admin guruhga a'zo bo'lmaydi — u guruh EGASI (groups.teacher_id).
    if group is not None and user.role is UserRole.STUDENT:
        await _join_group(db, user, group)

    await db.commit()
    fresh = await _reload_user(db, user.id)
    return UserOut.from_user(fresh)
