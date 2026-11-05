#!/usr/bin/env python
"""WS yuklama testi — DoD #2: `SLIDE_CHANGE` p95 **< 100 ms** (30 o'quvchi).

Nima o'lchanadi
---------------
Kechikish = (o'quvchi eventni OLGAN payt) − (o'qituvchi eventni YUBORGAN payt),
bitta mashinada `time.perf_counter()` bilan. Ya'ni to'liq zanjir:

    o'qituvchi WS → uvicorn → protokol validatsiyasi → Redis Lua (seq + state +
    PUBLISH) → global PubSub listener → 30 ta lokal socketga fan-out

Moslashtirish `seq` bo'yicha (indeks tartibi bo'yicha emas): o'qituvchi socketi
ham xonada bo'lgani uchun o'z eventining server bergan `seq` ini ko'radi, shu
bilan "yuborildi" vaqti `seq` ga bog'lanadi. Shu sababli bitta event yo'qolsa
ham qolgan o'lchovlar siljib ketmaydi.

`LIVE_CODE_PATCH` ataylab `LIVE_CODE_THROTTLE_MS + 10 ms` qadam bilan
yuboriladi — haqiqiy frontend ham shunday qiladi (AUDIT.md §B1). Tezroq
yuborilsa server koalesserga tushadi va bu endi "kechikish" emas, "birlashtirish"
bo'ladi.

Ishga tushirish
---------------
    DATABASE_URL=postgresql+asyncpg://syncclass:syncclass@localhost:55432/syncclass \\
    REDIS_URL=redis://localhost:56379/0 \\
    backend/.venv/bin/python scripts/loadtest_ws.py

Tashqi serverga qarshi: `--url 127.0.0.1:8000` (o'zi uvicorn ko'tarmaydi).
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import socket
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_BACKEND = Path(__file__).resolve().parent.parent / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import httpx  # noqa: E402
import uvicorn  # noqa: E402
import websockets  # noqa: E402
from sqlalchemy import select  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.security import create_access_token  # noqa: E402
from app.db.models import (  # noqa: E402
    Group,
    GroupMember,
    LessonSession,
    Presentation,
    User,
    UserRole,
)

LOAD_GROUP_NAME = "LOAD-TEST"
LOAD_INVITE_CODE = "LOADTEST-30"
LOAD_EMAIL_FMT = "loadtest{:02d}@syncclass.local"

#: `SLIDE_CHANGE` uchun qat'iy talab (AUDIT.md §I, DoD #2).
SLIDE_P95_BUDGET_MS = 100.0
#: `LIVE_CODE_PATCH` uchun talab (DoD #2).
CODE_P95_BUDGET_MS = 150.0


# ===========================================================================
# Statistika
# ===========================================================================


def percentile(values: list[float], q: float) -> float:
    """Chiziqli interpolyatsiyali persentil (NumPy `linear` usuli)."""
    if not values:
        return float("nan")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * q
    low = int(pos)
    high = min(low + 1, len(ordered) - 1)
    weight = pos - low
    return ordered[low] * (1.0 - weight) + ordered[high] * weight


@dataclass(slots=True)
class Stats:
    name: str
    samples: list[float] = field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.samples)

    def report(self) -> dict[str, float]:
        return {
            "min": min(self.samples) if self.samples else float("nan"),
            "p50": percentile(self.samples, 0.50),
            "p95": percentile(self.samples, 0.95),
            "p99": percentile(self.samples, 0.99),
            "max": max(self.samples) if self.samples else float("nan"),
        }


# ===========================================================================
# DB tayyorgarligi (idempotent)
# ===========================================================================


@dataclass(slots=True)
class Fixture:
    teacher_id: uuid.UUID
    teacher_role: str
    teacher_tv: int
    presentation_id: uuid.UUID
    group_id: int
    students: list[tuple[uuid.UUID, str, int]]


async def prepare_fixture(client_count: int) -> Fixture:
    """`LOAD-TEST` guruhi + `client_count` ta o'quvchi. Qayta ishga tushsa yangi yozuv yaratmaydi."""
    engine = create_async_engine(settings.sqlalchemy_url)
    factory = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    try:
        async with factory() as db:
            teacher = (
                await db.execute(select(User).where(User.role == UserRole.TEACHER).limit(1))
            ).scalar_one_or_none()
            if teacher is None:
                raise SystemExit("Seed yo'q: avval `python scripts/seed.py` ni ishga tushiring.")
            presentation = (
                await db.execute(
                    select(Presentation).where(Presentation.teacher_id == teacher.id).limit(1)
                )
            ).scalar_one_or_none()
            if presentation is None:
                raise SystemExit("Seed yo'q: prezentatsiya topilmadi.")

            group = (
                await db.execute(select(Group).where(Group.name == LOAD_GROUP_NAME))
            ).scalar_one_or_none()
            if group is None:
                group = Group(
                    name=LOAD_GROUP_NAME,
                    course_title="WS yuklama testi",
                    invite_code=LOAD_INVITE_CODE,
                    teacher_id=teacher.id,
                )
                db.add(group)
                await db.flush()

            students: list[tuple[uuid.UUID, str, int]] = []
            for index in range(1, client_count + 1):
                email = LOAD_EMAIL_FMT.format(index)
                student = (
                    await db.execute(select(User).where(User.email == email))
                ).scalar_one_or_none()
                if student is None:
                    student = User(
                        google_id=f"loadtest-{email}",
                        email=email,
                        full_name=f"Yuklama O'quvchi {index:02d}",
                        role=UserRole.STUDENT,
                        is_onboarded=True,
                    )
                    db.add(student)
                    await db.flush()
                member = (
                    await db.execute(
                        select(GroupMember.id).where(
                            GroupMember.group_id == group.id,
                            GroupMember.student_id == student.id,
                        )
                    )
                ).scalar_one_or_none()
                if member is None:
                    db.add(GroupMember(group_id=group.id, student_id=student.id))
                students.append((student.id, student.role.value, student.token_version))

            await db.commit()
            return Fixture(
                teacher_id=teacher.id,
                teacher_role=teacher.role.value,
                teacher_tv=teacher.token_version,
                presentation_id=presentation.id,
                group_id=group.id,
                students=students,
            )
    finally:
        await engine.dispose()


