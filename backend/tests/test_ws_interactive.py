"""v1.2 interaktiv slaydlar: POLL va OPEN (CONTRACTS.md §16.3, §16.5).

Hamma tekshiruv HAQIQIY kadrlarda: haqiqiy uvicorn, haqiqiy `websockets`
klienti, haqiqiy Redis. `Recorder` har bir kelgan xom kadrni saqlaydi —
maxfiylik talablari ("o'quvchi `POLL_PROGRESS` olmaydi", "OPEN kadrlarida
`student_id` yo'q") faqat KELGAN HAMMA narsaga qarab isbotlanadi, kutilgan
bitta kadrga qarab emas.

Seed prezentatsiyasida POLL/OPEN slaydi yo'q, shuning uchun har test o'z
prezentatsiyasini yaratadi va oxirida o'chiradi.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
from redis.asyncio import Redis
from sqlalchemy import delete, select

from app.core.config import settings
from app.db.models import Presentation, User
from app.services.room_state import (
    INTERACTIVE_RETAIN_SEC,
    RoomState,
    interactive_registry_key,
    members_key,
    poll_key,
    state_key,
)
from tests.test_ws_sync import (
    Api,
    db_session,
    drop_session,
    load_fixture,
    redis_client,
    run_test_server,
    ticket_for,
)

WS_TIMEOUT = 5.0

POLL_OPTIONS = ["Python", "Go", "Rust"]
IA_SLIDES: list[dict[str, Any]] = [
    {"index": 0, "type": "MARKDOWN", "title": "Kirish", "content": "# Salom"},
    {
        "index": 1,
        "type": "POLL",
        "title": "So'rovnoma",
        "question": "Qaysi tilni o'rganmoqchisiz?",
        "options": POLL_OPTIONS,
        "duration_sec": 60,
    },
    {
        "index": 2,
        "type": "OPEN",
        "title": "So'z buluti",
        "question": "Bir so'z bilan: dasturlash nima?",
        "duration_sec": 60,
        "max_chars": 20,
    },
    # Turi POLL, lekin yaroqsiz (variant bitta) — server ishonmasligi kerak.
    {"index": 3, "type": "POLL", "question": "Buzuq", "options": ["Yolg'iz"], "duration_sec": 60},
]

POLL_START_KEYS = {"poll_id", "slide_index", "question", "options", "duration_sec", "ends_at"}
OPEN_START_KEYS = {"open_id", "slide_index", "question", "duration_sec", "ends_at", "max_chars"}
LIVE_ONLY_KEYS = {"poll_progress", "open_update", "distribution", "answers"}


# ===========================================================================
# Yordamchilar
# ===========================================================================


@pytest.fixture(scope="module")
def base_url() -> Iterator[str]:
    """Shu modul uchun o'z uvicorn serveri (scope sababi: `run_test_server`)."""
    with run_test_server() as url:
        yield url


@pytest.fixture(autouse=True)
async def _reset_join_limits() -> AsyncIterator[None]:
    """`POST /join` brute-force hisoblagichlari testlar orasida tozalanadi."""
    async with redis_client() as redis:
        keys = [key async for key in redis.scan_iter(match="ratelimit:room_join*")]
        if keys:
            await redis.delete(*keys)
    yield


class Recorder:
    """WS klienti: har bir kelgan xom kadrni saqlaydi."""

    def __init__(self, sock: Any, label: str) -> None:
        self.sock = sock
        self.label = label
        self.frames: list[str] = []

    async def send(self, event: str, data: dict[str, Any] | None = None) -> None:
        await self.sock.send(json.dumps({"v": 1, "type": event, "data": data or {}}))

    async def next(self, expect: str, wait_sec: float = WS_TIMEOUT) -> dict[str, Any]:
        try:
            async with asyncio.timeout(wait_sec):
                while True:
                    raw = await self.sock.recv()
                    self.frames.append(raw)
                    envelope = json.loads(raw)
                    if envelope.get("type") == expect:
                        return envelope
        except TimeoutError:
            raise AssertionError(f"[{self.label}] `{expect}` kutildi, kelmadi") from None

    async def error(self, event: str, data: dict[str, Any] | None = None) -> str:
        """Xato kutilgan buyruq: `ERROR.data.code` ni qaytaradi."""
        await self.send(event, data)
        return str((await self.next("ERROR"))["data"]["code"])

    async def drain(self, quiet: float = 0.3) -> None:
        """Navbatdagi barcha kadrlarni yig'ib oladi (sukunatgacha)."""
        with contextlib.suppress(TimeoutError):
            while True:
                async with asyncio.timeout(quiet):
                    self.frames.append(await self.sock.recv())

    def types(self) -> list[str]:
        return [json.loads(f)["type"] for f in self.frames]

    def of_type(self, prefix: str) -> list[str]:
        return [f for f in self.frames if json.loads(f)["type"].startswith(prefix)]


