"""Zip-bomb, path-traversal va zero-disk upload himoyalarining testlari.

AUDIT.md §A3 (uch qatrali disk), §A4 (zip bomb / traversal / RAM), §D6
(`extracted_files` cheklovi) talablarini amalda tekshiradi.

Testlar tarmoqqa ham, DB ga ham, diskka ham chiqmaydi — hammasi RAM da.
"""

from __future__ import annotations

import base64
import io
import os
import zipfile
from typing import Any

import pytest
from starlette.datastructures import Headers

from app.core.config import settings
from app.core.errors import AppError
from app.services import zip_extractor
from app.services.upload_guard import (
    UPLOAD_SEMAPHORE,
    assert_allowed_extension,
    sanitize_file_name,
    sha256_of,
    stream_to_memory,
    stream_upload,
    upload_slot,
)
from app.services.zip_extractor import extract, extract_async, normalize_entry_name

BOUNDARY = b"----SyncClassTestBoundary7MA4YWxkTrZu0gW"


# ---------------------------------------------------------------------------
# Yordamchilar
# ---------------------------------------------------------------------------


def incompressible_text(size: int) -> str:
    """Siqilmaydigan ASCII matn — nisbat tekshiruviga tushib ketmasin."""
    raw = base64.b64encode(os.urandom(size)).decode("ascii")
    return raw[:size]


def make_zip(entries: list[tuple[str, bytes | str]], *, compress: bool = True) -> io.BytesIO:
    """Oddiy zip yasaydi (RAM da)."""
    buf = io.BytesIO()
    mode = zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED
    with zipfile.ZipFile(buf, "w", mode) as zf:
        for name, payload in entries:
            zf.writestr(name, payload)
    buf.seek(0)
    return buf


def make_symlink_zip(link_name: str, target: str) -> io.BytesIO:
    """Unix symlink entry bo'lgan zip (external_attr da S_IFLNK)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        info = zipfile.ZipInfo(link_name)
        info.external_attr = 0o120777 << 16
        zf.writestr(info, target)
        zf.writestr("main.py", "print('ok')")
    buf.seek(0)
    return buf


def mark_encrypted(data: bytes) -> bytes:
    """Zip baytlarida "parolli" bitini (general purpose bit 0) yoqadi.

    `zipfile` parolli arxiv **yozolmaydi**, shuning uchun mavjud arxivning
    lokal sarlavhasi (offset 6) va markaziy katalogi (offset 8) tahrirlanadi.
    """
    out = bytearray(data)
    for signature, flag_offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        pos = 0
        while True:
            pos = out.find(signature, pos)
            if pos < 0:
                break
            out[pos + flag_offset] |= 0x01
            pos += 4
    return bytes(out)


def multipart_body(
    files: list[tuple[str, str, bytes]] | None = None,
    fields: dict[str, str] | None = None,
) -> tuple[bytes, dict[str, str]]:
    """`multipart/form-data` tanasi va sarlavhalarini yasaydi."""
    parts: list[bytes] = []
    for name, value in (fields or {}).items():
        parts.append(
            b"--" + BOUNDARY + b"\r\n"
            b'Content-Disposition: form-data; name="' + name.encode() + b'"\r\n\r\n'
            + value.encode("utf-8") + b"\r\n"
        )
    for name, file_name, payload in files or []:
        parts.append(
            b"--" + BOUNDARY + b"\r\n"
            b'Content-Disposition: form-data; name="' + name.encode()
            + b'"; filename="' + file_name.encode("utf-8") + b'"\r\n'
            b"Content-Type: application/octet-stream\r\n\r\n" + payload + b"\r\n"
        )
    body = b"".join(parts) + b"--" + BOUNDARY + b"--\r\n"
    headers = {
        "content-type": f"multipart/form-data; boundary={BOUNDARY.decode()}",
        "content-length": str(len(body)),
    }
    return body, headers


class FakeRequest:
    """`starlette.Request` ning oqim qismini taqlid qiladi (`headers` + `stream()`)."""

    def __init__(self, body: bytes, headers: dict[str, str], chunk_size: int = 4096) -> None:
        self.headers = Headers(headers)
        self._body = body
        self._chunk_size = chunk_size

    async def stream(self) -> Any:
        for start in range(0, len(self._body), self._chunk_size):
            yield self._body[start : start + self._chunk_size]
        yield b""


# ---------------------------------------------------------------------------
# 1. Zip bomb
# ---------------------------------------------------------------------------


def test_zip_bomb_uncompressed_size_rejected() -> None:
    """E'lon qilingan ochilgan hajm chegaradan oshsa — 400 ZIP_BOMB_DETECTED."""
    oversized = (settings.ZIP_MAX_UNCOMPRESSED_MB + 4) * 1024 * 1024
    buf = make_zip([("bomb.txt", b"\x41" * oversized)])
    assert buf.getbuffer().nbytes < 1024 * 1024  # 24 MB nol -> bir necha KB

    with pytest.raises(AppError) as exc:
        extract(buf)
    assert exc.value.status_code == 400
    assert exc.value.detail["code"] == "ZIP_BOMB_DETECTED"


