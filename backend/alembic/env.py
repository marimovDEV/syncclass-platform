"""Alembic muhiti — async (asyncpg) rejimda.

URL `app.core.config.settings.sqlalchemy_url` dan olinadi, `alembic.ini` dan EMAS.
Shu sabab konteyner entrypoint da `alembic upgrade head` qo'shimcha env talab qilmaydi.
"""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context

# `app.db.models` import qilinishi SHART: shundan keyingina barcha jadvallar
# `Base.metadata` ga ro'yxatdan o'tadi (autogenerate bo'sh diff bermasin).
from app.core.config import settings
from app.db import models as _models  # noqa: F401
from app.db.base import Base

config = context.config
config.set_main_option("sqlalchemy.url", settings.sqlalchemy_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _include_object(obj, name, type_, reflected, compare_to) -> bool:
    """Alembic o'z `alembic_version` jadvalini diff ga qo'shmasin."""
    return not (type_ == "table" and name == "alembic_version")


def _configure(connection: Connection | None = None, url: str | None = None) -> None:
    context.configure(
        connection=connection,
        url=url,
        target_metadata=target_metadata,
        # Tip o'zgarishini ham sezsin (VARCHAR(50) -> VARCHAR(100) kabi).
        compare_type=True,
        compare_server_default=True,
        include_object=_include_object,
        # Postgres uchun batch rejim KERAK EMAS (u faqat SQLite cheklovi).
        render_as_batch=False,
        include_schemas=False,
        dialect_opts={"paramstyle": "named"},
    )


def run_migrations_offline() -> None:
    """`alembic upgrade head --sql` — DB ga ulanmasdan SQL chiqaradi."""
    _configure(url=config.get_main_option("sqlalchemy.url"), connection=None)
    with context.begin_transaction():
        context.run_migrations()


def _do_run_migrations(connection: Connection) -> None:
    _configure(connection=connection)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    """Haqiqiy asyncpg ulanishi bilan migratsiya."""
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        future=True,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(_do_run_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
