"""Jonli dars xonasi (room) sxemalari — CONTRACTS.md §4 (rooms) va §5 (WS).

Nomlar kontraktdan bir harf ham farq qilmaydi:
`RoomOut = {session_id, pin_code, join_url, status, current_slide_index,
presentation:{id,title,slides_count}}`.

`Participant` — `STUDENT_JOINED` va `ROOM_STATE_SYNC.participants` ning elementi.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from datetime import datetime
from typing import Any, Final

from pydantic import BaseModel, ConfigDict, Field

from app.db.models import AttendanceStatus, SessionStatus

# ---------------------------------------------------------------------------
# Umumiy bloklar
# ---------------------------------------------------------------------------


class PresentationBrief(BaseModel):
    """`RoomOut.presentation` — kontraktda aynan shu uch maydon."""

    id: uuid.UUID
    title: str
    slides_count: int


class Participant(BaseModel):
    """Xonadagi o'quvchi. `STUDENT_JOINED.data` bilan bir xil shakl.

    Redis `room:{session_id}:members` HASH ida JSON sifatida saqlanadi,
    shuning uchun `model_dump(mode="json")` orqali seriyalanadi.
    """

    model_config = ConfigDict(use_enum_values=True)

    student_id: uuid.UUID
    full_name: str
    avatar_url: str | None = None
    status: AttendanceStatus = AttendanceStatus.PRESENT


class ConfusedStats(BaseModel):
    """`ROOM_STATE_SYNC.confused` — `{count, percentage}`."""

    count: int = 0
    percentage: int = 0


class ActiveQuiz(BaseModel):
    """Redis `room:{session_id}:state.active_quiz` (JSON) ning tipi.

    `ends_at` — SERVER belgilaydi (AUDIT.md §G3): klient taymerni faqat ko'rsatadi.
    `started_at_ms` klientga chiqmaydi, lekin `answer_ms` ni serverda hisoblash uchun kerak.
    """

    quiz_id: str
    slide_index: int
    question: str
    options: list[str]
    duration_sec: int
    ends_at: datetime
    started_at_ms: int
    correct_option: int
    points: int = 100

    def to_event_data(self) -> dict[str, Any]:
        """`QUIZ_START.data` — to'g'ri javob va ichki vaqt KETMAYDI."""
        return {
            "quiz_id": self.quiz_id,
            "slide_index": self.slide_index,
            "question": self.question,
            "options": list(self.options),
            "duration_sec": self.duration_sec,
            "ends_at": self.ends_at.isoformat(),
        }


# ---------------------------------------------------------------------------
# POST /rooms
# ---------------------------------------------------------------------------


class RoomCreateIn(BaseModel):
    group_id: int = Field(ge=1)
    presentation_id: uuid.UUID


class RoomOut(BaseModel):
    """CONTRACTS.md §4: `join_url` ayni paytda QR kod payload'i ham."""

    session_id: uuid.UUID
    pin_code: str
    join_url: str
    status: SessionStatus
    current_slide_index: int
    presentation: PresentationBrief


# ---------------------------------------------------------------------------
# POST /rooms/{pin}/join
# ---------------------------------------------------------------------------


# Slayd JSON ida (CONTRACTS.md §3) QUIZ slaydi `correct_option` ni saqlaydi.
# Bu maydon O'QUVCHIGA KETMAYDI: aks holda u xonaga bir marta kirib butun
# darsning barcha javoblarini oldindan oladi (AUDIT.md §G3).
SLIDE_SECRET_FIELDS: Final[tuple[str, ...]] = ("correct_option",)


