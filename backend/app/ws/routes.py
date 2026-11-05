"""`/ws/room/{pin_code}` — jonli dars soketi.

Ulanish tartibi (har bir qadam majburiy):

1. `?ticket=` → Redis `GETDEL` (**bir martalik**, 30 s). JWT WS URL ga hech
   qachon tushmaydi (AUDIT.md §B3).
2. PIN bo'yicha faol sessiya; topilmasa `4404`.
3. Xonadagi rol: guruh egasi → `TEACHER`, guruh a'zosi → `STUDENT`,
   aks holda `4403 NOT_IN_GROUP` (AUDIT.md §C2).
4. O'quvchi uchun avto-davomat (`PRESENT`/`LATE`) — focus/quiz yozuvlari
   uchun `attendances` qatori mavjud bo'lishi SHART.
5. `members` HASH ga qo'shilish → `STUDENT_JOINED` (boshqalarga).
6. `ROOM_STATE_SYNC` — Redis Hash dan **to'liq** holat (AUDIT.md §B2).
7. `PING`/`PONG` heartbeat; `WS_HEARTBEAT_SEC` ning 3 barobari jim bo'lsa
   ulanish yopiladi (AUDIT.md §B4).
8. Uzilishda `members` dan chiqarish → `STUDENT_LEFT` (agar o'quvchining
   boshqa ochiq soketi qolmagan bo'lsa — reconnect da "chiqdi" ko'rinmasin).

DB yozuvi "issiq yo'l"da YO'Q: `SLIDE_CHANGE` p95 < 100 ms bo'lishi uchun
`lesson_sessions.current_slide_index` fonda, to'plam holida yoziladi
(`_FLUSH_INTERVAL_SEC`). Haqiqat manbasi — Redis Hash.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from pydantic import ValidationError
from redis.asyncio import Redis
from sqlalchemy import select, update

from app.api.rooms import (
    livekit_room_name,
    load_session,
    resolve_room_role,
    upsert_attendance,
)
from app.core.config import settings
from app.core.deps import create_redis
from app.core.errors import AppError
from app.db.models import (
    Attendance,
    AttendanceStatus,
    LessonSession,
    SessionStatus,
    User,
    UserRole,
)
from app.db.session import AsyncSessionLocal
from app.schemas.room import ActiveQuiz, Participant
from app.schemas.slide import DEFAULT_OPEN_MAX_CHARS, OpenSlide, PollSlide
from app.services.quiz import (
    build_results,
    count_answers,
    load_quiz_slide,
    make_quiz_id,
    record_answer,
)
from app.services.room_state import InteractiveResult, RoomState, consume_ticket, now_ms
from app.ws.manager import manager
from app.ws.protocol import (
    WS_CLOSE_FORBIDDEN,
    WS_CLOSE_HEARTBEAT_TIMEOUT,
    WS_CLOSE_INVALID_TICKET,
    WS_CLOSE_ROOM_NOT_FOUND,
    ClientEvent,
    ProtocolError,
    ServerEvent,
    decode,
    encode,
    encode_error,
    open_raw_limit,
    sanitize_open_text,
)

log = logging.getLogger("syncclass.ws.routes")

router = APIRouter()

#: `current_slide_index` / `is_screen_sharing` ni DB ga yozish davriyligi.
_FLUSH_INTERVAL_SEC: Final[float] = 3.0

#: Heartbeat nazoratchisi shu qadamda tekshiradi.
_WATCHDOG_TICK_SEC: Final[float] = 5.0

#: Jim turishga ruxsat etilgan vaqt: 3 ta javobsiz interval (AUDIT.md §B4).
_SILENCE_LIMIT_SEC: Final[float] = settings.WS_HEARTBEAT_SEC * 3

#: `QUIZ_ANSWER` uchun tarmoq kechikishiga beriladigan yon.
_QUIZ_GRACE_MS: Final[int] = 1500

#: `POLL_VOTE`/`OPEN_ANSWER` uchun xuddi shu yon (§16.5: "quiz bilan bir xil").
_INTERACTIVE_GRACE_MS: Final[int] = _QUIZ_GRACE_MS


#: `FOCUS_CHANGE` uchun eng kichik oraliq. Frontendda 10 s grace bor (AUDIT.md §F),
#: lekin server unga ISHONMAYDI: `is_focused` ni navbatma-navbat almashtirib
#: yuborish har xabarga bitta DB `UPDATE` keltirib chiqarishi mumkin edi.
_FOCUS_MIN_INTERVAL_SEC: Final[float] = 1.0


# ===========================================================================
# DB ga kechiktirilgan yozuv
# ===========================================================================

_dirty: dict[str, dict[str, Any]] = {}
_flusher: asyncio.Task[None] | None = None


def _mark_dirty(session_id: str, **fields: Any) -> None:
    _dirty.setdefault(session_id, {}).update(fields)


async def _flush_dirty() -> None:
    """To'plangan o'zgarishlarni bitta tranzaksiyada yozadi."""
    if not _dirty:
        return
    batch = {sid: fields for sid, fields in _dirty.items() if fields}
    _dirty.clear()
    if not batch:
        return
    try:
        async with AsyncSessionLocal() as db:
            for session_id, fields in batch.items():
                await db.execute(
                    update(LessonSession)
                    .where(
                        LessonSession.id == uuid.UUID(session_id),
                        LessonSession.status != SessionStatus.ENDED,
                    )
                    .values(**fields)
                )
            await db.commit()
    except Exception:  # DB vaqtincha yo'q bo'lsa jonli dars to'xtamasligi kerak
        log.exception("Xona holatini DB ga yozish muvaffaqiyatsiz")


async def _flush_loop() -> None:
    while True:
        await asyncio.sleep(_FLUSH_INTERVAL_SEC)
        await _flush_dirty()


async def _ensure_background() -> None:
    global _flusher
    if _flusher is None or _flusher.done():
        _flusher = asyncio.create_task(_flush_loop(), name="ws-db-flusher")


# ===========================================================================
# `LIVE_CODE_PATCH` koalesseri
# ===========================================================================


class _CodeCoalescer:
    """`LIVE_CODE_THROTTLE_MS` oynasi: oyna ichidagi patchlar birlashtiriladi.

    AUDIT.md §B1 — o'qituvchi har harf bosganda butun kodni yuborsa 30 klientga
    sekundiga megabaytlar ketadi. Bu yerda **last-write-wins**: oyna ichida
    kelgan patch kutayotganini almashtiradi, oyna tugashi bilan **oxirgi**
    holat e'lon qiladi. Shu sababli hech qachon holat yo'qolmaydi (tashlab
    ketish emas, birlashtirish).
    """

    __slots__ = ("_last_ms", "_pending", "_state", "_task", "_window_ms")

    def __init__(self, state: RoomState, window_ms: int) -> None:
        self._state = state
        self._window_ms = max(0, window_ms)
        self._last_ms = 0.0
        self._pending: tuple[int, str, dict[str, int] | None] | None = None
        self._task: asyncio.Task[None] | None = None

    async def submit(
        self, slide_index: int, code: str, cursor: dict[str, int] | None
    ) -> None:
        loop = asyncio.get_running_loop()
        now = loop.time() * 1000.0
        wait_ms = self._window_ms - (now - self._last_ms)
        if wait_ms <= 0:
            self._last_ms = now
            await self._state.patch_code(slide_index, code, cursor)
            return
        self._pending = (slide_index, code, cursor)
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._flush_after(wait_ms / 1000.0))

    async def _flush_after(self, delay: float) -> None:
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.sleep(delay)
            await self.flush()

    async def flush(self) -> None:
        pending, self._pending = self._pending, None
        if pending is None:
            return
        loop = asyncio.get_running_loop()
        self._last_ms = loop.time() * 1000.0
        with contextlib.suppress(Exception):
            await self._state.patch_code(*pending)

    async def aclose(self) -> None:
        task, self._task = self._task, None
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await self.flush()


# ===========================================================================
# Ulanish konteksti
# ===========================================================================


@dataclass(slots=True)
class _Ctx:
    session_id: str
    group_id: int
    user_id: str
    full_name: str
    role: UserRole
    slides: list[dict[str, Any]]
    state: RoomState
    attendance_status: AttendanceStatus
    db_status: SessionStatus = SessionStatus.LOBBY
    focus_lost_at: float | None = None
    focus_changed_at: float = 0.0
    last_seen: float = 0.0
    coalescer: _CodeCoalescer | None = field(default=None)

    @property
    def is_teacher(self) -> bool:
        return self.role is UserRole.TEACHER

    def slide(self, index: int) -> dict[str, Any] | None:
        if 0 <= index < len(self.slides):
            return self.slides[index]
        return None

    def slide_type(self, index: int) -> str:
        slide = self.slide(index)
        return str(slide.get("type", "MARKDOWN")) if slide else "MARKDOWN"


def _redis_for(ws: WebSocket) -> Redis:
    """Lifespan da yaratilgan klient; bo'lmasa (test/standalone) o'zi yaratadi."""
    pool = getattr(ws.app.state, "redis", None)
    if pool is None:
        pool = create_redis()
        ws.app.state.redis = pool
    return pool


# ===========================================================================
# Endpoint
# ===========================================================================


@router.websocket("/ws/room/{pin_code}")
async def room_socket(
    ws: WebSocket, pin_code: str, ticket: str = Query(default="")
) -> None:
    redis = _redis_for(ws)
    # Listener o'z ulanishini oladi (`app.state.redis` emas) — `manager.start()`
    # izohiga qarang. Holat o'qish/yozish esa umumiy pool orqali.
    await manager.start()
    await _ensure_background()

    # --- 1. Bir martalik ticket (GETDEL) -------------------------------
    # Rad etishning HAMMASI bir xil shaklda: `accept` → `ERROR{code}` → 44xx
    # close. `accept` dan OLDIN yopsak brauzerga shunchaki HTTP 403 ketadi va
    # frontend sababni o'qiy olmaydi (handshake tanasi JS ga ko'rinmaydi).
    user_id = await consume_ticket(redis, ticket)
    if user_id is None:
        await ws.accept()
        with contextlib.suppress(Exception):
            await ws.send_text(
                encode_error("INVALID_TICKET", "Ticket yaroqsiz yoki allaqachon ishlatilgan.")
            )
        await ws.close(code=WS_CLOSE_INVALID_TICKET, reason="INVALID_TICKET")
        return

    # --- 2-4. Foydalanuvchi, sessiya, rol, davomat ----------------------
    try:
        ctx = await _build_context(redis, pin_code, user_id)
    except AppError as exc:
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        code = str(detail.get("code", "FORBIDDEN"))
        await ws.accept()
        with contextlib.suppress(Exception):
            await ws.send_text(encode_error(code, str(detail.get("message", ""))))
        close_code = (
            WS_CLOSE_ROOM_NOT_FOUND if code == "ROOM_NOT_FOUND" else WS_CLOSE_FORBIDDEN
        )
        await ws.close(code=close_code, reason=code)
        return

    await ws.accept()

    # --- 5. members HASH + STUDENT_JOINED (ro'yxatga olishdan OLDIN) ----
    # Shu tartibda yangi socket o'zining `STUDENT_JOINED` ini ko'rmaydi,
    # boshqalar esa ko'radi.
    if not ctx.is_teacher:
        await ctx.state.add_member(
            Participant(
                student_id=uuid.UUID(ctx.user_id),
                full_name=ctx.full_name,
                avatar_url=None,
                status=ctx.attendance_status,
            )
        )

    conn = manager.register(
        ws=ws,
        session_id=ctx.session_id,
        user_id=ctx.user_id,
        role=ctx.role,
        full_name=ctx.full_name,
    )
    if ctx.is_teacher:
        ctx.coalescer = _CodeCoalescer(ctx.state, settings.LIVE_CODE_THROTTLE_MS)
        # DIQQAT: bu yerda `LIVE` ga O'TKAZILMAYDI. O'qituvchi sahifani ochishi
        # hali dars emas — u lobbida PIN/QR ko'rsatib o'quvchilarni kutadi.
        # `LOBBY -> LIVE` faqat birinchi `SLIDE_CHANGE` da (ya'ni "Darsni
        # boshlash" bosilganda) bo'ladi — pastdagi `_dispatch` ga qarang.
        # Aks holda o'quvchi PIN terishi bilan (o'qituvchi boshlamasidan)
        # slayd ochilib ketadi (snapshotdagi `status: LIVE` lobbini chetlaydi).

    try:
        # --- 6. ROOM_STATE_SYNC: Redis Hash dan to'liq holat ------------
        snapshot = await ctx.state.snapshot()
        sync_data = snapshot.to_sync_data()
        if ctx.is_teacher:
            # §16.3 K4: jonli diagramma FAQAT o'qituvchi snapshotiga, alohida
            # o'qish yo'li orqali. O'quvchi uchun bu chaqiruv umuman bo'lmaydi.
            sync_data.update(await ctx.state.teacher_live_view())
        await ws.send_text(encode(ServerEvent.ROOM_STATE_SYNC, sync_data, seq=snapshot.seq))
        ctx.last_seen = asyncio.get_running_loop().time()
        await _serve(ws, ctx)
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("WS ulanishida kutilmagan xato")
    finally:
        manager.unregister(conn)
        if ctx.coalescer is not None:
            with contextlib.suppress(Exception):
                await ctx.coalescer.aclose()
        # --- 8. STUDENT_LEFT faqat oxirgi socket yopilganda -------------
        if not ctx.is_teacher and not manager.has_other_connection(conn):
            with contextlib.suppress(Exception):
                await ctx.state.remove_member(ctx.user_id)
        if ctx.focus_lost_at is not None:
            with contextlib.suppress(Exception):
                await _apply_focus(ctx, is_focused=True, persist_only=True)
        if ctx.is_teacher:
            await _flush_dirty()


async def _build_context(redis: Redis, pin_code: str, user_id: str) -> _Ctx:
    """DB dan foydalanuvchi + sessiya + rol; o'quvchiga avto-davomat."""
    async with AsyncSessionLocal() as db:
        try:
            uid = uuid.UUID(user_id)
        except ValueError:
            raise AppError(403, "FORBIDDEN", "Ticket subyekti yaroqsiz.") from None
        user = (await db.execute(select(User).where(User.id == uid))).scalar_one_or_none()
        if user is None or not user.is_active:
            raise AppError(403, "FORBIDDEN", "Foydalanuvchi faol emas.")

        session = await load_session(db, pin_code)
        role = await resolve_room_role(db, session, user)

        attendance_status = AttendanceStatus.PRESENT
        if role is UserRole.STUDENT:
            attendance_status = await upsert_attendance(db, session, user.id)
            await db.commit()

        slides = list(session.presentation.slides_data or [])
        session_id = str(session.id)
        db_slide_index = session.current_slide_index
        db_status = session.status
        group_id = session.group_id
        full_name = user.full_name

    state = RoomState(redis, session_id)
    # Redis bo'shagan bo'lsa (restart/TTL) DB dagi holatdan tiklanadi.
    slide_type = (
        str(slides[db_slide_index].get("type", "MARKDOWN"))
        if 0 <= db_slide_index < len(slides)
        else "MARKDOWN"
    )
    await state.ensure(
        slide_index=db_slide_index, slide_type=slide_type, code="", status=db_status.value
    )

    return _Ctx(
        session_id=session_id,
        group_id=group_id,
        user_id=str(uid),
        full_name=full_name,
        role=role,
        slides=slides,
        state=state,
        attendance_status=attendance_status,
        db_status=db_status,
    )