@contextlib.asynccontextmanager
async def connect(host: str, pin: str, user_id: uuid.UUID, label: str):
    import websockets

    ticket = await ticket_for(user_id)
    async with websockets.connect(f"ws://{host}/ws/room/{pin}?ticket={ticket}") as sock:
        rec = Recorder(sock, label)
        yield rec


def keys_deep(value: Any) -> set[str]:
    """Ichma-ich obyektdagi BARCHA kalitlar (snapshotda yashirin maydon qolmasin)."""
    found: set[str] = set()
    if isinstance(value, dict):
        for key, inner in value.items():
            found.add(key)
            found |= keys_deep(inner)
    elif isinstance(value, list):
        for inner in value:
            found |= keys_deep(inner)
    return found


class Room:
    """Test uchun xona: POLL/OPEN slaydli prezentatsiya + sessiya."""

    def __init__(self, api: Api, fx: Any, presentation_id: uuid.UUID, pin: str, sid: uuid.UUID):
        self.api = api
        self.fx = fx
        self.presentation_id = presentation_id
        self.pin = pin
        self.session_id = sid


@contextlib.asynccontextmanager
async def ia_room(base_url: str, students: int) -> AsyncIterator[Room]:
    fx = await load_fixture()
    async with db_session() as db:
        presentation = Presentation(
            teacher_id=fx.teacher,
            title="Interaktiv test",
            module_number=1,
            lesson_number=1,
            slides_data=IA_SLIDES,
        )
        db.add(presentation)
        await db.commit()
        presentation_id = presentation.id

    api = Api(base_url)
    created = await api.create_room(fx.teacher, fx.p30_id, presentation_id)
    assert created.status_code == 201, created.text
    pin = created.json()["pin_code"]
    sid = uuid.UUID(created.json()["session_id"])
    try:
        for student in fx.p30_students[:students]:
            joined = await api.call("POST", f"/rooms/{pin}/join", student)
            assert joined.status_code == 200, joined.text
        yield Room(api, fx, presentation_id, pin, sid)
    finally:
        await drop_session(sid)
        async with db_session() as db:
            await db.execute(delete(Presentation).where(Presentation.id == presentation_id))
            await db.commit()


async def identities(user_ids: list[uuid.UUID]) -> list[str]:
    """Kadrlarda BO'LMASLIGI kerak bo'lgan har bir identifikator shakli."""
    async with db_session() as db:
        users = (await db.execute(select(User).where(User.id.in_(user_ids)))).scalars().all()
    out: list[str] = []
    for user in users:
        out += [str(user.id), user.id.hex, user.full_name, user.email]
    return out


async def joined(teacher: Recorder, students: list[Recorder]) -> None:
    """Hamma o'quvchining `STUDENT_JOINED` i o'qituvchiga yetib kelguncha kutadi."""
    for _ in students:
        await teacher.next("STUDENT_JOINED")


async def lesson_started(teacher: Recorder, students: list[Recorder]) -> None:
    """LOBBY -> LIVE: o'qituvchining birinchi `SLIDE_CHANGE` i ("Darsni boshlash").

    O'qituvchining shunchaki ulanishi endi darsni BOSHLAMAYDI (o'quvchilar
    lobbida kutadi) — interaktivlar esa faqat LIVE xonada ochiladi (§16.5).
    """
    await teacher.send("SLIDE_CHANGE", {"slide_index": 0})
    await teacher.next("SLIDE_CHANGE")
    for s in students:
        await s.next("SLIDE_CHANGE")


# ===========================================================================
# 1. POLL: to'liq oqim, jonli taqsimot faqat o'qituvchiga
# ===========================================================================


