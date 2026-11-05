"""Auth/avtorizatsiya guard testlari (AUDIT.md §C, DoD §I5).

4 ta xavfsizlik tekshiruvi:
  1. `test_onboarding_ignores_role_escalation` — onboardingda `role: "TEACHER"`
     yuborilsa rol O'ZGARMAYDI (privilege escalation yopilgan).
  2. `test_revoked_refresh_token_is_rejected` — logout dan keyin refresh ishlamaydi.
  3. `test_rate_limit_returns_429_on_eleventh_attempt` — 10/daqiqa chegarasi,
     11-urinish `429 RATE_LIMITED`.
  4. `test_token_version_bump_invalidates_access_token` — `token_version` oshgach
     eski access token rad etiladi.

Ishga tushirish (lokal dev konteynerlari):
    cd backend && .venv/bin/python -m pytest tests/test_auth_guards.py -v

Postgres `sc-pg` → localhost:55432, Redis `sc-redis` → localhost:56379.
Boshqa manzil kerak bo'lsa `DATABASE_URL` / `REDIS_URL` ni eksport qiling —
`setdefault` tashqi qiymatni ustun qo'yadi. Ilova kodi `os.environ` ga
HECH QACHON tegmaydi (faqat `app.core.config.settings`); bu yerdagi
`setdefault` — testni ishga tushirish uchun bootstrap, ilova mantig'i emas.
"""

from __future__ import annotations

import os
import uuid

os.environ.setdefault(
    "DATABASE_URL", "postgresql+asyncpg://syncclass:syncclass@localhost:55432/syncclass"
)
# 15-chi DB ataylab: ishlab turgan dev ma'lumotlariga tegmaydi.
os.environ.setdefault("REDIS_URL", "redis://localhost:56379/15")
os.environ.setdefault("SECRET_KEY", "test-only-secret-key-for-auth-guards")
os.environ.setdefault("TEACHER_EMAIL_ALLOWLIST", "")

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select, update

from app.api import auth as auth_api
from app.api import groups as groups_api
from app.core.deps import create_redis
from app.core.security import (
    RATE_LIMIT_ONBOARDING,
    create_access_token,
    create_refresh_token,
)
from app.db.models import GroupMember, RefreshToken, User, UserRole
from app.db.session import AsyncSessionLocal, engine

API = "/api/v1"


def _build_app() -> FastAPI:
    """`main.py` ning auth qismi: faqat auth + groups router lari.

    `main.py` ni import qilmaymiz — u boshqa agentlarning hali yozilmagan
    modullarini (`rooms`, `homeworks`, `ws`) talab qiladi.
    """
    app = FastAPI()
    app.include_router(auth_api.router, prefix=f"{API}/auth", tags=["auth"])
    app.include_router(groups_api.router, prefix=f"{API}/groups", tags=["groups"])
    return app


@pytest_asyncio.fixture
async def redis_client():
    client = create_redis()
    await client.flushdb()
    try:
        yield client
    finally:
        await client.flushdb()
        await client.aclose()


@pytest_asyncio.fixture
async def client(redis_client):
    app = _build_app()
    app.state.redis = redis_client
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


@pytest_asyncio.fixture
async def student():
    """Har test uchun yangi o'quvchi; test oxirida o'chiriladi (CASCADE)."""
    suffix = uuid.uuid4().hex[:12]
    user = User(
        google_id=f"test-{suffix}",
        email=f"guard-{suffix}@syncclass.test",
        full_name="Test O'quvchi",
        role=UserRole.STUDENT,
        is_onboarded=False,
    )
    async with AsyncSessionLocal() as session:
        session.add(user)
        await session.commit()
        user_id = user.id

    try:
        yield user
    finally:
        async with AsyncSessionLocal() as session:
            await session.execute(delete(GroupMember).where(GroupMember.student_id == user_id))
            await session.execute(delete(RefreshToken).where(RefreshToken.user_id == user_id))
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
        # Engine pool i keyingi test uchun yangi event loop da qayta ochilsin.
        await engine.dispose()


def _access_for(user: User, *, token_version: int | None = None, role: str | None = None) -> str:
    return create_access_token(
        user_id=user.id,
        role=role or user.role.value,
        token_version=user.token_version if token_version is None else token_version,
    )


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# 1. Rol eskalatsiyasi
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_onboarding_ignores_role_escalation(client: AsyncClient, student: User) -> None:
    """DoD §I5: onboardingda `role: "TEACHER"` yuborilsa — e'tiborga olinmaydi."""
    response = await client.post(
        f"{API}/auth/onboarding",
        json={
            "full_name": "Eskalatsiya Urinishi",
            "role": "TEACHER",
            "is_onboarded": True,
            "xp_points": 999999,
            "token_version": 42,
        },
        headers=_auth(_access_for(student)),
    )

    assert response.status_code == 200, response.text
    body = response.json()
    # So'rov rad etilmaydi (422 emas), lekin rol o'zgarmaydi.
    assert body["role"] == "STUDENT"
    assert body["full_name"] == "Eskalatsiya Urinishi"
    assert body["xp_points"] == 0

    async with AsyncSessionLocal() as session:
        fresh = await session.scalar(select(User).where(User.id == student.id))
        assert fresh is not None
        assert fresh.role is UserRole.STUDENT
        assert fresh.token_version == 0
        assert fresh.xp_points == 0

    # Schemada `role` maydoni umuman yo'q — ikkinchi qatlam himoya.
    assert "role" not in auth_api.OnboardingIn.model_fields