# ===========================================================================
# Asosiy tsikl + heartbeat nazoratchisi
# ===========================================================================


async def _serve(ws: WebSocket, ctx: _Ctx) -> None:
    """Xabarlarni o'qiydi. Heartbeat nazoratchisi alohida taskda.

    `receive_text()` ni `wait_for` ichiga olmaymiz: ASGI `receive` ni yarim
    yo'lda bekor qilish xabar yo'qolishiga olib kelishi mumkin. Nazoratchi
    soketni **yopadi**, bu esa `receive_text()` da uzilish beradi.
    """
    watchdog = asyncio.create_task(_watchdog(ws, ctx), name="ws-heartbeat")
    try:
        while True:
            raw = await ws.receive_text()
            ctx.last_seen = asyncio.get_running_loop().time()
            await _handle(ws, ctx, raw)
    finally:
        watchdog.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await watchdog


async def _watchdog(ws: WebSocket, ctx: _Ctx) -> None:
    loop = asyncio.get_running_loop()
    while True:
        await asyncio.sleep(_WATCHDOG_TICK_SEC)
        if loop.time() - ctx.last_seen > _SILENCE_LIMIT_SEC:
            log.info(
                "WS heartbeat yo'q — yopiladi",
                extra={"extra_fields": {"user_id": ctx.user_id}},
            )
            with contextlib.suppress(Exception):
                await ws.close(code=WS_CLOSE_HEARTBEAT_TIMEOUT, reason="HEARTBEAT_TIMEOUT")
            return


