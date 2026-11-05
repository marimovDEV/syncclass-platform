"""Slayd JSON sxemasi — CONTRACTS.md §3 ning aynan amalga oshirilishi.

`presentations.slides_data` JSONB bo'lgani uchun DB hech narsani tekshirmaydi
(AUDIT.md §D5). Shuning uchun YOZISHDAN OLDIN butun deck shu yerdagi
**discriminated union** dan o'tadi: `type` maydoni bo'yicha
`MarkdownSlide | CodeSlide | QuizSlide` ga tarmoqlanadi.

v1.2 (CONTRACTS.md §16.1): `IMAGE`, `POLL`, `OPEN` turlari qo'shildi. Ularda SIR YO'Q
(to'g'ri javob, XP yo'q), shuning uchun `/join` redaksiyasi (§15) ularga tegmaydi.

Qoidalar:
  * `extra="forbid"` — kontraktda yo'q maydon yozilmaydi (frontend yiqilmasin);
  * `options` 2..6 ta, `correct_option` SHU ro'yxat diapazonida;
  * `duration_sec` 10..120, `points` 1..1000 (default 100);
  * `index` deck ichida **unikal** va **0 dan ketma-ket** (deck darajasidagi
    `model_validator`, ya'ni `SlideDeck` / `SlideList`);
  * matn uzunliklari cheklangan — JSONB TOAST bloat bo'lmasin.

Eksport: `Slide` (union tipi), `SlideList` (deck uchun annotated list),
`SlideDeck` (mustaqil validatsiya uchun RootModel), `validate_slides_data()`.
"""

from __future__ import annotations

import enum
import re
import uuid
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    field_validator,
    model_validator,
)

from app.core.config import settings

# --- Chegaralar (kontraktdagilar + TOAST bloatdan himoya) ---
MAX_SLIDES = 100  # CONTRACTS.md §16.1: taqdimotda <= 100 slayd
MAX_TITLE_CHARS = 255
MAX_CONTENT_CHARS = 20_000
MAX_NOTES_CHARS = 5_000
MAX_QUESTION_CHARS = 1_000
MAX_OPTION_CHARS = 300
MIN_OPTIONS = 2
MAX_OPTIONS = 6
MIN_DURATION_SEC = 10
MAX_DURATION_SEC = 120
DEFAULT_QUIZ_POINTS = 100
MAX_QUIZ_POINTS = 1_000
# POLL / OPEN (CONTRACTS.md §16.1)
MIN_POLL_DURATION_SEC = 10
MAX_POLL_DURATION_SEC = 300
MIN_OPEN_DURATION_SEC = 30
MAX_OPEN_DURATION_SEC = 600
MIN_OPEN_MAX_CHARS = 10
MAX_OPEN_MAX_CHARS = 200
DEFAULT_OPEN_MAX_CHARS = 60
# IMAGE
MAX_ALT_CHARS = 300
MAX_IMAGE_URL_CHARS = 600
MAX_SOURCE_PAGE = 10_000
# `starter_code` jonli tahrirlashda WS orqali ham yuriladi — bir xil chegara.
MAX_STARTER_CODE_CHARS = settings.MAX_CODE_CHARS


class SlideType(str, enum.Enum):
    """CONTRACTS.md §2 dagi `slide_type`. DB da ENUM YO'Q — faqat shu yerda.

    WS `ROOM_STATE_SYNC` / `SLIDE_CHANGE` dagi `slide_type` qiymatlari ham shular.
    """

    MARKDOWN = "MARKDOWN"
    CODE = "CODE"
    QUIZ = "QUIZ"
    IMAGE = "IMAGE"
    POLL = "POLL"
    OPEN = "OPEN"


CodeLang = Literal["python", "sql", "javascript", "html", "css", "bash"]


class _SlideBase(BaseModel):
    """Barcha slaydlar uchun umumiy maydonlar."""

    model_config = ConfigDict(extra="forbid")

    index: int = Field(ge=0, lt=MAX_SLIDES)
    title: str | None = Field(default=None, max_length=MAX_TITLE_CHARS)


class MarkdownSlide(_SlideBase):
    """Nazariya slaydi: markdown matn."""

    type: Literal["MARKDOWN"]
    content: str = Field(min_length=1, max_length=MAX_CONTENT_CHARS)
    notes: str | None = Field(default=None, max_length=MAX_NOTES_CHARS)


