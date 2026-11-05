"""Zero-disk upload himoyasi.

NEGA BU MODUL BOR (AUDIT.md §A3):
Starlette `UploadFile` — `SpooledTemporaryFile(max_size=1 MB)`. 1 MB dan oshgan
har qanday yuklama **avtomatik `/tmp` ga yoziladi**, ya'ni `await file.read()`
chaqirilgan paytda fayl diskka allaqachon tushgan bo'ladi. Shuning uchun
`multipart/form-data` ni biz **o'zimiz** `request.stream()` ustida, callback
asosidagi parser bilan o'qiymiz va baytlarni faqat `io.BytesIO` (RAM) ga
yozamiz. Hech qanday vaqtinchalik fayl yaratilmaydi.

Himoyalar:
  * hard cap — `max_bytes` oshsa darhol `413 FILE_TOO_LARGE` (oqim to'xtaydi);
  * `Content-Length` bo'yicha oldindan tez rad etish;
  * `sha256` oqim davomida hisoblanadi (ikkinchi marta o'qish kerak emas);
  * kengaytma whitelist (`.py .sql .html .css .js .ts .json .md .txt .zip`);
  * fayl nomi normalizatsiyasi (katalog ajratgichlari, boshqaruv belgilari);
  * global `asyncio.Semaphore(MAX_CONCURRENT_UPLOADS)` — 100 o'quvchi bir
    vaqtda 25 MB yuborsa ham RAM portlamaydi (AUDIT.md §A4).
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

from app.core.config import settings
from app.core.errors import bad_request, rate_limited, too_large

# --- Doimiylar -------------------------------------------------------------

#: Oqimdan bir martada o'qiladigan blok (RAM bosimi past, syscall kam).
CHUNK_SIZE: int = 64 * 1024

#: Yuklash uchun ruxsat etilgan kengaytmalar (storage-engineer roli, AUDIT.md §A4).
ALLOWED_EXTENSIONS: frozenset[str] = frozenset(
    {".py", ".sql", ".html", ".css", ".js", ".ts", ".json", ".md", ".txt", ".zip"}
)

#: Multipart ichidagi matn maydonlari (masalan `file_name`) uchun chegara.
MAX_FORM_FIELD_BYTES: int = 1 * 1024 * 1024

#: Semafor navbatida kutishning maksimal vaqti; oshsa `429` (flood himoyasi).
UPLOAD_QUEUE_TIMEOUT_SEC: float = 30.0

#: Fayl nomida saqlanadigan belgilar; qolgani `_` ga almashtiriladi.
_UNSAFE_NAME_RE = re.compile(r"[^0-9A-Za-z._\- ]+")
_DOTS_RE = re.compile(r"\.{2,}")

#: Butun ilova bo'yicha bitta semafor (AUDIT.md §A4).
UPLOAD_SEMAPHORE: asyncio.Semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_UPLOADS)


# --- Natija tipi -----------------------------------------------------------


@dataclass(slots=True)
class StreamedUpload:
    """RAM dagi yuklama va uning metama'lumotlari.

    `buf` — pozitsiyasi 0 ga qaytarilgan `io.BytesIO`; diskda nusxasi yo'q.
    `form_fields` — multipart ichidagi fayl bo'lmagan maydonlar (matn).
    """

    buf: io.BytesIO
    size: int
    sha256: str
    file_name: str | None = None
    content_type: str | None = None
    form_fields: dict[str, str] = field(default_factory=dict)

    @property
    def data(self) -> bytes:
        return self.buf.getvalue()


# --- Konkurensiya ----------------------------------------------------------


@asynccontextmanager
async def upload_slot() -> AsyncIterator[None]:
    """Yuklash "slot"i. Bo'sh slot 30 s ichida chiqmasa — `429 RATE_LIMITED`.

    Ishlatilishi:
        async with upload_slot():
            ...
    """
    try:
        await asyncio.wait_for(UPLOAD_SEMAPHORE.acquire(), timeout=UPLOAD_QUEUE_TIMEOUT_SEC)
    except TimeoutError:
        raise rate_limited(
            "Server hozir band (juda ko'p fayl yuklanmoqda). "
            "Bir necha sekunddan keyin qayta urinib ko'ring."
        ) from None
    try:
        yield
    finally:
        UPLOAD_SEMAPHORE.release()


# --- Fayl nomi va kengaytma ------------------------------------------------


def sanitize_file_name(raw: str | None, *, default: str = "solution.txt") -> str:
    """Fayl nomini xavfsiz holatga keltiradi.

    Katalog ajratgichlari (`/`, `\\`), `..`, boshqaruv belgilari va NUL
    yo'qoladi; natija 255 belgidan oshmaydi. Bo'sh qolsa `default` qaytadi.
    """
    if not raw:
        return default
    name = raw.replace("\\", "/").split("/")[-1]
    name = name.replace("\x00", "")
    name = _UNSAFE_NAME_RE.sub("_", name).strip(" ._")
    name = _DOTS_RE.sub(".", name)
    if not name:
        return default
    if len(name) > 255:
        stem, dot, ext = name.rpartition(".")
        name = (stem[: 254 - len(ext)] + dot + ext) if dot else name[:255]
    return name


def file_extension(file_name: str) -> str:
    """Kichik harfdagi kengaytma (`.zip`), bo'lmasa bo'sh satr."""
    _, dot, ext = file_name.rpartition(".")
    return f".{ext.lower()}" if dot else ""


def assert_allowed_extension(file_name: str) -> str:
    """Kengaytma whitelistda bo'lmasa `400 UNSUPPORTED_FILE_TYPE`."""
    ext = file_extension(file_name)
    if ext not in ALLOWED_EXTENSIONS:
        raise bad_request(
            "UNSUPPORTED_FILE_TYPE",
            "Bu turdagi fayl qabul qilinmaydi. Ruxsat etilgan: "
            + ", ".join(sorted(ALLOWED_EXTENSIONS)),
            file_name=file_name,
            allowed=sorted(ALLOWED_EXTENSIONS),
        )
    return ext