async def _handle(ws: WebSocket, ctx: _Ctx, raw: str) -> None:
    """Bitta klient xabarini qayta ishlaydi. Xato → `ERROR`, ulanish tirik qoladi."""
    try:
        event, payload = decode(raw, ctx.role)
    except ProtocolError as exc:
        with contextlib.suppress(Exception):
            await ws.send_text(encode_error(exc.code, exc.message))
        return

    try:
        await _dispatch(ws, ctx, event, payload)
    except ProtocolError as exc:
        with contextlib.suppress(Exception):
            await ws.send_text(encode_error(exc.code, exc.message))


async def _dispatch(ws: WebSocket, ctx: _Ctx, event: ClientEvent, payload: Any) -> None:
    if event is ClientEvent.PING:
        await ws.send_text(encode(ServerEvent.PONG, {}))
        return

    if event is ClientEvent.SLIDE_CHANGE:
        if ctx.slide(payload.slide_index) is None:
            raise ProtocolError("BAD_PAYLOAD", "Bunday indeksli slayd yo'q.")
        # Birinchi `SLIDE_CHANGE` = "Darsni boshlash": `LOBBY -> LIVE` shu yerda
        # (o'qituvchi shunchaki sahifani ochganda EMAS — o'quvchilar lobbida
        # kutishi kerak). Idempotent: keyingi slaydlarda holat allaqachon LIVE.
        if ctx.db_status is SessionStatus.LOBBY:
            await ctx.state.set_status(SessionStatus.LIVE.value)
            _mark_dirty(ctx.session_id, status=SessionStatus.LIVE)
            ctx.db_status = SessionStatus.LIVE
        slide_type = ctx.slide_type(payload.slide_index)
        await ctx.state.set_slide(payload.slide_index, slide_type)
        _mark_dirty(ctx.session_id, current_slide_index=payload.slide_index)
        return

    if event is ClientEvent.LIVE_CODE_PATCH:
        if ctx.coalescer is None:  # pragma: no cover - rol-guard allaqachon to'sadi
            raise ProtocolError("FORBIDDEN_EVENT", "Kod yozish faqat o'qituvchida.")
        cursor = payload.cursor.model_dump() if payload.cursor is not None else None
        await ctx.coalescer.submit(payload.slide_index, payload.code, cursor)
        return

    if event is ClientEvent.LASER_MOVE:
        await ctx.state.laser_move(payload.x, payload.y, payload.drawing)
        return

    if event is ClientEvent.SCREEN_SHARE_STATE:
        await ctx.state.set_sharing(payload.is_sharing, livekit_room_name(ctx.session_id))
        _mark_dirty(ctx.session_id, is_screen_sharing=payload.is_sharing)
        return

    if event is ClientEvent.CONFUSED_PING:
        accepted, _count, _pct, _env = await ctx.state.mark_confused(ctx.user_id)
        if not accepted:
            raise ProtocolError(
                "CONFUSED_COOLDOWN", "Bir belgi 30 soniyada bir marta yuboriladi."
            )
        return

    if event is ClientEvent.FOCUS_CHANGE:
        await _apply_focus(ctx, is_focused=payload.is_focused)
        return

    if event is ClientEvent.QUIZ_START:
        await _start_quiz(ctx, payload.slide_index)
        return

    if event is ClientEvent.QUIZ_ANSWER:
        await _answer_quiz(ctx, payload.quiz_id, payload.selected_index)
        return

    if event is ClientEvent.QUIZ_END:
        await _end_quiz(ctx, payload.quiz_id)
        return

    # --- v1.2 interaktiv slaydlar (§16.3) — QUIZ_* yo'liga tegmaydi ------
    if event is ClientEvent.POLL_START:
        await _start_poll(ctx, payload.slide_index)
        return

    if event is ClientEvent.POLL_VOTE:
        _raise_if_failed(
            await ctx.state.vote_poll(payload.poll_id, ctx.user_id, payload.selected_index)
        )
        return

    if event is ClientEvent.POLL_END:
        _raise_if_failed(await ctx.state.end_poll(payload.poll_id))
        return

    if event is ClientEvent.OPEN_START:
        await _start_open(ctx, payload.slide_index)
        return

    if event is ClientEvent.OPEN_ANSWER:
        await _answer_open(ctx, payload.open_id, payload.text)
        return

    if event is ClientEvent.OPEN_HIDE:
        _raise_if_failed(await ctx.state.hide_open(payload.open_id, payload.answer_id))
        return

    if event is ClientEvent.OPEN_END:
        _raise_if_failed(await ctx.state.end_open(payload.open_id))
        return

    raise ProtocolError("UNKNOWN_EVENT", f"`{event.value}` qo'llab-quvvatlanmaydi.")


