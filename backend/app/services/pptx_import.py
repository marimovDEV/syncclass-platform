"""PPTX → MARKDOWN slaydlar (faqat matn) — CONTRACTS.md §16.2.

SAQLAMAYDI: `{slides, warnings, skipped_images}` qaytaradi, o'qituvchi oldindan
ko'rib tasdiqlagach alohida saqlaydi.

### Xavfsizlik (3 qatlam)
1. **Zip himoyasi — qayta ishlatiladi** (`zip_extractor`): yozuv soni, ochilgan
   hajm, siqish nisbati, parol. Entry nomlari (`..`, absolyut yo'l, symlink)
   ham o'sha modulning funksiyalari bilan tekshiriladi. Qayta yozilmagan.
   `zipfile` ochiq e'lon qilingan `file_size` dan ortiq baytni o'qimaydi, ya'ni
   markaziy katalogda yolg'on aytilgani zarar bermaydi (CRC xatosi → `INVALID_PPTX`).
2. **XML: DTD/ENTITY umuman rad etiladi.** PowerPoint hech qachon `<!DOCTYPE>` yozmaydi.
   Bu `python-pptx` parserining himoyasiga QO'SHIMCHA (3-qatlam).
3. **`python-pptx` parseri**: `pptx.oxml.oxml_parser = XMLParser(remove_blank_text=True,
   resolve_entities=False)` (python-pptx 1.0.2 `oxml/__init__.py:21`); butun paketda
   XML'ni parse qiladigan YAGONA joy (`parse_xml`, `oxml/__init__.py:36`). Entity'lar
   kengaytirilmaydi → billion-laughs ishlamaydi. `tests/test_slides_quiz.py` da
   sun'iy PPTX bilan isbotlangan.

### Zero-Disk
Hamma narsa `io.BytesIO` da. `python-pptx` `Presentation(BytesIO)` ni diskka yozmaydi.

### Nima YO'QOLADI (warnings da ochiq aytiladi)
Dizayn, ranglar, shriftlar, rasmlar, diagramma/SmartArt/video, animatsiya va
o'tish effektlari. To'liq vizual import uchun PPTX → PDF (brauzerdagi `pdf.js` yo'li).
"""

from __future__ import annotations

import io
import logging
import re
import zipfile
import zlib
from dataclasses import dataclass, field
from typing import Any

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE, PP_PLACEHOLDER
from pptx.shapes.picture import Picture
from starlette.concurrency import run_in_threadpool

from app.core.errors import bad_request
from app.schemas.slide import (
    MAX_CONTENT_CHARS,
    MAX_NOTES_CHARS,
    MAX_SLIDES,
    MAX_TITLE_CHARS,
    MarkdownSlide,
)
from app.services.zip_extractor import guard_archive, is_symlink, normalize_entry_name

log = logging.getLogger("syncclass.pptx_import")

#: Yuklama chegarasi (CONTRACTS.md §16.2). `upload_guard` ga shu uzatiladi.
MAX_PPTX_BYTES = 25 * 1024 * 1024

#: PPTX uchun zip chegaralari (uy ishi zip'iga mo'ljallangan 500 yozuv / 20 MB yetmaydi).
PPTX_MAX_ENTRIES = 2000
PPTX_MAX_UNCOMPRESSED_BYTES = 60 * 1024 * 1024

#: Guruh shakllari ichiga tushishning chegarasi (RecursionError dan himoya).
MAX_GROUP_DEPTH = 10

#: Ro'yxatdagi slayd raqamlari ogohlantirishda shuncha ko'rsatiladi.
_MAX_LISTED = 10

_EMPTY_SLIDE_PLACEHOLDER = "_(Bu slaydda matn topilmadi)_"

#: Markdown'ga TUSHMAYDIGAN placeholder'lar (pastki kolontitul, sana, raqam).
_NOISE_PLACEHOLDERS = frozenset(
    {PP_PLACEHOLDER.SLIDE_NUMBER, PP_PLACEHOLDER.DATE, PP_PLACEHOLDER.FOOTER, PP_PLACEHOLDER.HEADER}
)
_LIST_PLACEHOLDERS = frozenset({PP_PLACEHOLDER.BODY, PP_PLACEHOLDER.OBJECT})

