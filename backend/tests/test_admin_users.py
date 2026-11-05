"""Adminka (`/users`) testlari — ro'yxat va rol berish.

Qoidalar (users.py):
  1. Faqat `ADMIN` kiradi — o'qituvchi/o'quvchi `403 ADMIN_REQUIRED`.
  2. Rol berilganda `token_version` oshadi — eski token darhol o'ladi.
  3. Admin O'Z rolini o'zgartira olmaydi (`400 CANNOT_CHANGE_OWN_ROLE`).

Ishga tushirish (lokal dev servislari):
    cd backend && .venv/bin/python -m pytest tests/test_admin_users.py -v
"""

from __future__ import annotations

import os
import uuid

os.environ.setdefault(
    "DATABASE_URL", "postgresql+asyncpg://syncclass:syncclass@localhost:55432/syncclass"
)
os.environ.setdefault("REDIS_URL", "redis://localhost:56379/15")
os.environ.setdefault("SECRET_KEY", "test-only-secret-key-for-admin-users")

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select

from app.api import users as users_api
from app.core.deps import create_redis
from app.core.security import create_access_token
from app.db.models import RefreshToken, User, UserRole
from app.db.session import AsyncSessionLocal, engine

API = "/api/v1"

pytestmark = pytest.mark.asyncio


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(users_api.router, prefix=f"{API}/users", tags=["users"])
    return app


@pytest_asyncio.fixture
async def client():
    redis = create_redis()
    app = _build_app()
    app.state.redis = redis
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http
    await redis.aclose()


async def _make_user(role: UserRole) -> User:
    suffix = uuid.uuid4().hex[:12]
    user = User(
        google_id=f"adminka-{suffix}",
        email=f"adminka-{suffix}@syncclass.test",
        full_name=f"Adminka Test {role.value}",
        role=role,
        is_onboarded=True,
    )
    async with AsyncSessionLocal() as session:
        session.add(user)
        await session.commit()
        await session.refresh(user)
    return user


async def _drop_users(*user_ids: uuid.UUID) -> None:
    async with AsyncSessionLocal() as session:
        await session.execute(delete(RefreshToken).where(RefreshToken.user_id.in_(user_ids)))
        await session.execute(delete(User).where(User.id.in_(user_ids)))
        await session.commit()
    await engine.dispose()


@pytest_asyncio.fixture
async def admin():
    user = await _make_user(UserRole.ADMIN)
    yield user
    await _drop_users(user.id)


@pytest_asyncio.fixture
async def student():
    user = await _make_user(UserRole.STUDENT)
    yield user
    await _drop_users(user.id)


def _auth(user: User, *, token_version: int | None = None) -> dict[str, str]:
    token = create_access_token(
        user_id=user.id,
        role=user.role.value,
        token_version=user.token_version if token_version is None else token_version,
    )
    return {"Authorization": f"Bearer {token}"}


async def test_non_admin_is_forbidden(client, student):
    r = await client.get(f"{API}/users", headers=_auth(student))
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "ADMIN_REQUIRED"

    r = await client.patch(
        f"{API}/users/{student.id}/role", headers=_auth(student), json={"role": "TEACHER"}
    )
    assert r.status_code == 403


async def test_admin_lists_and_searches(client, admin, student):
    r = await client.get(f"{API}/users", headers=_auth(admin))
    assert r.status_code == 200, r.text
    emails = {u["email"] for u in r.json()}
    assert student.email in emails

    # Qidiruv — email bo'yicha, boshqa foydalanuvchilar chiqmaydi.
    r = await client.get(f"{API}/users", headers=_auth(admin), params={"query": student.email})
    assert r.status_code == 200
    assert [u["email"] for u in r.json()] == [student.email]


async def test_set_role_bumps_token_version(client, admin, student):
    old_headers = _auth(student)

    r = await client.patch(
        f"{API}/users/{student.id}/role", headers=_auth(admin), json={"role": "TEACHER"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["role"] == "TEACHER"

    async with AsyncSessionLocal() as session:
        fresh = (
            await session.execute(select(User).where(User.id == student.id))
        ).scalar_one()
    assert fresh.role is UserRole.TEACHER
    assert fresh.token_version == student.token_version + 1

    # Eski token endi o'lik — hatto oddiy ro'yxat so'roviga ham yaramaydi.
    r = await client.get(f"{API}/users", headers=old_headers)
    assert r.status_code == 401

    # Idempotent: xuddi shu rol qayta berilsa versiya OSHMAYDI.
    r = await client.patch(
        f"{API}/users/{student.id}/role", headers=_auth(admin), json={"role": "TEACHER"}
    )
    assert r.status_code == 200
    async with AsyncSessionLocal() as session:
        again = (
            await session.execute(select(User).where(User.id == student.id))
        ).scalar_one()
    assert again.token_version == fresh.token_version


async def test_admin_cannot_change_own_role(client, admin):
    r = await client.patch(
        f"{API}/users/{admin.id}/role", headers=_auth(admin), json={"role": "STUDENT"}
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "CANNOT_CHANGE_OWN_ROLE"


async def test_unknown_user_404(client, admin):
    r = await client.patch(
        f"{API}/users/{uuid.uuid4()}/role", headers=_auth(admin), json={"role": "TEACHER"}
    )
    assert r.status_code == 404
