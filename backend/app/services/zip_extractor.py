"""Zip arxivdan matnli kodni xavfsiz ajratib olish (AUDIT.md §A4, §D6).

Tahdid modeli va javob:
  * **Zip bomb** — 1 MB arxiv 10 GB matnga ochiladi. Javob: (a) e'lon qilingan
    jami hajm `ZIP_MAX_UNCOMPRESSED_MB` dan oshsa rad; (b) siqilish nisbati
    `ZIP_MAX_RATIO` dan oshsa rad; (c) **har bir entry faqat chegaralangan
    miqdorda o'qiladi** — e'lon qilingan hajm yolg'on bo'lsa ham RAM portlamaydi.
  * **Path traversal** — `../../etc/passwd`, `/etc/passwd`, `C:\\win`, symlink.
    Biz diskka yozmaymiz (RCE yo'q), lekin bunday entry UI daraxtini buzadi va
    ishonchsiz nom — shuning uchun **tashlanadi** (`skipped`).
  * **Parolli arxiv** — tekshirib bo'lmaydi → `400 ENCRYPTED_ZIP`.
  * **Binary / xizmat kataloglari** — `.venv`, `.git`, `__pycache__`,
    `node_modules`, `.idea`, `dist`, `build`, `.next` va UTF-8 ga dekodlanmagan
    fayllar o'qilmaydi.
  * **TOAST bloat** (AUDIT.md §D6) — har fayl `EXTRACT_MAX_FILE_CHARS`, jami
    `EXTRACT_MAX_TOTAL_CHARS`; oshsa `truncated=True` bilan qirqiladi.

`extract()` — sinxron va CPU-og'ir. Event loop bloklanmasligi uchun
endpointdan `extract_async()` chaqiriladi (`run_in_threadpool`).
"""

from __future__ import annotations

import io
import posixpath
import zipfile
from dataclasses import dataclass, field
from typing import Any

from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.errors import bad_request

# --- Doimiylar -------------------------------------------------------------

#: Arxiv ichida o'qiladigan kengaytmalar (whitelist — AUDIT.md §A4).
TEXT_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".py", ".pyi", ".sql", ".html", ".htm", ".css", ".scss", ".js", ".jsx",
        ".ts", ".tsx", ".json", ".md", ".txt", ".csv", ".yml", ".yaml", ".toml",
        ".ini", ".cfg", ".sh", ".bat", ".ps1", ".java", ".kt", ".c", ".h",
        ".cpp", ".hpp", ".cs", ".go", ".rs", ".rb", ".php", ".svg", ".xml",
        ".graphql", ".prisma", ".vue", ".svelte", ".tf", ".proto",
    }
)

#: Kengaytmasiz, lekin matnli bo'lgan standart fayl nomlari.
TEXT_FILENAMES: frozenset[str] = frozenset(
    {
        "dockerfile", "makefile", "procfile", "readme", "license", "licence",
        "requirements.txt", "pipfile", ".gitignore", ".dockerignore",
        ".editorconfig", ".env.example",
    }
)

#: Hech qachon o'qilmaydigan kataloglar.
IGNORED_DIR_PARTS: frozenset[str] = frozenset(
    {
        ".venv", "venv", ".git", "__pycache__", "node_modules", ".idea",
        "dist", "build", ".next", ".mypy_cache", ".pytest_cache", ".ruff_cache",
        ".svn", ".hg", ".tox", ".cache", "site-packages", ".vscode", "__macosx",
    }
)

#: Nisbat tekshiruvi faqat shu hajmdan katta arxivlarga qo'llanadi — kichik
#: fayllarda yuqori nisbat tabiiy (masalan 2 KB dan 300 KB takrorlanuvchi matn).
RATIO_CHECK_FLOOR_BYTES: int = 1 * 1024 * 1024

#: UTF-8 da bir belgi eng ko'p 4 bayt — shuncha bayt o'qisak, belgi chegarasi ta'minlanadi.
_BYTES_PER_CHAR: int = 4

#: `external_attr` dagi POSIX fayl turi maskasi va symlink biti.
_S_IFMT = 0o170000
_S_IFLNK = 0o120000

#: Parolli arxiv biti (general purpose bit flag, bit 0).
_FLAG_ENCRYPTED = 0x1


# --- Natija tiplari --------------------------------------------------------


