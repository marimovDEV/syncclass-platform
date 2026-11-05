"""Slayd sxemasi va quiz/XP mantiqi testlari (content-engineer).

Nimani isbotlaydi:
  1. Nosoz slayd (`correct_option=9`, `options` 1 ta, `duration_sec=5`, takroriy
     `index`) sxemadan O'TMAYDI va HTTP qatlamida **422** bo'ladi (AUDIT.md §D5);
  2. Bir o'quvchi ikki marta javob bersa — XP **bir marta** yoziladi
     (`quiz_answers` UNIQUE + `ON CONFLICT DO NOTHING`, AUDIT.md §D2);
  3. XP formulasi chegara qiymatlarda to'g'ri: 0 ms, to'liq vaqt, vaqtdan oshiq,
     noto'g'ri javob (CONTRACTS.md §6);
  4. `scripts/seed.py` yozgan HAQIQIY `slides_data` sxemadan o'tadi.

DB kerak bo'lgan testlar Postgres bo'lmasa `skip` bo'ladi (sof sxema/XP
testlari har qanday muhitda ishlaydi):
    DATABASE_URL=postgresql+asyncpg://syncclass:syncclass@localhost:55432/syncclass
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Any, get_type_hints

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.api.presentations import MAX_ASSET_BYTES, create_presentation
from app.api.presentations import router as presentations_router
from app.core.config import settings
from app.core.deps import require_teacher
from app.db.models import (
    Attendance,
    Group,
    LessonSession,
    Presentation,
    QuizAnswer,
    SessionStatus,
    User,
    UserRole,
)
from app.db.session import get_db
from app.schemas.presentation import PresentationCreate, PresentationOut
from app.schemas.slide import (
    ASSET_URL_PREFIX,
    CodeSlide,
    MarkdownSlide,
    QuizSlide,
    SlideDeck,
    dump_slides_data,
    validate_slides_data,
)
from app.services.quiz import (
    build_results,
    compute_xp,
    count_answers,
    load_quiz_slide,
    make_quiz_id,
    parse_quiz_id,
    record_answer,
)

# ---------------------------------------------------------------------------
# Yordamchi ma'lumotlar
# ---------------------------------------------------------------------------

VALID_QUIZ: dict[str, Any] = {
    "index": 0,
    "type": "QUIZ",
    "title": "Tekshiruv",
    "question": "2 + 2 = ?",
    "options": ["3", "4", "5", "6"],
    "correct_option": 1,
    "duration_sec": 30,
    "points": 100,
}


def _quiz(**overrides: Any) -> dict[str, Any]:
    return {**VALID_QUIZ, **overrides}


QUIZ_SLIDE = QuizSlide(
    index=2,
    type="QUIZ",
    title="Indekslash",
    question="sonlar[-2] nimani qaytaradi?",
    options=["10", "20", "30", "40"],
    correct_option=2,
    duration_sec=30,
    points=100,
)

DECK: list[Any] = [
    MarkdownSlide(index=0, type="MARKDOWN", title="Kirish", content="## Salom"),
    CodeSlide(index=1, type="CODE", title="Kod", code_lang="python", starter_code="x = 1\n"),
    QUIZ_SLIDE,
]


# ---------------------------------------------------------------------------
# 1. Slayd sxemasi — discriminated union
# ---------------------------------------------------------------------------


def test_discriminator_picks_the_right_model() -> None:
    slides = validate_slides_data(dump_slides_data(DECK))
    assert [type(s).__name__ for s in slides] == ["MarkdownSlide", "CodeSlide", "QuizSlide"]


def test_unknown_slide_type_rejected() -> None:
    with pytest.raises(ValidationError):
        validate_slides_data([{"index": 0, "type": "VIDEO", "content": "x"}])


def test_extra_field_rejected() -> None:
    """Kontraktda yo'q maydon — jim o'tmaydi, aks holda frontend kutmagan JSON oladi."""
    with pytest.raises(ValidationError):
        validate_slides_data([_quiz(sneaky_field="x")])


@pytest.mark.parametrize("correct_option", [9, 4, -1])
def test_correct_option_must_be_in_range(correct_option: int) -> None:
    """`correct_option=9` — rolda ko'rsatilgan asosiy holat (4 ta variant bor)."""
    with pytest.raises(ValidationError) as exc:
        validate_slides_data([_quiz(correct_option=correct_option)])
    assert "correct_option" in str(exc.value)


@pytest.mark.parametrize(
    "options",
    [
        [],
        ["bitta"],
        ["1", "2", "3", "4", "5", "6", "7"],
        ["   ", "2"],
    ],
)
def test_options_count_and_blanks(options: list[str]) -> None:
    with pytest.raises(ValidationError):
        validate_slides_data([_quiz(options=options, correct_option=0)])


@pytest.mark.parametrize("duration_sec", [0, 9, 121, 3600])
def test_duration_sec_bounds(duration_sec: int) -> None:
    with pytest.raises(ValidationError):
        validate_slides_data([_quiz(duration_sec=duration_sec)])


def test_quiz_points_default_is_100() -> None:
    payload = _quiz()
    del payload["points"]
    slide = validate_slides_data([payload])[0]
    assert slide.points == 100


def test_code_lang_whitelist() -> None:
    with pytest.raises(ValidationError):
        validate_slides_data(
            [{"index": 0, "type": "CODE", "code_lang": "rust", "starter_code": "fn main(){}"}]
        )


def test_duplicate_index_rejected() -> None:
    with pytest.raises(ValidationError) as exc:
        validate_slides_data(
            [
                {"index": 0, "type": "MARKDOWN", "content": "a"},
                {"index": 0, "type": "MARKDOWN", "content": "b"},
            ]
        )
    assert "takrorlangan" in str(exc.value)


def test_non_sequential_index_rejected() -> None:
    with pytest.raises(ValidationError) as exc:
        validate_slides_data(
            [
                {"index": 0, "type": "MARKDOWN", "content": "a"},
                {"index": 5, "type": "MARKDOWN", "content": "b"},
            ]
        )
    assert "ketma-ket emas" in str(exc.value)


def test_empty_deck_is_valid() -> None:
    assert SlideDeck.model_validate([]).root == []


def test_markdown_content_length_limit() -> None:
    with pytest.raises(ValidationError):
        validate_slides_data([{"index": 0, "type": "MARKDOWN", "content": "x" * 20_001}])


# ---------------------------------------------------------------------------
# 2. HTTP qatlami — nosoz slayd 422 beradi
# ---------------------------------------------------------------------------


def _probe_app() -> FastAPI:
    """`PresentationCreate` ni tana sifatida qabul qiladigan minimal ilova.

    Haqiqiy `POST /presentations` auth + DB talab qiladi, lekin tana modeli
    AYNAN shu (quyidagi test buni tekshiradi), demak 422 xatti-harakati bir xil.
    """
    app = FastAPI()

    @app.post("/probe")
    async def probe(payload: PresentationCreate) -> dict[str, int]:
        return {"slides": len(payload.slides_data)}

    return app