#: Boshqaruv belgilari + ko'rinmas/yo'nalishni buzuvchi Unicode (U+202E va h.k.).
_UNSAFE_CHARS_RE = re.compile(
    "[\x00-\x08\x0b-\x1f\x7f​-‏‪-‮⁠-⁩﻿]"
)
_SPACES_RE = re.compile(r"[ \t ]+")

#: PowerPoint hech qachon yozmaydigan konstruksiyalar (ASCII/UTF-8 va UTF-16 shakllari).
_DTD_MARKERS: tuple[bytes, ...] = tuple(
    word.encode(enc)
    for word in ("<!doctype", "<!entity")
    for enc in ("ascii", "utf-16-le", "utf-16-be")
)


@dataclass(slots=True)
class PptxImportResult:
    slides: list[MarkdownSlide] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    skipped_images: int = 0


# ---------------------------------------------------------------------------
# 1-2-qatlam: paket himoyasi
# ---------------------------------------------------------------------------


def _has_dtd(data: bytes) -> bool:
    low = data.lower()
    return any(marker in low for marker in _DTD_MARKERS)


def guard_package(buf: io.BytesIO) -> None:
    """Zip-bomb / traversal / DTD / "bu PPTX emas" tekshiruvi. Xato → `AppError` (400)."""
    buf.seek(0)
    try:
        with zipfile.ZipFile(buf) as zf:
            infos = zf.infolist()
            # Faqat ikki SON PPTX uchun kengaytirilgan (rasmli 100 slayd ~540 yozuv, ~25 MB);
            # siqish nisbati va parol tekshiruvi parametrlanmagan, har doim ishlaydi.
            guard_archive(
                infos,
                max_entries=PPTX_MAX_ENTRIES,
                max_uncompressed_bytes=PPTX_MAX_UNCOMPRESSED_BYTES,
            )
            for info in infos:
                if normalize_entry_name(info.filename) is None or is_symlink(info):
                    raise bad_request(
                        "UNSAFE_PPTX",
                        "Faylda xavfli yo'l yoki symlink bor — yuklab bo'lmaydi.",
                        entry=info.filename[:120],
                    )
            names = {i.filename for i in infos}
            if "[Content_Types].xml" not in names or "ppt/presentation.xml" not in names:
                raise bad_request(
                    "INVALID_PPTX",
                    "Bu PowerPoint (.pptx) fayli emas. Fayl .pptx formatida saqlanganini tekshiring.",
                )
            for info in infos:
                if not info.filename.lower().endswith((".xml", ".rels")):
                    continue
                if _has_dtd(zf.read(info)):
                    raise bad_request(
                        "UNSAFE_PPTX",
                        "Faylda DTD/ENTITY e'loni bor (xavfli XML) — yuklab bo'lmaydi.",
                        entry=info.filename[:120],
                    )
    except zipfile.BadZipFile as exc:
        raise bad_request(
            "INVALID_PPTX",
            "Fayl buzilgan yoki .pptx emas (eski .ppt va parolli fayllar qo'llab-quvvatlanmaydi). "
            "Faylni PowerPoint'da .pptx sifatida qayta saqlang.",
        ) from exc
    except (NotImplementedError, zlib.error, EOFError) as exc:
        raise bad_request("INVALID_PPTX", "Fayl ichidagi ma'lumotni o'qib bo'lmadi (buzilgan).") from exc
    finally:
        buf.seek(0)


# ---------------------------------------------------------------------------
# Matn tozalash
# ---------------------------------------------------------------------------


def _clean_line(text: str) -> str:
    """Bir qatorli matn: boshqaruv belgilari olib tashlanadi, bo'shliqlar yig'iladi."""
    text = text.replace("\v", " ").replace("\r", " ").replace("\n", " ")
    return _SPACES_RE.sub(" ", _UNSAFE_CHARS_RE.sub("", text)).strip()


def _clean_multiline(text: str) -> str:
    lines = (_clean_line(line) for line in text.replace("\r", "\n").replace("\v", "\n").split("\n"))
    return "\n".join(line for line in lines if line)


def _truncate(text: str, limit: int) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    return text[: max(0, limit - 1)].rstrip() + "…", True


def _fmt_slides(numbers: list[int]) -> str:
    shown = ", ".join(str(n) for n in numbers[:_MAX_LISTED])
    extra = len(numbers) - _MAX_LISTED
    return f"{shown} va yana {extra} ta" if extra > 0 else shown


# ---------------------------------------------------------------------------
# Slaydni o'qish
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class _SlideScan:
    blocks: list[str] = field(default_factory=list)
    pictures: int = 0
    other_objects: int = 0  # diagramma, SmartArt, video, OLE