async def test_poll_full_flow_live_distribution_is_teacher_only(base_url: str) -> None:
    async with ia_room(base_url, students=2) as room:
        s1_id, s2_id = room.fx.p30_students[:2]
        async with (
            connect(base_url, room.pin, room.fx.teacher, "teacher") as teacher,
            connect(base_url, room.pin, s1_id, "s1") as s1,
            connect(base_url, room.pin, s2_id, "s2") as s2,
        ):
            await teacher.next("ROOM_STATE_SYNC")
            await s1.next("ROOM_STATE_SYNC")
            await s2.next("ROOM_STATE_SYNC")
            await joined(teacher, [s1, s2])
            await lesson_started(teacher, [s1, s2])

            await teacher.send("POLL_START", {"slide_index": 1})
            start = await s1.next("POLL_START")
            await s2.next("POLL_START")
            await teacher.next("POLL_START")
            data = start["data"]
            print("\nPOLL_START   ->", json.dumps(start, ensure_ascii=False))
            # Aynan kontraktdagi maydonlar — hech narsa ortiq emas.
            assert set(data) == POLL_START_KEYS
            assert data["options"] == POLL_OPTIONS
            assert data["question"] == IA_SLIDES[1]["question"]
            assert data["duration_sec"] == 60 and data["ends_at"]
            poll_id = data["poll_id"]

            await s1.send("POLL_VOTE", {"poll_id": poll_id, "selected_index": 1})
            progress = await teacher.next("POLL_PROGRESS")
            print("POLL_PROGRESS->", json.dumps(progress, ensure_ascii=False))
            assert progress["data"] == {
                "poll_id": poll_id, "voted": 1, "total": 2, "distribution": [0, 1, 0],
            }

            # Ikki marta ovoz → ALREADY_VOTED, taqsimot o'zgarmaydi.
            assert await s1.error("POLL_VOTE", {"poll_id": poll_id, "selected_index": 2}) == (
                "ALREADY_VOTED"
            )
            # Mavjud bo'lmagan variant → INVALID_OPTION (BAD_PAYLOAD emas).
            assert await s2.error("POLL_VOTE", {"poll_id": poll_id, "selected_index": 7}) == (
                "INVALID_OPTION"
            )
            assert await s2.error("POLL_VOTE", {"poll_id": poll_id, "selected_index": -1}) == (
                "INVALID_OPTION"
            )
            # Boshqa poll_id → POLL_NOT_ACTIVE.
            assert await s2.error("POLL_VOTE", {"poll_id": "poll-yoq", "selected_index": 0}) == (
                "POLL_NOT_ACTIVE"
            )

            await s2.send("POLL_VOTE", {"poll_id": poll_id, "selected_index": 0})
            progress = await teacher.next("POLL_PROGRESS")
            assert progress["data"]["voted"] == 2
            assert progress["data"]["distribution"] == [1, 1, 0]

            await teacher.send("POLL_END", {"poll_id": poll_id})
            results = await s1.next("POLL_RESULTS")
            await s2.next("POLL_RESULTS")
            await teacher.next("POLL_RESULTS")
            print("POLL_RESULTS ->", json.dumps(results, ensure_ascii=False))
            assert results["data"] == {
                "poll_id": poll_id,
                "options": POLL_OPTIONS,
                "distribution": [1, 1, 0],
                "total": 2,  # §16.5: sum(distribution)
            }

            # Yakundan keyin ovoz → POLL_NOT_ACTIVE.
            assert await s1.error("POLL_VOTE", {"poll_id": poll_id, "selected_index": 0}) == (
                "POLL_NOT_ACTIVE"
            )
            # Yakunlangan pollni qayta yakunlash ham.
            assert await teacher.error("POLL_END", {"poll_id": poll_id}) == "POLL_NOT_ACTIVE"

            for student in (s1, s2):
                await student.drain()
                # O'quvchi jonli taqsimotni HECH QACHON olmaydi — yakunda natija.
                assert "POLL_PROGRESS" not in student.types(), student.label
                assert "POLL_RESULTS" in student.types()


# ===========================================================================
# 2. Muddat: `ends_at` server belgilaydi, o'tgach ovoz rad etiladi
# ===========================================================================


