"""WebSocket protokoli v1 — envelope, validatsiya va rol-guard.

CONTRACTS.md §5 ning aynan amalga oshirilishi. Envelope ikki yo'nalishda ham:

    {"v": 1, "type": "SLIDE_CHANGE", "seq": 128, "ts": 1762150000123, "data": {}}

`seq` — **faqat server** beradigan, room bo'yicha monotonik raqam (Redis
`HINCRBY`). Klient `seq <= oxirgi_seq` bo'lsa eventni **ignore** qiladi
(AUDIT.md §B5). Klient yuborgan `seq`/`ts` e'tiborga olinmaydi.

Boshqaruv kadrlari (`PONG`, `ERROR`, `ROOM_STATE_SYNC`) room ketma-ketligiga
kirmaydi: ular faqat so'ragan ulanishga boradi. `ROOM_STATE_SYNC` da `seq`
holatning joriy bazasi bo'ladi (klient shundan keyin eski eventlarni tashlaydi),
`PONG`/`ERROR` da esa `seq = 0`.
"""

from __future__ import annotations

import enum
import json
import re
import time
import unicodedata
from typing import Any, Final

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.core.config import settings
from app.db.models import UserRole

PROTOCOL_VERSION: Final[int] = 1

# Har qanday Unicode bo'shliq ketma-ketligi (`\s` str rejimida Unicode ni ham oladi).
_WS_RUN: Final[re.Pattern[str]] = re.compile(r"\s+")


# ---------------------------------------------------------------------------
# Event nomlari
# ---------------------------------------------------------------------------


class ServerEvent(str, enum.Enum):
    """Server → Klient (CONTRACTS.md §5)."""

    ROOM_STATE_SYNC = "ROOM_STATE_SYNC"
    STUDENT_JOINED = "STUDENT_JOINED"
    STUDENT_LEFT = "STUDENT_LEFT"
    SLIDE_CHANGE = "SLIDE_CHANGE"
    LIVE_CODE_PATCH = "LIVE_CODE_PATCH"
    LASER_MOVE = "LASER_MOVE"
    SCREEN_SHARE_STATE = "SCREEN_SHARE_STATE"
    CONFUSED_PING = "CONFUSED_PING"
    FOCUS_CHANGE = "FOCUS_CHANGE"
    QUIZ_START = "QUIZ_START"
    QUIZ_PROGRESS = "QUIZ_PROGRESS"
    QUIZ_RESULTS = "QUIZ_RESULTS"
    # v1.2 interaktiv slaydlar (CONTRACTS.md §16.3) — QUIZ_* dan ATAYLAB alohida.
    POLL_START = "POLL_START"
    POLL_PROGRESS = "POLL_PROGRESS"
    POLL_RESULTS = "POLL_RESULTS"
    OPEN_START = "OPEN_START"
    OPEN_UPDATE = "OPEN_UPDATE"
    OPEN_RESULTS = "OPEN_RESULTS"
    SESSION_ENDED = "SESSION_ENDED"
    PONG = "PONG"
    ERROR = "ERROR"


class ClientEvent(str, enum.Enum):
    """Klient → Server (CONTRACTS.md §5)."""

    SLIDE_CHANGE = "SLIDE_CHANGE"
    LIVE_CODE_PATCH = "LIVE_CODE_PATCH"
    LASER_MOVE = "LASER_MOVE"
    SCREEN_SHARE_STATE = "SCREEN_SHARE_STATE"
    QUIZ_START = "QUIZ_START"
    QUIZ_END = "QUIZ_END"
    CONFUSED_PING = "CONFUSED_PING"
    FOCUS_CHANGE = "FOCUS_CHANGE"
    QUIZ_ANSWER = "QUIZ_ANSWER"
    # v1.2 (CONTRACTS.md §16.3)
    POLL_START = "POLL_START"
    POLL_VOTE = "POLL_VOTE"
    POLL_END = "POLL_END"
    OPEN_START = "OPEN_START"
    OPEN_ANSWER = "OPEN_ANSWER"
    OPEN_HIDE = "OPEN_HIDE"
    OPEN_END = "OPEN_END"
    PING = "PING"