def redact_slides_for_student(slides: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Slayd massividan quiz javoblarini olib tashlaydi.

    Redaksiya SERIYALASH chegarasida, bitta nomlangan joyda bajariladi —
    endpoint ichida tarqoq `del` lar bilan emas. `points`, `duration_sec` va
    `options` qoladi: ular javobni oshkor qilmaydi va UI da ko'rsatiladi.
    """
    return [
        {k: v for k, v in slide.items() if k not in SLIDE_SECRET_FIELDS} for slide in slides
    ]


class RoomJoinOut(BaseModel):
    """O'quvchi xonaga kirgandan keyin olinadigan to'liq kontekst.

    `slides` — prezentatsiyaning JSONB massivi (CONTRACTS.md §3): jonli
    sahifa birinchi render uchun shuni ishlatadi, WS esa faqat o'zgarishlarni
    uzatadi. O'QUVCHI uchun massiv `redact_slides_for_student()` dan o'tadi,
    ya'ni QUIZ slaydlarida `correct_option` BO'LMAYDI.
    """

    session_id: uuid.UUID
    pin_code: str
    status: SessionStatus
    current_slide_index: int
    is_screen_sharing: bool
    attendance_status: AttendanceStatus
    late_after_minutes: int
    group_id: int
    group_name: str
    presentation: PresentationBrief
    slides: list[dict[str, Any]]


# ---------------------------------------------------------------------------
# POST /rooms/{pin}/ws-ticket
# ---------------------------------------------------------------------------


class WsTicketOut(BaseModel):
    """CONTRACTS.md §4: `{ticket}`. Bir martalik, TTL 30 s (AUDIT.md §B3)."""

    ticket: str


# ---------------------------------------------------------------------------
# GET /rooms/{pin}  (REST fallback — ROOM_STATE_SYNC ning oynasi)
# ---------------------------------------------------------------------------


class RoomStateOut(BaseModel):
    """`GET /rooms/{pin}` — `ROOM_STATE_SYNC` ning REST oynasi.

    `join_url` — `RoomOut` dagi bilan AYNI manba (`join_url_for`). O'qituvchi
    lobbisi QR kodni shu maydondan quradi: klientda `window.location.origin`
    dan qurish YARAMAYDI — o'qituvchi `localhost` da ochsa QR ham `localhost`
    ko'rsatadi va boshqa qurilmadagi o'quvchi uchun ishlamaydi.

    `presentation` — xona qaysi prezentatsiya bilan ishlayotgani. Bu bo'lmasa
    o'qituvchi sahifani yangilagach `presentation.id` ni bila olmaydi va
    slaydlarini butunlay yo'qotadi (o'quvchida ular `RoomJoinOut.slides` dan
    keladi, o'qituvchida esa boshqa manba yo'q). `POST /rooms` javobini
    keshlash yaramaydi: reconnect dan keyin kesh aynan bo'lmaydi.
    """

    session_id: uuid.UUID
    pin_code: str
    join_url: str
    presentation: PresentationBrief
    status: SessionStatus
    seq: int
    slide_index: int
    slide_type: str
    code: str
    code_rev: int
    is_sharing: bool
    active_quiz: dict[str, Any] | None
    # §16.3: faqat `POLL_START`/`OPEN_START` dagi ommaviy maydonlar. Jonli
    # ma'lumot (`poll_progress`/`open_update`) REST zaxirada UMUMAN yo'q — hech
    # bir rol uchun: bu javob rolga bog'liq emas va yagona xavfsiz qoida shu.
    active_poll: dict[str, Any] | None = None
    active_open: dict[str, Any] | None = None
    participants: list[Participant]
    confused: ConfusedStats


# ---------------------------------------------------------------------------
# POST /rooms/{pin}/end
# ---------------------------------------------------------------------------


class RoomEndOut(BaseModel):
    session_id: uuid.UUID
    status: SessionStatus
    ended_at: datetime
    present_count: int
    late_count: int
    absent_count: int


# ---------------------------------------------------------------------------
# POST /rooms/{pin}/livekit-token
# ---------------------------------------------------------------------------


class LiveKitTokenOut(BaseModel):
    """AUDIT.md §F: o'quvchida `can_publish=False, can_publish_data=False`."""

    token: str
    url: str
    room_name: str
    identity: str
    can_publish: bool
    can_publish_data: bool


# ---------------------------------------------------------------------------
# GET /rooms/{pin}/report
# ---------------------------------------------------------------------------


class RoomReportRow(BaseModel):
    student_id: uuid.UUID
    full_name: str
    status: AttendanceStatus
    joined_at: datetime | None
    tab_switches_count: int
    focus_lost_seconds: int
    quiz_score: int
    answers_count: int
    correct_count: int


class RoomQuizStat(BaseModel):
    slide_index: int
    answered: int
    correct: int
    avg_answer_ms: int
    distribution: list[int]


class RoomReportOut(BaseModel):
    session_id: uuid.UUID
    pin_code: str
    status: SessionStatus
    group_id: int
    group_name: str
    started_at: datetime
    ended_at: datetime | None
    present_count: int
    late_count: int
    absent_count: int
    students: list[RoomReportRow]
    quizzes: list[RoomQuizStat]


__all__ = [
    "ActiveQuiz",
    "ConfusedStats",
    "LiveKitTokenOut",
    "Participant",
    "PresentationBrief",
    "RoomCreateIn",
    "RoomEndOut",
    "RoomJoinOut",
    "RoomOut",
    "RoomQuizStat",
    "RoomReportOut",
    "RoomReportRow",
    "RoomStateOut",
    "WsTicketOut",
]