async def test_vote_after_deadline_is_rejected(base_url: str) -> None:
    """Muddatni Redis da o'tmishga suramiz — 60 s kutish o'rniga.

    Bu server qoidasining o'zini tekshiradi: rad etish Lua ichida, server
    yozgan `deadline` kalitiga qarab. Klient `ends_at` ga umuman ishonilmaydi.
    """
    async with ia_room(base_url, students=1) as room:
        student_id = room.fx.p30_students[0]
        async with (
            connect(base_url, room.pin, room.fx.teacher, "teacher") as teacher,
            connect(base_url, room.pin, student_id, "s1") as student,
        ):
            await teacher.next("ROOM_STATE_SYNC")
            await student.next("ROOM_STATE_SYNC")
            await lesson_started(teacher, [student])

            await teacher.send("POLL_START", {"slide_index": 1})
            poll_id = (await student.next("POLL_START"))["data"]["poll_id"]
            await teacher.send("OPEN_START", {"slide_index": 2})
            open_id = (await student.next("OPEN_START"))["data"]["open_id"]

            async with redis_client() as redis:
                await redis.set(poll_key(room.session_id, poll_id, "deadline"), "1")
                await redis.set(f"room:{room.session_id}:open:{open_id}:deadline", "1")

            assert await student.error(
                "POLL_VOTE", {"poll_id": poll_id, "selected_index": 0}
            ) == "POLL_NOT_ACTIVE"
            assert await student.error(
                "OPEN_ANSWER", {"open_id": open_id, "text": "kech"}
            ) == "OPEN_NOT_ACTIVE"

            # Muddat o'tgani hech narsani o'chirmaydi: o'qituvchi natijani oladi.
            await teacher.send("POLL_END", {"poll_id": poll_id})
            results = await student.next("POLL_RESULTS")
            assert results["data"]["distribution"] == [0, 0, 0]


# ===========================================================================
# 3. Rol-guard, xona holati va slayd turi (server slaydni o'zi o'qiydi)
# ===========================================================================


async def test_role_guard_room_status_and_slide_type(base_url: str) -> None:
    async with ia_room(base_url, students=1) as room:
        student_id = room.fx.p30_students[0]
        async with (
            connect(base_url, room.pin, room.fx.teacher, "teacher") as teacher,
            connect(base_url, room.pin, student_id, "s1") as student,
        ):
            await teacher.next("ROOM_STATE_SYNC")
            await student.next("ROOM_STATE_SYNC")
            await lesson_started(teacher, [student])

            # STUDENT o'qituvchi buyruqlarini yubora olmaydi (§16.3: FORBIDDEN_EVENT).
            for event, data in (
                ("POLL_START", {"slide_index": 1}),
                ("POLL_END", {"poll_id": "x"}),
                ("OPEN_START", {"slide_index": 2}),
                ("OPEN_HIDE", {"open_id": "x", "answer_id": "y"}),
                ("OPEN_END", {"open_id": "x"}),
            ):
                assert await student.error(event, data) == "FORBIDDEN_EVENT", event
            # Teskarisi: o'qituvchi ovoz bera olmaydi.
            assert await teacher.error(
                "POLL_VOTE", {"poll_id": "x", "selected_index": 0}
            ) == "FORBIDDEN_EVENT"
            assert await teacher.error(
                "OPEN_ANSWER", {"open_id": "x", "text": "a"}
            ) == "FORBIDDEN_EVENT"

            # Klient savol/variant yubora OLMAYDI — faqat `slide_index`.
            assert await teacher.error(
                "POLL_START", {"slide_index": 1, "question": "buzilgan", "options": ["a", "b"]}
            ) == "BAD_PAYLOAD"

            # Slayd turi mos emas yoki slayd yaroqsiz → NOT_A_POLL / NOT_AN_OPEN.
            assert await teacher.error("POLL_START", {"slide_index": 0}) == "NOT_A_POLL"
            assert await teacher.error("POLL_START", {"slide_index": 2}) == "NOT_A_POLL"
            assert await teacher.error("POLL_START", {"slide_index": 3}) == "NOT_A_POLL"
            assert await teacher.error("POLL_START", {"slide_index": 99}) == "NOT_A_POLL"
            assert await teacher.error("OPEN_START", {"slide_index": 1}) == "NOT_AN_OPEN"

            # Xona holati (Redis — yagona haqiqat manbasi).
            async with redis_client() as redis:
                key = state_key(room.session_id)
                await redis.hset(key, "status", "LOBBY")
                assert await teacher.error("POLL_START", {"slide_index": 1}) == "ROOM_NOT_LIVE"
                assert await teacher.error("OPEN_START", {"slide_index": 2}) == "ROOM_NOT_LIVE"
                await redis.hset(key, "status", "ENDED")
                assert await teacher.error("POLL_START", {"slide_index": 1}) == "ROOM_ENDED"
                await redis.hset(key, "status", "LIVE")

            await teacher.send("POLL_START", {"slide_index": 1})
            await student.next("POLL_START")

            await student.drain()
            # Rad etilgan buyruqlarning hech biri o'quvchiga hech narsa yubormagan.
            assert student.types().count("POLL_START") == 1
            assert "OPEN_START" not in student.types()