#: Faqat `TEACHER` yuborishi mumkin bo'lgan eventlar.
TEACHER_EVENTS: Final[frozenset[ClientEvent]] = frozenset(
    {
        ClientEvent.SLIDE_CHANGE,
        ClientEvent.LIVE_CODE_PATCH,
        ClientEvent.LASER_MOVE,
        ClientEvent.SCREEN_SHARE_STATE,
        ClientEvent.QUIZ_START,
        ClientEvent.QUIZ_END,
        # §16.3: boshlash/tugatish/yashirish — faqat o'qituvchi.
        ClientEvent.POLL_START,
        ClientEvent.POLL_END,
        ClientEvent.OPEN_START,
        ClientEvent.OPEN_HIDE,
        ClientEvent.OPEN_END,
    }
)

#: Faqat `STUDENT` yuborishi mumkin bo'lgan eventlar.
STUDENT_EVENTS: Final[frozenset[ClientEvent]] = frozenset(
    {
        ClientEvent.CONFUSED_PING,
        ClientEvent.FOCUS_CHANGE,
        ClientEvent.QUIZ_ANSWER,
        ClientEvent.POLL_VOTE,
        ClientEvent.OPEN_ANSWER,
    }
)

#: Har kim yuborishi mumkin.
ANY_EVENTS: Final[frozenset[ClientEvent]] = frozenset({ClientEvent.PING})

#: Server → Klient: FAQAT o'qituvchiga boradigan eventlar (§5 "Kimga" ustuni).
TEACHER_ONLY_AUDIENCE: Final[frozenset[str]] = frozenset(
    {
        ServerEvent.CONFUSED_PING.value,
        ServerEvent.FOCUS_CHANGE.value,
        ServerEvent.QUIZ_PROGRESS.value,
        # §16.3: jonli taqsimot va moderatsiya ro'yxati FAQAT o'qituvchiga —
        # o'quvchi natijani faqat yakunda (`*_RESULTS`) ko'radi.
        ServerEvent.POLL_PROGRESS.value,
        ServerEvent.OPEN_UPDATE.value,
    }
)


# ---------------------------------------------------------------------------
# Xatolar
# ---------------------------------------------------------------------------

# WS close kodlari (4000+ — ilova darajasi, RFC 6455).
WS_CLOSE_INVALID_TICKET: Final[int] = 4401
WS_CLOSE_FORBIDDEN: Final[int] = 4403
WS_CLOSE_ROOM_NOT_FOUND: Final[int] = 4404
WS_CLOSE_SESSION_ENDED: Final[int] = 4409
WS_CLOSE_HEARTBEAT_TIMEOUT: Final[int] = 4408
WS_CLOSE_SLOW_CLIENT: Final[int] = 4413


class ProtocolError(Exception):
    """Klient xabari protokolga mos emas → `ERROR{code, message}` qaytariladi."""

    __slots__ = ("code", "message")

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# Klient payload modellari
# ---------------------------------------------------------------------------


class _StrictIn(BaseModel):
    """Noma'lum maydon kelsa xato beradi — protokol "oqib ketmasin"."""

    model_config = ConfigDict(extra="forbid")


class Cursor(_StrictIn):
    line: int = Field(ge=0)
    col: int = Field(ge=0)


class SlideChangeIn(_StrictIn):
    slide_index: int = Field(ge=0, le=9999)


class LiveCodePatchIn(_StrictIn):
    slide_index: int = Field(ge=0, le=9999)
    # `MAX_CODE_CHARS` — AUDIT.md §B1: butun kod uzatiladi, lekin chegara bilan.
    code: str = Field(max_length=settings.MAX_CODE_CHARS)
    cursor: Cursor | None = None


class LaserMoveIn(_StrictIn):
    # 0..1 normalizatsiya (CONTRACTS.md §5) — ekran o'lchamiga bog'liq emas.
    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    drawing: bool = False


class ScreenShareStateIn(_StrictIn):
    is_sharing: bool


class QuizStartIn(_StrictIn):
    slide_index: int = Field(ge=0, le=9999)


class QuizEndIn(_StrictIn):
    quiz_id: str = Field(min_length=1, max_length=64)