class CodeSlide(_SlideBase):
    """Jonli kod slaydi: boshlang'ich kod + til."""

    type: Literal["CODE"]
    code_lang: CodeLang
    starter_code: str = Field(max_length=MAX_STARTER_CODE_CHARS)
    notes: str | None = Field(default=None, max_length=MAX_NOTES_CHARS)


class QuizSlide(_SlideBase):
    """Test slaydi. XP `services/quiz.py` da `points`/`duration_sec` dan hisoblanadi."""

    type: Literal["QUIZ"]
    question: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
    options: list[Annotated[str, Field(min_length=1, max_length=MAX_OPTION_CHARS)]] = Field(
        min_length=MIN_OPTIONS, max_length=MAX_OPTIONS
    )
    correct_option: int = Field(ge=0, lt=MAX_OPTIONS)
    duration_sec: int = Field(ge=MIN_DURATION_SEC, le=MAX_DURATION_SEC)
    points: int = Field(default=DEFAULT_QUIZ_POINTS, ge=1, le=MAX_QUIZ_POINTS)

    @field_validator("options")
    @classmethod
    def _options_not_blank(cls, v: list[str]) -> list[str]:
        for i, opt in enumerate(v):
            if not opt.strip():
                raise ValueError(f"options[{i}] bo'sh bo'lishi mumkin emas")
        return v

    @model_validator(mode="after")
    def _correct_option_in_range(self) -> QuizSlide:
        """`correct_option` HAQIQIY variantlar sonidan kichik bo'lishi SHART."""
        if self.correct_option >= len(self.options):
            raise ValueError(
                f"correct_option={self.correct_option} diapazondan tashqari: "
                f"0..{len(self.options) - 1} (options soni {len(self.options)})"
            )
        return self


# ---------------------------------------------------------------------------
# Barqaror asset URL (CONTRACTS.md §4 / §16.1) — IMAGE.image_url uchun yagona ruxsat
# ---------------------------------------------------------------------------

#: `POST /presentations/{id}/assets` qaytaradigan URL yo'lining prefiksi. `app/main.py`
#: dagi mount bilan AYNAN bir xil bo'lishi shart (`test_asset_url_roundtrip` tekshiradi).
ASSET_URL_PREFIX = "/api/v1/presentations"

#: `asset_key` — R2 kalitining FAQAT oxirgi bo'lagi: UUID + ruxsat etilgan kengaytma.
#: `/`, `..`, `%2F` va boshqa hech narsa o'tmaydi → path traversal yo'q.
ASSET_KEY_RE = re.compile(
    r"^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})"
    r"\.(?:png|jpg|jpeg|gif|webp)$"
)

_UUID_SEGMENT = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_ASSET_PATH_RE = re.compile(
    rf"^{re.escape(ASSET_URL_PREFIX)}/(?P<pid>{_UUID_SEGMENT})/assets/(?P<key>[^/?#]+)$"
)


def parse_asset_url(url: str) -> tuple[str, uuid.UUID, str] | None:
    """Barqaror asset URL → `(origin, presentation_id, asset_key)`; aks holda `None`.

    Qat'iy: faqat `http(s)://host[:port]/api/v1/presentations/{uuid}/assets/{asset_key}`.
    `javascript:`, `data:`, `//host/...` (protokolsiz), `user@host`, query/fragment,
    bo'shliq va boshqaruv belgilari — hammasi `None`. `host` ning O'ZI bu yerda
    tekshirilmaydi (o'qish yo'lida `BACKEND_PUBLIC_URL` o'zgarsa, eski decklar va
    `load_quiz_slide()` yiqilmasin); host `assert_images_belong_to()` da, YOZISHDA
    tekshiriladi.
    """
    if not isinstance(url, str) or not url or len(url) > MAX_IMAGE_URL_CHARS:
        return None
    if url != url.strip() or any(ord(ch) < 0x21 or ord(ch) == 0x7F for ch in url):
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    if parts.query or parts.fragment or "@" in parts.netloc or "\\" in url:
        return None
    match = _ASSET_PATH_RE.fullmatch(parts.path)
    if match is None or not ASSET_KEY_RE.fullmatch(match.group("key")):
        return None
    return f"{parts.scheme}://{parts.netloc}", uuid.UUID(match.group("pid")), match.group("key")