# ===========================================================================
# 4. OPEN: anonimlik (HAQIQIY kadrlarda), tozalash, moderatsiya
# ===========================================================================


async def test_open_flow_is_anonymous_sanitized_and_moderated(base_url: str) -> None:
    async with ia_room(base_url, students=3) as room:
        ids = room.fx.p30_students[:3]
        async with (
            connect(base_url, room.pin, room.fx.teacher, "teacher") as teacher,
            connect(base_url, room.pin, ids[0], "s1") as s1,
            connect(base_url, room.pin, ids[1], "s2") as s2,
            connect(base_url, room.pin, ids[2], "s3") as s3,
        ):
            students = [s1, s2, s3]
            await teacher.next("ROOM_STATE_SYNC")
            for s in students:
                await s.next("ROOM_STATE_SYNC")
            await joined(teacher, students)
            await lesson_started(teacher, students)

            await teacher.send("OPEN_START", {"slide_index": 2})
            start = await s1.next("OPEN_START")
            print("\nOPEN_START   ->", json.dumps(start, ensure_ascii=False))
            assert set(start["data"]) == OPEN_START_KEYS
            assert start["data"]["max_chars"] == 20
            open_id = start["data"]["open_id"]

            # Tozalash: trim + bo'shliqlarni yig'ish + kichik harf.
            await s1.send("OPEN_ANSWER", {"open_id": open_id, "text": "  Python\n"})
            update = await teacher.next("OPEN_UPDATE")
            print("OPEN_UPDATE  ->", json.dumps(update, ensure_ascii=False))
            assert update["data"]["answered"] == 1 and update["data"]["total"] == 3
            [row] = update["data"]["answers"]
            assert row["text"] == "python" and row["count"] == 1
            python_id = row["answer_id"]

            # Katta harf/bo'shliq farqi bir xil javobga tushadi (bitta answer_id).
            await s2.send("OPEN_ANSWER", {"open_id": open_id, "text": "PYTHON"})
            update = await teacher.next("OPEN_UPDATE")
            assert update["data"]["answers"] == [
                {"answer_id": python_id, "text": "python", "count": 2}
            ]

            # 1 javob / 2 s.
            assert await s1.error("OPEN_ANSWER", {"open_id": open_id, "text": "go"}) == (
                "RATE_LIMITED"
            )
            # Xom kirish `min(4*max_chars, 1000)` = 80 dan uzun → ANSWER_TOO_LONG.
            assert await s3.error("OPEN_ANSWER", {"open_id": open_id, "text": "x" * 81}) == (
                "ANSWER_TOO_LONG"
            )
            # Faqat boshqaruv/ko'rinmas belgilar → tozalangach bo'sh.
            assert await s3.error(
                "OPEN_ANSWER", {"open_id": open_id, "text": "‮​ \t"}
            ) == "BAD_PAYLOAD"
            # 80 belgigacha QABUL qilinadi, lekin `max_chars` (20) ga qirqiladi;
            # yo'nalishni aldaydigan U+202E olib tashlanadi.
            await s3.send(
                "OPEN_ANSWER",
                {"open_id": open_id, "text": "‮Juda   uzun javob matni, qirqilishi kerak"},
            )
            update = await teacher.next("OPEN_UPDATE")
            texts = {r["text"] for r in update["data"]["answers"]}
            assert "juda uzun javob matn" in texts
            assert all(len(t) <= 20 for t in texts)

            # Bir o'quvchi — bitta javob: oxirgisi yoziladi, eskisi kamayadi.
            await asyncio.sleep(2.1)
            await s1.send("OPEN_ANSWER", {"open_id": open_id, "text": "Go"})
            update = await teacher.next("OPEN_UPDATE")
            counts = {r["text"]: r["count"] for r in update["data"]["answers"]}
            assert counts["python"] == 1 and counts["go"] == 1
            assert update["data"]["answered"] == 3  # ishtirokchilar soni o'zgarmaydi
            go_id = next(r["answer_id"] for r in update["data"]["answers"] if r["text"] == "go")

            # Moderatsiya: yashirilgan javob OPEN_UPDATE dan ham chiqadi (§16.5).
            await teacher.send("OPEN_HIDE", {"open_id": open_id, "answer_id": go_id})
            update = await teacher.next("OPEN_UPDATE")
            assert "go" not in {r["text"] for r in update["data"]["answers"]}

            await teacher.send("OPEN_END", {"open_id": open_id})
            results = await s1.next("OPEN_RESULTS")
            print("OPEN_RESULTS ->", json.dumps(results, ensure_ascii=False))
            # So'z buluti: yashirilgan yo'q, `answer_id` yo'q (faqat {text, count}).
            answers = results["data"]["answers"]
            assert {r["text"] for r in answers} == {"python", "juda uzun javob matn"}
            assert all(set(r) == {"text", "count"} for r in answers)
            assert await s2.error("OPEN_ANSWER", {"open_id": open_id, "text": "kech"}) == (
                "OPEN_NOT_ACTIVE"
            )

            # --- ANONIMLIK: kelgan HAR BIR OPEN_* kadrda, HAR BIR rol uchun ---
            await teacher.drain()
            for s in students:
                await s.drain()
            secrets_ = await identities(ids)
            everyone = [teacher, *students]
            open_frames = [f for rec in everyone for f in rec.of_type("OPEN_")]
            assert len(open_frames) >= 10, "tekshiruv bo'sh bo'lmasin"
            for frame in open_frames:
                for secret in secrets_:
                    assert secret not in frame, f"OPEN kadrida shaxs ma'lumoti: {frame}"
                assert "student_id" not in frame and "full_name" not in frame

            # OPEN_UPDATE (moderatsiya ro'yxati) faqat o'qituvchiga.
            for s in students:
                assert "OPEN_UPDATE" not in s.types(), s.label
                assert "OPEN_RESULTS" in s.types()