# ===========================================================================
# v1.2: POLL / OPEN (CONTRACTS.md §16.3)
# ===========================================================================

_IA_MESSAGES: Final[dict[str, str]] = {
    "POLL_NOT_ACTIVE": "Bu so'rovnoma hozir faol emas.",
    "OPEN_NOT_ACTIVE": "Bu savol hozir faol emas.",
    "ALREADY_VOTED": "Siz allaqachon ovoz bergansiz.",
    "INVALID_OPTION": "Bunday variant yo'q.",
    "RATE_LIMITED": "Juda tez. Javobni 2 soniyadan keyin qayta yuboring.",
}


def _raise_if_failed(result: InteractiveResult) -> None:
    """Lua natijasini `ERROR` ga aylantiradi. Muvaffaqiyatli event Pub/Sub orqali ketgan."""
    if not result.ok:
        code = result.error or "BAD_PAYLOAD"
        raise ProtocolError(code, _IA_MESSAGES.get(code, "So'rov bajarilmadi."))


async def _require_live(ctx: _Ctx) -> None:
    """Boshlash faqat `LIVE` xonada (§16.3). LOBBY tekshiruvi himoya qatlami (§16.5)."""
    status = await ctx.state.current_status()
    if status == SessionStatus.ENDED.value:
        raise ProtocolError("ROOM_ENDED", "Dars tugagan.")
    if status != SessionStatus.LIVE.value:
        raise ProtocolError("ROOM_NOT_LIVE", "Dars hali boshlanmagan.")