def test_zip_bomb_ratio_rejected() -> None:
    """Siqilish nisbati `ZIP_MAX_RATIO` dan oshsa — 400 ZIP_BOMB_DETECTED."""
    # 2 MB bir xil belgi: hajm chegarasidan past, lekin nisbat ~1000:1.
    buf = make_zip([("flat.txt", b"0" * (2 * 1024 * 1024))])
    with zipfile.ZipFile(io.BytesIO(buf.getvalue())) as zf:
        info = zf.infolist()[0]
        assert info.file_size / info.compress_size > settings.ZIP_MAX_RATIO

    with pytest.raises(AppError) as exc:
        extract(buf)
    assert exc.value.detail["code"] == "ZIP_BOMB_DETECTED"


def test_too_many_entries_rejected() -> None:
    """`ZIP_MAX_ENTRIES` dan ko'p fayl — 400 ZIP_TOO_MANY_ENTRIES."""
    entries = [(f"src/f{i}.py", f"x = {i}\n") for i in range(settings.ZIP_MAX_ENTRIES + 5)]
    buf = make_zip(entries)
    with pytest.raises(AppError) as exc:
        extract(buf)
    assert exc.value.status_code == 400
    assert exc.value.detail["code"] == "ZIP_TOO_MANY_ENTRIES"


def test_normal_archive_is_extracted() -> None:
    """Oddiy arxiv muammosiz o'qiladi."""
    buf = make_zip(
        [
            ("project/main.py", "print('salom')\n"),
            ("project/query.sql", "SELECT 1;\n"),
            ("project/README.md", "# Loyiha\n"),
        ]
    )
    result = extract(buf)
    assert result.truncated is False
    assert sorted(result.paths) == [
        "project/README.md",
        "project/main.py",
        "project/query.sql",
    ]
    contents = {f["path"]: f["content"] for f in result.files}
    assert contents["project/main.py"] == "print('salom')\n"
    assert all(f["truncated"] is False for f in result.files)


# ---------------------------------------------------------------------------
# 2. Path traversal / symlink / xizmat kataloglari
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "../../etc/passwd",
        "../secret.py",
        "/etc/passwd",
        "//host/share/x.py",
        "..\\..\\windows\\win.ini",
        "C:/Windows/system.ini",
        "~/.ssh/id_rsa",
        "a/b/../../../../out.py",
    ],
)
def test_unsafe_entry_names_are_rejected_by_normalizer(name: str) -> None:
    assert normalize_entry_name(name) is None


def test_path_traversal_entries_are_skipped() -> None:
    """`../` entry tashlanadi, xavfsiz fayl qoladi."""
    buf = make_zip(
        [
            ("../../etc/passwd", "root:x:0:0\n"),
            ("..\\..\\win.ini", "[boot]\n"),
            ("/abs/evil.py", "evil()\n"),
            ("main.py", "print('ok')\n"),
        ]
    )
    result = extract(buf)
    assert result.paths == ["main.py"]
    reasons = {s.reason for s in result.skipped}
    assert "unsafe_path" in reasons
    assert len([s for s in result.skipped if s.reason == "unsafe_path"]) == 3


def test_symlink_entry_is_skipped() -> None:
    result = extract(make_symlink_zip("link.py", "../../etc/passwd"))
    assert result.paths == ["main.py"]
    assert any(s.reason == "symlink" for s in result.skipped)