# ===========================================================================
# 5. Reconnect: holat tiklanadi; jonli ma'lumot faqat O'QITUVCHI snapshotida
# ===========================================================================


async def test_reconnect_restores_state_and_live_data_reaches_teacher_only(
    base_url: str,
) -> None:
    """§16.3 K4: o'quvchi snapshotida `poll_progress`/`open_update`/`distribution`
    YO'Q, o'qituvchida BOR. Quiz sirini oqizgan xato turi — shuning uchun
    ikkala rol ham HAQIQIY `ROOM_STATE_SYNC` kadrida tekshiriladi.
    """
    async with ia_room(base_url, students=2) as room:
        s1_id, s2_id = room.fx.p30_students[:2]
        async with connect(base_url, room.pin, room.fx.teacher, "teacher") as teacher:
            await teacher.next("ROOM_STATE_SYNC")
            async with connect(base_url, room.pin, s1_id, "s1") as s1:
                await s1.next("ROOM_STATE_SYNC")
                await lesson_started(teacher, [s1])
                await teacher.send("POLL_START", {"slide_index": 1})
                poll_start = (await s1.next("POLL_START"))["data"]
                await teacher.send("OPEN_START", {"slide_index": 2})
                open_start = (await s1.next("OPEN_START"))["data"]
                await s1.send("POLL_VOTE", {"poll_id": poll_start["poll_id"], "selected_index": 2})
                await teacher.next("POLL_PROGRESS")
                await s1.send("OPEN_ANSWER", {"open_id": open_start["open_id"], "text": "Maxfiy"})
                await teacher.next("OPEN_UPDATE")

            # --- O'quvchi qayta ulandi (sahifani yangiladi) ---
            async with connect(base_url, room.pin, s1_id, "s1-again") as again:
                sync = await again.next("ROOM_STATE_SYNC")
                raw = again.frames[-1]
                print("\nSTUDENT ROOM_STATE_SYNC.active_poll ->",
                      json.dumps(sync["data"]["active_poll"], ensure_ascii=False))
                data = sync["data"]
                # Holat tiklandi: aynan `*_START` dagi ommaviy maydonlar.
                assert data["active_poll"] == poll_start
                assert data["active_open"] == open_start
                # Jonli ma'lumot YO'Q — ichma-ich hech qayerda.
                leaked = keys_deep(data) & LIVE_ONLY_KEYS
                assert not leaked, f"o'quvchi snapshotida jonli ma'lumot: {leaked}"
                assert "maxfiy" not in raw.lower(), "OPEN javobi o'quvchi snapshotiga tushdi"

            # REST zaxira (`GET /rooms/{pin}`): ommaviy holat BOR, jonli ma'lumot
            # HECH BIR rol uchun yo'q — o'qituvchi uchun ham (javob rolga bog'liq emas).
            for actor in (s1_id, room.fx.teacher):
                rest = await room.api.call("GET", f"/rooms/{room.pin}", actor)
                assert rest.status_code == 200, rest.text
                body = rest.json()
                if actor == room.fx.teacher:
                    print("REST GET /rooms (o'qituvchi) active_poll/active_open ->",
                          json.dumps({k: body[k] for k in ("active_poll", "active_open")},
                                     ensure_ascii=False))
                assert body["active_poll"] == poll_start
                assert body["active_open"] == open_start
                leaked = keys_deep(body) & LIVE_ONLY_KEYS
                assert not leaked, f"REST javobida jonli ma'lumot ({actor}): {leaked}"
                assert "maxfiy" not in rest.text.lower(), "OPEN javobi REST ga tushdi"

            # Kech kirgan BOSHQA o'quvchi ham xuddi shunday.
            async with connect(base_url, room.pin, s2_id, "s2") as late:
                data = (await late.next("ROOM_STATE_SYNC"))["data"]
                assert data["active_poll"] == poll_start
                assert not keys_deep(data) & LIVE_ONLY_KEYS
                # U hali ovoz bermagan — ovoz bera oladi.
                await late.send(
                    "POLL_VOTE", {"poll_id": poll_start["poll_id"], "selected_index": 0}
                )
                await teacher.next("POLL_PROGRESS")

        # --- O'qituvchi qayta ulandi: diagramma YO'QOLMAYDI ---
        async with connect(base_url, room.pin, room.fx.teacher, "teacher-again") as t2:
            sync = await t2.next("ROOM_STATE_SYNC")
            data = sync["data"]
            print("TEACHER ROOM_STATE_SYNC.poll_progress ->",
                  json.dumps(data["poll_progress"], ensure_ascii=False))
            print("TEACHER ROOM_STATE_SYNC.open_update   ->",
                  json.dumps(data["open_update"], ensure_ascii=False))
            assert data["active_poll"] == poll_start
            assert data["poll_progress"]["poll_id"] == poll_start["poll_id"]
            assert data["poll_progress"]["distribution"] == [1, 0, 1]
            assert data["poll_progress"]["voted"] == 2
            assert data["open_update"]["open_id"] == open_start["open_id"]
            assert [r["text"] for r in data["open_update"]["answers"]] == ["maxfiy"]
            # O'qituvchi snapshotida ham OPEN anonim.
            for secret in await identities([s1_id, s2_id]):
                assert secret not in json.dumps(data["open_update"], ensure_ascii=False)


