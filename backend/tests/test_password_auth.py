"""Email + parol oqimi testlari — /auth/register, /auth/password-login,
PUT /users/{id}/password.

Qoidalar:
  1. Ro'yxatdan o'tgan yangi hisob HAR DOIM `STUDENT` (AUDIT §C1).
  2. Band email bilan ro'yxatdan o'tib bo'lmaydi (`EMAIL_TAKEN`).
  3. Noto'g'ri parol / yo'q hisob — bitta umumiy `INVALID_CREDENTIALS`.
  4. Admin parol o'rnatadi (`password_plain`), u ro'yxatda ko'rinadi va
     o'sha parol bilan kirish mumkin.

Ishga tushirish (lokal dev servislari):
    cd backend && .venv/bin/python -m pytest tests/test_password_auth.py -v
"""

from __future__ import annotations

import os
import uuid

os.environ.setdefault(
    "DATABASE_URL", "postgresql+asyncpg://syncclass:syncclass@localhost:55432/syncclass"
)
os.environ.setdefault("REDIS_URL", "redis://localhost:56379/15")
os.environ.setdefault("SECRET_KEY", "test-only-secret-key-for-password-auth")

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select

from app.api import auth as auth_api
from app.api import users as users_api
from app.core.deps import create_redis
from app.core.security import create_access_token
from app.db.models import RefreshToken, User, UserRole
from app.db.session import AsyncSessionLocal, engine

API = "/api/v1"

pytestmark = pytest.mark.asyncio


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(auth_api.router, prefix=f"{API}/auth", tags=["auth"])
    app.include_router(users_api.router, prefix=f"{API}/users", tags=["users"])
    return app


@pytest_asyncio.fixture
async def client():
    redis = create_redis()
    # Rate-limit/lockout kalitlari testlar orasida qolmasin.
    await redis.flushdb()
    app = _build_app()
    app.state.redis = redis
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http
    await redis.flushdb()
    await redis.aclose()


async def _drop_by_email(*emails: str) -> None:
    async with AsyncSessionLocal() as session:
        ids = (
            (await session.execute(select(User.id).where(User.email.in_(emails))))
            .scalars()
            .all()
        )
        if ids:
            await session.execute(delete(RefreshToken).where(RefreshToken.user_id.in_(ids)))
            await session.execute(delete(User).where(User.id.in_(ids)))
            await session.commit()
    await engine.dispose()


def _email() -> str:
    return f"pwd-{uuid.uuid4().hex[:10]}@syncclass.test"


async def test_register_then_login(client):
    email = _email()
    try:
        r = await client.post(
            f"{API}/auth/register",
            json={"email": email, "password": "olma-2024", "full_name": "Pwd Test"},
        )
        assert r.status_code == 201, r.text
        assert r.json()["access_token"]

        # Yangi hisob — STUDENT va parol saqlangan.
        async with AsyncSessionLocal() as session:
            user = await session.scalar(select(User).where(User.email == email))
            assert user is not None
            assert user.role is UserRole.STUDENT
            assert user.password_plain == "olma-2024"

        r = await client.post(
            f"{API}/auth/password-login", json={"email": email, "password": "olma-2024"}
        )
        assert r.status_code == 200, r.text

        # Email katta harflarda yozilsa ham kiradi.
        r = await client.post(
            f"{API}/auth/password-login",
            json={"email": email.upper(), "password": "olma-2024"},
        )
        assert r.status_code == 200
    finally:
        await _drop_by_email(email)


async def test_register_duplicate_email(client):
    email = _email()
    body = {"email": email, "password": "parol-1", "full_name": "Birinchi"}
    try:
        assert (await client.post(f"{API}/auth/register", json=body)).status_code == 201
        r = await client.post(f"{API}/auth/register", json=body)
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "EMAIL_TAKEN"
    finally:
        await _drop_by_email(email)


async def test_wrong_password_and_missing_user(client):
    email = _email()
    try:
        await client.post(
            f"{API}/auth/register",
            json={"email": email, "password": "togri-parol", "full_name": "Pwd Test"},
        )
        r = await client.post(
            f"{API}/auth/password-login", json={"email": email, "password": "notogri"}
        )
        assert r.status_code == 401
        assert r.json()["detail"]["code"] == "INVALID_CREDENTIALS"

        # Yo'q hisob ham AYNAN shu javobni oladi (enumeration yo'q).
        r = await client.post(
            f"{API}/auth/password-login",
            json={"email": "yoq-hisob@syncclass.test", "password": "x"},
        )
        assert r.status_code == 401
        assert r.json()["detail"]["code"] == "INVALID_CREDENTIALS"
    finally:
        await _drop_by_email(email)


async def test_admin_sets_password_and_sees_it(client):
    email = _email()
    admin_email = _email()
    try:
        await client.post(
            f"{API}/auth/register",
            json={"email": email, "password": "eski-parol", "full_name": "Unutuvchi"},
        )
        async with AsyncSessionLocal() as session:
            student = await session.scalar(select(User).where(User.email == email))
            admin = User(
                google_id=f"pwdadm-{uuid.uuid4().hex[:8]}",
                email=admin_email,
                full_name="Pwd Admin",
                role=UserRole.ADMIN,
                is_onboarded=True,
            )
            session.add(admin)
            await session.commit()
            await session.refresh(admin)
            student_id, admin_headers = student.id, {
                "Authorization": "Bearer "
                + create_access_token(
                    user_id=admin.id, role="ADMIN", token_version=admin.token_version
                )
            }

        r = await client.put(
            f"{API}/users/{student_id}/password",
            headers=admin_headers,
            json={"password": "yangi-parol"},
        )
        assert r.status_code == 200, r.text
        assert r.json()["password_plain"] == "yangi-parol"

        # Ro'yxatda ham ko'rinadi.
        r = await client.get(f"{API}/users", headers=admin_headers, params={"query": email})
        assert r.status_code == 200
        assert r.json()[0]["password_plain"] == "yangi-parol"

        # Eski parol ishlamaydi, yangisi ishlaydi.
        r = await client.post(
            f"{API}/auth/password-login", json={"email": email, "password": "eski-parol"}
        )
        assert r.status_code == 401
        r = await client.post(
            f"{API}/auth/password-login", json={"email": email, "password": "yangi-parol"}
        )
        assert r.status_code == 200
    finally:
        await _drop_by_email(email, admin_email)


async def test_lockout_after_failures(client):
    email = _email()
    try:
        await client.post(
            f"{API}/auth/register",
            json={"email": email, "password": "parol-ok", "full_name": "Lockout Test"},
        )
        for _ in range(5):
            r = await client.post(
                f"{API}/auth/password-login", json={"email": email, "password": "xato"}
            )
            assert r.status_code == 401
        # 5 xatodan keyin — qulf: endi TO'G'RI parol ham 429 oladi.
        r = await client.post(
            f"{API}/auth/password-login", json={"email": email, "password": "parol-ok"}
        )
        assert r.status_code == 429
    finally:
        await _drop_by_email(email)