def stable_asset_url(presentation_id: uuid.UUID | str, asset_key: str) -> str:
    """`POST .../assets` va testlar uchun yagona URL quruvchi."""
    base = settings.BACKEND_PUBLIC_URL.rstrip("/")
    return f"{base}{ASSET_URL_PREFIX}/{presentation_id}/assets/{asset_key}"


class ImageSource(BaseModel):
    """Rasm qayerdan kelgani (UI uchun yorliq; xavfsizlikka ta'siri yo'q)."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["PDF", "PPTX", "UPLOAD"]
    page: int | None = Field(default=None, ge=1, le=MAX_SOURCE_PAGE)


class ImageSlide(_SlideBase):
    """Rasm slaydi (PDF sahifasi, PPTX dan keyin qo'lda yuklangan rasm, ...).

    XAVFSIZLIK: `image_url` FAQAT o'zimizning barqaror asset URL i. Tashqi URL
    har bir o'quvchi brauzerini begona serverga yuborardi (IP sizib chiqishi,
    kuzatuv, aralash kontent). Bu yerda URL SHAKLI tekshiriladi; "aynan shu
    taqdimotniki" ekani va host `assert_images_belong_to()` da (yozishda).
    """

    type: Literal["IMAGE"]
    image_url: str = Field(max_length=MAX_IMAGE_URL_CHARS)
    # Ko'rishida nuqsoni bor o'quvchi uchun majburiy (§16.1).
    alt: str = Field(min_length=1, max_length=MAX_ALT_CHARS)
    notes: str | None = Field(default=None, max_length=MAX_NOTES_CHARS)
    source: ImageSource | None = None

    @field_validator("image_url")
    @classmethod
    def _image_url_is_our_asset(cls, v: str) -> str:
        if parse_asset_url(v) is None:
            raise ValueError(
                "image_url faqat shu platformaning asset havolasi bo'lishi mumkin "
                f"(.../{ASSET_URL_PREFIX.lstrip('/')}/{{id}}/assets/{{asset_key}}); "
                "tashqi havola, javascript: va data: qabul qilinmaydi"
            )
        return v

    @field_validator("alt")
    @classmethod
    def _alt_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("alt bo'sh bo'lishi mumkin emas")
        return v


class PollSlide(_SlideBase):
    """So'rovnoma (baholanmaydi). To'g'ri javob YO'Q — XP ham yo'q (§16.1)."""

    type: Literal["POLL"]
    question: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
    options: list[Annotated[str, Field(min_length=1, max_length=MAX_OPTION_CHARS)]] = Field(
        min_length=MIN_OPTIONS, max_length=MAX_OPTIONS
    )
    duration_sec: int = Field(ge=MIN_POLL_DURATION_SEC, le=MAX_POLL_DURATION_SEC)

    @field_validator("options")
    @classmethod
    def _options_not_blank(cls, v: list[str]) -> list[str]:
        for i, opt in enumerate(v):
            if not opt.strip():
                raise ValueError(f"options[{i}] bo'sh bo'lishi mumkin emas")
        return v


class OpenSlide(_SlideBase):
    """Ochiq savol / so'z buluti. Javoblar anonim, `max_chars` bilan cheklangan."""

    type: Literal["OPEN"]
    question: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
    duration_sec: int = Field(ge=MIN_OPEN_DURATION_SEC, le=MAX_OPEN_DURATION_SEC)
    max_chars: int = Field(default=DEFAULT_OPEN_MAX_CHARS, ge=MIN_OPEN_MAX_CHARS, le=MAX_OPEN_MAX_CHARS)


#: CONTRACTS.md §3 + §16.1 — `Annotated[Union[...], Field(discriminator="type")]`.
Slide = Annotated[
    MarkdownSlide | CodeSlide | QuizSlide | ImageSlide | PollSlide | OpenSlide,
    Field(discriminator="type"),
]


def ensure_sequential_indices(slides: list[Any]) -> list[Any]:
    """Deck darajasidagi tekshiruv: `index` unikal va 0 dan ketma-ket.

    Frontend slaydni `slides_data[i]` deb emas, `index` bo'yicha topadi —
    teshik yoki takror bo'lsa jonli darsda slayd almashinuvi buziladi.
    """
    seen: set[int] = set()
    for position, slide in enumerate(slides):
        if slide.index in seen:
            raise ValueError(f"index={slide.index} takrorlangan (pozitsiya {position})")
        seen.add(slide.index)
        if slide.index != position:
            raise ValueError(
                f"index ketma-ket emas: pozitsiya {position} da index={slide.index} "
                f"(kutilgan {position})"
            )
    return slides


