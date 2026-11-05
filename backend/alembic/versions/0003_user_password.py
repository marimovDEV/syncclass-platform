"""users: password_plain — email+parol bilan kirish (Google'siz).

Mahsulot qarori (markaz egasining talabi): o'quvchilar parolni tez-tez
unutadi, shuning uchun parol ochiq saqlanadi va adminkada ADMIN'ga
ko'rinadi. Login/ro'yxatdan o'tish formasi foydalanuvchini Gmail parolini
EMAS, shu sayt uchun alohida parol yozishga undaydi (xavfni kamaytirish).

`NULL` — parol qo'yilmagan (faqat Google orqali kiradi).

Revision ID: 0003_user_password
Revises: 0002_ai_strengths_issues
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0003_user_password"
down_revision: str | None = "0002_ai_strengths_issues"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("password_plain", sa.String(128), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "password_plain")
