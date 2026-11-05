"""Quiz mantiqi va XP hisoblash — CONTRACTS.md §6, §2.2, AUDIT.md §D2.

Bu modul `app/ws/*` (realtime-engineer) tomonidan import qilinadi, shuning uchun
quyidagi eksportlar **BARQAROR** deb e'lon qilinadi:

    compute_xp(points, is_correct, answer_ms, duration_sec) -> int
    make_quiz_id(session_id, slide_index) -> str
    parse_quiz_id(quiz_id) -> tuple[UUID, int]
    load_quiz_slide(slides_data, slide_index) -> QuizSlide | None
    await record_answer(db, *, session_id, slide_index, student_id, slide,
                        selected_index, answer_ms) -> AnswerOutcome
    await count_answers(db, *, session_id, slide_index) -> int
    await build_results(db, *, session_id, slide_index, slide,
                        leaderboard_limit=10) -> QuizResults

TRANZAKSIYA QOIDASI (CONTRACTS.md §2.3): bu modul **commit qilmaydi**.
`record_answer()` dan keyin chaqiruvchi `await db.commit()` ni O'ZI bajaradi —
aks holda XP yozilmaydi. `ON CONFLICT DO NOTHING` ishlatilgani uchun
`IntegrityError` ko'tarilmaydi, demak `rollback` ham kerak bo'lmaydi.
"""

from __future__ import annotations

import uuid
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Attendance, QuizAnswer, User
from app.schemas.slide import QuizSlide, validate_slides_data

#: `quiz_answers` dagi UNIQUE constraint nomi (db-architect bergan nom).
QUIZ_ANSWER_UNIQUE = "uq_quiz_answers_session_id_slide_index_student_id"

#: WS `QUIZ_RESULTS` freymini kichik ushlab turish uchun standart cheklov.
DEFAULT_LEADERBOARD_LIMIT = 10

#: `quiz_id` ajratuvchisi: `"{session_id}:{slide_index}"`.
_QUIZ_ID_SEP = ":"


# ---------------------------------------------------------------------------
# Natija tiplari (WS `data` ga to'g'ridan-to'g'ri `model_dump()` bilan tushadi)
# ---------------------------------------------------------------------------


class AnswerOutcome(BaseModel):
    """`record_answer()` natijasi.

    `accepted=False` — bu o'quvchi bu slaydga ALLAQACHON javob bergan
    (`quiz_answers` UNIQUE). Bunda qaytarilgan qiymatlar **bazadagi birinchi**
    javobga tegishli va XP qayta berilmaydi.
    """

    accepted: bool
    is_correct: bool
    xp_awarded: int
    selected_index: int
    answer_ms: int
    correct_option: int


class LeaderboardEntry(BaseModel):
    """WS `QUIZ_RESULTS.leaderboard` elementi (nomlar kontraktdan)."""

    student_id: uuid.UUID
    full_name: str
    xp: int
    answer_ms: int


class QuizResults(BaseModel):
    """WS `QUIZ_RESULTS.data` — maydonlar kontrakt §5 bilan AYNAN bir xil."""

    quiz_id: str
    correct_option: int
    distribution: list[int] = Field(default_factory=list)
    leaderboard: list[LeaderboardEntry] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# XP formulasi (CONTRACTS.md §6)
# ---------------------------------------------------------------------------


def compute_xp(points: int, is_correct: bool, answer_ms: int, duration_sec: int) -> int:
    """XP: tez va to'g'ri javob — ko'proq ball.

        base = points
        if not is_correct: xp = 0
        else: xp = round(base * (0.5 + 0.5 * max(0, 1 - answer_ms / (duration_sec * 1000))))

    Ya'ni to'g'ri javob kamida `base/2`, eng tez javob to'liq `base` oladi.
    Natija 0..points oralig'iga qisiladi (clamp).

    Himoya: `duration_sec <= 0` da nolga bo'linish bo'lmasin (oyna kamida 1 s),
    manfiy `answer_ms` 0 ga, manfiy `points` 0 ga qisiladi.
    """
    base = max(0, int(points))
    if not is_correct or base == 0:
        return 0
    window_ms = max(1, int(duration_sec)) * 1000
    elapsed_ms = max(0, int(answer_ms))
    speed_factor = max(0.0, 1.0 - elapsed_ms / window_ms)
    xp = round(base * (0.5 + 0.5 * speed_factor))
    return max(0, min(base, int(xp)))


# ---------------------------------------------------------------------------
# `quiz_id` yordamchilari
# ---------------------------------------------------------------------------