# ===========================================================================
# 6. Bir o'quvchi — bir ovoz: 30 ta parallel so'rov (poyga yo'q)
# ===========================================================================


async def test_thirty_concurrent_votes_are_atomic() -> None:
    """Tekshirib-keyin-yozish poygasi bo'lsa, bir xil o'quvchining parallel
    ovozlaridan bir nechtasi o'tib ketardi. Lua (`HSETNX`+`HINCRBY`) bilan
    aynan bittasi o'tadi.

    MUHIM: 30 ta so'rov HAQIQATAN bir vaqtda bo'lishi uchun har biri o'z
    OLDINDAN ULANGAN klientida (alohida worker lar kabi). Bitta klient pool i
    yangi ulanishlarni navbat bilan ochadi va so'rovlarni amalda ketma-ket
    qilib qo'yadi — shunda poyga yashirinib, test hech narsani isbotlamas edi
    (mutatsiya bilan tekshirilgan: Python da `HEXISTS` → yozish poygasi eski
    variantda O'TIB KETGAN).
    """
    session_id = uuid.uuid4()
    poll_id = "poll-parallel"
    clients = [Redis.from_url(settings.REDIS_URL, decode_responses=True) for _ in range(30)]
    states = [RoomState(c, session_id) for c in clients]
    try:
        await asyncio.gather(*(c.ping() for c in clients))  # 30 ta ulanish tayyor
        admin, redis = states[0], clients[0]
        await admin.ensure(status="LIVE")
        students = [str(uuid.uuid4()) for _ in range(30)]
        await redis.hset(
            members_key(session_id),
            mapping={sid: json.dumps({"student_id": sid}) for sid in students},
        )
        await admin.start_poll(
            {
                "poll_id": poll_id,
                "slide_index": 1,
                "question": "?",
                "options": POLL_OPTIONS,
                "duration_sec": 60,
                "ends_at": "2099-01-01T00:00:00+00:00",
            },
            deadline_ms=4_102_444_800_000,
        )
        # (a) BITTA o'quvchi, 30 ta parallel ovoz, 30 ta alohida ulanishdan.
        same = await asyncio.gather(
            *(st.vote_poll(poll_id, students[0], i % 3) for i, st in enumerate(states))
        )
        assert sum(r.ok for r in same) == 1, [r.error for r in same]
        assert sorted({r.error for r in same if not r.ok}) == ["ALREADY_VOTED"]

        # (b) 29 ta BOSHQA o'quvchi, parallel, alohida ulanishlardan.
        others = await asyncio.gather(
            *(
                states[i].vote_poll(poll_id, sid, i % 3)
                for i, sid in enumerate(students[1:], start=1)
            )
        )
        assert all(r.ok for r in others)

        dist = await redis.hgetall(poll_key(session_id, poll_id, "dist"))
        assert sum(int(v) for v in dist.values()) == 30, dist
        assert await redis.hlen(poll_key(session_id, poll_id, "votes")) == 30

        # Har muvaffaqiyatli ovoz o'z `seq` ini oldi — takror yo'q, oxirgisida voted=30.
        ok = [r for r in (*same, *others) if r.ok]
        assert len({r.seq for r in ok}) == 30
        last = max(ok, key=lambda r: r.seq)
        assert json.loads(last.envelope)["data"]["voted"] == 30

        final = await admin.end_poll(poll_id)
        data = json.loads(final.envelope)["data"]
        assert data["total"] == 30 and sum(data["distribution"]) == 30
    finally:
        await states[0].destroy()
        for part in ("votes", "dist", "deadline"):
            await clients[0].delete(poll_key(session_id, poll_id, part))
        await clients[0].delete(interactive_registry_key(session_id))
        await asyncio.gather(*(c.aclose() for c in clients))