class ConfusedPingIn(_StrictIn):
    pass


class FocusChangeIn(_StrictIn):
    is_focused: bool


class QuizAnswerIn(_StrictIn):
    quiz_id: str = Field(min_length=1, max_length=64)
    selected_index: int = Field(ge=0, le=5)
    # Klient `time_ms` faqat TELEMETRIYA: haqiqiy `answer_ms` serverda
    # `now - started_at` dan hisoblanadi (AUDIT.md §G3).
    time_ms: int = Field(default=0, ge=0)


class PingIn(_StrictIn):
    pass


# --- v1.2: POLL / OPEN (CONTRACTS.md §16.3) ---------------------------------
# Boshlash buyrug'i faqat `slide_index` oladi: savol, variantlar va muddat
# SERVERDA slayd JSON idan o'qiladi — klient yuborgan matnga ishonilmaydi.


class PollStartIn(_StrictIn):
    slide_index: int = Field(ge=0, le=9999)


class PollVoteIn(_StrictIn):
    poll_id: str = Field(min_length=1, max_length=64)
    # Diapazon bu yerda EMAS, serverda tekshiriladi: variantlar soni slaydga
    # bog'liq va kontrakt bo'yicha xato kodi `INVALID_OPTION` (`BAD_PAYLOAD` emas).
    selected_index: int


class PollEndIn(_StrictIn):
    poll_id: str = Field(min_length=1, max_length=64)


class OpenStartIn(_StrictIn):
    slide_index: int = Field(ge=0, le=9999)


class OpenAnswerIn(_StrictIn):
    open_id: str = Field(min_length=1, max_length=64)
    # Uzunlik bu yerda EMAS: chegara slaydning `max_chars` iga bog'liq va
    # oshsa kod `ANSWER_TOO_LONG` (§16.3 K2). Butun xabar hajmini `decode()`
    # boshidagi `PAYLOAD_TOO_LARGE` tekshiruvi baribir cheklaydi.
    text: str


class OpenHideIn(_StrictIn):
    open_id: str = Field(min_length=1, max_length=64)
    answer_id: str = Field(min_length=1, max_length=64)


class OpenEndIn(_StrictIn):
    open_id: str = Field(min_length=1, max_length=64)


# ---------------------------------------------------------------------------
# OPEN javob matnini tozalash (CONTRACTS.md §16.3 — server tomonida, MAJBURIY)
# ---------------------------------------------------------------------------

# Xom kirishning qattiq chegarasi (§16.3 K2): megabaytli payload TOZALASHDAN
# OLDIN to'xtatiladi. Undan qisqa matn tozalanib `max_chars` ga qirqiladi.
OPEN_RAW_HARD_CAP: Final[int] = 1000

# O'zbek lotin yozuvidagi tutuq belgisining barcha ko'rinishlari bitta `'` ga
# keltiriladi: aks holda "o'zbek", "oʻzbek" va "o‘zbek" so'z bulutida uch xil
# so'z bo'lib sanalardi (klaviaturalar har xil belgi yozadi).
_APOSTROPHES: Final[dict[int, str]] = {
    ord(ch): "'" for ch in ("\u2018", "\u2019", "\u02bb", "\u02bc", "\u0060", "\u00b4")
}

# Unicode "C*" toifalari: boshqaruv (Cc), formatlash (Cf — jumladan matn
# yo'nalishini aldaydigan U+202E), surrogat, xususiy va tayinlanmagan belgilar.
_DROP_CATEGORIES: Final[frozenset[str]] = frozenset({"Cc", "Cf", "Cs", "Co", "Cn"})


def open_raw_limit(max_chars: int) -> int:
    """`ANSWER_TOO_LONG` chegarasi: `min(4*max_chars, 1000)` (§16.3 K2)."""
    return min(4 * max_chars, OPEN_RAW_HARD_CAP)