def assert_content_length(headers: Any, max_bytes: int | None = None) -> None:
    """`Content-Length` sarlavhasi bo'yicha oldindan rad etish (tez yo'l)."""
    limit = settings.max_upload_bytes if max_bytes is None else max_bytes
    raw = None
    try:
        raw = headers.get("content-length")
    except AttributeError:  # pragma: no cover - sarlavhasiz manba
        return
    if not raw:
        return
    try:
        declared = int(raw)
    except (TypeError, ValueError):
        return
    if declared > limit:
        raise too_large(
            f"Fayl hajmi {settings.MAX_UPLOAD_MB} MB dan oshmasligi kerak "
            f"(yuborilgan: {declared / 1048576:.1f} MB)."
        )


def sha256_of(buf: io.BytesIO) -> str:
    """Buferning sha256 hex digesti; pozitsiya 0 ga qaytariladi."""
    hasher = hashlib.sha256()
    pos = buf.tell()
    buf.seek(0)
    while True:
        block = buf.read(CHUNK_SIZE)
        if not block:
            break
        hasher.update(block)
    buf.seek(pos)
    return hasher.hexdigest()


# --- Ichki: oqimni RAM ga ko'chirish --------------------------------------


class _Sink:
    """`BytesIO` + sha256 + hard cap. Cap oshsa darhol `413`."""

    __slots__ = ("_limit", "buf", "hasher", "size")

    def __init__(self, limit: int) -> None:
        self.buf = io.BytesIO()
        self.hasher = hashlib.sha256()
        self.size = 0
        self._limit = limit

    def write(self, data: bytes) -> None:
        if not data:
            return
        self.size += len(data)
        if self.size > self._limit:
            raise too_large(
                f"Fayl hajmi {settings.MAX_UPLOAD_MB} MB dan oshmasligi kerak."
            )
        self.buf.write(data)
        self.hasher.update(data)

    def finish(self) -> tuple[io.BytesIO, int, str]:
        self.buf.seek(0)
        return self.buf, self.size, self.hasher.hexdigest()


def _is_request_like(source: Any) -> bool:
    """`starlette.Request` yoki shunga o'xshash (`headers` + `stream()`) obyekt."""
    return hasattr(source, "stream") and hasattr(source, "headers")


def _content_type_of(source: Any) -> str:
    try:
        return str(source.headers.get("content-type") or "")
    except AttributeError:  # pragma: no cover
        return ""


def is_multipart(source: Any) -> bool:
    """So'rov tanasi `multipart/form-data` ekanini aytadi."""
    return _content_type_of(source).split(";")[0].strip().lower() == "multipart/form-data"


async def _drain_raw_stream(source: Any, limit: int) -> StreamedUpload:
    """Xom (multipart bo'lmagan) tanani RAM ga oqitadi."""
    sink = _Sink(limit)
    async for chunk in source.stream():
        sink.write(chunk)
    buf, size, digest = sink.finish()
    return StreamedUpload(
        buf=buf,
        size=size,
        sha256=digest,
        content_type=_content_type_of(source) or None,
    )


