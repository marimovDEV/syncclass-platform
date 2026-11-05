"""Declarative baza, naming convention va mixinlar.

`naming_convention` Alembic `autogenerate` uchun SHART: aks holda
PostgreSQL constraint/index nomlarini o'zi o'ylab topadi va har
migratsiyada boshqacha nom chiqadi (diff "shovqin" qiladi).

Nom shablonlari (CONTRACTS.md §2 bo'yicha):
  pk_<jadval>                          — primary key
  uq_<jadval>_<ustunlar>               — unique constraint
  ix_<jadval>_<ustunlar>               — oddiy index
  fk_<jadval>_<ustun>_<havola_jadval>  — foreign key
  ck_<jadval>_<nom>                    — check constraint

QO'LDA nomlangan indekslar (`uq_active_pin`, `uq_latest_sub`) konventsiyaga
tushmaydi — ular kontraktda aynan shu nom bilan yozilgan.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, MetaData, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

NAMING_CONVENTION: dict[str, str] = {
    "pk": "pk_%(table_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
}

metadata = MetaData(naming_convention=NAMING_CONVENTION)


class Base(DeclarativeBase):
    """Barcha ORM modellarining umumiy bazasi."""

    metadata = metadata

    def __repr__(self) -> str:  # pragma: no cover - faqat debug uchun
        pk = getattr(self, "id", None)
        return f"<{type(self).__name__} id={pk!r}>"


class CreatedAtMixin:
    """Faqat `created_at` (immutable jadvallar: log, javob, token)."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class TimestampMixin(CreatedAtMixin):
    """`created_at` + `updated_at` (AUDIT.md §D8).

    `onupdate=func.now()` — ORM `UPDATE` da DB vaqtini yozadi.
    `server_default` migratsiyada ham mavjud, shuning uchun xom SQL
    (masalan seed) ham to'g'ri ishlaydi.
    """

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


__all__ = ["NAMING_CONVENTION", "Base", "CreatedAtMixin", "TimestampMixin", "metadata"]