@dataclass(slots=True)
class SkippedEntry:
    """Tashlab ketilgan entry va sababi (hisobot/diagnostika uchun)."""

    path: str
    reason: str


@dataclass(slots=True)
class ExtractResult:
    """`submissions.extracted_files` uchun tayyor natija.

    `files` elementi (JSONB sxemasi, frontend `FileTreeSidebar` va AI grader
    shu kalitlarga tayanadi):
        {"path": str, "content": str, "chars": int, "truncated": bool}
    """

    files: list[dict[str, Any]] = field(default_factory=list)
    truncated: bool = False
    total_chars: int = 0
    skipped: list[SkippedEntry] = field(default_factory=list)
    entry_count: int = 0

    @property
    def paths(self) -> list[str]:
        return [f["path"] for f in self.files]

    def as_jsonb(self) -> list[dict[str, Any]]:
        """DB ga yoziladigan ko'rinish (`extracted_files` ustuni)."""
        return self.files


# --- Yordamchilar ----------------------------------------------------------


def normalize_entry_name(raw: str) -> str | None:
    """Entry nomini normallashtiradi; ishonchsiz bo'lsa `None`.

    Rad etiladi: absolyut yo'l (`/x`, `C:\\x`), `..` chiqishi, UNC (`\\\\host`),
    bo'sh nom, `~` bilan boshlanadigan yo'l.
    """
    if not raw:
        return None
    name = raw.replace("\\", "/").replace("\x00", "")
    if name.startswith("//"):
        return None
    if name.startswith("/"):
        return None
    # Windows disk harfi: `C:/...` yoki `C:...`
    if len(name) >= 2 and name[1] == ":" and name[0].isalpha():
        return None
    if name.startswith("~"):
        return None
    normalized = posixpath.normpath(name)
    if normalized in (".", "..", "") or normalized.startswith("../") or normalized == "/":
        return None
    if normalized.startswith("/"):
        return None
    parts = normalized.split("/")
    if any(p == ".." for p in parts):
        return None
    return normalized


def is_symlink(info: zipfile.ZipInfo) -> bool:
    """Unix symlink entry (external_attr dagi fayl turi)."""
    mode = (info.external_attr >> 16) & 0xFFFF
    return bool(mode) and (mode & _S_IFMT) == _S_IFLNK


#: Orqaga moslik: `pptx_import` va boshqalar eski nom bilan import qilgan.
_is_symlink = is_symlink


def _is_ignored_path(normalized: str) -> bool:
    parts = normalized.split("/")
    for part in parts[:-1]:
        if part.lower() in IGNORED_DIR_PARTS:
            return True
    return parts[-1].lower() == ".ds_store"


def _is_text_candidate(normalized: str) -> bool:
    base = normalized.rsplit("/", 1)[-1]
    lower = base.lower()
    if lower in TEXT_FILENAMES:
        return True
    _, dot, ext = lower.rpartition(".")
    if not dot:
        # Kengaytmasiz va whitelistda yo'q → o'qimaymiz.
        return False
    return f".{ext}" in TEXT_EXTENSIONS