def _placeholder_type(shape: Any) -> Any:
    try:
        return shape.placeholder_format.type if shape.is_placeholder else None
    except Exception:
        return None


def _text_block(shape: Any, ph_type: Any) -> str:
    paragraphs = [(p.level or 0, _clean_line(p.text)) for p in shape.text_frame.paragraphs]
    paragraphs = [(lvl, txt) for lvl, txt in paragraphs if txt]
    if not paragraphs:
        return ""
    as_list = len(paragraphs) > 1 or ph_type in _LIST_PLACEHOLDERS
    if not as_list:
        return paragraphs[0][1]
    return "\n".join(f"{'  ' * min(lvl, 6)}- {txt}" for lvl, txt in paragraphs)


def _table_block(shape: Any) -> str:
    rows = [
        [_clean_line(cell.text).replace("|", "\\|") for cell in row.cells]
        for row in shape.table.rows
    ]
    if not rows or not any(any(cell for cell in row) for row in rows):
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "|" + "---|" * width]
    lines += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n".join(lines)


def _sort_key(item: tuple[int, Any]) -> tuple[int, int, int]:
    """O'qish tartibi: yuqoridan pastga, chapdan o'ngga; koordinatasiz shakl — asl o'rnida."""
    position, shape = item
    try:
        top, left = shape.top, shape.left
    except Exception:
        top = left = None
    if top is None or left is None:
        return (0, position, 0)
    return (1, int(top), int(left))


def _shape_type(shape: Any) -> Any:
    """`shape_type` ba'zi noma'lum shakllarda `NotImplementedError` beradi."""
    try:
        return shape.shape_type
    except NotImplementedError:
        return None


_OBJECT_TYPES = frozenset(
    {
        MSO_SHAPE_TYPE.MEDIA,
        MSO_SHAPE_TYPE.EMBEDDED_OLE_OBJECT,
        MSO_SHAPE_TYPE.LINKED_OLE_OBJECT,
    }
)


def _scan_shapes(shapes: Any, title_shape: Any, scan: _SlideScan, depth: int = 0) -> None:
    # Koordinatasizlar asl o'rnida oldinda, koordinatalilar yuqoridan pastga/chapdan o'ngga.
    for _, shape in sorted(enumerate(shapes), key=_sort_key):
        if title_shape is not None and shape.shape_id == title_shape.shape_id:
            continue
        if isinstance(shape, Picture):
            scan.pictures += 1
            continue
        kind = _shape_type(shape)
        if kind == MSO_SHAPE_TYPE.GROUP:
            if depth < MAX_GROUP_DEPTH:
                _scan_shapes(shape.shapes, title_shape, scan, depth + 1)
            continue
        if _placeholder_type(shape) in _NOISE_PLACEHOLDERS:
            continue
        if shape.has_table:
            block = _table_block(shape)
        elif shape.has_chart or kind in _OBJECT_TYPES:
            scan.other_objects += 1
            continue
        elif shape.has_text_frame:
            block = _text_block(shape, _placeholder_type(shape))
        else:
            # Matnsiz GraphicFrame (SmartArt) yoki noma'lum shakl; oddiy chiziq/konnektor emas.
            if kind is None:
                scan.other_objects += 1
            continue
        if block:
            scan.blocks.append(block)


def _slide_has(slide: Any, tag: str) -> bool:
    return bool(slide.element.xpath(f"./{tag}"))