async def _drain_upload_file(source: Any, limit: int) -> StreamedUpload:
    """`UploadFile` ni chunk-chunk o'qiydi.

    DIQQAT: bu yo'l zero-disk EMAS — Starlette faylni allaqachon spool qilgan
    bo'lishi mumkin. Faqat moslik uchun saqlanadi; `submit` oqimi
    `request.stream()` yo'lidan foydalanadi.
    """
    sink = _Sink(limit)
    while True:
        chunk = await source.read(CHUNK_SIZE)
        if not chunk:
            break
        sink.write(chunk)
    buf, size, digest = sink.finish()
    return StreamedUpload(
        buf=buf,
        size=size,
        sha256=digest,
        file_name=sanitize_file_name(getattr(source, "filename", None)),
        content_type=getattr(source, "content_type", None),
    )


def _import_multipart_parser() -> tuple[Any, Any]:
    """`python-multipart` ni ikki nom ostida izlaydi (0.0.20 da nom o'zgargan)."""
    try:
        from python_multipart.multipart import (  # type: ignore[import-not-found]
            MultipartParser,
            parse_options_header,
        )
    except ModuleNotFoundError:  # pragma: no cover - eski o'rnatma
        from multipart.multipart import (  # type: ignore[import-not-found,no-redef]
            MultipartParser,
            parse_options_header,
        )
    return MultipartParser, parse_options_header


class _MultipartCollector:
    """Callback asosidagi multipart yig'uvchi — diskka tegmaydi.

    Faqat `field_name` nomli fayl qismi `BytesIO` ga yoziladi; qolgan matn
    maydonlari `MAX_FORM_FIELD_BYTES` chegarasida `fields` ga tushadi.
    Boshqa fayl qismlari o'qilmaydi (baytlari tashlanadi).
    """

    def __init__(self, field_name: str, limit: int, parse_options_header: Any) -> None:
        self._field_name = field_name
        self._limit = limit
        self._parse_options_header = parse_options_header
        self.sink = _Sink(limit)
        self.file_name: str | None = None
        self.content_type: str | None = None
        self.fields: dict[str, str] = {}
        self.found_file = False
        self._header_field = bytearray()
        self._header_value = bytearray()
        self._headers: dict[bytes, bytes] = {}
        self._cur_name: str | None = None
        self._cur_filename: str | None = None
        self._is_target = False
        self._text = bytearray()

    # -- parser callbacklari ------------------------------------------------

    def on_part_begin(self) -> None:
        self._headers.clear()
        self._header_field.clear()
        self._header_value.clear()
        self._cur_name = None
        self._cur_filename = None
        self._is_target = False
        self._text.clear()

    def on_header_field(self, data: bytes, start: int, end: int) -> None:
        self._header_field.extend(data[start:end])

    def on_header_value(self, data: bytes, start: int, end: int) -> None:
        self._header_value.extend(data[start:end])

    def on_header_end(self) -> None:
        self._headers[bytes(self._header_field).lower()] = bytes(self._header_value)
        self._header_field.clear()
        self._header_value.clear()

    def on_headers_finished(self) -> None:
        disposition = self._headers.get(b"content-disposition", b"")
        _value, params = self._parse_options_header(disposition)
        name = params.get(b"name")
        filename = params.get(b"filename")
        self._cur_name = name.decode("utf-8", "replace") if name else None
        self._cur_filename = filename.decode("utf-8", "replace") if filename else None
        ctype = self._headers.get(b"content-type")
        if self._cur_name == self._field_name and self._cur_filename is not None:
            if self.found_file:
                # Takroriy `file` qismi — ikkinchisini o'qimaymiz.
                self._is_target = False
            else:
                self._is_target = True
                self.file_name = sanitize_file_name(self._cur_filename)
                self.content_type = ctype.decode("latin-1") if ctype else None

    def on_part_data(self, data: bytes, start: int, end: int) -> None:
        if self._is_target:
            self.sink.write(data[start:end])
        elif self._cur_filename is None and self._cur_name:
            chunk = data[start:end]
            if len(self._text) + len(chunk) <= MAX_FORM_FIELD_BYTES:
                self._text.extend(chunk)

    def on_part_end(self) -> None:
        if self._is_target:
            self.found_file = True
        elif self._cur_filename is None and self._cur_name:
            self.fields[self._cur_name] = bytes(self._text).decode("utf-8", "replace")
        self._text.clear()

    def on_end(self) -> None:  # pragma: no cover - parser talab qiladi
        return None

    # -- natija -------------------------------------------------------------

    def callbacks(self) -> dict[str, Any]:
        return {
            "on_part_begin": self.on_part_begin,
            "on_part_data": self.on_part_data,
            "on_part_end": self.on_part_end,
            "on_header_field": self.on_header_field,
            "on_header_value": self.on_header_value,
            "on_header_end": self.on_header_end,
            "on_headers_finished": self.on_headers_finished,
            "on_end": self.on_end,
        }