def test_service_directories_and_binaries_are_skipped() -> None:
    """`.venv/.git/__pycache__/node_modules/...` va binary fayllar o'qilmaydi."""
    buf = make_zip(
        [
            (".venv/lib/python3.12/site.py", "import sys\n"),
            (".git/config", "[core]\n"),
            ("__pycache__/main.cpython-312.pyc", b"\x00\x01binary"),
            ("node_modules/left-pad/index.js", "module.exports = 1\n"),
            (".idea/workspace.xml", "<xml/>\n"),
            ("dist/bundle.js", "var a=1\n"),
            ("build/out.js", "var b=2\n"),
            (".next/static/chunk.js", "var c=3\n"),
            ("logo.png", b"\x89PNG\r\n\x1a\n\x00\x00"),
            ("broken.py", b"print('a')\xff\xfe\x00bad"),
            ("app/main.py", "print('ok')\n"),
        ]
    )
    result = extract(buf)
    assert result.paths == ["app/main.py"]
    reasons = {s.path: s.reason for s in result.skipped}
    assert reasons[".venv/lib/python3.12/site.py"] == "ignored_dir"
    assert reasons["node_modules/left-pad/index.js"] == "ignored_dir"
    assert reasons["__pycache__/main.cpython-312.pyc"] == "ignored_dir"
    assert reasons["logo.png"] == "not_text"
    assert reasons["broken.py"] == "binary"


# ---------------------------------------------------------------------------
# 3. Parolli zip
# ---------------------------------------------------------------------------


def test_encrypted_zip_rejected_with_400() -> None:
    """Parolli arxiv — 400 ENCRYPTED_ZIP (tekshirib bo'lmaydi)."""
    plain = make_zip([("secret.py", "print('maxfiy')\n")]).getvalue()
    encrypted = io.BytesIO(mark_encrypted(plain))

    with zipfile.ZipFile(io.BytesIO(encrypted.getvalue())) as zf:
        assert zf.infolist()[0].flag_bits & 0x1, "test fixture: parol biti yoqilmagan"

    with pytest.raises(AppError) as exc:
        extract(encrypted)
    assert exc.value.status_code == 400
    assert exc.value.detail["code"] == "ENCRYPTED_ZIP"


def test_corrupt_zip_rejected() -> None:
    with pytest.raises(AppError) as exc:
        extract(io.BytesIO(b"bu zip emas, shunchaki matn"))
    assert exc.value.detail["code"] == "INVALID_ZIP"


# ---------------------------------------------------------------------------
# 4. Chegaralar → truncated (AUDIT.md §D6)
# ---------------------------------------------------------------------------


def test_limits_produce_truncated_result() -> None:
    """Har fayl `EXTRACT_MAX_FILE_CHARS`, jami `EXTRACT_MAX_TOTAL_CHARS`."""
    per_file = settings.EXTRACT_MAX_FILE_CHARS
    total_cap = settings.EXTRACT_MAX_TOTAL_CHARS
    chunk = incompressible_text(per_file + 50_000)
    file_count = (total_cap // per_file) + 3
    buf = make_zip([(f"src/big_{i}.py", chunk) for i in range(file_count)])

    result = extract(buf)

    assert result.truncated is True
    assert all(f["chars"] <= per_file for f in result.files)
    assert result.total_chars <= total_cap
    assert sum(f["chars"] for f in result.files) == result.total_chars
    assert len(result.files) == total_cap // per_file
    assert all(f["truncated"] is True for f in result.files)
    assert any(s.reason == "total_limit" for s in result.skipped)


def test_single_large_file_is_truncated() -> None:
    per_file = settings.EXTRACT_MAX_FILE_CHARS
    buf = make_zip([("solo.py", incompressible_text(per_file + 10_000))])
    result = extract(buf)
    assert result.truncated is True
    assert len(result.files) == 1
    assert result.files[0]["chars"] == per_file
    assert result.files[0]["truncated"] is True


def test_single_file_result_without_zip() -> None:
    """Zip bo'lmagan yakka fayl ham bir xil JSONB shaklini beradi."""
    result = zip_extractor.single_file_result("solution.py", b"print('ok')\n")
    assert result.files == [
        {"path": "solution.py", "content": "print('ok')\n", "chars": 12, "truncated": False}
    ]
    assert result.truncated is False

    binary = zip_extractor.single_file_result("solution.py", b"\x00\x01\x02")
    assert binary.files == []
    assert binary.skipped[0].reason == "binary"


async def test_extract_async_runs_in_threadpool() -> None:
    buf = make_zip([("main.py", "print('ok')\n")])
    result = await extract_async(buf)
    assert result.paths == ["main.py"]


# ---------------------------------------------------------------------------
# 5. upload_guard — kengaytma, nom, hard cap
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "file_name",
    ["a.py", "b.sql", "c.html", "d.css", "e.js", "f.ts", "g.json", "h.md", "i.txt", "j.zip"],
)
def test_allowed_extensions_pass(file_name: str) -> None:
    assert assert_allowed_extension(file_name).startswith(".")