def _poll_slide(ctx: _Ctx, slide_index: int) -> PollSlide:
    """Slayd SERVERDA `slides_data` dan o'qiladi — klient matniga ishonilmaydi.

    Validatsiya `content-engineer` ning `PollSlide` modeli bilan (§16.1
    chegaralari, `extra="forbid"`) — chegaralar bitta joyda yashaydi.
    """
    slide = ctx.slide(slide_index)
    if slide is None or slide.get("type") != "POLL":
        raise ProtocolError("NOT_A_POLL", "Bu slayd so'rovnoma emas.")
    try:
        return PollSlide.model_validate(slide)
    except ValidationError:
        raise ProtocolError("NOT_A_POLL", "So'rovnoma slaydi yaroqsiz.") from None


def _open_slide(ctx: _Ctx, slide_index: int) -> OpenSlide:
    slide = ctx.slide(slide_index)
    if slide is None or slide.get("type") != "OPEN":
        raise ProtocolError("NOT_AN_OPEN", "Bu slayd ochiq savol emas.")
    try:
        return OpenSlide.model_validate(slide)
    except ValidationError:
        raise ProtocolError("NOT_AN_OPEN", "Ochiq savol slaydi yaroqsiz.") from None


def _deadline(duration_sec: int) -> tuple[str, int]:
    """`ends_at` (ISO, klientga) va qabul muddati (ms, faqat serverda)."""
    ends_at = datetime.now(UTC) + timedelta(seconds=duration_sec)
    return ends_at.isoformat(), now_ms() + duration_sec * 1000 + _INTERACTIVE_GRACE_MS