def guard_archive(
    infos: list[zipfile.ZipInfo],
    *,
    max_entries: int | None = None,
    max_uncompressed_bytes: int | None = None,
) -> None:
    """Arxiv darajasidagi zip-bomb va parol tekshiruvlari.

    `max_entries` / `max_uncompressed_bytes` — faqat shu ikki SON chaqiruvchi
    uchun o'zgaradi (masalan PPTX: rasmli 100 slayd ~540 yozuv, ~25 MB).
    `None` bo'lsa uy ishi chegaralari (`ZIP_MAX_ENTRIES`,
    `ZIP_MAX_UNCOMPRESSED_MB`) ishlatiladi — uy ishi yo'li o'zgarmaydi.

    Qolgan himoyalar parametrga BOG'LIQ EMAS va har doim ishlaydi:
    parol biti → `ENCRYPTED_ZIP`, siqish nisbati `ZIP_MAX_RATIO` →
    `ZIP_BOMB_DETECTED`. Entry-darajasidagi traversal/symlink tekshiruvi
    chaqiruvchida `normalize_entry_name()` va `is_symlink()` bilan qilinadi.
    """
    entries_limit = settings.ZIP_MAX_ENTRIES if max_entries is None else max_entries
    max_uncompressed = (
        settings.ZIP_MAX_UNCOMPRESSED_MB * 1024 * 1024
        if max_uncompressed_bytes is None
        else max_uncompressed_bytes
    )

    if len(infos) > entries_limit:
        raise bad_request(
            "ZIP_TOO_MANY_ENTRIES",
            f"Arxivda juda ko'p fayl ({len(infos)}). "
            f"Ruxsat etilgan chegara: {entries_limit}.",
            entries=len(infos),
            limit=entries_limit,
        )

    for info in infos:
        if info.flag_bits & _FLAG_ENCRYPTED:
            raise bad_request(
                "ENCRYPTED_ZIP",
                "Arxiv parol bilan himoyalangan — tekshirib bo'lmaydi. "
                "Parolsiz zip yuboring.",
                entry=info.filename,
            )

    total_uncompressed = sum(i.file_size for i in infos)
    if total_uncompressed > max_uncompressed:
        raise bad_request(
            "ZIP_BOMB_DETECTED",
            f"Arxiv ochilganda {total_uncompressed / 1048576:.1f} MB bo'ladi — "
            f"chegara {max_uncompressed / 1048576:.0f} MB.",
            uncompressed_bytes=total_uncompressed,
            limit_bytes=max_uncompressed,
        )

    # Nisbat chegarasi ATAYLAB parametrlanmaydi: bomba har qanday chaqiruvda ushlanadi.
    total_compressed = sum(i.compress_size for i in infos)
    if total_uncompressed > RATIO_CHECK_FLOOR_BYTES and total_compressed > 0:
        ratio = total_uncompressed / total_compressed
        if ratio > settings.ZIP_MAX_RATIO:
            raise bad_request(
                "ZIP_BOMB_DETECTED",
                f"Siqilish nisbati juda yuqori ({ratio:.0f}:1) — "
                f"chegara {settings.ZIP_MAX_RATIO}:1.",
                ratio=round(ratio, 1),
                limit=settings.ZIP_MAX_RATIO,
            )


#: Orqaga moslik: eski ichki nom (`pptx_import` shu nom bilan import qilgan).
_guard_archive = guard_archive


# --- Asosiy funksiya -------------------------------------------------------


def extract(buf: io.BytesIO) -> ExtractResult:
    """Zip arxivdan matnli fayllarni chegaralar ichida o'qiydi.

    CPU-og'ir (decompress + decode). Endpointdan `extract_async()` orqali
    chaqiring, aks holda event loop bloklanadi.
    """
    pos = buf.tell()
    buf.seek(0)
    try:
        with zipfile.ZipFile(buf) as zf:
            infos = zf.infolist()
            guard_archive(infos)
            result = _read_entries(zf, infos)
    except zipfile.BadZipFile as exc:
        raise bad_request(
            "INVALID_ZIP", "Zip arxivni o'qib bo'lmadi (fayl buzilgan)."
        ) from exc
    except NotImplementedError as exc:
        # Qo'llab-quvvatlanmagan siqish usuli (masalan deflate64).
        raise bad_request(
            "UNSUPPORTED_ZIP",
            "Arxivning siqish usuli qo'llab-quvvatlanmaydi. Oddiy zip yuboring.",
        ) from exc
    finally:
        buf.seek(pos)
    return result


