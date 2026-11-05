"""WS sinxronlik, guruh guardi va PIN retry testlari.

Haqiqiy Postgres va Redis talab qiladi (mock YO'Q), chunki tekshirilayotgan
narsalarning o'zi — partial unique index (`uq_active_pin`), `ON CONFLICT DO
NOTHING` va Redis Lua atomarligi.

Ishga tushirish::

    DATABASE_URL=postgresql+asyncpg://syncclass:syncclass@localhost:55432/syncclass \\
    REDIS_URL=redis://localhost:56379/15 \\
    .venv/bin/python -m pytest tests/test_ws_sync.py -v

Muhit tekshiruvi (Postgres/Redis bor-yo'qligi va 0-DB ni rad etish) umumiy
`tests/conftest.py` da — bu yerda takrorlanmaydi.

Seed talab qilinadi (`python scripts/seed.py`): P-30 va P-31 guruhlari,
har birida 5 o'quvchi, 6 slaydli prezentatsiya (indeks 2 va 5 — QUIZ).

Server haqiqiy uvicorn sifatida alohida threadda ko'tariladi: WS kechikishi,
heartbeat va uzilish xatti-harakati ASGI "tranzport"iga bog'liq, shuning uchun
`TestClient` ning soxta soketi bu yerda yetarli emas.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import socket
import threading
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from typing import Annotated, Any

import httpx
import pytest
import uvicorn
import websockets
from fastapi import Depends, FastAPI, Request
from redis.asyncio import Redis
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.rooms import get_current_user
from app.core.config import settings
from app.core.errors import forbidden
from app.db.models import (
    Attendance,
    AttendanceStatus,
    Group,
    GroupMember,
    LessonSession,
    Presentation,
    SessionStatus,
    User,
    UserRole,
)
from app.db.session import get_db
from app.services.room_state import (
    PUBLIC_STATE_FIELDS,
    RoomState,
    issue_ticket,
    state_key,
)
from app.ws.manager import RoomManager

# `pyproject.toml` da `asyncio_mode = "auto"` — `async def test_*` o'zi ishga tushadi.
WS_RECV_TIMEOUT = 5.0


# ===========================================================================
# Test ilovasi
# ===========================================================================


async def _test_current_user(
    request: Request, db: Annotated[AsyncSession, Depends(get_db)]
) -> User:
    """`X-Test-User` sarlavhasidagi UUID → `User`.

    JWT oqimining o'zi `auth-engineer` ning `test_auth_guards.py` zimmasida;
    bu yerda faqat xona qoidalari tekshiriladi, shuning uchun dependency
    override ishlatiladi (rol guardi esa HAQIQIY `require_teacher` orqali).
    """
    raw = request.headers.get("X-Test-User", "")
    try:
        user_id = uuid.UUID(raw)
    except ValueError:
        raise forbidden("UNAUTHORIZED", "X-Test-User sarlavhasi yo'q.") from None
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise forbidden("UNAUTHORIZED", "Test foydalanuvchisi topilmadi.")
    return user


def build_app() -> FastAPI:
    """Haqiqiy `app.main:app` + faqat autentifikatsiya override i.

    JWT oqimining o'zi `auth-engineer` ning `test_auth_guards.py` zimmasida;
    bu yerda xona qoidalari tekshiriladi, shuning uchun `get_current_user`
    almashtiriladi. `require_teacher` esa HAQIQIY qoladi — rol guardi
    test ostida.
    """
    from app.main import app

    app.dependency_overrides[get_current_user] = _test_current_user
    return app


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture(scope="module")
def base_url() -> Iterator[str]:
    """Haqiqiy uvicorn serveri (alohida thread, o'z event loop i bilan).

    Scope ATAYLAB `module`, `session` emas. Server `app.main:app` ni ishlatadi,
    ya'ni GLOBAL `app.db.session.engine` pool i uning loop iga bog'lanib qoladi.
    Agar server sessiya oxirigacha tirik tursa, keyingi test modullari o'z
    loop idan shu pool dan ulanish olib
    `RuntimeError: ... got Future attached to a different loop` oladi
    (`test_auth_guards.py` da aynan shunday bo'lgan). Modul tugashi bilan
    server to'xtaydi va `main.py` lifespan i `await engine.dispose()` ni
    O'Z loop ida bajaradi — pool toza qoladi.
    """
    with run_test_server() as url:
        yield url


@contextlib.contextmanager
def run_test_server() -> Iterator[str]:
    """`base_url` fixture ining tanasi — boshqa test modullari ham o'z
    module-scoped fixture ini shu bilan quradi (scope sababi yuqorida).
    """
    port = _free_port()
    server = uvicorn.Server(
        uvicorn.Config(
            build_app(), host="127.0.0.1", port=port, log_level="warning", lifespan="on"
        )
    )
    thread = threading.Thread(target=server.run, daemon=True, name="test-uvicorn")
    thread.start()
    deadline = time.monotonic() + 20
    while not server.started:
        if time.monotonic() > deadline:  # pragma: no cover
            pytest.fail("uvicorn test serveri ishga tushmadi")
        time.sleep(0.02)
    try:
        yield f"127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=10)


# ===========================================================================
# DB / Redis yordamchilari (har chaqiruvda o'z engine i — loop aralashmasin)
# ===========================================================================


@contextlib.asynccontextmanager
async def db_session() -> AsyncIterator[AsyncSession]:
    engine = create_async_engine(settings.sqlalchemy_url, poolclass=None)
    factory = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    try:
        async with factory() as session:
            yield session
    finally:
        await engine.dispose()


@contextlib.asynccontextmanager
async def redis_client() -> AsyncIterator[Redis]:
    client = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        yield client
    finally:
        await client.aclose()


@pytest.fixture(autouse=True)
async def _reset_join_limits() -> AsyncIterator[None]:
    """Har test o'z holatidan boshlanadi.

    `POST /rooms/{pin}/join` da brute-force himoyasi bor (10/daqiqa + 5 xatodan
    keyin 5 daqiqa lockout). Guruhlararo testi ataylab xato urinish qiladi,
    shuning uchun hisoblagichlar testlar O'RTASIDA ham, qayta ishga tushirishlar
    orasida ham tozalanishi SHART — aks holda test tartibga bog'liq bo'lib qoladi.
    """
    async with redis_client() as redis:
        keys = [key async for key in redis.scan_iter(match="ratelimit:room_join*")]
        if keys:
            await redis.delete(*keys)
    yield


class Fixture:
    """Seed dan olingan aktyorlar."""

    def __init__(
        self,
        teacher: uuid.UUID,
        presentation: uuid.UUID,
        p30_id: int,
        p31_id: int,
        p30_students: list[uuid.UUID],
        p31_students: list[uuid.UUID],
        slides: list[dict[str, Any]],
    ) -> None:
        self.teacher = teacher
        self.presentation = presentation
        self.p30_id = p30_id
        self.p31_id = p31_id
        self.p30_students = p30_students
        self.p31_students = p31_students
        self.slides = slides


async def load_fixture() -> Fixture:
    async with db_session() as db:
        teacher = (
            await db.execute(select(User).where(User.role == UserRole.TEACHER).limit(1))
        ).scalar_one()
        presentation = (
            await db.execute(
                select(Presentation).where(Presentation.teacher_id == teacher.id).limit(1)
            )
        ).scalar_one()
        groups = {
            g.name: g
            for g in (
                await db.execute(select(Group).where(Group.name.in_(["P-30", "P-31"])))
            ).scalars()
        }
        members: dict[str, list[uuid.UUID]] = {}
        for name, group in groups.items():
            members[name] = list(
                (
                    await db.execute(
                        select(GroupMember.student_id)
                        .join(User, User.id == GroupMember.student_id)
                        .where(GroupMember.group_id == group.id)
                        .order_by(User.email)
                    )
                ).scalars()
            )
    assert len(members["P-30"]) >= 2, "seed: P-30 da kamida 2 o'quvchi bo'lishi kerak"
    assert len(members["P-31"]) >= 1, "seed: P-31 da kamida 1 o'quvchi bo'lishi kerak"
    return Fixture(
        teacher=teacher.id,
        presentation=presentation.id,
        p30_id=groups["P-30"].id,
        p31_id=groups["P-31"].id,
        p30_students=members["P-30"],
        p31_students=members["P-31"],
        slides=list(presentation.slides_data or []),
    )


async def drop_session(session_id: uuid.UUID) -> None:
    async with db_session() as db:
        await db.execute(delete(LessonSession).where(LessonSession.id == session_id))
        await db.commit()


# ===========================================================================
# HTTP / WS mijoz yordamchilari
# ===========================================================================


class Api:
    def __init__(self, base_url: str) -> None:
        self._base = f"http://{base_url}/api/v1"
        self.host = base_url

    async def call(
        self, method: str, path: str, actor: uuid.UUID, **kwargs: Any
    ) -> httpx.Response:
        async with httpx.AsyncClient(timeout=15.0) as client:
            return await client.request(
                method,
                f"{self._base}{path}",
                headers={"X-Test-User": str(actor)},
                **kwargs,
            )

    async def create_room(self, teacher: uuid.UUID, group_id: int, presentation_id: uuid.UUID):
        return await self.call(
            "POST",
            "/rooms",
            teacher,
            json={"group_id": group_id, "presentation_id": str(presentation_id)},
        )


async def ticket_for(user_id: uuid.UUID) -> str:
    async with redis_client() as redis:
        return await issue_ticket(redis, user_id)


@contextlib.asynccontextmanager
async def ws_connect(host: str, pin: str, user_id: uuid.UUID):
    ticket = await ticket_for(user_id)
    async with websockets.connect(f"ws://{host}/ws/room/{pin}?ticket={ticket}") as sock:
        yield sock


async def recv(sock: Any, expect: str | None = None, deadline_sec: float = WS_RECV_TIMEOUT) -> dict:
    """Kutilgan turdagi eventni qaytaradi; boshqalarni o'tkazib yuboradi."""
    try:
        async with asyncio.timeout(deadline_sec):
            while True:
                envelope = json.loads(await sock.recv())
                if expect is None or envelope.get("type") == expect:
                    return envelope
    except TimeoutError:
        raise AssertionError(f"`{expect or 'event'}` kutildi, lekin kelmadi") from None


async def send(sock: Any, event: str, data: dict[str, Any] | None = None) -> None:
    await sock.send(json.dumps({"v": 1, "type": event, "data": data or {}}))


def ws_rejection_code(exc: BaseException) -> int | None:
    """WS rad etilish kodini xato SHAKLIGA bog'lanmasdan chiqaradi.

    `websockets` rad etishni ikki xil joyda beradi va atribut nomlari
    versiyadan versiyaga o'zgaradi (17.4 da `InvalidStatus.rcvd` YO'Q):

      * handshake rad etilsa → `InvalidStatus.response.status_code` (HTTP, 403)
        yoki eski versiyalarda `InvalidStatusCode.status_code`
      * ulanib, keyin yopilsa → `ConnectionClosed.code` (WS close kodi, 44xx),
        eski versiyalarda `ConnectionClosed.rcvd.code`

    Diqqat: bu funksiya HTTP statusni ham qaytaradi, lekin testlar ataylab
    AYNAN 44xx close kodini kutadi. 403 kelishi — serverda `ws.accept()` dan
    oldin xato bo'lganini bildiradi (handshake rad etilgan), ya'ni haqiqiy
    nosozlik; uni "ham to'g'ri" deb qabul qilsak, nosozlik yashirinib qoladi.
    """
    code = getattr(exc, "code", None)  # ConnectionClosed.code (yangi versiyalar)
    if isinstance(code, int):
        return code
    rcvd = getattr(exc, "rcvd", None)  # ConnectionClosed.rcvd.code (eski)
    rcvd_code = getattr(rcvd, "code", None)
    if isinstance(rcvd_code, int):
        return rcvd_code
    status = getattr(getattr(exc, "response", None), "status_code", None)  # InvalidStatus
    if isinstance(status, int):
        return status
    status = getattr(exc, "status_code", None)  # InvalidStatusCode (eski)
    return status if isinstance(status, int) else None


# ===========================================================================
# 1. PIN: retry, tugash, ENDED dan keyin qayta ishlatish
# ===========================================================================


async def test_pin_retry_exhaustion_and_reuse(
    base_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`uq_active_pin` → `IntegrityError` → yangi PIN bilan 5 martagacha retry."""
    import app.api.rooms as rooms

    fx = await load_fixture()
    api = Api(base_url)
    created: list[uuid.UUID] = []
    taken = f"{uuid.uuid4().int % 900_000 + 100_000:06d}"

    try:
        # --- (a) birinchi sessiya `taken` PIN ni egallaydi ---
        monkeypatch.setattr(rooms, "generate_pin_code", lambda: taken)
        first = await api.create_room(fx.teacher, fx.p30_id, fx.presentation)
        assert first.status_code == 201, first.text
        assert first.json()["pin_code"] == taken
        created.append(uuid.UUID(first.json()["session_id"]))

        # --- (b) band PIN 3 marta qaytadi, 4-chisi bo'sh → RETRY ishlaydi ---
        fresh = f"{(uuid.uuid4().int + 7) % 900_000 + 100_000:06d}"
        sequence = iter([taken, taken, taken, fresh])
        monkeypatch.setattr(rooms, "generate_pin_code", lambda: next(sequence))
        second = await api.create_room(fx.teacher, fx.p30_id, fx.presentation)
        assert second.status_code == 201, second.text
        assert second.json()["pin_code"] == fresh, "retry yangi PIN bilan ishlashi kerak"
        created.append(uuid.UUID(second.json()["session_id"]))

        # --- (c) har safar band PIN → 5 urinishdan keyin 409 ---
        monkeypatch.setattr(rooms, "generate_pin_code", lambda: taken)
        blocked = await api.create_room(fx.teacher, fx.p30_id, fx.presentation)
        assert blocked.status_code == 409
        assert blocked.json()["detail"]["code"] == "PIN_UNAVAILABLE"

        # --- (d) sessiya ENDED bo'lgach PIN AVTOMATIK bo'shaydi ---
        ended = await api.call("POST", f"/rooms/{taken}/end", fx.teacher)
        assert ended.status_code == 200, ended.text
        again = await api.create_room(fx.teacher, fx.p30_id, fx.presentation)
        assert again.status_code == 201, "ENDED dan keyin PIN qayta ishlatilishi kerak"
        assert again.json()["pin_code"] == taken
        created.append(uuid.UUID(again.json()["session_id"]))
    finally:
        for session_id in created:
            await drop_session(session_id)


# ===========================================================================
# 2. Guruhlararo kirish — P-31 o'quvchisi P-30 sessiyasiga KIRA OLMAYDI
# ===========================================================================


async def test_cross_group_access_forbidden(base_url: str) -> None:
    """AUDIT.md §C2 / DoD #5 — REST da 403, WS da 4403 bilan yopiladi."""
    fx = await load_fixture()
    api = Api(base_url)
    room = await api.create_room(fx.teacher, fx.p30_id, fx.presentation)
    assert room.status_code == 201, room.text
    pin = room.json()["pin_code"]
    session_id = uuid.UUID(room.json()["session_id"])
    outsider = fx.p31_students[0]
    insider = fx.p30_students[0]

    try:
        # --- REST: 403 NOT_IN_GROUP ---
        denied = await api.call("POST", f"/rooms/{pin}/join", outsider)
        assert denied.status_code == 403, denied.text
        assert denied.json()["detail"]["code"] == "NOT_IN_GROUP"

        # Ticket ham berilmaydi.
        no_ticket = await api.call("POST", f"/rooms/{pin}/ws-ticket", outsider)
        assert no_ticket.status_code == 403
        assert no_ticket.json()["detail"]["code"] == "NOT_IN_GROUP"

        # --- O'z guruhidagi o'quvchi esa kiradi ---
        allowed = await api.call("POST", f"/rooms/{pin}/join", insider)
        assert allowed.status_code == 200, allowed.text
        assert allowed.json()["attendance_status"] in {"PRESENT", "LATE"}
        assert allowed.json()["group_name"] == "P-30"

        # --- WS: ticket to'g'ridan-to'g'ri berilsa ham guard to'sadi ---
        ticket = await ticket_for(outsider)
        with pytest.raises(websockets.exceptions.WebSocketException) as err:
            async with websockets.connect(
                f"ws://{base_url}/ws/room/{pin}?ticket={ticket}"
            ) as sock:
                # Server avval ERROR yuboradi, so'ng 4403 bilan yopadi.
                first = json.loads(await asyncio.wait_for(sock.recv(), 5))
                assert first["type"] == "ERROR"
                assert first["data"]["code"] == "NOT_IN_GROUP"
                await asyncio.wait_for(sock.recv(), 5)
        # 4403 — ilova darajasidagi close kodi. HTTP 403 kelsa, bu handshake
        # `ws.accept()` dan oldin rad etilgani, ya'ni boshqa nosozlik.
        assert ws_rejection_code(err.value) == 4403
    finally:
        await drop_session(session_id)


# ===========================================================================
# 3. Reconnect → `ROOM_STATE_SYNC` AYNAN joriy holatni beradi
# ===========================================================================


async def test_reconnect_state_sync_is_exact(base_url: str) -> None:
    """DoD #6 — uzilib qayta ulangan o'quvchi holati o'qituvchidagi bilan bir xil."""
    fx = await load_fixture()
    api = Api(base_url)
    room = await api.create_room(fx.teacher, fx.p30_id, fx.presentation)
    pin = room.json()["pin_code"]
    session_id = uuid.UUID(room.json()["session_id"])
    student = fx.p30_students[0]
    code_slide = next(i for i, s in enumerate(fx.slides) if s["type"] == "CODE")
    live_code = "print('reconnect testi')\nx = [1, 2, 3]\n"

    try:
        async with ws_connect(base_url, pin, fx.teacher) as teacher_ws:
            await recv(teacher_ws, "ROOM_STATE_SYNC")

            # --- 1-ulanish ---
            async with ws_connect(base_url, pin, student) as first_ws:
                sync1 = await recv(first_ws, "ROOM_STATE_SYNC")
                assert sync1["data"]["slide_index"] == 0
                assert sync1["data"]["code"] == ""
                # O'qituvchi xonada bo'lsa ham dars hali BOSHLANMAGAN — LOBBY.
                # LIVE faqat birinchi `SLIDE_CHANGE` da ("Darsni boshlash").
                assert sync1["data"]["status"] == "LOBBY"
                # O'qituvchi o'quvchining qo'shilganini ko'radi.
                joined = await recv(teacher_ws, "STUDENT_JOINED")
                assert joined["data"]["student_id"] == str(student)

                # --- o'qituvchi holatni o'zgartiradi ---
                await send(teacher_ws, "SLIDE_CHANGE", {"slide_index": code_slide})
                slide_evt = await recv(first_ws, "SLIDE_CHANGE")
                assert slide_evt["data"]["slide_index"] == code_slide
                assert slide_evt["data"]["slide_type"] == "CODE"

                await send(
                    teacher_ws,
                    "LIVE_CODE_PATCH",
                    {"slide_index": code_slide, "code": live_code, "cursor": {"line": 1, "col": 4}},
                )
                patch = await recv(first_ws, "LIVE_CODE_PATCH")
                assert patch["data"]["code"] == live_code
                assert patch["data"]["code_rev"] >= 1
                expected_rev = patch["data"]["code_rev"]
                highest_seq = patch["seq"]

                await send(teacher_ws, "SCREEN_SHARE_STATE", {"is_sharing": True})
                share = await recv(first_ws, "SCREEN_SHARE_STATE")
                assert share["data"]["is_sharing"] is True
                highest_seq = max(highest_seq, share["seq"])

            # --- uzildi (context chiqdi) → qayta ulanamiz ---
            await asyncio.sleep(0.25)
            async with ws_connect(base_url, pin, student) as second_ws:
                sync2 = await recv(second_ws, "ROOM_STATE_SYNC")
                data = sync2["data"]
                # AYNAN joriy holat — Redis Hash dan (AUDIT.md §B2).
                assert data["slide_index"] == code_slide
                assert data["slide_type"] == "CODE"
                assert data["code"] == live_code
                assert data["code_rev"] == expected_rev
                assert data["is_sharing"] is True
                # §5: reconnect da sessiya holati BIR MARTADA tiklanadi —
                # klient yangi `SLIDE_CHANGE` kutib lobbida qotib qolmaydi.
                assert data["status"] == "LIVE"
                assert data["active_quiz"] is None
                assert data["confused"] == {"count": 0, "percentage": 0}
                # Qayta ulangan o'quvchi participants ichida bor.
                assert str(student) in {p["student_id"] for p in data["participants"]}
                # `seq` — yangi baza va eski eventlardan KICHIK EMAS.
                assert sync2["seq"] >= highest_seq
    finally:
        await drop_session(session_id)


# ===========================================================================
# 4. `seq` monotonik; eski `seq` klient tomonida ignore qilinadi
# ===========================================================================


async def test_seq_is_monotonic_so_stale_events_are_ignored(base_url: str) -> None:
    """Klientning "seq <= oxirgi_seq → ignore" qoidasi faqat `seq` qat'iy
    o'sganda to'g'ri ishlaydi. Shu yerda aynan shu kafolat tekshiriladi."""
    fx = await load_fixture()
    api = Api(base_url)
    room = await api.create_room(fx.teacher, fx.p30_id, fx.presentation)
    pin = room.json()["pin_code"]
    session_id = uuid.UUID(room.json()["session_id"])
    student = fx.p30_students[1]
    code_slide = next(i for i, s in enumerate(fx.slides) if s["type"] == "CODE")

    try:
        async with ws_connect(base_url, pin, fx.teacher) as teacher_ws:
            await recv(teacher_ws, "ROOM_STATE_SYNC")
            async with ws_connect(base_url, pin, student) as student_ws:
                base_seq = (await recv(student_ws, "ROOM_STATE_SYNC"))["seq"]
                await recv(teacher_ws, "STUDENT_JOINED")

                seen: list[int] = []
                for index in (1, 0, code_slide, 0):
                    await send(teacher_ws, "SLIDE_CHANGE", {"slide_index": index})
                    seen.append((await recv(student_ws, "SLIDE_CHANGE"))["seq"])

                assert seen == sorted(seen), f"seq monotonik emas: {seen}"
                assert len(set(seen)) == len(seen), "seq takrorlanmasligi kerak"
                assert seen[0] > base_seq

                # Klient simulyatsiyasi: eski seq li event TASHLANADI.
                last_applied = seen[-1]
                stale = {"v": 1, "type": "SLIDE_CHANGE", "seq": seen[0], "data": {}}
                assert stale["seq"] <= last_applied, "eski event ignore qilinadi"

                # `LIVE_CODE_PATCH` ham umumiy `seq` oqimida.
                await send(
                    teacher_ws, "LIVE_CODE_PATCH", {"slide_index": code_slide, "code": "a=1\n"}
                )
                patch_seq = (await recv(student_ws, "LIVE_CODE_PATCH"))["seq"]
                assert patch_seq > last_applied
    finally:
        await drop_session(session_id)


# ===========================================================================
# 5. Rol guardi va ticket ning bir martaligi
# ===========================================================================


async def test_role_guard_and_one_time_ticket(base_url: str) -> None:
    fx = await load_fixture()
    api = Api(base_url)
    room = await api.create_room(fx.teacher, fx.p30_id, fx.presentation)
    pin = room.json()["pin_code"]
    session_id = uuid.UUID(room.json()["session_id"])
    student = fx.p30_students[2]

    try:
        ticket = await ticket_for(student)
        url = f"ws://{base_url}/ws/room/{pin}?ticket={ticket}"
        async with websockets.connect(url) as sock:
            await recv(sock, "ROOM_STATE_SYNC")

            # STUDENT `TEACHER` eventini yuborolmaydi → ERROR{FORBIDDEN_EVENT}
            await send(sock, "SLIDE_CHANGE", {"slide_index": 1})
            err = await recv(sock, "ERROR")
            assert err["data"]["code"] == "FORBIDDEN_EVENT"

            # Noma'lum event ham ulanishni yiqitmaydi.
            await send(sock, "DROP_DATABASE", {})
            assert (await recv(sock, "ERROR"))["data"]["code"] == "UNKNOWN_EVENT"

            # PING → PONG
            await send(sock, "PING", {})
            assert (await recv(sock, "PONG"))["type"] == "PONG"

            # CONFUSED_PING: birinchisi o'tadi, ikkinchisi cooldownga tushadi.
            await send(sock, "CONFUSED_PING", {})
            await send(sock, "CONFUSED_PING", {})
            cooldown = await recv(sock, "ERROR")
            assert cooldown["data"]["code"] == "CONFUSED_COOLDOWN"

        # --- Ticket IKKINCHI marta ishlamaydi (GETDEL) ---
        with pytest.raises(websockets.exceptions.WebSocketException) as err_ctx:
            async with websockets.connect(url) as sock:
                first = json.loads(await asyncio.wait_for(sock.recv(), 5))
                assert first["data"]["code"] == "INVALID_TICKET"
                await asyncio.wait_for(sock.recv(), 5)
        assert ws_rejection_code(err_ctx.value) == 4401
    finally:
        await drop_session(session_id)


# ===========================================================================
# 6. ABSENT reconciliation
# ===========================================================================


async def test_absent_reconciliation_on_end(base_url: str) -> None:
    """AUDIT.md §D3 — guruhda bor-u darsga kirmaganlar `ABSENT` bo'ladi."""
    fx = await load_fixture()
    api = Api(base_url)
    room = await api.create_room(fx.teacher, fx.p30_id, fx.presentation)
    pin = room.json()["pin_code"]
    session_id = uuid.UUID(room.json()["session_id"])
    joined = fx.p30_students[0]

    try:
        assert (await api.call("POST", f"/rooms/{pin}/join", joined)).status_code == 200

        ended = await api.call("POST", f"/rooms/{pin}/end", fx.teacher)
        assert ended.status_code == 200, ended.text
        body = ended.json()
        assert body["status"] == "ENDED"
        assert body["present_count"] + body["late_count"] == 1
        assert body["absent_count"] == len(fx.p30_students) - 1

        async with db_session() as db:
            rows = dict(
                (
                    await db.execute(
                        select(Attendance.student_id, Attendance.status).where(
                            Attendance.session_id == session_id
                        )
                    )
                ).all()
            )
        assert len(rows) == len(fx.p30_students)
        assert rows[joined] in {AttendanceStatus.PRESENT, AttendanceStatus.LATE}
        for other in fx.p30_students[1:]:
            assert rows[other] is AttendanceStatus.ABSENT

        # Ikkinchi `end` — idempotent emas, lekin ma'lumotni buzmaydi.
        repeat = await api.call("POST", f"/rooms/{pin}/end", fx.teacher)
        assert repeat.status_code == 404

        async with db_session() as db:
            status = (
                await db.execute(
                    select(LessonSession.status).where(LessonSession.id == session_id)
                )
            ).scalar_one()
        assert status is SessionStatus.ENDED
    finally:
        await drop_session(session_id)


# ===========================================================================
# 7. Quiz oqimi: `answer_ms` serverda, takroriy javob XP bermaydi
# ===========================================================================


async def test_quiz_flow_server_timing_and_single_xp(base_url: str) -> None:
    fx = await load_fixture()
    api = Api(base_url)
    room = await api.create_room(fx.teacher, fx.p30_id, fx.presentation)
    pin = room.json()["pin_code"]
    session_id = uuid.UUID(room.json()["session_id"])
    student = fx.p30_students[3]
    quiz_index = next(i for i, s in enumerate(fx.slides) if s["type"] == "QUIZ")
    quiz_slide = fx.slides[quiz_index]

    try:
        assert (await api.call("POST", f"/rooms/{pin}/join", student)).status_code == 200
        async with ws_connect(base_url, pin, fx.teacher) as teacher_ws:
            await recv(teacher_ws, "ROOM_STATE_SYNC")
            async with ws_connect(base_url, pin, student) as student_ws:
                await recv(student_ws, "ROOM_STATE_SYNC")
                await recv(teacher_ws, "STUDENT_JOINED")

                await send(teacher_ws, "QUIZ_START", {"slide_index": quiz_index})
                started = await recv(student_ws, "QUIZ_START")
                quiz_id = started["data"]["quiz_id"]
                assert started["data"]["ends_at"], "`ends_at` server tomonidan beriladi"
                assert "correct_option" not in started["data"], "to'g'ri javob oqib ketmasin"

                # Klient yolg'on `time_ms=0` yuboradi — server o'zi hisoblaydi.
                await asyncio.sleep(0.4)
                await send(
                    student_ws,
                    "QUIZ_ANSWER",
                    {
                        "quiz_id": quiz_id,
                        "selected_index": int(quiz_slide["correct_option"]),
                        "time_ms": 0,
                    },
                )
                progress = await recv(teacher_ws, "QUIZ_PROGRESS")
                assert progress["data"]["answered"] == 1

                # Takroriy javob → XP ikkinchi marta berilmaydi.
                await send(
                    student_ws,
                    "QUIZ_ANSWER",
                    {
                        "quiz_id": quiz_id,
                        "selected_index": int(quiz_slide["correct_option"]),
                        "time_ms": 0,
                    },
                )
                dup = await recv(student_ws, "ERROR")
                assert dup["data"]["code"] == "ALREADY_ANSWERED"

                await send(teacher_ws, "QUIZ_END", {"quiz_id": quiz_id})
                results = await recv(student_ws, "QUIZ_RESULTS")
                data = results["data"]
                assert data["correct_option"] == int(quiz_slide["correct_option"])
                assert sum(data["distribution"]) == 1
                assert len(data["leaderboard"]) == 1
                # Variant MATNLARI: reconnect QUIZ_START va QUIZ_RESULTS orasiga
                # tushsa ham o'quvchi nimaga ovoz berganini ko'radi.
                assert data["options"] == list(quiz_slide["options"])
                # Tartib `distribution` indekslariga mos: distribution[i] <-> options[i]
                assert len(data["options"]) == len(data["distribution"])
                voted = data["distribution"].index(1)
                assert data["options"][voted] == quiz_slide["options"][
                    int(quiz_slide["correct_option"])
                ]

        async with db_session() as db:
            answers = (
                await db.execute(
                    select(Attendance.quiz_score).where(
                        Attendance.session_id == session_id,
                        Attendance.student_id == student,
                    )
                )
            ).scalar_one()
            points = int(quiz_slide.get("points", 100))
            # `answer_ms` serverda ~400 ms → XP 50%..100% oralig'ida, bir marta.
            assert points * 0.5 <= answers <= points
    finally:
        await drop_session(session_id)


# ===========================================================================
# 8. Anti-cheat: faol quiz javobi SNAPSHOT orqali ham oqib ketmaydi
# ===========================================================================


async def test_active_quiz_secret_never_reaches_snapshot(base_url: str) -> None:
    """AUDIT.md §G3: `correct_option` hech bir yo'ldan klientga chiqmaydi.

    `QUIZ_START` redaksiyalangan edi, lekin snapshot BOSHQA yo'ldan borardi:
    quiz ketayotganda o'quvchi sahifani bir marta yangilasa, qayta ulanishdagi
    `ROOM_STATE_SYNC` freymida `correct_option` turardi → DevTools → 100% XP.

    Test quiz FAOL holatda tekshiradi (`active_quiz` bo'sh emas) — aks holda
    hech narsa tekshirilmagan bo'lardi.
    """
    fx = await load_fixture()
    api = Api(base_url)
    room = await api.create_room(fx.teacher, fx.p30_id, fx.presentation)
    pin = room.json()["pin_code"]
    session_id = uuid.UUID(room.json()["session_id"])
    student = fx.p30_students[2]
    quiz_index = next(i for i, s in enumerate(fx.slides) if s["type"] == "QUIZ")
    quiz_slide = fx.slides[quiz_index]
    secret_fields = ("correct_option", "started_at_ms", "points")

    try:
        joined = await api.call("POST", f"/rooms/{pin}/join", student)
        assert joined.status_code == 200
        # 1-yo'l: `POST /join` o'quvchiga XOM slayd JSON ini beradi. Bu eng
        # og'ir yo'l edi — quiz boshlanishi ham kerak emas, bir marta kirish
        # butun darsning javoblarini berardi.
        student_slides = joined.json()["slides"]
        assert len(student_slides) == len(fx.slides)
        assert not [i for i, sl in enumerate(student_slides) if "correct_option" in sl]
        # Javobni oshkor qilmaydigan maydonlar QOLADI (UI ularni ko'rsatadi).
        student_quiz = student_slides[quiz_index]
        assert student_quiz["options"] == list(quiz_slide["options"])
        assert student_quiz["points"] == quiz_slide["points"]
        # O'qituvchi — prezentatsiyaning egasi, unga to'liq massiv ketadi.
        teacher_join = await api.call("POST", f"/rooms/{pin}/join", fx.teacher)
        assert teacher_join.status_code == 200
        assert teacher_join.json()["slides"][quiz_index]["correct_option"] == int(
            quiz_slide["correct_option"]
        )

        async with ws_connect(base_url, pin, fx.teacher) as teacher_ws:
            await recv(teacher_ws, "ROOM_STATE_SYNC")
            async with ws_connect(base_url, pin, student) as first_ws:
                await recv(first_ws, "ROOM_STATE_SYNC")
                await recv(teacher_ws, "STUDENT_JOINED")
                await send(teacher_ws, "QUIZ_START", {"slide_index": quiz_index})
                started = await recv(first_ws, "QUIZ_START")
                quiz_id = started["data"]["quiz_id"]

            # Quiz HALI FAOL: o'quvchi sahifani yangiladi (reconnect).
            async with ws_connect(base_url, pin, student) as again_ws:
                sync = await recv(again_ws, "ROOM_STATE_SYNC")
                active = sync["data"]["active_quiz"]
                assert active is not None, "quiz faol bo'lishi SHART, aks holda test bo'sh"
                assert active["quiz_id"] == quiz_id
                # 2-yo'l: snapshot. `QUIZ_START` redaksiyalangan edi, bu esa yo'q.
                leaked = [f for f in secret_fields if f in active]
                assert not leaked, f"snapshotda sir oshkor bo'ldi: {leaked}"
                # Ommaviy qism `QUIZ_START` bilan bir xil — ikkisi bitta manba.
                assert set(active) == set(started["data"])

                # REST fallback ham xuddi shunday redaksiyalangan.
                rest = await api.call("GET", f"/rooms/{pin}", student)
                assert rest.status_code == 200, rest.text
                rest_active = rest.json()["active_quiz"]
                assert rest_active is not None
                assert not [f for f in secret_fields if f in rest_active]

            # Sir Redisda ALOHIDA maydonda yashaydi: server baholay oladi,
            # snapshot esa uni o'qiydigan yo'lga ega emas.
            async with redis_client() as redis:
                secret = await redis.hget(state_key(session_id), "active_quiz_secret")
                assert secret, "sir maydoni bo'sh — server javobni tekshira olmaydi"
                parsed = json.loads(secret)
                assert parsed["correct_option"] == int(quiz_slide["correct_option"])
                assert "active_quiz_secret" not in PUBLIC_STATE_FIELDS

            # O'quvchi to'g'ri javobni TAXMIN qilmasdan bila olmaydi, lekin
            # server uni baholashda baribir ishlatadi.
            await send(teacher_ws, "QUIZ_END", {"quiz_id": quiz_id})
            results = await recv(teacher_ws, "QUIZ_RESULTS")
            assert results["data"]["correct_option"] == int(quiz_slide["correct_option"])

            # `QUIZ_RESULTS` dan keyin ikki maydon ham tozalanadi.
            async with redis_client() as redis:
                leftover = await redis.hmget(
                    state_key(session_id), ["active_quiz", "active_quiz_secret"]
                )
            assert not any(leftover), f"quiz holati qoldi: {leftover}"
    finally:
        await drop_session(session_id)


async def test_legacy_quiz_key_written_before_the_split_does_not_leak() -> None:
    """Deploy paytida ketayotgan dars: eski `active_quiz` da TO'LIQ model.

    Ikkiga bo'linishdan oldin boshlangan quiz uchun ham ikki shart bajarilishi
    kerak: (1) snapshot sirni ko'rsatmaydi, (2) server baholashni davom etadi.
    """
    legacy = {
        "quiz_id": "q-legacy",
        "slide_index": 2,
        "question": "2 + 2 = ?",
        "options": ["3", "4", "5", "6"],
        "duration_sec": 30,
        "ends_at": "2030-01-01T00:00:00+00:00",
        "started_at_ms": 1_700_000_000_000,
        "correct_option": 1,
        "points": 100,
    }
    session_id = uuid.uuid4()
    async with redis_client() as redis:
        state = RoomState(redis, session_id)
        await state.ensure(slide_index=2, slide_type="QUIZ")
        # Sir maydoni ATAYLAB bo'sh — aynan eski kalitning shakli.
        await redis.hset(
            state.state_key,
            mapping={"active_quiz": json.dumps(legacy), "active_quiz_secret": ""},
        )
        try:
            active = (await state.snapshot()).to_sync_data()["active_quiz"]
            assert active is not None and active["quiz_id"] == "q-legacy"
            assert not [
                f for f in ("correct_option", "started_at_ms", "points") if f in active
            ]
            # Baholash yo'li eski joydan ham to'liq modelni yig'adi.
            quiz = await state.get_active_quiz()
            assert quiz is not None
            assert quiz.correct_option == 1
            assert quiz.started_at_ms == legacy["started_at_ms"]
        finally:
            await state.destroy()


# ===========================================================================
# 8. REST fallback, hisobot va LiveKit grantlari
# ===========================================================================


async def test_rest_fallback_report_and_livekit_grants(
    base_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`GET /rooms/{pin}`, `GET /rooms/{pin}/report` va `canPublish` qoidasi.

    AUDIT.md §F: o'quvchi tokenida `can_publish=False, can_publish_data=False` —
    u texnik jihatdan efirga chiqara OLMAYDI.
    """
    import jwt as pyjwt

    fx = await load_fixture()
    api = Api(base_url)
    room = await api.create_room(fx.teacher, fx.p30_id, fx.presentation)
    pin = room.json()["pin_code"]
    session_id = uuid.UUID(room.json()["session_id"])
    student = fx.p30_students[4]
    code_slide = next(i for i, s in enumerate(fx.slides) if s["type"] == "CODE")

    try:
        # --- LiveKit sozlanmagan: aniq 503, "import paytida yiqilish" YO'Q ---
        monkeypatch.setattr(settings, "LIVEKIT_API_KEY", "")
        monkeypatch.setattr(settings, "LIVEKIT_API_SECRET", "")
        off = await api.call("POST", f"/rooms/{pin}/livekit-token", fx.teacher)
        assert off.status_code == 503
        assert off.json()["detail"]["code"] == "LIVEKIT_NOT_CONFIGURED"

        # --- Sozlangan holat: grantlar rolga qarab ---
        monkeypatch.setattr(settings, "LIVEKIT_API_KEY", "devkey")
        monkeypatch.setattr(settings, "LIVEKIT_API_SECRET", "devsecret-at-least-32-bytes-long!")

        assert (await api.call("POST", f"/rooms/{pin}/join", student)).status_code == 200

        for actor, expected in ((fx.teacher, True), (student, False)):
            resp = await api.call("POST", f"/rooms/{pin}/livekit-token", actor)
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["can_publish"] is expected
            assert body["can_publish_data"] is expected
            grants = pyjwt.decode(
                body["token"], "devsecret-at-least-32-bytes-long!", algorithms=["HS256"]
            )["video"]
            assert grants["room"] == body["room_name"]
            assert grants.get("roomJoin") is True
            assert grants.get("canSubscribe") is True
            # Kalit yo'q bo'lsa LiveKit `false` deb qabul qiladi.
            assert bool(grants.get("canPublish", False)) is expected
            assert bool(grants.get("canPublishData", False)) is expected

        # --- REST fallback joriy holatni ko'rsatadi ---
        async with ws_connect(base_url, pin, fx.teacher) as teacher_ws:
            await recv(teacher_ws, "ROOM_STATE_SYNC")
            await send(teacher_ws, "SLIDE_CHANGE", {"slide_index": code_slide})
            await recv(teacher_ws, "SLIDE_CHANGE")

            state = await api.call("GET", f"/rooms/{pin}", student)
            assert state.status_code == 200, state.text
            payload = state.json()
            assert payload["slide_index"] == code_slide
            assert payload["slide_type"] == "CODE"
            assert payload["seq"] >= 1
            assert payload["confused"] == {"count": 0, "percentage": 0}
            # `join_url` — o'qituvchi lobbisi QR kodni shu maydondan quradi.
            # Manba SERVER: klientdagi `window.location.origin` o'qituvchi
            # `localhost` da ochsa boshqa qurilma uchun ishlamaydigan QR beradi.
            assert payload["join_url"] == room.json()["join_url"]
            assert payload["join_url"].endswith(f"/live/{pin}")
            # `presentation` — o'qituvchi sahifani yangilagach xona qaysi
            # prezentatsiya bilan ishlayotganini SHU maydondan biladi; aks
            # holda `presentation.id` yo'q va slaydlar butunlay yo'qoladi.
            assert payload["presentation"] == room.json()["presentation"]
            assert payload["presentation"]["id"] == str(fx.presentation)
            assert payload["presentation"]["slides_count"] == len(fx.slides)

        # --- Hisobot: davomat + focus + quiz ustunlari ---
        report = await api.call("GET", f"/rooms/{pin}/report", fx.teacher)
        assert report.status_code == 200, report.text
        body = report.json()
        assert body["group_name"] == "P-30"
        assert body["present_count"] + body["late_count"] == 1
        row = next(r for r in body["students"] if r["student_id"] == str(student))
        assert row["tab_switches_count"] == 0
        assert row["answers_count"] == 0
        assert isinstance(body["quizzes"], list)

        # O'quvchi hisobotni ko'ra olmaydi.
        denied = await api.call("GET", f"/rooms/{pin}/report", student)
        assert denied.status_code == 403
    finally:
        await drop_session(session_id)


# ===========================================================================
# 9. Regressiya: `RoomManager` event loop almashganda yiqilmasin
# ===========================================================================


def test_room_manager_survives_event_loop_change() -> None:
    """`manager` modul darajasidagi yagona nusxa — loop ga "yopishib" qolmasin.

    REGRESSIYA: `asyncio.Lock`/`Event` birinchi ishlatilgan event loop ga
    bog'lanadi. To'liq test to'plamida har modul o'z loop ini ochadi, shuning
    uchun ikkinchi loop dan `manager.start()` chaqirilganda
    `RuntimeError: ... bound to a different event loop` chiqardi. Bu xato
    `ws.accept()` DAN OLDIN sodir bo'lgani uchun Starlette handshake ni
    HTTP 403 bilan rad etardi va WS qatlami butunlay ishlamay qolardi —
    tashqi ko'rinishi "flaky test" bo'lib ko'ringan edi
    (`InvalidStatus` → `.rcvd` yo'q → `AttributeError`).

    Global `manager` ATAYLAB ishlatilmaydi: uni bu loop ga bog'lash uvicorn
    threadidagi haqiqiy listenerni buzadi (bir jarayon, bitta nusxa).
    """

    # MUHIM: bitta nusxa, IKKI xil loop. Har tsiklda yangi `RoomManager()`
    # yaratilsa primitivlar ham yangi loop da tug'iladi va xato TAKRORLANMAYDI
    # (ya'ni test tishsiz bo'lib qoladi).
    shared = RoomManager()

    async def cycle() -> bool:
        await shared.start()
        running = shared.is_running
        await shared.stop()
        return running

    first = asyncio.run(cycle())   # loop A — primitivlar shu loop ga bog'lanadi
    second = asyncio.run(cycle())  # loop B — fix bo'lmasa shu yerda RuntimeError
    assert first is True
    assert second is True


# ===========================================================================
# 10. LOBBY → LIVE va `conftest.py` darvozasining mantig'i
# ===========================================================================


async def test_first_slide_change_marks_session_live(base_url: str) -> None:
    """`LOBBY -> LIVE` FAQAT birinchi `SLIDE_CHANGE` da ("Darsni boshlash").

    O'qituvchining shunchaki ulanishi darsni boshlamaydi: aks holda o'quvchi
    PIN terishi bilan (o'qituvchi "Darsni boshlash" ni bosmasidan) snapshotdagi
    `status: LIVE` uni lobbidan chiqarib, slaydni ochib yuborardi.
    """
    fx = await load_fixture()
    api = Api(base_url)
    room = await api.create_room(fx.teacher, fx.p30_id, fx.presentation)
    pin = room.json()["pin_code"]
    session_id = uuid.UUID(room.json()["session_id"])
    student = fx.p30_students[0]

    try:
        assert room.json()["status"] == "LOBBY"

        # O'quvchi yakka ulansa — hali LOBBY.
        async with ws_connect(base_url, pin, student) as student_ws:
            assert (await recv(student_ws, "ROOM_STATE_SYNC"))["data"]["status"] == "LOBBY"

        # O'qituvchi ulandi — hali ham LOBBY (o'quvchilar lobbida kutadi).
        async with ws_connect(base_url, pin, fx.teacher) as teacher_ws:
            assert (await recv(teacher_ws, "ROOM_STATE_SYNC"))["data"]["status"] == "LOBBY"
            async with ws_connect(base_url, pin, student) as student_ws:
                assert (await recv(student_ws, "ROOM_STATE_SYNC"))["data"]["status"] == "LOBBY"

            # "Darsni boshlash" = birinchi SLIDE_CHANGE → endi LIVE.
            await send(teacher_ws, "SLIDE_CHANGE", {"slide_index": 0})
            await recv(teacher_ws, "SLIDE_CHANGE")
            async with ws_connect(base_url, pin, student) as student_ws:
                assert (await recv(student_ws, "ROOM_STATE_SYNC"))["data"]["status"] == "LIVE"

        # REST ham, DB ham (fon flusheri) LIVE ni ko'rsatadi.
        state = await api.call("GET", f"/rooms/{pin}", student)
        assert state.json()["seq"] >= 1
        await asyncio.sleep(3.5)  # `_FLUSH_INTERVAL_SEC` = 3.0
        async with db_session() as db:
            db_status = (
                await db.execute(
                    select(LessonSession.status).where(LessonSession.id == session_id)
                )
            ).scalar_one()
        assert db_status is SessionStatus.LIVE
    finally:
        await drop_session(session_id)


def test_redis_db_index_parsing_protects_live_db() -> None:
    """`conftest.py` darvozasi: 0-DB ni chetlab o'tishning yo'li qolmasin."""
    from tests.conftest import PROTECTED_REDIS_DB, redis_db_index

    assert redis_db_index("redis://localhost:56379/15") == 15
    assert redis_db_index("redis://localhost:56379/0") == 0
    # Indeks YOZILMAGAN URL — Redis uni 0 deb oladi, demak darvoza to'sishi kerak.
    assert redis_db_index("redis://localhost:56379") == PROTECTED_REDIS_DB
    assert redis_db_index("redis://localhost:56379/") == PROTECTED_REDIS_DB
    # Buzuq indeks ham himoyalangan tomonga yo'naltiriladi (fail-safe).
    assert redis_db_index("redis://localhost:56379/abc") == PROTECTED_REDIS_DB
    assert redis_db_index("redis://:parol@h:6379/9") == 9