async def _start_poll(ctx: _Ctx, slide_index: int) -> None:
    await _require_live(ctx)
    slide = _poll_slide(ctx, slide_index)
    ends_at, deadline_ms = _deadline(slide.duration_sec)
    await ctx.state.start_poll(
        {
            "poll_id": f"poll-{uuid.uuid4().hex[:12]}",
            "slide_index": slide_index,
            "question": slide.question,
            "options": list(slide.options),
            "duration_sec": slide.duration_sec,
            "ends_at": ends_at,
        },
        deadline_ms,
    )
    _mark_dirty(ctx.session_id, current_slide_index=slide_index)


async def _start_open(ctx: _Ctx, slide_index: int) -> None:
    await _require_live(ctx)
    slide = _open_slide(ctx, slide_index)
    ends_at, deadline_ms = _deadline(slide.duration_sec)
    await ctx.state.start_open(
        {
            "open_id": f"open-{uuid.uuid4().hex[:12]}",
            "slide_index": slide_index,
            "question": slide.question,
            "duration_sec": slide.duration_sec,
            "ends_at": ends_at,
            "max_chars": slide.max_chars,
        },
        deadline_ms,
    )
    _mark_dirty(ctx.session_id, current_slide_index=slide_index)


async def _answer_open(ctx: _Ctx, open_id: str, raw_text: str) -> None:
    """Uzunlik → tozalash → atomar yozish (§16.3).

    `max_chars` FAOL open dan olinadi (`active_open` — server o'zi yozgan
    qiymat), klientdan emas. Open faol bo'lmasa Lua `OPEN_NOT_ACTIVE` qaytaradi.
    """
    active = await ctx.state.active_open()
    if not active or active.get("open_id") != open_id:
        raise ProtocolError("OPEN_NOT_ACTIVE", _IA_MESSAGES["OPEN_NOT_ACTIVE"])
    max_chars = int(active.get("max_chars") or DEFAULT_OPEN_MAX_CHARS)
    # K2: xom kirish chegarasi TOZALASHDAN OLDIN — megabaytli matn
    # NFKC/regex ga umuman yetib bormaydi.
    if len(raw_text) > open_raw_limit(max_chars):
        raise ProtocolError(
            "ANSWER_TOO_LONG", f"Javob juda uzun (eng ko'pi {max_chars} belgi)."
        )
    text = sanitize_open_text(raw_text, max_chars)
    if not text:
        raise ProtocolError("BAD_PAYLOAD", "Javob bo'sh.")
    _raise_if_failed(await ctx.state.answer_open(open_id, ctx.user_id, text))