async def _drain_multipart(source: Any, limit: int, field_name: str) -> StreamedUpload:
    """`multipart/form-data` ni oqim ustida parse qiladi (vaqtinchalik faylsiz)."""
    parser_cls, parse_options_header = _import_multipart_parser()
    content_type = _content_type_of(source)
    _value, params = parse_options_header(content_type)
    boundary = params.get(b"boundary")
    if not boundary:
        raise bad_request(
            "INVALID_MULTIPART", "multipart/form-data so'rovida boundary topilmadi."
        )

    collector = _MultipartCollector(field_name, limit, parse_options_header)
    parser = parser_cls(boundary, collector.callbacks())
    async for chunk in source.stream():
        if chunk:
            parser.write(chunk)
    parser.finalize()

    if not collector.found_file:
        raise bad_request(
            "FILE_REQUIRED",
            f"multipart so'rovida `{field_name}` nomli fayl topilmadi.",
            field=field_name,
        )
    buf, size, digest = collector.sink.finish()
    return StreamedUpload(
        buf=buf,
        size=size,
        sha256=digest,
        file_name=collector.file_name,
        content_type=collector.content_type,
        form_fields=collector.fields,
    )


# --- Ommaviy API -----------------------------------------------------------


async def stream_upload(
    source: Any,
    max_bytes: int | None = None,
    *,
    field_name: str = "file",
) -> StreamedUpload:
    """Yuklamani RAM ga oqitadi va metama'lumot bilan qaytaradi.

    `source` quyidagilardan biri bo'lishi mumkin:
      * `starlette.Request` — `multipart/form-data` bo'lsa oqim ustida
        parse qilinadi, aks holda xom tana o'qiladi;
      * `UploadFile` — chunk-chunk o'qiladi (zero-disk kafolati yo'q);
      * `bytes` / `bytearray` / `io.BytesIO` — to'g'ridan-to'g'ri o'raladi.

    Hajm `max_bytes` (default `settings.max_upload_bytes`) dan oshsa —
    `413 FILE_TOO_LARGE`.
    """
    limit = settings.max_upload_bytes if max_bytes is None else max_bytes

    if isinstance(source, bytes | bytearray | memoryview):
        data = bytes(source)
        if len(data) > limit:
            raise too_large(
                f"Fayl hajmi {settings.MAX_UPLOAD_MB} MB dan oshmasligi kerak."
            )
        return StreamedUpload(
            buf=io.BytesIO(data),
            size=len(data),
            sha256=hashlib.sha256(data).hexdigest(),
        )

    if isinstance(source, io.BytesIO):
        size = source.getbuffer().nbytes
        if size > limit:
            raise too_large(
                f"Fayl hajmi {settings.MAX_UPLOAD_MB} MB dan oshmasligi kerak."
            )
        source.seek(0)
        return StreamedUpload(buf=source, size=size, sha256=sha256_of(source))

    if _is_request_like(source):
        assert_content_length(source.headers, limit)
        if is_multipart(source):
            return await _drain_multipart(source, limit, field_name)
        return await _drain_raw_stream(source, limit)

    if hasattr(source, "read"):
        return await _drain_upload_file(source, limit)

    raise bad_request(
        "UNSUPPORTED_UPLOAD_SOURCE",
        "Yuklama manbasini o'qib bo'lmadi.",
        kind=type(source).__name__,
    )


async def stream_to_memory(request_or_file: Any, max_bytes: int | None = None) -> io.BytesIO:
    """KONTRAKT signaturasi: yuklamani faqat RAM dagi `BytesIO` ga o'qiydi.

    Metama'lumot (hajm, sha256, fayl nomi) kerak bo'lsa — `stream_upload()`.
    """
    result = await stream_upload(request_or_file, max_bytes)
    return result.buf


__all__ = [
    "ALLOWED_EXTENSIONS",
    "CHUNK_SIZE",
    "MAX_FORM_FIELD_BYTES",
    "UPLOAD_QUEUE_TIMEOUT_SEC",
    "UPLOAD_SEMAPHORE",
    "StreamedUpload",
    "assert_allowed_extension",
    "assert_content_length",
    "file_extension",
    "is_multipart",
    "sanitize_file_name",
    "sha256_of",
    "stream_to_memory",
    "stream_upload",
    "upload_slot",
]