@pytest.mark.parametrize("file_name", ["virus.exe", "a.sh", "b.so", "c.pdf", "noext"])
def test_disallowed_extensions_rejected(file_name: str) -> None:
    with pytest.raises(AppError) as exc:
        assert_allowed_extension(file_name)
    assert exc.value.status_code == 400
    assert exc.value.detail["code"] == "UNSUPPORTED_FILE_TYPE"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("../../etc/passwd", "passwd"),
        ("..\\..\\windows\\win.ini", "win.ini"),
        ("/abs/path/main.py", "main.py"),
        ("ok_fayl-1.zip", "ok_fayl-1.zip"),
        ("", "solution.txt"),
        ("....py", "py"),
    ],
)
def test_sanitize_file_name(raw: str, expected: str) -> None:
    assert sanitize_file_name(raw) == expected


def test_sanitize_file_name_drops_nul_and_separators() -> None:
    assert "/" not in sanitize_file_name("a/b/c.py")
    assert "\x00" not in sanitize_file_name("ev\x00il.py")


async def test_raw_stream_hard_cap_returns_413() -> None:
    body = b"x" * 5000
    request = FakeRequest(body, {"content-type": "application/octet-stream"})
    with pytest.raises(AppError) as exc:
        await stream_upload(request, 1000)
    assert exc.value.status_code == 413
    assert exc.value.detail["code"] == "FILE_TOO_LARGE"


async def test_content_length_header_short_circuits() -> None:
    request = FakeRequest(
        b"x" * 10,
        {"content-type": "application/octet-stream", "content-length": "999999999"},
    )
    with pytest.raises(AppError) as exc:
        await stream_upload(request, 1024)
    assert exc.value.status_code == 413


async def test_stream_to_memory_returns_bytesio_with_sha256() -> None:
    import hashlib

    payload = b"print('salom dunyo')\n" * 100
    request = FakeRequest(payload, {"content-type": "application/json"})
    buf = await stream_to_memory(request, len(payload) + 1)
    assert isinstance(buf, io.BytesIO)
    assert buf.getvalue() == payload
    assert sha256_of(buf) == hashlib.sha256(payload).hexdigest()
    # `sha256_of` pozitsiyani buzmaydi
    assert buf.tell() == 0


# ---------------------------------------------------------------------------
# 6. upload_guard — multipart oqimi (vaqtinchalik faylsiz)
# ---------------------------------------------------------------------------


async def test_multipart_stream_parses_file_and_fields() -> None:
    import hashlib

    zip_bytes = make_zip([("main.py", "print('ok')\n")]).getvalue()
    body, headers = multipart_body(
        files=[("file", "solution.zip", zip_bytes)],
        fields={"note": "mening ishim"},
    )
    request = FakeRequest(body, headers, chunk_size=256)

    result = await stream_upload(request, len(body) + 1)

    assert result.file_name == "solution.zip"
    assert result.size == len(zip_bytes)
    assert result.data == zip_bytes
    assert result.sha256 == hashlib.sha256(zip_bytes).hexdigest()
    assert result.form_fields["note"] == "mening ishim"
    # Ajratib olingan bufer haqiqiy zip bo'lib qoladi
    assert extract(result.buf).paths == ["main.py"]


async def test_multipart_sanitizes_traversal_filename() -> None:
    body, headers = multipart_body(files=[("file", "../../etc/passwd.py", b"x = 1\n")])
    result = await stream_upload(FakeRequest(body, headers), len(body) + 1)
    assert result.file_name == "passwd.py"