# ===========================================================================
# Focus tracker (AUDIT.md §F — faqat tavsiya xarakterida)
# ===========================================================================


async def _apply_focus(
    ctx: _Ctx, *, is_focused: bool, persist_only: bool = False
) -> None:
    """`tab_switches_count` / `focus_lost_seconds` ni yangilaydi.

    Bu ma'lumot **bahoga ta'sir qilmaydi** va o'quvchi ekranida ochiq
    ko'rsatiladi (yashirin kuzatuv emas).
    """
    loop = asyncio.get_running_loop()
    now = loop.time()
    if not persist_only and now - ctx.focus_changed_at < _FOCUS_MIN_INTERVAL_SEC:
        return
    ctx.focus_changed_at = now
    switches_delta = 0
    lost_delta = 0

    if not is_focused:
        if ctx.focus_lost_at is None:
            ctx.focus_lost_at = now
            switches_delta = 1
    elif ctx.focus_lost_at is not None:
        lost_delta = max(0, int(now - ctx.focus_lost_at))
        ctx.focus_lost_at = None

    if switches_delta == 0 and lost_delta == 0 and not persist_only:
        return

    async with AsyncSessionLocal() as db:
        total = (
            await db.execute(
                update(Attendance)
                .where(
                    Attendance.session_id == uuid.UUID(ctx.session_id),
                    Attendance.student_id == uuid.UUID(ctx.user_id),
                )
                .values(
                    tab_switches_count=Attendance.tab_switches_count + switches_delta,
                    focus_lost_seconds=Attendance.focus_lost_seconds + lost_delta,
                )
                .returning(Attendance.tab_switches_count)
            )
        ).scalar_one_or_none()
        await db.commit()

    if persist_only:
        return
    await ctx.state.focus_change(ctx.user_id, is_focused, int(total or 0))


# ===========================================================================
# Quiz oqimi
# ===========================================================================