# ---------------------------------------------------------------------------
# 2. Revoke qilingan refresh token
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_revoked_refresh_token_is_rejected(client: AsyncClient, student: User) -> None:
    """Logout → refresh `401 TOKEN_REVOKED`. Ishlaydigan refresh esa yangi juftlik beradi."""
    issued = create_refresh_token(user_id=student.id, token_version=student.token_version)
    async with AsyncSessionLocal() as session:
        session.add(
            RefreshToken(jti=issued.jti, user_id=student.id, expires_at=issued.expires_at)
        )
        await session.commit()

    # Avval token ishlashini isbotlaymiz (rotatsiya yangi juftlik qaytaradi).
    ok = await client.post(f"{API}/auth/refresh", json={"refresh_token": issued.token})
    assert ok.status_code == 200, ok.text
    rotated = ok.json()["refresh_token"]
    assert ok.json()["token_type"] == "bearer"

    # Rotatsiyadan keyin ESKI token ishlamaydi (reuse detection).
    reused = await client.post(f"{API}/auth/refresh", json={"refresh_token": issued.token})
    assert reused.status_code == 401
    assert reused.json()["detail"]["code"] == "TOKEN_REVOKED"

    # Logout yangi tokenni ham bekor qiladi.
    logout = await client.post(
        f"{API}/auth/logout",
        json={"refresh_token": rotated},
        headers=_auth(_access_for(student)),
    )
    assert logout.status_code == 200, logout.text
    assert logout.json()["revoked"] == 1

    after_logout = await client.post(f"{API}/auth/refresh", json={"refresh_token": rotated})
    assert after_logout.status_code == 401
    assert after_logout.json()["detail"]["code"] == "TOKEN_REVOKED"

    # Muddati o'tgan token ham o'tmaydi.
    expired = create_refresh_token(user_id=student.id, token_version=0, expires_days=-1)
    response = await client.post(f"{API}/auth/refresh", json={"refresh_token": expired.token})
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "TOKEN_EXPIRED"


# ---------------------------------------------------------------------------
# 3. Rate limit → 429
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rate_limit_returns_429_on_eleventh_attempt(
    client: AsyncClient, student: User
) -> None:
    """AUDIT.md §C3: onboarding/join — 10/daqiqa; 11-urinish `429 RATE_LIMITED`."""
    limit, _window = RATE_LIMIT_ONBOARDING
    assert limit == 10

    headers = _auth(_access_for(student))
    for attempt in range(limit):
        response = await client.post(
            f"{API}/auth/onboarding",
            json={"full_name": f"Urinish {attempt}"},
            headers=headers,
        )
        assert response.status_code == 200, f"{attempt}: {response.text}"

    blocked = await client.post(
        f"{API}/auth/onboarding",
        json={"full_name": "11-urinish"},
        headers=headers,
    )
    assert blocked.status_code == 429, blocked.text
    assert blocked.json()["detail"]["code"] == "RATE_LIMITED"


# ---------------------------------------------------------------------------
# 4. token_version
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_token_version_bump_invalidates_access_token(
    client: AsyncClient, student: User
) -> None:
    """AUDIT.md §C4: `token_version` oshgach eski access token kuchini yo'qotadi."""
    old_access = _access_for(student, token_version=0)

    before = await client.get(f"{API}/auth/me", headers=_auth(old_access))
    assert before.status_code == 200, before.text
    assert before.json()["email"] == student.email

    async with AsyncSessionLocal() as session:
        await session.execute(
            update(User).where(User.id == student.id).values(token_version=1)
        )
        await session.commit()

    after = await client.get(f"{API}/auth/me", headers=_auth(old_access))
    assert after.status_code == 401, after.text
    assert after.json()["detail"]["code"] == "TOKEN_VERSION_MISMATCH"

    # Yangi `tv` bilan berilgan token ishlaydi.
    new_access = _access_for(student, token_version=1)
    renewed = await client.get(f"{API}/auth/me", headers=_auth(new_access))
    assert renewed.status_code == 200, renewed.text

    # Buzilgan imzo (boshqa kalit / `alg` almashtirish) ham o'tmaydi.
    tampered = new_access[:-4] + ("abcd" if not new_access.endswith("abcd") else "efgh")
    bad = await client.get(f"{API}/auth/me", headers=_auth(tampered))
    assert bad.status_code == 401
    assert bad.json()["detail"]["code"] in {"INVALID_TOKEN", "TOKEN_EXPIRED"}


# ---------------------------------------------------------------------------
# Qo'shimcha: refresh tokenni access sifatida ishlatish mumkin emas
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_refresh_token_cannot_be_used_as_access(
    client: AsyncClient, student: User
) -> None:
    issued = create_refresh_token(user_id=student.id, token_version=student.token_version)
    response = await client.get(f"{API}/auth/me", headers=_auth(issued.token))
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "INVALID_TOKEN_TYPE"


@pytest.mark.asyncio
async def test_student_cannot_create_group(client: AsyncClient, student: User) -> None:
    """`require_teacher` guard i: o'quvchi guruh ocha olmaydi (AUDIT.md §C1)."""
    response = await client.post(
        f"{API}/groups",
        json={"name": f"T-{uuid.uuid4().hex[:6]}", "course_title": "Test kursi"},
        headers=_auth(_access_for(student)),
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "TEACHER_REQUIRED"


@pytest.mark.asyncio
async def test_expired_access_token_is_rejected(client: AsyncClient, student: User) -> None:
    expired = create_access_token(
        user_id=student.id, role=student.role.value, token_version=0, expires_minutes=-1
    )
    response = await client.get(f"{API}/auth/me", headers=_auth(expired))
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "TOKEN_EXPIRED"