async def test_multipart_without_file_part_returns_400() -> None:
    body, headers = multipart_body(fields={"code": "print(1)"})
    with pytest.raises(AppError) as exc:
        await stream_upload(FakeRequest(body, headers), len(body) + 1)
    assert exc.value.status_code == 400
    assert exc.value.detail["code"] == "FILE_REQUIRED"


async def test_multipart_hard_cap_returns_413() -> None:
    body, headers = multipart_body(files=[("file", "big.zip", b"y" * 4096)])
    with pytest.raises(AppError) as exc:
        await stream_upload(FakeRequest(body, headers, chunk_size=128), 1024)
    assert exc.value.status_code == 413


# ---------------------------------------------------------------------------
# 7. Konkurensiya semafori
# ---------------------------------------------------------------------------


async def test_upload_slot_acquires_and_releases() -> None:
    assert UPLOAD_SEMAPHORE.locked() is False
    async with upload_slot():
        pass
    assert UPLOAD_SEMAPHORE.locked() is False


async def test_upload_slot_limits_concurrency() -> None:
    """Semafor `MAX_CONCURRENT_UPLOADS` dan ko'p parallel ishga ruxsat bermaydi."""
    import asyncio

    limit = settings.MAX_CONCURRENT_UPLOADS
    peak = 0
    current = 0

    async def worker() -> None:
        nonlocal peak, current
        async with upload_slot():
            current += 1
            peak = max(peak, current)
            await asyncio.sleep(0.01)
            current -= 1

    await asyncio.gather(*(worker() for _ in range(limit * 3)))
    assert peak <= limit
    assert UPLOAD_SEMAPHORE.locked() is False


# ---------------------------------------------------------------------------
# 8. Ko'rinish qoidasi (kontrakt v1.1.1): o'quvchi FAQAT o'zinikini ko'radi
# ---------------------------------------------------------------------------


class _FakeScalarResult:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def all(self) -> list[Any]:
        return self._rows


class _FakeDB:
    """`AsyncSession` ning shu endpoint uchun kerakli qismini taqlid qiladi.

    `scalar()` navbat bo'yicha oldindan berilgan qiymatlarni qaytaradi,
    `scalars()` esa so'rovni yozib oladi — biz uning SQL sidagi filtrni
    tekshiramiz (DB ga ulanmasdan).
    """

    def __init__(self, scalar_values: list[Any], rows: list[Any] | None = None) -> None:
        self._scalar_values = list(scalar_values)
        self._rows = rows or []
        self.scalars_stmt: Any = None

    async def scalar(self, _stmt: Any) -> Any:
        return self._scalar_values.pop(0)

    async def scalars(self, stmt: Any) -> _FakeScalarResult:
        self.scalars_stmt = stmt
        return _FakeScalarResult(self._rows)


def _fake_submission(**overrides: Any) -> Any:
    import uuid as _uuid
    from datetime import UTC, datetime
    from types import SimpleNamespace

    from app.db.models import BackupStatus, StorageKind, SubmissionStatus

    base = {
        "id": _uuid.uuid4(),
        "homework_id": _uuid.uuid4(),
        "student_id": _uuid.uuid4(),
        "attempt_no": 1,
        "is_latest": True,
        "storage_primary": StorageKind.R2,
        "tg_backup_status": BackupStatus.OK,
        "file_name": "solution.zip",
        "file_size_bytes": 1234,
        "content_sha256": "a" * 64,
        "extracted_files": [
            {"path": "main.py", "content": "print(1)", "chars": 8, "truncated": False}
        ],
        "extract_truncated": False,
        "ai_suspected": True,
        "ai_confidence_percent": 82,
        "ai_review_summary": "Kod juda bir xil uslubda yozilgan.",
        "ai_evidence": [{"file": "main.py", "line_start": 1, "line_end": 3, "reason": "uslub"}],
        "ai_injection_suspected": False,
        "suggested_score": 70,
        "final_score": 90,
        "penalty_applied": 0,
        "teacher_comment": None,
        "student_appeal": None,
        "ai_strengths": ["Kod toza bo'lingan", "Nomlar mazmunli"],
        "ai_issues": ["Xatoliklar ushlanmagan"],
        "status": SubmissionStatus.READY_FOR_REVIEW,
        "submitted_at": datetime.now(UTC),
        "graded_at": None,
        "created_at": datetime.now(UTC),
        "updated_at": datetime.now(UTC),
        "student": SimpleNamespace(full_name="Ali Valiyev", avatar_url=None),
    }
    base.update(overrides)
    return SimpleNamespace(**base)