def test_real_endpoint_uses_presentation_create() -> None:
    """Probe ilova haqiqiy endpoint bilan BIR XIL modelni ishlatishini kafolatlaydi."""
    hints = get_type_hints(create_presentation)
    assert hints["payload"] is PresentationCreate
    assert hints["return"] is PresentationOut


def test_http_422_for_invalid_slide() -> None:
    client = TestClient(_probe_app())
    body = {
        "title": "Dars 1",
        "module_number": 1,
        "lesson_number": 1,
        "slides_data": [_quiz(correct_option=9)],
    }
    response = client.post("/probe", json=body)
    assert response.status_code == 422
    assert "correct_option" in response.text


def test_http_200_for_valid_deck() -> None:
    client = TestClient(_probe_app())
    body = {
        "title": "Dars 1",
        "module_number": 1,
        "lesson_number": 1,
        "slides_data": dump_slides_data(DECK),
    }
    response = client.post("/probe", json=body)
    assert response.status_code == 200
    assert response.json() == {"slides": 3}


# ---------------------------------------------------------------------------
# 3. XP formulasi (CONTRACTS.md §6)
# ---------------------------------------------------------------------------


def test_xp_instant_answer_gets_full_points() -> None:
    assert compute_xp(points=100, is_correct=True, answer_ms=0, duration_sec=30) == 100


def test_xp_full_time_answer_gets_half() -> None:
    assert compute_xp(points=100, is_correct=True, answer_ms=30_000, duration_sec=30) == 50


def test_xp_over_time_never_below_half() -> None:
    """`max(0, 1 - ...)` sabab vaqtdan oshgan to'g'ri javob ham base/2 oladi."""
    assert compute_xp(points=100, is_correct=True, answer_ms=10**6, duration_sec=30) == 50


def test_xp_wrong_answer_is_zero() -> None:
    assert compute_xp(points=100, is_correct=False, answer_ms=0, duration_sec=30) == 0
    assert compute_xp(points=100, is_correct=False, answer_ms=10**6, duration_sec=30) == 0


def test_xp_half_time_is_three_quarters() -> None:
    assert compute_xp(points=100, is_correct=True, answer_ms=15_000, duration_sec=30) == 75


def test_xp_is_clamped_to_points() -> None:
    for answer_ms in (0, 1, 7_500, 15_000, 29_999, 30_000, 10**9):
        xp = compute_xp(points=100, is_correct=True, answer_ms=answer_ms, duration_sec=30)
        assert 0 <= xp <= 100


def test_xp_degenerate_inputs_do_not_crash() -> None:
    """Nolga bo'linish va manfiy qiymatlar — `compute_xp` ommaviy funksiya."""
    assert compute_xp(points=100, is_correct=True, answer_ms=0, duration_sec=0) == 100
    assert compute_xp(points=100, is_correct=True, answer_ms=-5, duration_sec=30) == 100
    assert compute_xp(points=0, is_correct=True, answer_ms=0, duration_sec=30) == 0
    assert compute_xp(points=-10, is_correct=True, answer_ms=0, duration_sec=30) == 0


def test_xp_scales_with_points() -> None:
    assert compute_xp(points=200, is_correct=True, answer_ms=0, duration_sec=30) == 200
    assert compute_xp(points=200, is_correct=True, answer_ms=30_000, duration_sec=30) == 100


# ---------------------------------------------------------------------------
# 4. quiz_id va slayd yuklash
# ---------------------------------------------------------------------------


def test_quiz_id_roundtrip() -> None:
    session_id = uuid.uuid4()
    quiz_id = make_quiz_id(session_id, 7)
    assert parse_quiz_id(quiz_id) == (session_id, 7)


@pytest.mark.parametrize("bad", ["", "abc", "not-a-uuid:1", f"{uuid.uuid4()}:x", "12345"])
def test_parse_quiz_id_rejects_garbage(bad: str) -> None:
    with pytest.raises(ValueError):
        parse_quiz_id(bad)


def test_load_quiz_slide_from_raw_jsonb() -> None:
    raw = dump_slides_data(DECK)
    assert load_quiz_slide(raw, 2) == QUIZ_SLIDE
    assert load_quiz_slide(raw, 0) is None       # MARKDOWN
    assert load_quiz_slide(raw, 99) is None      # diapazondan tashqari
    assert load_quiz_slide([{"index": 0, "type": "NOPE"}], 0) is None  # nosoz deck


# ---------------------------------------------------------------------------
# DB fixture (Postgres bo'lmasa skip)
# ---------------------------------------------------------------------------


@pytest.fixture
async def db() -> AsyncIterator[AsyncSession]:
    """Tashqi tranzaksiya + SAVEPOINT: oxirida ROLLBACK, bazada iz QOLMAYDI.

    `app.db.session.engine` ATAYLAB ishlatilmaydi: uning pool'i ulanishlarni
    birinchi event loop ga bog'laydi, pytest-asyncio esa har testga YANGI loop
    beradi → "attached to a different loop". Shuning uchun `NullPool` li
    alohida engine (qolgan sozlamalar produksiyadagidek).

    `join_transaction_mode="create_savepoint"` sabab endpoint ichidagi
    `await db.commit()` faqat SAVEPOINT ni yopadi — tashqi tranzaksiya
    oxirida butunlay orqaga qaytariladi.
    """
    engine = create_async_engine(settings.sqlalchemy_url, poolclass=NullPool)
    try:
        conn = await engine.connect()
    except Exception as exc:
        await engine.dispose()
        pytest.skip(f"Postgres mavjud emas: {exc.__class__.__name__}: {exc}")

    outer = await conn.begin()
    session = AsyncSession(
        bind=conn,
        expire_on_commit=False,
        autoflush=False,
        join_transaction_mode="create_savepoint",
    )
    try:
        await session.execute(select(Presentation.id).limit(1))
    except Exception as exc:
        await session.close()
        await outer.rollback()
        await conn.close()
        await engine.dispose()
        pytest.skip(f"Jadvallar mavjud emas (alembic upgrade head?): {exc.__class__.__name__}")
    try:
        yield session
    finally:
        await session.close()
        await outer.rollback()
        await conn.close()
        await engine.dispose()


@pytest.fixture
async def api(db: AsyncSession) -> AsyncIterator[dict[str, Any]]:
    """HAQIQIY `presentations.router` ni ishga tushiradi.

    Faqat ikki bog'liqlik almashtiriladi: `get_db` (test sessiyasi) va
    `require_teacher` (auth-engineer moduli, uning JWT oqimi bu testning
    predmeti emas). Endpoint mantiqi — egalik guard'i, validatsiya, status
    kodlari — HAQIQIY kod.
    """
    scene = await _scenario(db)
    teacher: User = scene["teacher"]
    state: dict[str, Any] = {"teacher": teacher}

    app = FastAPI()
    app.include_router(presentations_router, prefix="/api/v1/presentations")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[require_teacher] = lambda: state["teacher"]

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield {"client": client, "scene": scene, "state": state, "db": db}