def assert_images_belong_to(
    slides: list[Any], presentation_id: uuid.UUID | None, *, public_url: str | None = None
) -> list[tuple[int, str]]:
    """IMAGE slaydlari FAQAT shu taqdimotning o'z assetlariga ishora qilishini tekshiradi.

    Qaytaradi: rad etilgan `[(slide_index, sabab)]` (bo'sh = hammasi joyida). Chaqiruvchi
    (endpoint) bo'sh bo'lmasa 422 beradi. Tekshiriladi:
      * host/port/sxema == `BACKEND_PUBLIC_URL` (o'zimizning server);
      * URL dagi `{id}` == `presentation_id` (BOSHQA taqdimot asseti → rad);
      * `presentation_id is None` (yangi taqdimot, ID hali yo'q) → har qanday IMAGE
        rad: avval taqdimot yaratiladi, keyin rasm yuklanadi va `PATCH` qilinadi.
    """
    own = urlsplit((public_url or settings.BACKEND_PUBLIC_URL).rstrip("/"))
    own_origin = f"{own.scheme}://{own.netloc}"
    problems: list[tuple[int, str]] = []
    for slide in slides:
        if not isinstance(slide, ImageSlide):
            continue
        parsed = parse_asset_url(slide.image_url)
        if parsed is None:  # sxema allaqachon rad etgan bo'lardi; himoya qatlami
            problems.append((slide.index, "image_url noto'g'ri formatda"))
        elif presentation_id is None:
            problems.append(
                (slide.index, "yangi taqdimotga rasm slaydi qo'shib bo'lmaydi: avval taqdimotni "
                 "saqlang, keyin rasm yuklab, PATCH qiling")
            )
        elif parsed[0].lower() != own_origin.lower():
            problems.append((slide.index, "image_url tashqi serverga ishora qiladi"))
        elif parsed[1] != presentation_id:
            problems.append((slide.index, "image_url boshqa taqdimotning assetiga ishora qiladi"))
    return problems


#: Prezentatsiya sxemalarida ishlatiladigan deck tipi (tartib tekshiruvi bilan).
SlideList = Annotated[
    list[Slide],
    Field(max_length=MAX_SLIDES),
    AfterValidator(ensure_sequential_indices),
]


class SlideDeck(RootModel[list[Slide]]):
    """Mustaqil deck validatori (xom JSONB ni tekshirish uchun).

    `RootModel` bo'lgani uchun JSON ko'rinishi oddiy massiv — kontrakt bilan bir xil.
    """

    root: SlideList = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_indices(self) -> SlideDeck:
        ensure_sequential_indices(self.root)
        return self

    def __len__(self) -> int:
        return len(self.root)

    def __iter__(self):  # type: ignore[override]
        return iter(self.root)

    def __getitem__(self, item: int) -> Any:
        return self.root[item]


def validate_slides_data(raw: Any) -> list[Any]:
    """Xom JSONB (`presentations.slides_data`) → tekshirilgan slaydlar ro'yxati.

    Xato bo'lsa `pydantic.ValidationError` ko'taradi (FastAPI body'da 422 beradi).
    """
    return SlideDeck.model_validate(raw).root


def dump_slides_data(slides: list[Any]) -> list[dict[str, Any]]:
    """Tekshirilgan slaydlar → JSONB ga yozish uchun toza `dict` lar.

    `exclude_none=False` ataylab: `notes: null` frontendda maydon borligini bildiradi.
    """
    return [s.model_dump(mode="json") for s in slides]


__all__ = [
    "ASSET_KEY_RE",
    "ASSET_URL_PREFIX",
    "DEFAULT_OPEN_MAX_CHARS",
    "DEFAULT_QUIZ_POINTS",
    "MAX_DURATION_SEC",
    "MAX_OPTIONS",
    "MAX_SLIDES",
    "MIN_DURATION_SEC",
    "MIN_OPTIONS",
    "CodeLang",
    "CodeSlide",
    "ImageSlide",
    "ImageSource",
    "MarkdownSlide",
    "OpenSlide",
    "PollSlide",
    "QuizSlide",
    "Slide",
    "SlideDeck",
    "SlideList",
    "SlideType",
    "assert_images_belong_to",
    "dump_slides_data",
    "ensure_sequential_indices",
    "parse_asset_url",
    "stable_asset_url",
    "validate_slides_data",
]