def test_student_sees_ai_verdict_but_not_suggested_score() -> None:
    """AUDIT §E2: o'quvchi AI sababini ko'radi, lekin ichki tavsiyani ko'rmaydi."""
    from app.api.homeworks import _serialize_submission

    sub = _fake_submission()
    student_view = _serialize_submission(sub, for_student=True)

    # AI xulosasi o'quvchidan YASHIRILMAYDI (e'tiroz huquqi uchun shart).
    assert student_view.ai_suspected is True
    assert student_view.ai_confidence_percent == 82
    assert student_view.ai_review_summary
    assert student_view.ai_evidence
    # Ichki tavsiya va baholanmagan ball yashiriladi.
    assert student_view.suggested_score is None
    assert student_view.final_score is None
    assert student_view.student_name == "Ali Valiyev"
    # CONTRACTS §12.1: kuchli tomonlar ham, kamchiliklar ham o'quvchiga yetadi
    assert student_view.ai_strengths == ["Kod toza bo'lingan", "Nomlar mazmunli"]
    assert student_view.ai_issues == ["Xatoliklar ushlanmagan"]
    # `AppealNotice` uchun vaqt tamg'alari (SplitScreenIDE)
    assert student_view.created_at is not None
    assert student_view.updated_at is not None


def test_teacher_sees_suggested_score() -> None:
    from app.api.homeworks import _serialize_submission

    teacher_view = _serialize_submission(_fake_submission(), for_student=False)
    assert teacher_view.suggested_score == 70
    assert teacher_view.final_score == 90


def test_graded_submission_shows_final_score_to_student() -> None:
    from app.api.homeworks import _serialize_submission
    from app.db.models import SubmissionStatus

    sub = _fake_submission(status=SubmissionStatus.GRADED, penalty_applied=15)
    view = _serialize_submission(sub, for_student=True)
    assert view.final_score == 90
    assert view.penalty_applied == 15
    assert view.suggested_score is None


async def test_list_submissions_forces_student_filter() -> None:
    """O'quvchi so'rovi majburiy `student_id = current_user.id` bilan bajariladi."""
    import uuid as _uuid
    from types import SimpleNamespace

    from app.api.homeworks import list_submissions
    from app.db.models import UserRole

    hw_id = _uuid.uuid4()
    student = SimpleNamespace(id=_uuid.uuid4(), role=UserRole.STUDENT)
    homework = SimpleNamespace(id=hw_id, group_id=7)
    group = SimpleNamespace(id=7, teacher_id=_uuid.uuid4())
    db = _FakeDB([homework, group, 42], rows=[])

    rows = await list_submissions(hw_id, True, db, student)

    assert rows == []
    sql = str(db.scalars_stmt)
    assert "submissions.student_id = " in sql
    assert "submissions.homework_id = " in sql


async def test_list_submissions_teacher_sees_whole_group() -> None:
    import uuid as _uuid
    from types import SimpleNamespace

    from app.api.homeworks import list_submissions
    from app.db.models import UserRole

    hw_id = _uuid.uuid4()
    teacher_id = _uuid.uuid4()
    teacher = SimpleNamespace(id=teacher_id, role=UserRole.TEACHER)
    homework = SimpleNamespace(id=hw_id, group_id=7)
    group = SimpleNamespace(id=7, teacher_id=teacher_id)
    db = _FakeDB([homework, group], rows=[])

    await list_submissions(hw_id, True, db, teacher)

    sql = str(db.scalars_stmt)
    assert "submissions.student_id = " not in sql


async def test_non_member_student_gets_403_not_in_group() -> None:
    import uuid as _uuid
    from types import SimpleNamespace

    from app.api.homeworks import list_submissions
    from app.db.models import UserRole

    hw_id = _uuid.uuid4()
    outsider = SimpleNamespace(id=_uuid.uuid4(), role=UserRole.STUDENT)
    homework = SimpleNamespace(id=hw_id, group_id=7)
    group = SimpleNamespace(id=7, teacher_id=_uuid.uuid4())
    db = _FakeDB([homework, group, None], rows=[])

    with pytest.raises(AppError) as exc:
        await list_submissions(hw_id, True, db, outsider)
    assert exc.value.status_code == 403
    assert exc.value.detail["code"] == "NOT_IN_GROUP"


