"""`RoomManager` — lokal WS ulanishlari + **bitta global** Redis PubSub listener.

### Nega bitta listener?
Har xona uchun alohida `pubsub` ochish 30 darsda 30 ta Redis ulanishi va 30 ta
task degani. Buning o'rniga bitta ulanish `room:*:channel` pattern iga
`PSUBSCRIBE` qiladi va kanal nomidan `session_id` ajratiladi. Bu, qo'shimcha
sifatida, **tartibni** ham saqlaydi: bitta listener xabarlarni Redis bergan
ketma-ketlikda qayta ishlaydi (AUDIT.md §B5).

### Backpressure
Sekin klient (telefon, yomon tarmoq) `send` da osilib qolsa, `asyncio.gather`
butun xonani kutib turadi va 100 ms talabi buziladi. Shuning uchun har bir
`send` `WS_SEND_TIMEOUT_SEC` (2 s) bilan o'raladi; timeout bo'lsa ulanish
**uziladi** (`4413`), xona esa ishlashda davom etadi.

### Nega qayta seriyalanmaydi?
Pub/Sub dan kelgan envelope allaqachon tayyor JSON matn (Lua ichida yig'ilgan).
U `send_text` ga **o'zi** beriladi: 20 KB lik `LIVE_CODE_PATCH` ni 30 ta klient
uchun 30 marta `json.dumps` qilish p95 ni buzardi.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import logging
from typing import Final

from fastapi import WebSocket
from redis.asyncio import Redis

from app.core.deps import create_redis
from app.db.models import UserRole
from app.services.room_state import CHANNEL_PATTERN, session_id_from_channel
from app.ws.protocol import (
    TEACHER_ONLY_AUDIENCE,
    WS_CLOSE_SESSION_ENDED,
    WS_CLOSE_SLOW_CLIENT,
    ServerEvent,
    event_type_of,
)

log = logging.getLogger("syncclass.ws.manager")

#: Sekin klientni shu muddatdan keyin uzamiz (backpressure himoyasi).
WS_SEND_TIMEOUT_SEC: Final[float] = 2.0

#: PubSub listener qayta ulanishga urinishlar orasidagi tanaffus.
_RECONNECT_DELAY_SEC: Final[float] = 0.5


class Connection:
    """Bitta ochiq WebSocket ulanishi.

    `conn_id` — bir foydalanuvchi ikki qurilmadan kirishi mumkin, shuning uchun
    kalit `user_id` emas, monotonik raqam.
    """

    __slots__ = ("alive", "conn_id", "full_name", "role", "session_id", "user_id", "ws")

    def __init__(
        self,
        *,
        conn_id: int,
        ws: WebSocket,
        session_id: str,
        user_id: str,
        role: UserRole,
        full_name: str,
    ) -> None:
        self.conn_id = conn_id
        self.ws = ws
        self.session_id = session_id
        self.user_id = user_id
        self.role = role
        self.full_name = full_name
        self.alive = True

    @property
    def is_teacher(self) -> bool:
        return self.role is UserRole.TEACHER

    def __repr__(self) -> str:  # pragma: no cover - faqat debug
        return f"<Connection {self.conn_id} {self.role.value} room={self.session_id[:8]}>"


class RoomManager:
    """Jarayon doirasidagi xonalar reyestri va Pub/Sub ko'prigi."""

    def __init__(self) -> None:
        self._rooms: dict[str, dict[int, Connection]] = {}
        self._ids = itertools.count(1)
        self._redis: Redis | None = None
        self._owns_redis = False
        self._pubsub = None
        self._task: asyncio.Task[None] | None = None
        self._ready: asyncio.Event = asyncio.Event()
        self._lock = asyncio.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None

    def _bind_loop(self) -> None:
        """Loop-bound primitivlarni joriy event loop ga bog'laydi.

        `manager` — modul darajasidagi YAGONA nusxa, `asyncio.Lock`/`Event` esa
        birinchi ishlatilgan loop ga bog'lanib qoladi. Boshqa loop dan
        murojaat `RuntimeError: ... bound to a different event loop` beradi, va
        bu xato `ws.accept()` DAN OLDIN sodir bo'lgani uchun Starlette butun
        handshake ni HTTP 403 bilan rad etadi — ya'ni WS qatlami butunlay
        "ishlamay" qoladi. Amalda bu to'liq test to'plamida chiqadi: har test
        moduli o'z loop ini ochadi.

        Loop almashgani aniqlansa — eski loop allaqachon yopilgan, undagi
        socketlar va listener task o'lik. Shuning uchun holat toza boshlanadi.
        """
        loop = asyncio.get_running_loop()
        if self._loop is loop:
            return
        self._loop = loop
        self._lock = asyncio.Lock()
        self._ready = asyncio.Event()
        # Eski loop dagi task ni cancel qilib bo'lmaydi (loop yopilgan) —
        # u loop bilan birga yo'q bo'lgan.
        self._task = None
        self._pubsub = None
        self._redis = None
        self._owns_redis = False
        self._rooms.clear()

    # -- hayot sikli -----------------------------------------------------

    async def start(self, redis: Redis | None = None) -> None:
        """Listener ni ishga tushiradi. **Idempotent** — ko'p marta chaqirilsa xavfsiz.

        `redis` berilmasa listener O'ZINING alohida ulanishini oladi. Bu ataylab:
        bloklanadigan `PSUBSCRIBE` ulanishi umumiy pool dan olinmasligi kerak,
        va ilova `app.state.redis` ni yopganda listener "Connection closed by
        server" bilan qayta ulanishga urinib log ni to'ldirmasligi kerak.
        """
        self._bind_loop()
        async with self._lock:
            if self._task is not None and not self._task.done():
                await self._ready.wait()
                return
            self._owns_redis = redis is None
            self._redis = redis if redis is not None else create_redis()
            self._ready.clear()
            self._task = asyncio.create_task(self._listen(), name="ws-pubsub-listener")
        await self._ready.wait()

    async def stop(self) -> None:
        self._bind_loop()
        async with self._lock:
            task, self._task = self._task, None
            pubsub, self._pubsub = self._pubsub, None
            redis, self._redis = self._redis, None
            owns, self._owns_redis = self._owns_redis, False
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        if pubsub is not None:
            with contextlib.suppress(Exception):
                await pubsub.aclose()
        if owns and redis is not None:
            with contextlib.suppress(Exception):
                await redis.aclose()
        self._ready.clear()

    @property
    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    # -- ro'yxatga olish -------------------------------------------------

    def register(
        self,
        *,
        ws: WebSocket,
        session_id: str,
        user_id: str,
        role: UserRole,
        full_name: str,
    ) -> Connection:
        conn = Connection(
            conn_id=next(self._ids),
            ws=ws,
            session_id=session_id,
            user_id=user_id,
            role=role,
            full_name=full_name,
        )
        self._rooms.setdefault(session_id, {})[conn.conn_id] = conn
        return conn

    def unregister(self, conn: Connection) -> None:
        conn.alive = False
        room = self._rooms.get(conn.session_id)
        if room is None:
            return
        room.pop(conn.conn_id, None)
        if not room:
            self._rooms.pop(conn.session_id, None)

    def local_connections(self, session_id: str) -> list[Connection]:
        return list(self._rooms.get(session_id, {}).values())

    def local_count(self, session_id: str) -> int:
        return len(self._rooms.get(session_id, {}))

    def has_other_connection(self, conn: Connection) -> bool:
        """Shu foydalanuvchining xonada BOSHQA ulanishi bormi?

        Reconnect paytida (eski socket hali yopilmagan) `STUDENT_LEFT`
        yuborib yubormaslik uchun kerak.
        """
        return any(
            other.user_id == conn.user_id and other.conn_id != conn.conn_id
            for other in self._rooms.get(conn.session_id, {}).values()
        )

    # -- yuborish --------------------------------------------------------

    async def send(self, conn: Connection, envelope_json: str) -> bool:
        """Bitta ulanishga yuboradi. Timeout/xato → ulanish uziladi."""
        if not conn.alive:
            return False
        try:
            await asyncio.wait_for(conn.ws.send_text(envelope_json), WS_SEND_TIMEOUT_SEC)
        except TimeoutError:
            # HAQIQIY backpressure: klient 2 s ichida qabul qilmadi.
            log.warning(
                "WS sekin klient uzildi",
                extra={"extra_fields": {"conn_id": conn.conn_id, "user_id": conn.user_id}},
            )
            await self._kill(conn, WS_CLOSE_SLOW_CLIENT)
            return False
        except Exception:
            # Allaqachon yopilgan socket (oddiy uzilish, server to'xtashi) —
            # bu xato emas, shuning uchun WARNING ga ko'tarilmaydi.
            log.debug("WS yopilgan socketga yuborish", exc_info=True)
            await self._kill(conn, WS_CLOSE_SLOW_CLIENT)
            return False
        return True

    async def _kill(self, conn: Connection, code: int) -> None:
        conn.alive = False
        self.unregister(conn)
        with contextlib.suppress(Exception):
            await conn.ws.close(code=code)

    async def fanout(self, session_id: str, envelope_json: str, *, teacher_only: bool) -> int:
        """Lokal ulanishlarga parallel yuboradi. → muvaffaqiyatli yuborilgan soni."""
        targets = [
            c
            for c in self._rooms.get(session_id, {}).values()
            if c.alive and (c.is_teacher or not teacher_only)
        ]
        if not targets:
            return 0
        results = await asyncio.gather(
            *(self.send(c, envelope_json) for c in targets), return_exceptions=True
        )
        return sum(1 for ok in results if ok is True)

    # -- Pub/Sub listener ------------------------------------------------

    async def _listen(self) -> None:
        """`room:*:channel` ni kuzatadi va lokal ulanishlarga tarqatadi."""
        redis = self._redis
        if redis is None:  # pragma: no cover - start() dan oldin chaqirilmaydi
            self._ready.set()
            return
        while True:
            try:
                pubsub = redis.pubsub(ignore_subscribe_messages=True)
                await pubsub.psubscribe(CHANNEL_PATTERN)
                self._pubsub = pubsub
                self._ready.set()
                log.info("WS PubSub listener ishga tushdi (%s)", CHANNEL_PATTERN)
                async for message in pubsub.listen():
                    if message is None or message.get("type") not in {"message", "pmessage"}:
                        continue
                    await self._dispatch(message)
            except asyncio.CancelledError:
                with contextlib.suppress(Exception):
                    if self._pubsub is not None:
                        await self._pubsub.aclose()
                raise
            except Exception:  # Redis uzilsa qayta ulanamiz
                log.exception("WS PubSub listener xatosi — qayta ulanamiz")
                self._ready.clear()
                with contextlib.suppress(Exception):
                    if self._pubsub is not None:
                        await self._pubsub.aclose()
                await asyncio.sleep(_RECONNECT_DELAY_SEC)

    async def _dispatch(self, message: dict[str, object]) -> None:
        raw_channel = message.get("channel")
        channel = raw_channel.decode() if isinstance(raw_channel, bytes) else str(raw_channel)
        session_id = session_id_from_channel(channel)
        if session_id is None or session_id not in self._rooms:
            return

        raw_data = message.get("data")
        envelope = raw_data.decode() if isinstance(raw_data, bytes) else str(raw_data)
        event = event_type_of(envelope)

        await self.fanout(session_id, envelope, teacher_only=event in TEACHER_ONLY_AUDIENCE)

        if event == ServerEvent.SESSION_ENDED.value:
            # Dars tugadi: hamma socket yopiladi (klient qayta ulanmaydi).
            for conn in self.local_connections(session_id):
                await self._kill(conn, WS_CLOSE_SESSION_ENDED)


#: Jarayon bo'yicha yagona nusxa — `app/ws/routes.py` shuni ishlatadi.
manager: Final[RoomManager] = RoomManager()

__all__ = ["WS_SEND_TIMEOUT_SEC", "Connection", "RoomManager", "manager"]