async def drop_session(session_id: uuid.UUID) -> None:
    engine = create_async_engine(settings.sqlalchemy_url)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with factory() as db:
            found = (
                await db.execute(select(LessonSession).where(LessonSession.id == session_id))
            ).scalar_one_or_none()
            if found is not None:
                await db.delete(found)
                await db.commit()
    finally:
        await engine.dispose()


# ===========================================================================
# Server
# ===========================================================================


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class LocalServer:
    """`app.main:app` ni alohida threadda uvicorn bilan ko'taradi."""

    def __init__(self) -> None:
        from app.main import app

        self.port = free_port()
        self._server = uvicorn.Server(
            uvicorn.Config(
                app, host="127.0.0.1", port=self.port, log_level="warning", lifespan="on"
            )
        )
        self._thread = threading.Thread(target=self._server.run, daemon=True)

    @property
    def host(self) -> str:
        return f"127.0.0.1:{self.port}"

    def start(self) -> None:
        self._thread.start()
        deadline = time.monotonic() + 30
        while not self._server.started:
            if time.monotonic() > deadline:
                raise SystemExit("uvicorn ishga tushmadi")
            time.sleep(0.02)

    def stop(self) -> None:
        self._server.should_exit = True
        self._thread.join(timeout=15)


# ===========================================================================
# Mijozlar
# ===========================================================================


def token_for(user_id: uuid.UUID, role: str, token_version: int) -> str:
    return create_access_token(user_id=user_id, role=role, token_version=token_version)