async def test_submission_detail_blocks_other_students_record() -> None:
    """Boshqa o'quvchining yozuvi hech qanday holatda chiqmaydi."""
    import uuid as _uuid
    from types import SimpleNamespace

    from app.api.homeworks import get_submission
    from app.db.models import UserRole

    other_sub = _fake_submission()
    student = SimpleNamespace(id=_uuid.uuid4(), role=UserRole.STUDENT)
    homework = SimpleNamespace(id=other_sub.homework_id, group_id=7)
    group = SimpleNamespace(id=7, teacher_id=_uuid.uuid4())
    # scalar navbati: submission -> homework -> group -> a'zolik
    db = _FakeDB([other_sub, homework, group, 42])

    with pytest.raises(AppError) as exc:
        await get_submission(other_sub.id, db, student)
    assert exc.value.status_code == 403
    assert exc.value.detail["code"] == "NOT_OWNER"


async def test_submission_detail_allows_own_record() -> None:
    import uuid as _uuid
    from datetime import UTC, datetime, timedelta
    from types import SimpleNamespace

    from app.api.homeworks import get_submission
    from app.db.models import UserRole

    student_id = _uuid.uuid4()
    deadline = datetime.now(UTC) + timedelta(days=1)
    own = _fake_submission(student_id=student_id)
    student = SimpleNamespace(id=student_id, role=UserRole.STUDENT)
    homework = SimpleNamespace(id=own.homework_id, group_id=7, deadline=deadline)
    group = SimpleNamespace(id=7, teacher_id=_uuid.uuid4())
    db = _FakeDB([own, homework, group, 42])

    view = await get_submission(own.id, db, student)
    assert view.id == own.id
    assert view.suggested_score is None
    assert view.is_late is False  # deadline hali o'tmagan


# ---------------------------------------------------------------------------
# 9. `is_late` hisoblangan maydoni (CONTRACTS.md §11.1)
# ---------------------------------------------------------------------------


def test_is_late_false_before_deadline() -> None:
    """Deadline'dan oldin topshirilgan ish kechikkan hisoblanmaydi."""
    from datetime import UTC, datetime, timedelta

    from app.api.homeworks import _serialize_submission

    submitted = datetime(2026, 3, 10, 12, 0, tzinfo=UTC)
    deadline = submitted + timedelta(hours=3)
    sub = _fake_submission(submitted_at=submitted)

    view = _serialize_submission(sub, for_student=True, deadline=deadline)
    assert view.is_late is False
    # `is_late` hech qachon ball kamaytirmaydi (AUDIT §E2).
    assert view.penalty_applied == 0


def test_is_late_true_after_deadline() -> None:
    """Deadline o'tgandan keyin topshirilgan ish qabul qilinadi, lekin `is_late=True`."""
    from datetime import UTC, datetime, timedelta

    from app.api.homeworks import _serialize_submission

    deadline = datetime(2026, 3, 10, 12, 0, tzinfo=UTC)
    sub = _fake_submission(submitted_at=deadline + timedelta(minutes=1))

    view = _serialize_submission(sub, for_student=True, deadline=deadline)
    assert view.is_late is True
    assert view.penalty_applied == 0


def test_is_late_falls_back_to_homework_relationship() -> None:
    """`deadline` berilmasa `Submission.homework.deadline` dan olinadi."""
    from datetime import UTC, datetime, timedelta
    from types import SimpleNamespace

    from app.api.homeworks import _brief, _compute_is_late

    deadline = datetime(2026, 3, 10, 12, 0, tzinfo=UTC)
    late = _fake_submission(
        submitted_at=deadline + timedelta(days=1),
        homework=SimpleNamespace(deadline=deadline),
    )
    on_time = _fake_submission(
        submitted_at=deadline - timedelta(days=1),
        homework=SimpleNamespace(deadline=deadline),
    )

    assert _compute_is_late(late) is True
    assert _compute_is_late(on_time) is False
    # Ro'yxat ko'rinishi (`SubmissionWithStudent`) ham to'ldiriladi
    assert _brief(late, for_student=True).is_late is True
    assert _brief(on_time, for_student=False).is_late is False
    # Deadline topilmasa (eski yozuv) — `False`, xato bermaydi
    assert _compute_is_late(_fake_submission()) is False