def make_quiz_id(session_id: uuid.UUID | str, slide_index: int) -> str:
    """Deterministik `quiz_id` — reconnect bo'lganda ham AYNAN bir xil chiqadi.

    Shuning uchun uni Redis da saqlash shart emas: `(session_id, slide_index)`
    juftligi quizni to'liq aniqlaydi (`quiz_answers` UNIQUE ham shunga tayanadi).
    """
    return f"{session_id}{_QUIZ_ID_SEP}{int(slide_index)}"


def parse_quiz_id(quiz_id: str) -> tuple[uuid.UUID, int]:
    """`"{session_id}:{slide_index}"` → `(UUID, int)`.

    Noto'g'ri formatda `ValueError` ko'taradi — klient yuborgan `quiz_id` ga
    ishonmaslik kerak (WS `QUIZ_ANSWER` da `quiz_id` klientdan keladi).
    """
    raw = (quiz_id or "").strip()
    session_part, sep, index_part = raw.rpartition(_QUIZ_ID_SEP)
    if not sep or not session_part or not index_part:
        raise ValueError(f"quiz_id formati noto'g'ri: {quiz_id!r}")
    session_uuid = uuid.UUID(session_part)
    slide_index = int(index_part)
    if slide_index < 0:
        raise ValueError(f"quiz_id dagi slide_index manfiy: {quiz_id!r}")
    return session_uuid, slide_index


def load_quiz_slide(slides_data: Any, slide_index: int) -> QuizSlide | None:
    """Xom `presentations.slides_data` dan QUIZ slaydni oladi.

    `None` qaytaradi, agar: deck nosoz, indeks diapazondan tashqari yoki
    slayd QUIZ emas. Chaqiruvchi (WS) bunda `ERROR` eventini o'zi yuboradi —
    shuning uchun bu yerda HTTP xatosi ko'tarilmaydi.
    """
    try:
        slides = validate_slides_data(slides_data)
    except Exception:
        return None
    if not 0 <= slide_index < len(slides):
        return None
    slide = slides[slide_index]
    return slide if isinstance(slide, QuizSlide) else None


# ---------------------------------------------------------------------------
# Javobni yozish (atomar, bir marta)
# ---------------------------------------------------------------------------


async def record_answer(
    db: AsyncSession,
    *,
    session_id: uuid.UUID,
    slide_index: int,
    student_id: uuid.UUID,
    slide: QuizSlide,
    selected_index: int,
    answer_ms: int,
) -> AnswerOutcome:
    """Javobni atomar yozadi va XP beradi. Takroriy javob XP BERMAYDI.

    Mantiq:
      1. `INSERT ... ON CONFLICT DO NOTHING RETURNING id` — UNIQUE
         `(session_id, slide_index, student_id)` sabab ikkinchi javob o'tmaydi
         (AUDIT.md §D2). `IntegrityError` ko'tarilmaydi, sessiya buzilmaydi.
      2. INSERT o'tgan bo'lsa (`accepted=True`) → `attendances.quiz_score += xp`
         va `users.xp_points += xp` (SQL darajasida `x = x + :xp`, parallel
         javoblarda yo'qotish bo'lmasin).
      3. O'tmagan bo'lsa (`accepted=False`) → bazadagi BIRINCHI javob qaytariladi.

    `selected_index` diapazondan tashqari bo'lsa — javob **noto'g'ri** deb
    yoziladi (XP = 0). Ataylab: shunda "yaroqsiz indeks yuborib, keyin to'g'risini
    yuborish" yo'li yopiladi. `build_results()` bunday indeksni taqsimotda
    hisobga olmaydi.

    ⚠️ Commit qilmaydi — chaqiruvchi `await db.commit()` ni o'zi bajaradi.
    """
    window_ms = max(1, slide.duration_sec) * 1000
    # Int ustunining chegarasidan oshmasin + "o'ta kech" javob to'liq oyna deb olinadi.
    elapsed_ms = max(0, min(int(answer_ms), window_ms))
    is_correct = selected_index == slide.correct_option
    xp = compute_xp(
        points=slide.points,
        is_correct=is_correct,
        answer_ms=elapsed_ms,
        duration_sec=slide.duration_sec,
    )

    stmt = (
        pg_insert(QuizAnswer)
        .values(
            session_id=session_id,
            slide_index=slide_index,
            student_id=student_id,
            selected_index=int(selected_index),
            is_correct=is_correct,
            answer_ms=elapsed_ms,
            xp_awarded=xp,
        )
        .on_conflict_do_nothing(constraint=QUIZ_ANSWER_UNIQUE)
        .returning(QuizAnswer.id)
    )
    inserted_id = (await db.execute(stmt)).scalar_one_or_none()

    if inserted_id is None:
        # Takroriy javob: XP qayta berilmaydi, birinchi javob qaytariladi.
        existing = (
            await db.execute(
                select(
                    QuizAnswer.selected_index,
                    QuizAnswer.is_correct,
                    QuizAnswer.xp_awarded,
                    QuizAnswer.answer_ms,
                ).where(
                    QuizAnswer.session_id == session_id,
                    QuizAnswer.slide_index == slide_index,
                    QuizAnswer.student_id == student_id,
                )
            )
        ).first()
        if existing is None:  # pragma: no cover — konflikt bor, lekin yozuv yo'q
            raise RuntimeError("quiz_answers: konflikt bo'ldi, lekin yozuv topilmadi")
        return AnswerOutcome(
            accepted=False,
            is_correct=bool(existing.is_correct),
            xp_awarded=int(existing.xp_awarded),
            selected_index=int(existing.selected_index),
            answer_ms=int(existing.answer_ms),
            correct_option=slide.correct_option,
        )

    if xp > 0:
        await db.execute(
            update(Attendance)
            .where(Attendance.session_id == session_id, Attendance.student_id == student_id)
            .values(quiz_score=Attendance.quiz_score + xp)
        )
        await db.execute(
            update(User).where(User.id == student_id).values(xp_points=User.xp_points + xp)
        )

    return AnswerOutcome(
        accepted=True,
        is_correct=is_correct,
        xp_awarded=xp,
        selected_index=int(selected_index),
        answer_ms=elapsed_ms,
        correct_option=slide.correct_option,
    )