async def _start_quiz(ctx: _Ctx, slide_index: int) -> None:
    """`QUIZ_START` — `ends_at` ni **server** belgilaydi (AUDIT.md §G3).

    Slayd validatsiyasi `content-engineer` ning `load_quiz_slide()` sida:
    noto'g'ri tuzilgan slayd bu yergacha yetib kelmaydi.
    """
    slide = load_quiz_slide(ctx.slides, slide_index)
    if slide is None:
        raise ProtocolError("NOT_A_QUIZ", "Bu slayd quiz emas yoki yaroqsiz.")

    quiz = ActiveQuiz(
        quiz_id=make_quiz_id(ctx.session_id, slide_index),
        slide_index=slide_index,
        question=slide.question,
        options=list(slide.options),
        duration_sec=slide.duration_sec,
        ends_at=datetime.now(UTC) + timedelta(seconds=slide.duration_sec),
        started_at_ms=now_ms(),
        correct_option=slide.correct_option,
        points=slide.points,
    )
    await ctx.state.start_quiz(quiz)
    _mark_dirty(ctx.session_id, current_slide_index=slide_index)


async def _answer_quiz(ctx: _Ctx, quiz_id: str, selected_index: int) -> None:
    """`answer_ms` **serverda** `now - started_at` dan hisoblanadi.

    Klient yuborgan `time_ms` faqat telemetriya — soatni o'zgartirib XP
    oshirib bo'lmaydi (AUDIT.md §G3). Diapazondan tashqari `selected_index`
    ataylab RAD ETILMAYDI: `record_answer()` uni "noto'g'ri javob" deb yozadi,
    shunda "avval yaroqsiz, keyin to'g'ri javob" yo'li yopiladi.
    """
    quiz = await ctx.state.get_active_quiz()
    if quiz is None or quiz.quiz_id != quiz_id:
        raise ProtocolError("QUIZ_NOT_ACTIVE", "Bu test hozir faol emas.")
    slide = load_quiz_slide(ctx.slides, quiz.slide_index)
    if slide is None:  # pragma: no cover - QUIZ_START da tekshirilgan
        raise ProtocolError("NOT_A_QUIZ", "Slayd yaroqsiz.")

    elapsed = now_ms() - quiz.started_at_ms
    if elapsed > slide.duration_sec * 1000 + _QUIZ_GRACE_MS:
        raise ProtocolError("QUIZ_CLOSED", "Javob berish vaqti tugadi.")

    async with AsyncSessionLocal() as db:
        outcome = await record_answer(
            db,
            session_id=uuid.UUID(ctx.session_id),
            slide_index=quiz.slide_index,
            student_id=uuid.UUID(ctx.user_id),
            slide=slide,
            selected_index=selected_index,
            answer_ms=elapsed,
        )
        # `record_answer()` ATAYLAB commit qilmaydi (CONTRACTS.md §2.3).
        await db.commit()
        answered = await count_answers(
            db, session_id=uuid.UUID(ctx.session_id), slide_index=quiz.slide_index
        )

    if not outcome.accepted:
        raise ProtocolError("ALREADY_ANSWERED", "Siz bu savolga allaqachon javob berdingiz.")

    total = await ctx.state.member_count()
    await ctx.state.quiz_progress(quiz.quiz_id, answered, total)


async def _end_quiz(ctx: _Ctx, quiz_id: str) -> None:
    """`QUIZ_RESULTS` — taqsimot + leaderboard, keyin `active_quiz` tozalanadi."""
    quiz = await ctx.state.get_active_quiz()
    if quiz is None or quiz.quiz_id != quiz_id:
        raise ProtocolError("QUIZ_NOT_ACTIVE", "Bu test hozir faol emas.")
    slide = load_quiz_slide(ctx.slides, quiz.slide_index)
    if slide is None:  # pragma: no cover
        raise ProtocolError("NOT_A_QUIZ", "Slayd yaroqsiz.")

    async with AsyncSessionLocal() as db:
        results = await build_results(
            db,
            session_id=uuid.UUID(ctx.session_id),
            slide_index=quiz.slide_index,
            slide=slide,
        )
    payload = results.model_dump(mode="json")
    # Variant MATNLARI: reconnect `QUIZ_START` va `QUIZ_RESULTS` orasiga tushsa,
    # klientda faqat `distribution` bo'lib "A/B varianti" chiqardi. Tartib
    # `build_results()` ning `distribution` i bilan AYNAN bir xil, chunki
    # ikkisi ham bitta `slide.options` dan kelib chiqadi.
    payload["options"] = list(slide.options)
    await ctx.state.finish_quiz(payload)


__all__ = ["router"]