def sanitize_open_text(raw: str, max_chars: int) -> str:
    """Ochiq javobni normallashtiradi — natija so'z bulutida SANALADIGAN shakl.

    Tartib muhim:
    1. NFKC — vizual bir xil belgilar bitta ko'rinishga (to'liq kenglikdagi
       harflar, ligaturalar).
    2. Barcha bo'shliqlar (`\n`, `\t` va h.k.) bitta probelga — boshqaruv
       belgilarini o'chirishdan OLDIN, aks holda "salom\ndunyo" yopishib qoladi.
    3. Qolgan boshqaruv/formatlash belgilari o'chiriladi.
    4. Tutuq belgilari birlashtiriladi, kichik harfga keltiriladi (§16.3:
       "kichik harfga keltirib hisoblash").
    5. Trim → `max_chars` ga qirqish → yana trim (qirqish oxirida probel
       qoldirmasin).
    """
    text = unicodedata.normalize("NFKC", raw)
    text = _WS_RUN.sub(" ", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) not in _DROP_CATEGORIES)
    text = text.translate(_APOSTROPHES).lower().strip()
    return text[:max_chars].strip()


PAYLOAD_MODELS: Final[dict[ClientEvent, type[_StrictIn]]] = {
    ClientEvent.SLIDE_CHANGE: SlideChangeIn,
    ClientEvent.LIVE_CODE_PATCH: LiveCodePatchIn,
    ClientEvent.LASER_MOVE: LaserMoveIn,
    ClientEvent.SCREEN_SHARE_STATE: ScreenShareStateIn,
    ClientEvent.QUIZ_START: QuizStartIn,
    ClientEvent.QUIZ_END: QuizEndIn,
    ClientEvent.CONFUSED_PING: ConfusedPingIn,
    ClientEvent.FOCUS_CHANGE: FocusChangeIn,
    ClientEvent.QUIZ_ANSWER: QuizAnswerIn,
    ClientEvent.POLL_START: PollStartIn,
    ClientEvent.POLL_VOTE: PollVoteIn,
    ClientEvent.POLL_END: PollEndIn,
    ClientEvent.OPEN_START: OpenStartIn,
    ClientEvent.OPEN_ANSWER: OpenAnswerIn,
    ClientEvent.OPEN_HIDE: OpenHideIn,
    ClientEvent.OPEN_END: OpenEndIn,
    ClientEvent.PING: PingIn,
}


# ---------------------------------------------------------------------------
# Envelope: yig'ish va ajratish
# ---------------------------------------------------------------------------