# ---------------------------------------------------------------------------
# 10. `guard_archive` chegara parametrlari (PPTX importi qayta ishlatadi)
# ---------------------------------------------------------------------------

_PPTX_MAX_ENTRIES = 2000
_PPTX_MAX_BYTES = 60 * 1024 * 1024


def _infos(buf: io.BytesIO) -> list[zipfile.ZipInfo]:
    with zipfile.ZipFile(io.BytesIO(buf.getvalue())) as zf:
        return zf.infolist()


def _large_presentation_like_zip() -> io.BytesIO:
    """~540 yozuv + ~25 MB siqilmaydigan "rasm" — rasmli 100 slaydli PPTX shakli."""
    entries: list[tuple[str, bytes | str]] = [
        (f"ppt/slides/slide{i}.xml", f"<p:sld>{i}</p:sld>") for i in range(1, 540)
    ]
    entries.append(("ppt/media/image1.png", os.urandom(25 * 1024 * 1024)))
    return make_zip(entries, compress=False)


def test_guard_archive_default_limits_unchanged() -> None:
    """Parametrsiz chaqiruv avvalgidek (uy ishi chegaralari) rad etadi."""
    from app.services.zip_extractor import guard_archive

    infos = _infos(_large_presentation_like_zip())
    assert len(infos) > settings.ZIP_MAX_ENTRIES
    with pytest.raises(AppError) as exc:
        guard_archive(infos)
    assert exc.value.detail["code"] == "ZIP_TOO_MANY_ENTRIES"

    # Yozuv soni chegarasini oshirsak ham, hajm chegarasi default bo'yicha ishlaydi
    with pytest.raises(AppError) as exc:
        guard_archive(infos, max_entries=_PPTX_MAX_ENTRIES)
    assert exc.value.detail["code"] == "ZIP_BOMB_DETECTED"
    assert exc.value.detail["fields"]["limit_bytes"] == settings.ZIP_MAX_UNCOMPRESSED_MB * 1048576


def test_guard_archive_custom_limits_allow_large_archive() -> None:
    """Chegara berilganda katta (lekin siqilmagan, xavfsiz) arxiv o'tadi."""
    from app.services.zip_extractor import guard_archive

    infos = _infos(_large_presentation_like_zip())
    guard_archive(
        infos, max_entries=_PPTX_MAX_ENTRIES, max_uncompressed_bytes=_PPTX_MAX_BYTES
    )


def test_guard_archive_custom_limits_still_reject_bomb() -> None:
    """Chegaralar kengaygan bo'lsa ham bomba nisbat bo'yicha ushlanadi."""
    from app.services.zip_extractor import guard_archive

    # 30 MB bir xil bayt: kengaytirilgan 60 MB hajmga sig'adi, lekin nisbat ~1000:1
    bomb = make_zip([("ppt/media/flat.bin", b"\x00" * (30 * 1024 * 1024))])
    with pytest.raises(AppError) as exc:
        guard_archive(
            _infos(bomb),
            max_entries=_PPTX_MAX_ENTRIES,
            max_uncompressed_bytes=_PPTX_MAX_BYTES,
        )
    assert exc.value.detail["code"] == "ZIP_BOMB_DETECTED"
    assert "ratio" in exc.value.detail["fields"]


def test_guard_archive_custom_limits_still_reject_encrypted() -> None:
    from app.services.zip_extractor import guard_archive

    plain = make_zip([("ppt/slides/slide1.xml", "<p:sld/>")]).getvalue()
    with pytest.raises(AppError) as exc:
        guard_archive(
            _infos(io.BytesIO(mark_encrypted(plain))),
            max_entries=_PPTX_MAX_ENTRIES,
            max_uncompressed_bytes=_PPTX_MAX_BYTES,
        )
    assert exc.value.detail["code"] == "ENCRYPTED_ZIP"


def test_old_private_names_remain_as_aliases() -> None:
    """`pptx_import` eski `_`-nomlar bilan import qiladi — yiqilmasin."""
    from app.services import zip_extractor as ze

    assert ze._guard_archive is ze.guard_archive
    assert ze._is_symlink is ze.is_symlink
    symlink_info = _infos(make_symlink_zip("link.py", "../../etc/passwd"))[0]
    assert ze.is_symlink(symlink_info) is True