async def _scenario(db: AsyncSession, student_count: int = 2) -> dict[str, Any]:
    """Commit QILINMAYDIGAN test sahnasi: o'qituvchi, guruh, deck, sessiya, o'quvchilar."""
    tag = uuid.uuid4().hex[:10]
    teacher = User(
        google_id=f"test-t-{tag}",
        email=f"t-{tag}@test.local",
        full_name="Test Ustoz",
        role=UserRole.TEACHER,
        is_onboarded=True,
    )
    db.add(teacher)
    await db.flush()

    group = Group(
        name=f"T-{tag}",
        course_title="Test kursi",
        invite_code=f"INV-{tag}",
        teacher_id=teacher.id,
    )
    db.add(group)
    await db.flush()

    presentation = Presentation(
        teacher_id=teacher.id,
        title=f"Test deck {tag}",
        module_number=1,
        lesson_number=1,
        schema_version=1,
        slides_data=dump_slides_data(DECK),
    )
    db.add(presentation)
    await db.flush()

    lesson = LessonSession(
        group_id=group.id,
        presentation_id=presentation.id,
        pin_code=f"{uuid.uuid4().int % 900_000 + 100_000}",
        status=SessionStatus.LIVE,
    )
    db.add(lesson)
    await db.flush()

    students: list[User] = []
    for i in range(student_count):
        student = User(
            google_id=f"test-s-{tag}-{i}",
            email=f"s{i}-{tag}@test.local",
            full_name=f"O'quvchi {i}",
            role=UserRole.STUDENT,
            is_onboarded=True,
        )
        db.add(student)
        await db.flush()
        db.add(Attendance(session_id=lesson.id, student_id=student.id))
        students.append(student)
    await db.flush()

    return {
        "teacher": teacher,
        "group": group,
        "presentation": presentation,
        "session": lesson,
        "students": students,
    }


async def _xp_of(db: AsyncSession, student_id: uuid.UUID) -> int:
    return int((await db.execute(select(User.xp_points).where(User.id == student_id))).scalar_one())


async def _quiz_score_of(db: AsyncSession, session_id: uuid.UUID, student_id: uuid.UUID) -> int:
    return int(
        (
            await db.execute(
                select(Attendance.quiz_score).where(
                    Attendance.session_id == session_id, Attendance.student_id == student_id
                )
            )
        ).scalar_one()
    )


# ---------------------------------------------------------------------------
# 5. Takroriy javob XP bermaydi (AUDIT.md §D2)
# ---------------------------------------------------------------------------


async def test_double_answer_awards_xp_only_once(db: AsyncSession) -> None:
    scene = await _scenario(db)
    session_id = scene["session"].id
    student = scene["students"][0]

    first = await record_answer(
        db,
        session_id=session_id,
        slide_index=2,
        student_id=student.id,
        slide=QUIZ_SLIDE,
        selected_index=2,
        answer_ms=0,
    )
    assert first.accepted is True
    assert first.is_correct is True
    assert first.xp_awarded == 100

    # Ikkinchi urinish: AYNI slayd, AYNI o'quvchi — XP qayta berilmaydi.
    second = await record_answer(
        db,
        session_id=session_id,
        slide_index=2,
        student_id=student.id,
        slide=QUIZ_SLIDE,
        selected_index=2,
        answer_ms=0,
    )
    assert second.accepted is False
    assert second.xp_awarded == 100  # birinchi javobdagi qiymat qaytariladi

    assert await count_answers(db, session_id=session_id, slide_index=2) == 1
    assert await _xp_of(db, student.id) == 100
    assert await _quiz_score_of(db, session_id, student.id) == 100


async def test_second_answer_cannot_overwrite_a_wrong_one(db: AsyncSession) -> None:
    """Noto'g'ri javobdan keyin "to'g'risini" yuborish XP bermaydi."""
    scene = await _scenario(db)
    session_id = scene["session"].id
    student = scene["students"][0]

    wrong = await record_answer(
        db,
        session_id=session_id,
        slide_index=2,
        student_id=student.id,
        slide=QUIZ_SLIDE,
        selected_index=0,
        answer_ms=1_000,
    )
    assert wrong.accepted is True
    assert wrong.is_correct is False
    assert wrong.xp_awarded == 0

    retry = await record_answer(
        db,
        session_id=session_id,
        slide_index=2,
        student_id=student.id,
        slide=QUIZ_SLIDE,
        selected_index=2,
        answer_ms=1_000,
    )
    assert retry.accepted is False
    assert retry.is_correct is False
    assert retry.xp_awarded == 0
    assert await _xp_of(db, student.id) == 0
    assert await _quiz_score_of(db, session_id, student.id) == 0


async def test_out_of_range_selection_is_recorded_as_wrong(db: AsyncSession) -> None:
    scene = await _scenario(db)
    session_id = scene["session"].id
    student = scene["students"][0]

    outcome = await record_answer(
        db,
        session_id=session_id,
        slide_index=2,
        student_id=student.id,
        slide=QUIZ_SLIDE,
        selected_index=99,
        answer_ms=500,
    )
    assert outcome.accepted is True
    assert outcome.is_correct is False
    assert outcome.xp_awarded == 0

    results = await build_results(db, session_id=session_id, slide_index=2, slide=QUIZ_SLIDE)
    # Diapazondan tashqari indeks taqsimotni buzmaydi.
    assert results.distribution == [0, 0, 0, 0]


async def test_answer_ms_is_clamped_to_the_window(db: AsyncSession) -> None:
    """`answer_ms` INTEGER ustuniga sig'ishi uchun oyna bo'yicha qisiladi."""
    scene = await _scenario(db)
    session_id = scene["session"].id
    student = scene["students"][0]

    outcome = await record_answer(
        db,
        session_id=session_id,
        slide_index=2,
        student_id=student.id,
        slide=QUIZ_SLIDE,
        selected_index=2,
        answer_ms=10**12,
    )
    assert outcome.answer_ms == QUIZ_SLIDE.duration_sec * 1000
    assert outcome.xp_awarded == 50

    stored = (
        await db.execute(
            select(QuizAnswer.answer_ms).where(
                QuizAnswer.session_id == session_id,
                QuizAnswer.slide_index == 2,
                QuizAnswer.student_id == student.id,
            )
        )
    ).scalar_one()
    assert stored == QUIZ_SLIDE.duration_sec * 1000


# ---------------------------------------------------------------------------
# 6. Natijalar: taqsimot + leaderboard
# ---------------------------------------------------------------------------