def encode(event_type: ServerEvent | str, data: dict[str, Any], *, seq: int = 0,
           ts: int | None = None) -> str:
    """Server → Klient envelope ni JSON matnga aylantiradi.

    Pub/Sub orqali ketadigan eventlar envelope ni **Lua ichida** yig'adi
    (`room_state.py`), shuning uchun bu funksiya faqat to'g'ridan-to'g'ri
    yuborilgan kadrlar uchun: `ROOM_STATE_SYNC`, `PONG`, `ERROR`.
    """
    name = event_type.value if isinstance(event_type, ServerEvent) else str(event_type)
    return json.dumps(
        {
            "v": PROTOCOL_VERSION,
            "type": name,
            "seq": seq,
            "ts": ts if ts is not None else int(time.time() * 1000),
            "data": data,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def encode_error(code: str, message: str) -> str:
    """`ERROR{code, message}` — faqat so'ragan ulanishga."""
    return encode(ServerEvent.ERROR, {"code": code, "message": message})


def event_type_of(envelope_json: str) -> str:
    """Envelope JSON idan `type` ni **to'liq parse qilmasdan** ajratadi.

    20 KB lik `LIVE_CODE_PATCH` ni har ulanish uchun qayta parse qilish p95 ga
    bevosita zarar beradi. Envelope ni biz o'zimiz yig'amiz va `type` doim
    ikkinchi kalit: `{"v":1,"type":"...". Shablon buzilgan bo'lsa — to'liq
    `json.loads` ga qaytamiz.
    """
    prefix = '{"v":1,"type":"'
    if envelope_json.startswith(prefix):
        end = envelope_json.find('"', len(prefix))
        if end != -1:
            return envelope_json[len(prefix) : end]
    try:
        parsed = json.loads(envelope_json)
    except (TypeError, ValueError):
        return ""
    return str(parsed.get("type", "")) if isinstance(parsed, dict) else ""


def check_role(event: ClientEvent, role: UserRole) -> None:
    """Rol-guard: `STUDENT` `TEACHER` eventini yuborolmaydi (CONTRACTS.md §5).

    Xato → `ProtocolError("FORBIDDEN_EVENT")`, event **e'tiborga olinmaydi**.
    """
    if event in ANY_EVENTS:
        return
    if event in TEACHER_EVENTS:
        if role is not UserRole.TEACHER:
            raise ProtocolError(
                "FORBIDDEN_EVENT",
                f"`{event.value}` eventini faqat o'qituvchi yuborishi mumkin.",
            )
        return
    if event in STUDENT_EVENTS:
        if role is not UserRole.STUDENT:
            raise ProtocolError(
                "FORBIDDEN_EVENT",
                f"`{event.value}` eventini faqat o'quvchi yuborishi mumkin.",
            )
        return
    raise ProtocolError("UNKNOWN_EVENT", f"`{event.value}` qo'llab-quvvatlanmaydi.")


def decode(raw: str, role: UserRole) -> tuple[ClientEvent, Any]:
    """Klient xabarini tekshiradi → `(event, validatsiyadan o'tgan payload)`.

    Rol-guard payload validatsiyasidan **oldin** ishlaydi: ruxsatsiz event
    uchun ichki tuzilish muhim emas.
    """
    if len(raw) > settings.MAX_CODE_CHARS + 4096:
        raise ProtocolError("PAYLOAD_TOO_LARGE", "Xabar hajmi chegaradan katta.")
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        raise ProtocolError("BAD_JSON", "Xabar JSON formatida emas.") from None
    if not isinstance(parsed, dict):
        raise ProtocolError("BAD_ENVELOPE", "Envelope obyekt bo'lishi kerak.")

    version = parsed.get("v", PROTOCOL_VERSION)
    if version != PROTOCOL_VERSION:
        raise ProtocolError(
            "UNSUPPORTED_VERSION", f"Protokol v{PROTOCOL_VERSION} kutilgan, v{version} keldi."
        )

    raw_type = parsed.get("type")
    try:
        event = ClientEvent(raw_type)
    except ValueError:
        raise ProtocolError("UNKNOWN_EVENT", f"`{raw_type}` qo'llab-quvvatlanmaydi.") from None

    check_role(event, role)

    data = parsed.get("data") or {}
    if not isinstance(data, dict):
        raise ProtocolError("BAD_PAYLOAD", "`data` obyekt bo'lishi kerak.")
    try:
        payload = PAYLOAD_MODELS[event].model_validate(data)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(p) for p in first.get("loc", ())) or "data"
        reason = str(first.get("msg") or "qiymat yaroqsiz")
        raise ProtocolError("BAD_PAYLOAD", f"`{event.value}.{where}`: {reason}") from None
    return event, payload


__all__ = [
    "ANY_EVENTS",
    "OPEN_RAW_HARD_CAP",
    "PAYLOAD_MODELS",
    "PROTOCOL_VERSION",
    "STUDENT_EVENTS",
    "TEACHER_EVENTS",
    "TEACHER_ONLY_AUDIENCE",
    "WS_CLOSE_FORBIDDEN",
    "WS_CLOSE_HEARTBEAT_TIMEOUT",
    "WS_CLOSE_INVALID_TICKET",
    "WS_CLOSE_ROOM_NOT_FOUND",
    "WS_CLOSE_SESSION_ENDED",
    "WS_CLOSE_SLOW_CLIENT",
    "ClientEvent",
    "ConfusedPingIn",
    "Cursor",
    "FocusChangeIn",
    "LaserMoveIn",
    "LiveCodePatchIn",
    "OpenAnswerIn",
    "OpenEndIn",
    "OpenHideIn",
    "OpenStartIn",
    "PingIn",
    "PollEndIn",
    "PollStartIn",
    "PollVoteIn",
    "ProtocolError",
    "QuizAnswerIn",
    "QuizEndIn",
    "QuizStartIn",
    "ScreenShareStateIn",
    "ServerEvent",
    "SlideChangeIn",
    "check_role",
    "decode",
    "encode",
    "encode_error",
    "event_type_of",
    "open_raw_limit",
    "sanitize_open_text",
]
