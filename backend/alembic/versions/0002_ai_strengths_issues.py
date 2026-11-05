"""submissions: ai_strengths / ai_issues (JSONB) — CONTRACTS.md §12.1

Nega kerak: §7 `AiVerdict` da `strengths` va `issues` bor, lekin `0001_initial`
dagi `submissions` ularni saqlamagan. Natijada AI xulosasining FAQAT tanqidiy
qismi saqlanib, o'quvchining kuchli tomonlari UI ga yetib bormasdi — bu
AUDIT §E2 (adolatli, qurilish xarakteridagi baholash) tamoyiliga qarshi.

Mazmuni: `list[str]` (o'zbekcha qisqa gaplar). `recommended_penalty` ATAYLAB
ustun sifatida saqlanmaydi — u `homeworks.ai_penalty_points` dan olinadi,
tavsiya DB da qotib qolmasin (§12.1).

Mavjud qatorlar uchun xavfsiz: `server_default '[]'::jsonb` + `NOT NULL`,
ya'ni jadval bo'sh bo'lmasa ham `ALTER TABLE` muvaffaqiyatli o'tadi.
PG 11+ da bu `DEFAULT` bilan `ADD COLUMN` — jadvalni qayta yozmaydi (tez,
`ACCESS EXCLUSIVE` lock faqat metama'lumot uchun).

Revision ID: 0002_ai_strengths_issues
Revises: 0001_initial
"""

from __future__ import annotations

from typing import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002_ai_strengths_issues"
down_revision: str | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_EMPTY_JSONB = sa.text("'[]'::jsonb")


def upgrade() -> None:
    op.add_column(
        "submissions",
        sa.Column(
            "ai_strengths",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=_EMPTY_JSONB,
        ),
    )
    op.add_column(
        "submissions",
        sa.Column(
            "ai_issues",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=_EMPTY_JSONB,
        ),
    )


def downgrade() -> None:
    op.drop_column("submissions", "ai_issues")
    op.drop_column("submissions", "ai_strengths")