async def test_build_results_distribution_and_leaderboard(db: AsyncSession) -> None:
    scene = await _scenario(db, student_count=3)
    session_id = scene["session"].id
    fast, slow, wrong = scene["students"]

    await record_answer(
        db, session_id=session_id, slide_index=2, student_id=fast.id,
        slide=QUIZ_SLIDE, selected_index=2, answer_ms=0,
    )
    await record_answer(
        db, session_id=session_id, slide_index=2, student_id=slow.id,
        slide=QUIZ_SLIDE, selected_index=2, answer_ms=30_000,
    )
    await record_answer(
        db, session_id=session_id, slide_index=2, student_id=wrong.id,
        slide=QUIZ_SLIDE, selected_index=0, answer_ms=5_000,
    )

    results = await build_results(db, session_id=session_id, slide_index=2, slide=QUIZ_SLIDE)

    assert results.quiz_id == make_quiz_id(session_id, 2)
    assert results.correct_option == 2
    assert results.distribution == [1, 0, 2, 0]
    assert len(results.distribution) == len(QUIZ_SLIDE.options)
    assert [e.student_id for e in results.leaderboard] == [fast.id, slow.id, wrong.id]
    assert [e.xp for e in results.leaderboard] == [100, 50, 0]
    assert results.leaderboard[0].full_name == fast.full_name

    # WS `QUIZ_RESULTS.data` maydonlari kontrakt §5 bilan aynan bir xil.
    assert set(results.model_dump().keys()) == {
        "quiz_id",
        "correct_option",
        "distribution",
        "leaderboard",
    }


async def test_build_results_empty_distribution_when_nobody_answered(db: AsyncSession) -> None:
    scene = await _scenario(db)
    results = await build_results(
        db, session_id=scene["session"].id, slide_index=2, slide=QUIZ_SLIDE
    )
    assert results.distribution == [0, 0, 0, 0]
    assert results.leaderboard == []


async def test_load_quiz_slide_from_db_row(db: AsyncSession) -> None:
    """Realtime-engineer aynan shu yo'ldan boradi: DB → `slides_data` → QuizSlide."""
    scene = await _scenario(db)
    row = (
        await db.execute(
            select(Presentation.slides_data).where(Presentation.id == scene["presentation"].id)
        )
    ).scalar_one()
    slide = load_quiz_slide(row, 2)
    assert slide is not None
    assert slide.correct_option == 2
    assert load_quiz_slide(row, 1) is None


# ---------------------------------------------------------------------------
# 7. Seed ma'lumoti HAQIQIY bazadan o'qib validatsiya qilinadi
# ---------------------------------------------------------------------------


async def test_seeded_presentation_passes_schema(db: AsyncSession) -> None:
    """`scripts/seed.py` yozgan deck sxemadan o'tishi SHART (aks holda CONTRACT_CONFLICT)."""
    rows = (
        await db.execute(
            select(Presentation.id, Presentation.title, Presentation.slides_data).where(
                text("jsonb_array_length(presentations.slides_data) > 0")
            )
        )
    ).all()
    if not rows:
        pytest.skip("Bazada seed prezentatsiyasi yo'q (python scripts/seed.py ishlatilmagan)")

    for row in rows:
        slides = validate_slides_data(row.slides_data)
        assert [s.index for s in slides] == list(range(len(slides)))
        for slide in slides:
            if isinstance(slide, QuizSlide):
                assert 0 <= slide.correct_option < len(slide.options)
                assert 10 <= slide.duration_sec <= 120

    seeded = next((r for r in rows if len(r.slides_data) == 6), None)
    if seeded is not None:
        types = [s.type for s in validate_slides_data(seeded.slides_data)]
        assert types == ["MARKDOWN", "CODE", "QUIZ", "MARKDOWN", "CODE", "QUIZ"]


# ---------------------------------------------------------------------------
# 8. HAQIQIY endpointlar: validatsiya + egalik guard'i (CONTRACTS.md §4)
# ---------------------------------------------------------------------------

_BASE = "/api/v1/presentations"


def _create_body(**overrides: Any) -> dict[str, Any]:
    body = {
        "title": "Dars 1 — ro'yxatlar",
        "module_number": 1,
        "lesson_number": 2,
        "slides_data": dump_slides_data(DECK),
    }
    body.update(overrides)
    return body