def _read_entries(zf: zipfile.ZipFile, infos: list[zipfile.ZipInfo]) -> ExtractResult:
    result = ExtractResult(entry_count=len(infos))
    total_budget = settings.EXTRACT_MAX_TOTAL_CHARS
    per_file_cap = settings.EXTRACT_MAX_FILE_CHARS
    max_uncompressed = settings.ZIP_MAX_UNCOMPRESSED_MB * 1024 * 1024
    read_bytes_total = 0

    for info in infos:
        if info.is_dir():
            continue

        normalized = normalize_entry_name(info.filename)
        if normalized is None:
            result.skipped.append(SkippedEntry(info.filename, "unsafe_path"))
            continue
        if is_symlink(info):
            result.skipped.append(SkippedEntry(normalized, "symlink"))
            continue
        if _is_ignored_path(normalized):
            result.skipped.append(SkippedEntry(normalized, "ignored_dir"))
            continue
        if not _is_text_candidate(normalized):
            result.skipped.append(SkippedEntry(normalized, "not_text"))
            continue

        remaining_chars = total_budget - result.total_chars
        if remaining_chars <= 0:
            result.truncated = True
            result.skipped.append(SkippedEntry(normalized, "total_limit"))
            continue

        # Faqat kerakli miqdordagi baytni o'qiymiz: e'lon qilingan `file_size`
        # yolg'on bo'lsa ham ochilgan hajm shu bilan chegaralangan.
        want_chars = min(per_file_cap, remaining_chars)
        read_limit = want_chars * _BYTES_PER_CHAR + 1
        try:
            with zf.open(info, "r") as handle:
                raw = handle.read(read_limit)
        except RuntimeError as exc:
            # zipfile parolli arxivda RuntimeError beradi (yuqorida ushlagan
            # bo'lsak ham, ikkinchi himoya qatlami bo'lib qoladi).
            if "encrypted" in str(exc).lower():
                raise bad_request(
                    "ENCRYPTED_ZIP",
                    "Arxiv parol bilan himoyalangan — tekshirib bo'lmaydi.",
                    entry=normalized,
                ) from exc
            result.skipped.append(SkippedEntry(normalized, "read_error"))
            continue
        except (zipfile.BadZipFile, OSError, EOFError):
            result.skipped.append(SkippedEntry(normalized, "read_error"))
            continue

        read_bytes_total += len(raw)
        if read_bytes_total > max_uncompressed:
            # E'lon qilingan hajm yolg'on bo'lgan holat.
            raise bad_request(
                "ZIP_BOMB_DETECTED",
                "Arxiv ochilganda ruxsat etilgan hajmdan oshdi.",
                read_bytes=read_bytes_total,
                limit_bytes=max_uncompressed,
            )

        if b"\x00" in raw:
            result.skipped.append(SkippedEntry(normalized, "binary"))
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            result.skipped.append(SkippedEntry(normalized, "binary"))
            continue

        file_truncated = False
        if len(text) > want_chars:
            text = text[:want_chars]
            file_truncated = True
            result.truncated = True
        elif len(raw) >= read_limit:
            # Fayl o'qish chegarasiga yetdi, demak davomi bor.
            file_truncated = True
            result.truncated = True

        result.files.append(
            {
                "path": normalized,
                "content": text,
                "chars": len(text),
                "truncated": file_truncated,
            }
        )
        result.total_chars += len(text)

    if result.total_chars >= total_budget:
        result.truncated = True
    return result


async def extract_async(buf: io.BytesIO) -> ExtractResult:
    """`extract()` ni threadpool da bajaradi — event loop bloklanmaydi."""
    return await run_in_threadpool(extract, buf)


def single_file_result(file_name: str, data: bytes) -> ExtractResult:
    """Zip bo'lmagan yakka fayl uchun `extracted_files` yasaydi.

    Binary bo'lsa (UTF-8 dekodlanmasa) — `files` bo'sh, `skipped` ga tushadi.
    """
    result = ExtractResult(entry_count=1)
    normalized = normalize_entry_name(file_name) or "solution.txt"
    cap = min(settings.EXTRACT_MAX_FILE_CHARS, settings.EXTRACT_MAX_TOTAL_CHARS)
    if b"\x00" in data[: cap * _BYTES_PER_CHAR]:
        result.skipped.append(SkippedEntry(normalized, "binary"))
        return result
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        result.skipped.append(SkippedEntry(normalized, "binary"))
        return result
    truncated = len(text) > cap
    if truncated:
        text = text[:cap]
    result.files.append(
        {
            "path": normalized,
            "content": text,
            "chars": len(text),
            "truncated": truncated,
        }
    )
    result.total_chars = len(text)
    result.truncated = truncated
    return result


async def single_file_result_async(file_name: str, data: bytes) -> ExtractResult:
    """Katta matnni dekodlash ham CPU-og'ir — threadpool da."""
    return await run_in_threadpool(single_file_result, file_name, data)


__all__ = [
    "IGNORED_DIR_PARTS",
    "TEXT_EXTENSIONS",
    "TEXT_FILENAMES",
    "ExtractResult",
    "SkippedEntry",
    "extract",
    "extract_async",
    "guard_archive",
    "is_symlink",
    "normalize_entry_name",
    "single_file_result",
    "single_file_result_async",
]