# ===========================================================================
# 7. Saqlash: dars tugagach 24 soat, DB ga yozilmaydi
# ===========================================================================


async def test_interactive_keys_kept_24h_after_end(base_url: str) -> None:
    async with ia_room(base_url, students=1) as room:
        student_id = room.fx.p30_students[0]
        async with (
            connect(base_url, room.pin, room.fx.teacher, "teacher") as teacher,
            connect(base_url, room.pin, student_id, "s1") as student,
        ):
            await teacher.next("ROOM_STATE_SYNC")
            await student.next("ROOM_STATE_SYNC")
            await lesson_started(teacher, [student])
            await teacher.send("POLL_START", {"slide_index": 1})
            poll_id = (await student.next("POLL_START"))["data"]["poll_id"]
            await student.send("POLL_VOTE", {"poll_id": poll_id, "selected_index": 0})
            await teacher.next("POLL_PROGRESS")

        ended = await room.api.call("POST", f"/rooms/{room.pin}/end", room.fx.teacher)
        assert ended.status_code == 200, ended.text

        async with redis_client() as redis:
            # Xona HASH i o'chdi, poll natijalari esa 24 soatga qoldi.
            assert not await redis.exists(state_key(room.session_id))
            for part in ("votes", "dist"):
                key = poll_key(room.session_id, poll_id, part)
                ttl = await redis.ttl(key)
                assert INTERACTIVE_RETAIN_SEC - 60 < ttl <= INTERACTIVE_RETAIN_SEC, (key, ttl)
            assert await redis.hget(poll_key(room.session_id, poll_id, "votes"), str(student_id))