def import_pptx(buf: io.BytesIO) -> PptxImportResult:
    """PPTX (RAM dagi `BytesIO`) → MARKDOWN slaydlar. CPU-og'ir: endpointdan
    `import_pptx_async()` orqali chaqiring."""
    guard_package(buf)
    try:
        prs = Presentation(buf)
        slides = list(prs.slides)
    except Exception as exc:
        log.info("pptx ochilmadi: %s", exc.__class__.__name__)
        raise bad_request(
            "INVALID_PPTX",
            "PPTX faylni o'qib bo'lmadi (buzilgan bo'lishi mumkin). "
            "Faylni PowerPoint'da qayta saqlab ko'ring.",
        ) from exc

    result = PptxImportResult()
    total_slides = len(slides)
    if total_slides > MAX_SLIDES:
        result.warnings.append(
            f"Faylda {total_slides} ta slayd bor; taqdimotda ko'pi bilan {MAX_SLIDES} ta bo'ladi — "
            f"birinchi {MAX_SLIDES} tasi olindi, qolgan {total_slides - MAX_SLIDES} tasi tashlandi."
        )
        slides = slides[:MAX_SLIDES]

    image_slides: list[int] = []
    object_slides: list[int] = []
    empty_slides: list[int] = []
    motion_slides: list[int] = []
    hidden_slides: list[int] = []
    failed_slides: list[int] = []
    truncated_slides: list[int] = []

    for index, slide in enumerate(slides):
        number = index + 1
        title: str | None = None
        content = ""
        notes: str | None = None
        try:
            title_shape = slide.shapes.title
            if title_shape is not None and title_shape.has_text_frame:
                title = _clean_line(title_shape.text_frame.text) or None
            scan = _SlideScan()
            _scan_shapes(slide.shapes, title_shape, scan)
            content = "\n\n".join(scan.blocks)
            if scan.pictures:
                result.skipped_images += scan.pictures
                image_slides.append(number)
            if scan.other_objects:
                object_slides.append(number)
            if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None:
                notes = _clean_multiline(slide.notes_slide.notes_text_frame.text) or None
            if _slide_has(slide, "p:timing") or _slide_has(slide, "p:transition"):
                motion_slides.append(number)
            if slide.element.get("show") == "0":
                hidden_slides.append(number)
        except Exception:
            log.warning("pptx: %d-slayd o'qilmadi", number, exc_info=True)
            failed_slides.append(number)
            title, content, notes = None, "", None

        if not content:
            if title:
                content = f"## {title}"  # bo'lim slaydi: faqat sarlavha
            else:
                content = _EMPTY_SLIDE_PLACEHOLDER
                if number not in failed_slides:
                    empty_slides.append(number)

        content, cut_content = _truncate(content, MAX_CONTENT_CHARS)
        if title:
            title, cut_title = _truncate(title, MAX_TITLE_CHARS)
        else:
            cut_title = False
        if notes:
            notes, cut_notes = _truncate(notes, MAX_NOTES_CHARS)
        else:
            cut_notes = False
        if cut_content or cut_title or cut_notes:
            truncated_slides.append(number)

        result.slides.append(
            MarkdownSlide(
                index=index, type="MARKDOWN", title=title, content=content, notes=notes
            )
        )

    w = result.warnings
    w.insert(
        0,
        "Faqat matn import qilindi: dizayn, ranglar, shriftlar, animatsiya va o'tish effektlari "
        "saqlanmaydi. To'liq ko'rinish kerak bo'lsa, PPTX ni PDF ga eksport qilib, PDF sifatida yuklang.",
    )
    if result.skipped_images:
        w.append(
            f"{result.skipped_images} ta rasm o'tkazib yuborildi (slaydlar: {_fmt_slides(image_slides)}). "
            "Rasmlarni keyin qo'lda yuklab, rasm slaydi sifatida qo'shishingiz mumkin."
        )
    if object_slides:
        w.append(
            "Diagramma, SmartArt, video yoki ichki obyektlar import qilinmadi "
            f"(slaydlar: {_fmt_slides(object_slides)})."
        )
    if motion_slides:
        w.append(f"Animatsiya yoki o'tish effekti bor slaydlar (ular yo'qoldi): {_fmt_slides(motion_slides)}.")
    if empty_slides:
        w.append(
            f"Matn topilmagan slaydlar (faqat rasm yoki dizayn bo'lishi mumkin): {_fmt_slides(empty_slides)}. "
            "O'rniga bo'sh joy belgisi qo'yildi."
        )
    if hidden_slides:
        w.append(f"PowerPoint'da yashirilgan slaydlar ham olindi: {_fmt_slides(hidden_slides)}.")
    if truncated_slides:
        w.append(f"Juda uzun matn qirqildi (slaydlar: {_fmt_slides(truncated_slides)}).")
    if failed_slides:
        w.append(f"Bu slaydlarni o'qib bo'lmadi, bo'sh qoldirildi: {_fmt_slides(failed_slides)}.")
    return result


async def import_pptx_async(buf: io.BytesIO) -> PptxImportResult:
    return await run_in_threadpool(import_pptx, buf)


__all__ = [
    "MAX_PPTX_BYTES",
    "PptxImportResult",
    "guard_package",
    "import_pptx",
    "import_pptx_async",
]