class Receiver:
    """Bitta WS mijoz: kelgan eventlarni `(seq, olingan_vaqt)` ko'rinishida yozadi."""

    __slots__ = ("heartbeat", "label", "reader", "seen", "sock")

    def __init__(self, label: str, sock: Any) -> None:
        self.label = label
        self.sock = sock
        self.seen: dict[str, list[tuple[int, float]]] = {}
        self.reader: asyncio.Task[None] | None = None
        self.heartbeat: asyncio.Task[None] | None = None

    def start(self) -> None:
        self.reader = asyncio.create_task(self._read())
        self.heartbeat = asyncio.create_task(self._ping())

    async def _read(self) -> None:
        with contextlib.suppress(Exception):
            while True:
                raw = await self.sock.recv()
                now = time.perf_counter()
                envelope = json.loads(raw)
                self.seen.setdefault(envelope.get("type", "?"), []).append(
                    (int(envelope.get("seq", 0)), now)
                )

    async def _ping(self) -> None:
        """Haqiqiy frontend kabi 20 s da bir `PING` — server watchdog'i tinch bo'lsin."""
        with contextlib.suppress(Exception):
            while True:
                await asyncio.sleep(20)
                await self.sock.send(json.dumps({"v": 1, "type": "PING", "data": {}}))

    async def stop_heartbeat(self) -> None:
        """Yopilish oldidan: yopilayotgan socketga `PING` yuborilmasin."""
        if self.heartbeat is not None:
            self.heartbeat.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.heartbeat
            self.heartbeat = None

    async def stop(self) -> None:
        await self.stop_heartbeat()
        if self.reader is not None:
            self.reader.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.reader
            self.reader = None

    def timeline(self, event: str) -> dict[int, float]:
        return dict(self.seen.get(event, []))


# ===========================================================================
# Asosiy oqim
# ===========================================================================