# ---------------------------------------------------------------------------
# Natijalar
# ---------------------------------------------------------------------------


async def count_answers(db: AsyncSession, *, session_id: uuid.UUID, slide_index: int) -> int:
    """WS `QUIZ_PROGRESS.answered` uchun: bu slaydga javob berganlar soni."""
    return int(
        (
            await db.execute(
                select(func.count())
                .select_from(QuizAnswer)
                .where(
                    QuizAnswer.session_id == session_id,
                    QuizAnswer.slide_index == slide_index,
                )
            )
        ).scalar_one()
    )


async def build_results(
    db: AsyncSession,
    *,
    session_id: uuid.UUID,
    slide_index: int,
    slide: QuizSlide,
    leaderboard_limit: int = DEFAULT_LEADERBOARD_LIMIT,
) -> QuizResults:
    """WS `QUIZ_RESULTS` uchun taqsimot + leaderboard.

    `distribution` uzunligi HAR DOIM `len(slide.options)` ga teng (javob
    bo'lmasa ham nollar bilan) — frontend diagrammasi yiqilmaydi.
    Leaderboard tartibi: XP kamayishi bo'yicha, teng bo'lsa tezroq javob oldinda.
    """
    rows = (
        await db.execute(
            select(
                QuizAnswer.student_id,
                QuizAnswer.selected_index,
                QuizAnswer.xp_awarded,
                QuizAnswer.answer_ms,
                User.full_name,
            )
            .join(User, User.id == QuizAnswer.student_id)
            .where(
                QuizAnswer.session_id == session_id,
                QuizAnswer.slide_index == slide_index,
            )
            .order_by(QuizAnswer.xp_awarded.desc(), QuizAnswer.answer_ms.asc())
        )
    ).all()

    option_count = len(slide.options)
    distribution = [0] * option_count
    leaderboard: list[LeaderboardEntry] = []
    for row in rows:
        if 0 <= row.selected_index < option_count:
            distribution[row.selected_index] += 1
        if len(leaderboard) < max(0, leaderboard_limit):
            leaderboard.append(
                LeaderboardEntry(
                    student_id=row.student_id,
                    full_name=row.full_name,
                    xp=int(row.xp_awarded),
                    answer_ms=int(row.answer_ms),
                )
            )

    return QuizResults(
        quiz_id=make_quiz_id(session_id, slide_index),
        correct_option=slide.correct_option,
        distribution=distribution,
        leaderboard=leaderboard,
    )


__all__ = [
    "DEFAULT_LEADERBOARD_LIMIT",
    "QUIZ_ANSWER_UNIQUE",
    "AnswerOutcome",
    "LeaderboardEntry",
    "QuizResults",
    "build_results",
    "compute_xp",
    "count_answers",
    "load_quiz_slide",
    "make_quiz_id",
    "parse_quiz_id",
    "record_answer",
]
