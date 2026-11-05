"""Barcha test modullari uchun umumiy muhit darvozasi.

Bu fayl bitta maqsadga xizmat qiladi: **test to'plami hech qachon jonli
ma'lumotni o'chirib yubormasin**.

### Nega bu kerak
Test to'plamida `flushdb` ishlatiladi (masalan `test_auth_guards.py` dagi
`redis_client` fixture i) — u **butun Redis DB sini** tozalaydi, faqat o'z
kalitlarini emas. Redis esa bu loyihada xona holatining **yagona haqiqat
manbasi** (AUDIT.md §B2): `room:{session_id}:state` Hash ida slayd indeksi,
jonli kod, `code_rev`, faol quiz va `seq` yashaydi.

Natijada `.env` dagi `REDIS_URL=redis://redis:6379/0` bilan testni yugurtirish
= dars ketayotgan vaqtda **barcha jonli xonalarni o'chirish**. Shuning uchun
0-DB da ishga tushish butunlay rad etiladi.

### Ishga tushirish
    DATABASE_URL=postgresql+asyncpg://syncclass:syncclass@localhost:55432/syncclass \\
    REDIS_URL=redis://localhost:56379/15 \\
    .venv/bin/python -m pytest tests -q
"""

from __future__ import annotations

import asyncio
from urllib.parse import urlparse

import pytest
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import settings

#: Ilova va worker shu DB ni ishlatadi — testlarga TAQIQLANGAN.
PROTECTED_REDIS_DB = 0

#: Xato xabarlarida tavsiya qilinadigan test DB si.
SUGGESTED_TEST_DB = 15


def redis_db_index(url: str) -> int:
    """`redis://host:port/15` → `15`.

    Indeks umuman ko'rsatilmasa (`redis://host:port`) Redis uni **0** deb
    qabul qiladi, shuning uchun bu holat ham `0` qaytaradi — ya'ni himoyadan
    "indeksni yozmasdan" o'tib ketish imkoni yo'q.
    """
    raw = (urlparse(url).path or "").lstrip("/").split("/")[0]
    if not raw:
        return PROTECTED_REDIS_DB
    try:
        return int(raw)
    except ValueError:
        return PROTECTED_REDIS_DB


def _suggested_url(url: str) -> str:
    parsed = urlparse(url)
    netloc = parsed.netloc or "localhost:56379"
    return f"{parsed.scheme or 'redis'}://{netloc}/{SUGGESTED_TEST_DB}"


async def _check_infra(url: str) -> None:
    """Postgres va Redis haqiqatan javob berayotganini tekshiradi."""
    engine = create_async_engine(settings.sqlalchemy_url)
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    finally:
        await engine.dispose()

    client = Redis.from_url(url, decode_responses=True)
    try:
        await client.ping()
        # Testga ajratilgan DB — sessiya boshida BIR MARTA tozalanadi.
        # Modullardagi `flushdb` chaqiruvlari shundan keyin ziyonsiz takror
        # bo'lib qoladi, chunki bu allaqachon test DB si.
        await client.flushdb()
    finally:
        await client.aclose()


def pytest_sessionstart(session: pytest.Session) -> None:
    """Darvoza: hamma narsadan OLDIN, yig'ishdan ham oldin ishlaydi."""
    url = settings.REDIS_URL
    db_index = redis_db_index(url)

    if db_index == PROTECTED_REDIS_DB:
        pytest.exit(
            "\n"
            "=====================================================================\n"
            " TESTLAR 0-RAQAMLI REDIS DB DA ISHGA TUSHIRILMAYDI\n"
            "=====================================================================\n"
            "\n"
            "NEGA: test to'plami `flushdb` qiladi — u BUTUN DB ni tozalaydi,\n"
            "faqat o'z kalitlarini emas. 0-DB ni esa ilova va worker ishlatadi.\n"
            "Redis bu loyihada xona holatining YAGONA haqiqat manbasi\n"
            "(AUDIT.md §B2): slayd indeksi, jonli kod, `code_rev`, faol quiz va\n"
            "`seq` shu yerda. Ya'ni dars ketayotganda testni yugurtirish\n"
            "BARCHA jonli xonalarni o'chiradi.\n"
            "\n"
            f"HOZIRGI QIYMAT: REDIS_URL={url}   (DB indeksi: {db_index})\n"
            "Eslatma: indeks yozilmagan URL ham 0 ni bildiradi.\n"
            "\n"
            "YECHIM — testga ajratilgan DB ni ko'rsating:\n"
            f"    REDIS_URL={_suggested_url(url)}\n"
            "=====================================================================\n",
            returncode=3,
        )

    try:
        asyncio.run(_check_infra(url))
    except Exception as exc:
        pytest.exit(
            "\n"
            "Postgres yoki Redis ga ulanib bo'lmadi — testlar haqiqiy\n"
            "infratuzilma talab qiladi (mock yo'q).\n"
            "\n"
            "Kerakli muhit:\n"
            "    DATABASE_URL=postgresql+asyncpg://syncclass:syncclass"
            "@localhost:55432/syncclass\n"
            f"    REDIS_URL={_suggested_url(url)}\n"
            "\n"
            "Redis ni ko'tarish:\n"
            "    docker run -d --name sc-redis -p 56379:6379 redis:7-alpine\n"
            "\n"
            f"Xato: {type(exc).__name__}: {exc}\n",
            returncode=3,
        )