async def run(args: argparse.Namespace) -> int:
    fixture = await prepare_fixture(args.clients)

    server: LocalServer | None = None
    if args.url:
        host = args.url.replace("http://", "").replace("ws://", "").rstrip("/")
    else:
        server = LocalServer()
        server.start()
        host = server.host

    api = f"http://{host}/api/v1"
    teacher_token = token_for(fixture.teacher_id, fixture.teacher_role, fixture.teacher_tv)
    session_id: uuid.UUID | None = None
    pin = ""
    receivers: list[Receiver] = []
    sockets: list[Any] = []
    exit_code = 0

    try:
        async with httpx.AsyncClient(timeout=30.0) as http:
            created = await http.post(
                f"{api}/rooms",
                headers={"Authorization": f"Bearer {teacher_token}"},
                json={
                    "group_id": fixture.group_id,
                    "presentation_id": str(fixture.presentation_id),
                },
            )
            if created.status_code != 201:
                raise SystemExit(f"Xona yaratilmadi: {created.status_code} {created.text}")
            room = created.json()
            pin = str(room["pin_code"])
            session_id = uuid.UUID(room["session_id"])
            print(f"Xona: PIN={pin}  session={session_id}  host={host}")

            # --- tiketlar HAQIQIY endpoint orqali (bir martalik, 30 s) ---
            async def ticket(token: str) -> str:
                resp = await http.post(
                    f"{api}/rooms/{pin}/ws-ticket", headers={"Authorization": f"Bearer {token}"}
                )
                resp.raise_for_status()
                return str(resp.json()["ticket"])

            teacher_ticket = await ticket(teacher_token)
            student_tokens = [token_for(*student) for student in fixture.students]
            # O'quvchilar guruhda ekani tasdiqlanishi uchun avval REST join.
            await asyncio.gather(
                *(
                    http.post(
                        f"{api}/rooms/{pin}/join", headers={"Authorization": f"Bearer {tok}"}
                    )
                    for tok in student_tokens
                )
            )
            student_tickets = await asyncio.gather(*(ticket(tok) for tok in student_tokens))

        # --- 1 + N socket ---
        ws_url = f"ws://{host}/ws/room/{pin}"
        teacher_sock = await websockets.connect(
            f"{ws_url}?ticket={teacher_ticket}", max_size=4 * 1024 * 1024, close_timeout=1
        )
        sockets.append(teacher_sock)
        teacher = Receiver("teacher", teacher_sock)

        students: list[Receiver] = []
        for index, tkt in enumerate(student_tickets):
            sock = await websockets.connect(
                f"{ws_url}?ticket={tkt}", max_size=4 * 1024 * 1024, close_timeout=1
            )
            sockets.append(sock)
            students.append(Receiver(f"student{index:02d}", sock))

        receivers = [teacher, *students]
        for receiver in receivers:
            receiver.start()
        # `ROOM_STATE_SYNC` va `STUDENT_JOINED` to'lqini tinchishini kutamiz.
        await asyncio.sleep(1.0)
        for receiver in receivers:
            receiver.seen.clear()
        print(f"Ulandi: 1 o'qituvchi + {len(students)} o'quvchi")

        # --- SLIDE_CHANGE ---
        slide_sent = await _drive(
            teacher_sock,
            "SLIDE_CHANGE",
            count=args.slides,
            interval_ms=args.slide_interval_ms,
            payload=lambda i: {"slide_index": i % 2},
        )
        await asyncio.sleep(0.6)

        # --- LIVE_CODE_PATCH (throttle oynasiga mos qadam) ---
        code_body = _sample_code(args.code_chars)
        patch_sent = await _drive(
            teacher_sock,
            "LIVE_CODE_PATCH",
            count=args.patches,
            interval_ms=max(args.patch_interval_ms, settings.LIVE_CODE_THROTTLE_MS + 10),
            payload=lambda i: {
                "slide_index": 1,
                "code": f"# patch {i}\n{code_body}",
                "cursor": {"line": i % 50, "col": 0},
            },
        )
        await asyncio.sleep(1.0)

        # --- hisobot ---
        slide_stats = _collect("SLIDE_CHANGE", teacher, students, slide_sent)
        code_stats = _collect("LIVE_CODE_PATCH", teacher, students, patch_sent)

        print()
        print("=" * 68)
        print(f"  {len(students)} parallel WS klient · bitta global PubSub listener")
        print(f"  yuborildi: {args.slides} SLIDE_CHANGE + {args.patches} LIVE_CODE_PATCH")
        print(f"  kod hajmi: {len(code_body)} belgi/patch")
        print("=" * 68)
        exit_code |= _print_block(slide_stats, args.slides, len(students), SLIDE_P95_BUDGET_MS)
        exit_code |= _print_block(code_stats, args.patches, len(students), CODE_P95_BUDGET_MS)
        print("=" * 68)
        print("NATIJA:", "O'TDI ✓" if exit_code == 0 else "O'TMADI ✗")
    finally:
        # Tartib muhim: (1) heartbeat to'xtaydi, (2) `/end` → server SESSION_ENDED
        # yuborib socketlarni O'ZI yopadi, (3) socketlar PARALLEL yopiladi.
        # Ketma-ket yopilsa klient tsikli bloklanadi va server bizni haqli
        # ravishda "sekin klient" deb uzadi (backpressure himoyasi ishlaydi).
        for receiver in receivers:
            await receiver.stop_heartbeat()
        if session_id is not None:
            with contextlib.suppress(Exception):
                async with httpx.AsyncClient(timeout=15.0) as http:
                    await http.post(
                        f"{api}/rooms/{pin}/end",
                        headers={"Authorization": f"Bearer {teacher_token}"},
                    )
            await asyncio.sleep(0.3)
        if sockets:
            await asyncio.gather(
                *(sock.close() for sock in sockets), return_exceptions=True
            )
        for receiver in receivers:
            await receiver.stop()
        if session_id is not None:
            await drop_session(session_id)
        if server is not None:
            server.stop()
    return exit_code


