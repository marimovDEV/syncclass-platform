"""Async engine, sessionmaker va FastAPI dependency.

KONTRAKT: `engine`, `AsyncSessionLocal`, `get_db` nomlari o'zgarmaydi —
`app/main.py` va barcha API modullari aynan shularga tayanadi.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings

engine = create_async_engine(
    settings.sqlalchemy_url,
    echo=False,
    future=True,
    # Uzilib qolgan TCP ulanishni so'rovdan oldin tekshiradi (Postgres restart / NAT timeout).
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
    pool_recycle=1800,
    # JSONB/UUID uchun asyncpg statement cache + pgbouncer muammosi bo'lmasin.
    connect_args={"timeout": 10},
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    # Commitdan keyin obyektlar expire bo'lmasin: response serializatsiyasi
    # paytida qo'shimcha lazy-load (va MissingGreenlet) bo'lmaydi.
    expire_on_commit=False,
    autoflush=False,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency: `db: AsyncSession = Depends(get_db)`.

    Sessiya har so'rov uchun yangi. Xato bo'lsa rollback, har holatda yopiladi.
    Commit — endpoint o'z zimmasida (bir so'rovda bir nechta tranzaksiya bo'lishi mumkin).
    """
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


__all__ = ["AsyncSessionLocal", "engine", "get_db"]