async def test_endpoint_creates_and_reads_back(api: dict[str, Any]) -> None:
    client: AsyncClient = api["client"]

    created = await client.post(_BASE, json=_create_body())
    assert created.status_code == 201, created.text
    payload = created.json()
    assert payload["teacher_id"] == str(api["scene"]["teacher"].id)
    assert payload["schema_version"] == 1
    assert payload["slides_count"] == 3
    assert [s["type"] for s in payload["slides_data"]] == ["MARKDOWN", "CODE", "QUIZ"]

    fetched = await client.get(f"{_BASE}/{payload['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["slides_data"] == payload["slides_data"]

    listed = await client.get(_BASE)
    assert listed.status_code == 200
    briefs = {item["id"]: item for item in listed.json()}
    assert briefs[payload["id"]]["slides_count"] == 3
    assert "slides_data" not in briefs[payload["id"]]


async def test_endpoint_rejects_invalid_slide_with_422(api: dict[str, Any]) -> None:
    """Rolda ko'rsatilgan asosiy holat: `correct_option=9` → 422."""
    client: AsyncClient = api["client"]
    bad_quiz = _quiz(index=0, correct_option=9)
    response = await client.post(_BASE, json=_create_body(slides_data=[bad_quiz]))
    assert response.status_code == 422
    assert "correct_option" in response.text


async def test_endpoint_rejects_broken_deck_order(api: dict[str, Any]) -> None:
    client: AsyncClient = api["client"]
    slides = [
        {"index": 0, "type": "MARKDOWN", "content": "a"},
        {"index": 2, "type": "MARKDOWN", "content": "b"},
    ]
    response = await client.post(_BASE, json=_create_body(slides_data=slides))
    assert response.status_code == 422


async def test_endpoint_patch_replaces_slides(api: dict[str, Any]) -> None:
    client: AsyncClient = api["client"]
    created = (await client.post(_BASE, json=_create_body())).json()

    patched = await client.patch(
        f"{_BASE}/{created['id']}",
        json={"title": "Yangi sarlavha", "slides_data": [_quiz(index=0)]},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["title"] == "Yangi sarlavha"
    assert patched.json()["slides_count"] == 1
    assert patched.json()["slides_data"][0]["type"] == "QUIZ"
    # Yuborilmagan maydon o'zgarmaydi.
    assert patched.json()["module_number"] == 1


async def test_endpoint_patch_without_fields_is_400(api: dict[str, Any]) -> None:
    client: AsyncClient = api["client"]
    created = (await client.post(_BASE, json=_create_body())).json()
    response = await client.patch(f"{_BASE}/{created['id']}", json={})
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "EMPTY_PATCH"


async def test_endpoint_blocks_foreign_teacher(api: dict[str, Any]) -> None:
    """Boshqa o'qituvchining deck'i — 403 `NOT_OWNER` (o'qish ham, yozish ham)."""
    client: AsyncClient = api["client"]
    db: AsyncSession = api["db"]
    created = (await client.post(_BASE, json=_create_body())).json()

    intruder = await _scenario(db)
    api["state"]["teacher"] = intruder["teacher"]

    for method, kwargs in (
        ("get", {}),
        ("patch", {"json": {"title": "O'zgartirdim"}}),
        ("delete", {}),
    ):
        response = await getattr(client, method)(f"{_BASE}/{created['id']}", **kwargs)
        assert response.status_code == 403, f"{method}: {response.text}"
        assert response.json()["detail"]["code"] == "NOT_OWNER"

    # Ro'yxatda ham ko'rinmaydi.
    listed = await client.get(_BASE)
    assert created["id"] not in {item["id"] for item in listed.json()}


async def test_endpoint_delete_then_404(api: dict[str, Any]) -> None:
    client: AsyncClient = api["client"]
    created = (await client.post(_BASE, json=_create_body())).json()

    deleted = await client.delete(f"{_BASE}/{created['id']}")
    assert deleted.status_code == 204

    missing = await client.get(f"{_BASE}/{created['id']}")
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "PRESENTATION_NOT_FOUND"


async def test_endpoint_rejects_empty_title(api: dict[str, Any]) -> None:
    client: AsyncClient = api["client"]
    response = await client.post(_BASE, json=_create_body(title=""))
    assert response.status_code == 422


async def test_quiz_flow_uses_stored_deck(api: dict[str, Any]) -> None:
    """To'liq zanjir: endpoint deck yozadi → quiz xizmati shu deck'dan XP beradi."""
    client: AsyncClient = api["client"]
    db: AsyncSession = api["db"]
    created = (await client.post(_BASE, json=_create_body())).json()

    raw = (
        await db.execute(
            select(Presentation.slides_data).where(Presentation.id == uuid.UUID(created["id"]))
        )
    ).scalar_one()
    slide = load_quiz_slide(raw, 2)
    assert slide is not None

    student = api["scene"]["students"][0]
    outcome = await record_answer(
        db,
        session_id=api["scene"]["session"].id,
        slide_index=2,
        student_id=student.id,
        slide=slide,
        selected_index=slide.correct_option,
        answer_ms=0,
    )
    assert outcome.accepted is True
    assert outcome.xp_awarded == slide.points


# ---------------------------------------------------------------------------
# 9. `POST /presentations/{id}/assets` — rasm validatsiyasi
# ---------------------------------------------------------------------------

#: Haqiqiy 1x1 shaffof PNG (67 bayt).
PNG_1X1 = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06"
    b"\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05"
    b"\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


class _R2Calls(list):
    """`upload_bytes` chaqiruvlari ro'yxati + `presigned` chaqiruvlari yonida."""

    presigned: list[tuple[str, int | None]]


@pytest.fixture
def fake_r2(monkeypatch: pytest.MonkeyPatch) -> _R2Calls:
    """R2 ni tarmoqqa chiqmasdan almashtiradi (storage-engineer moduli tegilmaydi).

    `app.api.presentations` funksiyalarni nom bilan import qilgani uchun
    aynan shu moduldagi nomlar almashtiriladi.
    """
    calls = _R2Calls()

    async def _upload(key: str, buf: Any, content_type: str = "", **kwargs: Any) -> str:
        calls.append((key, len(buf.getvalue()), content_type))
        return key

    presigned: list[tuple[str, int | None]] = []

    async def _presign(key: str, ttl: int | None = None) -> str:
        presigned.append((key, ttl))
        return f"https://r2.test/{key}?sig=deadbeef&ttl={ttl}"

    async def _exists(key: str) -> bool:
        """Faqat HAQIQATAN yuklangan kalit mavjud (R2 HEAD ning o'rni)."""
        return any(call[0] == key for call in calls)

    monkeypatch.setattr("app.api.presentations.upload_bytes", _upload)
    monkeypatch.setattr("app.api.presentations.presigned_url", _presign)
    monkeypatch.setattr("app.api.presentations._asset_exists", _exists)
    calls.presigned = presigned
    return calls


async def test_asset_upload_accepts_png(
    api: dict[str, Any], fake_r2: _R2Calls
) -> None:
    client: AsyncClient = api["client"]
    created = (await client.post(_BASE, json=_create_body())).json()

    response = await client.post(
        f"{_BASE}/{created['id']}/assets",
        files={"file": ("rasm.png", PNG_1X1, "image/png")},
    )
    assert response.status_code == 200, response.text
    url = response.json()["url"]
    # Presigned EMAS — barqaror havola (v1.1.1): BACKEND_PUBLIC_URL + redirect yo'li.
    expected_prefix = (
        f"{settings.BACKEND_PUBLIC_URL.rstrip('/')}"
        f"{ASSET_URL_PREFIX}/{created['id']}/assets/"
    )
    assert url.startswith(expected_prefix), url
    assert url.endswith(".png")
    assert "sig=" not in url and "ttl=" not in url
    assert fake_r2.presigned == []  # yuklash paytida presign chaqirilmaydi

    key, size, content_type = fake_r2[0]
    assert size == len(PNG_1X1)
    assert content_type == "image/png"  # klient aytgani emas, biz aniqlagani
    assert key.startswith(f"presentations/{created['id']}/")


async def test_asset_upload_rejects_non_image(
    api: dict[str, Any], fake_r2: _R2Calls
) -> None:
    """`Content-Type: image/png` deb aytilgan, lekin mazmuni HTML — rad etiladi."""
    client: AsyncClient = api["client"]
    created = (await client.post(_BASE, json=_create_body())).json()

    response = await client.post(
        f"{_BASE}/{created['id']}/assets",
        files={"file": ("xss.png", b"<svg onload=alert(1)>", "image/png")},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "INVALID_IMAGE"
    assert fake_r2 == []


async def test_asset_upload_rejects_wrong_declared_type(
    api: dict[str, Any], fake_r2: _R2Calls
) -> None:
    client: AsyncClient = api["client"]
    created = (await client.post(_BASE, json=_create_body())).json()

    response = await client.post(
        f"{_BASE}/{created['id']}/assets",
        files={"file": ("rasm.svg", PNG_1X1, "image/svg+xml")},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "UNSUPPORTED_MEDIA_TYPE"
    assert fake_r2 == []


async def test_asset_upload_enforces_size_cap(
    api: dict[str, Any], fake_r2: _R2Calls
) -> None:
    client: AsyncClient = api["client"]
    created = (await client.post(_BASE, json=_create_body())).json()

    oversized = PNG_1X1 + b"\x00" * (MAX_ASSET_BYTES + 1)
    response = await client.post(
        f"{_BASE}/{created['id']}/assets",
        files={"file": ("katta.png", oversized, "image/png")},
    )
    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "FILE_TOO_LARGE"
    assert fake_r2 == []


async def test_asset_upload_blocks_foreign_teacher(
    api: dict[str, Any], fake_r2: _R2Calls
) -> None:
    client: AsyncClient = api["client"]
    db: AsyncSession = api["db"]
    created = (await client.post(_BASE, json=_create_body())).json()

    intruder = await _scenario(db)
    api["state"]["teacher"] = intruder["teacher"]

    response = await client.post(
        f"{_BASE}/{created['id']}/assets",
        files={"file": ("rasm.png", PNG_1X1, "image/png")},
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "NOT_OWNER"
    assert fake_r2 == []


# ---------------------------------------------------------------------------
# 10. `GET /presentations/{id}/assets/{asset_key}` — barqaror URL → 307 redirect
# ---------------------------------------------------------------------------


def _asset_path(url: str) -> str:
    """Barqaror URL dan test klienti uchun yo'lni ajratib oladi."""
    base = settings.BACKEND_PUBLIC_URL.rstrip("/")
    assert url.startswith(base), url
    return url[len(base) :]


async def test_asset_url_roundtrip(
    api: dict[str, Any], fake_r2: _R2Calls
) -> None:
    """POST qaytargan URL HAQIQATAN GET endpointiga mos tushadi (307 + presigned)."""
    client: AsyncClient = api["client"]
    created = (await client.post(_BASE, json=_create_body())).json()

    posted = await client.post(
        f"{_BASE}/{created['id']}/assets",
        files={"file": ("rasm.png", PNG_1X1, "image/png")},
    )
    url = posted.json()["url"]

    # `ASSET_URL_PREFIX` main.py dagi mount bilan bir xilligini isbotlaydi:
    # mos bo'lmasa bu so'rov 404 bo'lardi.
    response = await client.get(_asset_path(url), follow_redirects=False)
    assert response.status_code == 307, response.text
    assert response.headers["location"].startswith("https://r2.test/presentations/")
    assert "sig=deadbeef" in response.headers["location"]
    assert response.headers["cache-control"] == (
        f"private, max-age={settings.R2_PRESIGN_TTL_SEC // 2}"
    )

    # R2 kaliti SERVERDA yasaladi: URL dagi `asset_key` + prezentatsiya prefiksi.
    asset_key = url.rsplit("/", 1)[-1]
    presigned_key, ttl = fake_r2.presigned[-1]
    assert presigned_key == f"presentations/{created['id']}/{asset_key}"
    assert ttl == settings.R2_PRESIGN_TTL_SEC


@pytest.mark.parametrize(
    "bad_key",
    [
        "../../etc/passwd",
        "..%2F..%2Fetc%2Fpasswd",
        "%2e%2e%2fsecret.png",
        "submissions%2Fleak.png",
        "0123456789abcdef0123456789abcdef.svg",
        "0123456789abcdef0123456789abcdef.png.svg",
        "short.png",
        "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ.png",
    ],
)
async def test_asset_key_traversal_is_rejected(
    api: dict[str, Any], fake_r2: _R2Calls, bad_key: str
) -> None:
    """Path traversal / noto'g'ri shablon — R2 ga umuman murojaat qilinmaydi."""
    client: AsyncClient = api["client"]
    created = (await client.post(_BASE, json=_create_body())).json()

    response = await client.get(
        f"{_BASE}/{created['id']}/assets/{bad_key}", follow_redirects=False
    )
    assert response.status_code in (400, 404), f"{bad_key}: {response.status_code}"
    if response.status_code == 404 and response.headers.get("content-type", "").startswith(
        "application/json"
    ):
        detail = response.json().get("detail")
        if isinstance(detail, dict):
            assert detail["code"] == "ASSET_NOT_FOUND"
    assert fake_r2.presigned == []  # presign HECH QACHON chaqirilmaydi


async def test_asset_key_is_scoped_to_its_presentation(
    api: dict[str, Any], fake_r2: _R2Calls
) -> None:
    """Boshqa prezentatsiya ID si bilan so'ralsa — o'sha faylga YETIB BO'LMAYDI."""
    client: AsyncClient = api["client"]
    first = (await client.post(_BASE, json=_create_body(title="Birinchi"))).json()
    second = (await client.post(_BASE, json=_create_body(title="Ikkinchi"))).json()

    posted = await client.post(
        f"{_BASE}/{first['id']}/assets",
        files={"file": ("rasm.png", PNG_1X1, "image/png")},
    )
    asset_key = posted.json()["url"].rsplit("/", 1)[-1]

    # O'z prezentatsiyasida — ishlaydi.
    ok = await client.get(f"{_BASE}/{first['id']}/assets/{asset_key}", follow_redirects=False)
    assert ok.status_code == 307

    # Boshqa prezentatsiya ID si bilan — 404 (kalit prefiksi serverda yasaladi).
    leaked = await client.get(
        f"{_BASE}/{second['id']}/assets/{asset_key}", follow_redirects=False
    )
    assert leaked.status_code == 404
    assert leaked.json()["detail"]["code"] == "ASSET_NOT_FOUND"

    # Mavjud bo'lmagan prezentatsiya — 404 PRESENTATION_NOT_FOUND.
    missing = await client.get(
        f"{_BASE}/{uuid.uuid4()}/assets/{asset_key}", follow_redirects=False
    )
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "PRESENTATION_NOT_FOUND"

    # Faqat BITTA presign bo'ldi — ya'ni "ishlagan" holat.
    assert len(fake_r2.presigned) == 1
    assert fake_r2.presigned[0][0] == f"presentations/{first['id']}/{asset_key}"


# ---------------------------------------------------------------------------
# 11. v1.2 (CONTRACTS.md §16.1): IMAGE / POLL / OPEN slaydlari
# ---------------------------------------------------------------------------

PID = "952c4601-3cbd-4d66-b57a-44bd5a1ee49d"
OTHER_PID = "11111111-2222-4333-8444-555555555555"
KEY = "0123456789abcdef0123456789abcdef.png"


def _our_url(pid: str = PID, key: str = KEY) -> str:
    return f"{settings.BACKEND_PUBLIC_URL.rstrip('/')}{ASSET_URL_PREFIX}/{pid}/assets/{key}"


def _poll(**overrides: Any) -> dict[str, Any]:
    return {
        "index": 0,
        "type": "POLL",
        "question": "Qaysi til yoqadi?",
        "options": ["Python", "SQL"],
        "duration_sec": 60,
        **overrides,
    }


def _open(**overrides: Any) -> dict[str, Any]:
    return {"index": 0, "type": "OPEN", "question": "Bugun nimani o'rgandingiz?", "duration_sec": 120, **overrides}


def _image(**overrides: Any) -> dict[str, Any]:
    return {
        "index": 0,
        "type": "IMAGE",
        "image_url": _our_url(),
        "alt": "Ro'yxat indekslari diagrammasi",
        **overrides,
    }


def test_poll_and_open_valid_and_defaults() -> None:
    poll, opened = validate_slides_data([_poll(), _open(index=1)])
    assert poll.type == "POLL" and poll.options == ["Python", "SQL"]
    assert opened.type == "OPEN" and opened.max_chars == 60  # default (§16.1)


@pytest.mark.parametrize(
    "overrides",
    [
        {"options": ["bitta"]},
        {"options": ["1", "2", "3", "4", "5", "6", "7"]},
        {"options": ["a", "  "]},
        {"duration_sec": 9},
        {"duration_sec": 301},
        {"question": ""},
        {"correct_option": 0},  # POLL da to'g'ri javob YO'Q — extra="forbid"
        {"points": 100},  # XP yo'q
    ],
)
def test_poll_bounds(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        validate_slides_data([_poll(**overrides)])


@pytest.mark.parametrize("ok", [{"duration_sec": 10}, {"duration_sec": 300}, {"options": list("abcdef")}])
def test_poll_edges_accepted(ok: dict[str, Any]) -> None:
    assert validate_slides_data([_poll(**ok)])[0].type == "POLL"


@pytest.mark.parametrize(
    "overrides",
    [
        {"duration_sec": 29},
        {"duration_sec": 601},
        {"max_chars": 9},
        {"max_chars": 201},
        {"question": ""},
        {"options": ["a", "b"]},
        {"correct_option": 1},
    ],
)
def test_open_bounds(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        validate_slides_data([_open(**overrides)])


@pytest.mark.parametrize(
    "ok", [{"duration_sec": 30}, {"duration_sec": 600}, {"max_chars": 10}, {"max_chars": 200}]
)
def test_open_edges_accepted(ok: dict[str, Any]) -> None:
    assert validate_slides_data([_open(**ok)])[0].type == "OPEN"


@pytest.mark.parametrize("alt", [None, "", "   ", "x" * 301])
def test_image_alt_is_required(alt: str | None) -> None:
    payload = _image()
    if alt is None:
        del payload["alt"]
    else:
        payload["alt"] = alt
    with pytest.raises(ValidationError):
        validate_slides_data([payload])


# image_url rad etish matritsasi: HAR BIRI schema darajasida ham rad etiladi.
_GOOD_PATH = f"{ASSET_URL_PREFIX}/{PID}/assets/{KEY}"
REJECTED_IMAGE_URLS = [
    pytest.param("https://evil.example/x.png", id="tashqi-url"),
    pytest.param("http://169.254.169.254/latest/meta-data", id="ssrf-metadata"),
    pytest.param("javascript:alert(1)", id="javascript"),
    pytest.param("JaVaScRiPt:alert(1)", id="javascript-aralash-harf"),
    pytest.param("data:image/png;base64,iVBORw0KGgo=", id="data-uri"),
    pytest.param("file:///etc/passwd", id="file"),
    pytest.param("//evil.example" + _GOOD_PATH, id="protokolsiz"),
    pytest.param(_GOOD_PATH, id="nisbiy-yol"),
    pytest.param("https://evil.example@host.test" + _GOOD_PATH, id="userinfo"),
    pytest.param("http://localhost:8000" + _GOOD_PATH + "?x=1", id="query"),
    pytest.param("http://localhost:8000" + _GOOD_PATH + "#frag", id="fragment"),
    pytest.param("http://localhost:8000" + _GOOD_PATH + "/../../etc", id="traversal-oxirida"),
    pytest.param(f"http://localhost:8000{ASSET_URL_PREFIX}/{PID}/assets/../secret.png", id="traversal-kalit"),
    pytest.param(f"http://localhost:8000{ASSET_URL_PREFIX}/{PID}/assets/{KEY}.svg", id="svg"),
    pytest.param(f"http://localhost:8000{ASSET_URL_PREFIX}/{PID}/assets/short.png", id="kalit-shabloni"),
    pytest.param(f"http://localhost:8000{ASSET_URL_PREFIX}/not-a-uuid/assets/{KEY}", id="id-uuid-emas"),
    pytest.param(f"http://localhost:8000/api/v1/submissions/{PID}/assets/{KEY}", id="boshqa-resurs"),
    pytest.param(f"http://localhost:8000/x{_GOOD_PATH}", id="prefiks-oldida-ortiqcha"),
    pytest.param(" http://localhost:8000" + _GOOD_PATH, id="bosh-bo'shliq"),
    pytest.param("http://localhost:8000" + _GOOD_PATH + "\n", id="yangi-qator"),
    pytest.param("http://local host:8000" + _GOOD_PATH, id="ichki-bo'shliq"),
    pytest.param("http://localhost:8000" + _GOOD_PATH.replace("/", "\\", 3), id="teskari-slesh"),
    pytest.param("", id="bo'sh"),
    pytest.param("x" * 700, id="juda-uzun"),
]


@pytest.mark.parametrize("image_url", REJECTED_IMAGE_URLS)
def test_image_url_rejected_by_schema(image_url: str) -> None:
    with pytest.raises(ValidationError) as exc:
        validate_slides_data([_image(image_url=image_url)])
    assert "image_url" in str(exc.value)


def test_image_url_accepts_our_stable_url_and_source() -> None:
    slide = validate_slides_data(
        [_image(source={"kind": "PDF", "page": 3}, title="3-sahifa", notes="eslatma")]
    )[0]
    assert slide.image_url == _our_url()
    assert slide.source is not None and slide.source.page == 3


@pytest.mark.parametrize("source", [{"kind": "DOCX"}, {"kind": "PDF", "page": 0}, {"kind": "PDF", "x": 1}])
def test_image_source_bounds(source: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        validate_slides_data([_image(source=source)])


def test_deck_limit_is_100_slides() -> None:
    def deck(n: int) -> list[dict[str, Any]]:
        return [{"index": i, "type": "MARKDOWN", "content": "x"} for i in range(n)]

    assert len(validate_slides_data(deck(100))) == 100
    with pytest.raises(ValidationError):
        validate_slides_data(deck(101))
    with pytest.raises(ValidationError):
        PresentationCreate(title="t", module_number=1, lesson_number=1, slides_data=deck(101))


def test_all_six_types_in_one_deck_roundtrip() -> None:
    raw = [
        {"index": 0, "type": "MARKDOWN", "content": "a"},
        {"index": 1, "type": "CODE", "code_lang": "python", "starter_code": "x=1"},
        _quiz(index=2),
        _image(index=3),
        _poll(index=4),
        _open(index=5),
    ]
    slides = validate_slides_data(raw)
    assert [s.type for s in slides] == ["MARKDOWN", "CODE", "QUIZ", "IMAGE", "POLL", "OPEN"]
    assert validate_slides_data(dump_slides_data(slides)) == slides


# --- /join redaksiyasi (§15): POLL/OPEN/IMAGE ga TEGMAydi, correct_option faqat QUIZ da ---


def test_redaction_leaves_poll_open_image_untouched() -> None:
    from app.schemas.room import redact_slides_for_student

    slides = validate_slides_data([_quiz(index=0), _image(index=1), _poll(index=2), _open(index=3)])
    dumped = dump_slides_data(slides)
    redacted = redact_slides_for_student(dumped)

    assert "correct_option" in dumped[0] and "correct_option" not in redacted[0]
    for original, safe in zip(dumped[1:], redacted[1:], strict=True):
        assert safe == original  # hech narsa olib tashlanmadi
        assert "correct_option" not in original  # ular uchun sxemada bunday maydon umuman yo'q
    # Yangi turlarda boshqa "sir" maydonlari ham yo'q:
    assert set(redacted[2]) == {"index", "title", "type", "question", "options", "duration_sec"}
    assert set(redacted[3]) == {"index", "title", "type", "question", "duration_sec", "max_chars"}
    assert set(redacted[1]) == {"index", "title", "type", "image_url", "alt", "notes", "source"}


# --- Yozish vaqtidagi egalik tekshiruvi (unit) ---


@pytest.mark.parametrize(
    ("url", "presentation_id", "public_url", "ok"),
    [
        (_our_url(PID), PID, "http://localhost:8000", True),
        (_our_url(OTHER_PID), PID, "http://localhost:8000", False),  # boshqa taqdimot asseti
        (_our_url(PID), None, "http://localhost:8000", False),  # yangi taqdimot: ID yo'q
        (_our_url(PID), PID, "https://api.syncclass.uz", False),  # boshqa host
        (_our_url(PID).replace("http://", "https://"), PID, "http://localhost:8000", False),  # sxema
        (_our_url(PID).replace("localhost:8000", "localhost:9999"), PID, "http://localhost:8000", False),  # port
        (_our_url(PID).replace("localhost:8000", "LOCALHOST:8000"), PID, "http://localhost:8000", True),  # registr
    ],
)
def test_assert_images_belong_to(url: str, presentation_id: str | None, public_url: str, ok: bool) -> None:
    from app.schemas.slide import assert_images_belong_to

    slides = validate_slides_data([{"index": 0, "type": "MARKDOWN", "content": "a"}, _image(index=1, image_url=url)])
    pid = uuid.UUID(presentation_id) if presentation_id else None
    problems = assert_images_belong_to(slides, pid, public_url=public_url)
    assert (problems == []) is ok
    if not ok:
        assert problems[0][0] == 1  # IMAGE slaydning indeksi


# --- HAQIQIY endpointlar ---


async def test_endpoint_rejects_image_on_create(api: dict[str, Any]) -> None:
    """Yangi taqdimotning ID si yo'q → unga tegishli asset ham yo'q → 422."""
    client: AsyncClient = api["client"]
    response = await client.post(_BASE, json=_create_body(slides_data=[_image()]))
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "VALIDATION_ERROR"
    assert "slides_data.0.image_url" in detail["fields"]
    # Foydalanuvchiga to'g'ri yo'l aytiladi (sabab: ID yo'q), shunchaki "noto'g'ri" emas:
    assert "avval taqdimotni saqlang" in detail["fields"]["slides_data.0.image_url"]


async def test_endpoint_image_patch_matrix(api: dict[str, Any]) -> None:
    client: AsyncClient = api["client"]
    mine = (await client.post(_BASE, json=_create_body())).json()
    other = (await client.post(_BASE, json=_create_body(title="Boshqasi"))).json()

    cases = {
        "own": (_our_url(mine["id"]), 200),
        "other-presentation": (_our_url(other["id"]), 422),
        "external": ("https://evil.example/x.png", 422),
        "javascript": ("javascript:alert(1)", 422),
        "data": ("data:image/png;base64,AAAA", 422),
        "other-host": (_our_url(mine["id"]).replace("localhost:8000", "evil.example"), 422),
    }
    for name, (url, expected) in cases.items():
        response = await client.patch(
            f"{_BASE}/{mine['id']}", json={"slides_data": [_image(image_url=url)]}
        )
        assert response.status_code == expected, f"{name}: {response.text}"

    # Rad etilganlari saqlanmadi: faqat "own" holati yozilgan.
    stored = (await client.get(f"{_BASE}/{mine['id']}")).json()
    assert [s["image_url"] for s in stored["slides_data"]] == [_our_url(mine["id"])]


async def test_endpoint_image_422_has_standard_error_shape(api: dict[str, Any]) -> None:
    """Pydantic 422 bilan bir xil konvert: {detail:{code:VALIDATION_ERROR, fields:{...}}}."""
    client: AsyncClient = api["client"]
    mine = (await client.post(_BASE, json=_create_body())).json()
    other = (await client.post(_BASE, json=_create_body(title="Boshqasi"))).json()

    response = await client.patch(
        f"{_BASE}/{mine['id']}",
        json={"slides_data": [{"index": 0, "type": "MARKDOWN", "content": "a"}, _image(index=1, image_url=_our_url(other["id"]))]},
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "VALIDATION_ERROR"
    assert list(detail["fields"]) == ["slides_data.1.image_url"]
    assert "boshqa taqdimot" in detail["fields"]["slides_data.1.image_url"]


async def test_endpoint_stores_poll_open_and_returns_defaults(api: dict[str, Any]) -> None:
    client: AsyncClient = api["client"]
    created = await client.post(
        _BASE, json=_create_body(slides_data=[_poll(index=0), _open(index=1)])
    )
    assert created.status_code == 201, created.text
    slides = created.json()["slides_data"]
    assert [s["type"] for s in slides] == ["POLL", "OPEN"]
    assert slides[1]["max_chars"] == 60
    fetched = (await client.get(f"{_BASE}/{created.json()['id']}")).json()
    assert fetched["slides_data"] == slides


async def test_upload_url_is_accepted_as_image_url(
    api: dict[str, Any], fake_r2: _R2Calls
) -> None:
    """Zanjir: POST .../assets qaytargan URL → PATCH da IMAGE.image_url sifatida qabul qilinadi."""
    client: AsyncClient = api["client"]
    created = (await client.post(_BASE, json=_create_body())).json()
    uploaded = await client.post(
        f"{_BASE}/{created['id']}/assets", files={"file": ("rasm.png", PNG_1X1, "image/png")}
    )
    url = uploaded.json()["url"]

    patched = await client.patch(
        f"{_BASE}/{created['id']}",
        json={"slides_data": [_image(image_url=url, source={"kind": "UPLOAD"})]},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["slides_data"][0]["image_url"] == url