async def _drive(
    sock: Any,
    event: str,
    *,
    count: int,
    interval_ms: float,
    payload: Any,
) -> list[float]:
    """Eventlarni belgilangan qadam bilan yuboradi. → yuborilgan vaqtlar ro'yxati."""
    sent: list[float] = []
    step = interval_ms / 1000.0
    for index in range(count):
        frame = json.dumps({"v": 1, "type": event, "data": payload(index)})
        sent.append(time.perf_counter())
        await sock.send(frame)
        await asyncio.sleep(step)
    return sent


def _collect(
    event: str, teacher: Receiver, students: list[Receiver], sent: list[float]
) -> Stats:
    """`seq` → yuborilgan vaqt moslashtiruvi orqali kechikishlarni yig'adi."""
    teacher_seqs = [seq for seq, _ in sorted(teacher.seen.get(event, []), key=lambda x: x[0])]
    sent_by_seq = dict(zip(teacher_seqs, sent, strict=False))
    stats = Stats(event)
    for student in students:
        for seq, received in student.seen.get(event, []):
            origin = sent_by_seq.get(seq)
            if origin is not None:
                stats.samples.append((received - origin) * 1000.0)
    return stats


def _print_block(stats: Stats, sent: int, clients: int, budget_ms: float) -> int:
    expected = sent * clients
    report = stats.report()
    ok = report["p95"] < budget_ms and stats.count > 0
    print()
    print(f"{stats.name}  ({stats.count}/{expected} o'lchov)")
    print(
        f"  min {report['min']:7.2f} ms │ p50 {report['p50']:7.2f} ms │ "
        f"p95 {report['p95']:7.2f} ms │ p99 {report['p99']:7.2f} ms │ "
        f"max {report['max']:7.2f} ms"
    )
    verdict = "✓" if ok else "✗"
    print(f"  talab: p95 < {budget_ms:.0f} ms  →  {report['p95']:.2f} ms  {verdict}")
    if stats.count < expected:
        lost = expected - stats.count
        print(f"  ⚠ {lost} o'lchov yo'q ({lost / expected:.1%}) — yo'qolgan yoki birlashtirilgan")
    return 0 if ok else 1


def _sample_code(target_chars: int) -> str:
    """Haqiqiy darsga o'xshash Python kodi, kerakli hajmgacha takrorlanadi."""
    block = (
        "def yigindi(sonlar: list[int]) -> int:\n"
        "    jami = 0\n"
        "    for son in sonlar:\n"
        "        jami += son\n"
        "    return jami\n"
        "\n"
        "baholar = {'Aziza': [90, 85, 100], 'Bekzod': [70, 75, 80]}\n"
        "for ism, royxat in baholar.items():\n"
        "    print(f'{ism}: {yigindi(royxat) / len(royxat):.1f}')\n"
        "\n"
    )
    repeats = max(1, target_chars // len(block))
    code = block * repeats
    return code[: min(len(code), settings.MAX_CODE_CHARS - 64)]


def main() -> int:
    parser = argparse.ArgumentParser(description="SyncClass WS yuklama testi")
    parser.add_argument("--clients", type=int, default=30, help="parallel o'quvchi soni")
    parser.add_argument("--slides", type=int, default=50, help="SLIDE_CHANGE soni")
    parser.add_argument("--patches", type=int, default=200, help="LIVE_CODE_PATCH soni")
    parser.add_argument("--slide-interval-ms", type=float, default=20.0)
    parser.add_argument("--patch-interval-ms", type=float, default=0.0)
    parser.add_argument("--code-chars", type=int, default=2000)
    parser.add_argument("--url", default="", help="tashqi server (masalan 127.0.0.1:8000)")
    args = parser.parse_args()
    return asyncio.run(run(args))


if __name__ == "__main__":
    raise SystemExit(main())
