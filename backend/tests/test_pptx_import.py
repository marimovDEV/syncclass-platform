"""`POST /presentations/import/pptx` testlari (CONTRACTS.md §16.2).

Qamrov: oddiy fayl, bo'sh/bo'lim slaydlari, rasm/jadval/eslatma, 100 dan ortiq slayd,
zip-bomb (nisbat, jami hajm, yozuvlar soni), path traversal, symlink, billion-laughs
(entity-expansion) — ham yuklash darvozasida, ham `python-pptx` parserining O'ZIDA —
25 MB dan katta fayl, buzuq fayl, noto'g'ri kengaytma, Zero-Disk (diskka yozish yo'q).

Haqiqiy `app.main.app` ishlatiladi (yo'l, xato konverti, handlerlar bilan); faqat
`require_teacher` almashtiriladi. DB kerak emas — endpoint hech narsa saqlamaydi.
"""

from __future__ import annotations

import io
import os
import tempfile
import time
import uuid
import zipfile
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from lxml import etree
from PIL import Image
from pptx import Presentation
from pptx.oxml import parse_xml
from pptx.util import Inches

from app.api.presentations import router as presentations_router
from app.core.deps import require_teacher
from app.core.errors import AppError
from app.main import app
from app.schemas.slide import MAX_SLIDES, SlideDeck, validate_slides_data
from app.services import pptx_import
from app.services.pptx_import import MAX_PPTX_BYTES, import_pptx

URL = "/api/v1/presentations/import/pptx"
#: Kontrakt (§16.2): 25 MB. ATAYLAB literal — modul konstantasidan olinsa, uni o'zgartirgan
#: xato testni ham birga "moslashtirib" yuboradi.
LIMIT = 25 * 1024 * 1024
PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"


# ---------------------------------------------------------------------------
# Yordamchilar
# ---------------------------------------------------------------------------


def _png() -> io.BytesIO:
    buf = io.BytesIO()
    Image.new("RGB", (16, 16), "blue").save(buf, "PNG")
    buf.seek(0)
    return buf


def make_pptx(build: Callable[[Any], None] | None = None, slides: int = 1) -> bytes:
    """python-pptx bilan haqiqiy PPTX yasaydi (RAM da)."""
    prs = Presentation()
    if build is None:
        for i in range(slides):
            s = prs.slides.add_slide(prs.slide_layouts[5])
            s.shapes.title.text = f"Slayd {i + 1}"
    else:
        build(prs)
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()


def rewrite_zip(
    src: bytes,
    replace: dict[str, bytes] | None = None,
    add: dict[str, bytes] | None = None,
    stored: bool = False,
) -> bytes:
    """Mavjud PPTX ning ayrim entry'larini almashtiradi / yangi entry qo'shadi."""
    out = io.BytesIO()
    method = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
    with zipfile.ZipFile(io.BytesIO(src)) as zin, zipfile.ZipFile(out, "w", method) as zout:
        for info in zin.infolist():
            data = (replace or {}).get(info.filename, zin.read(info))
            zout.writestr(info.filename, data)
        for name, data in (add or {}).items():
            zout.writestr(name, data)
    return out.getvalue()


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    app.dependency_overrides[require_teacher] = lambda: SimpleNamespace(id=uuid.uuid4())
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test", timeout=60) as c:
            yield c
    finally:
        app.dependency_overrides.pop(require_teacher, None)


async def _upload(client: AsyncClient, data: bytes, name: str = "dars.pptx") -> Any:
    return await client.post(URL, files={"file": (name, data, PPTX_MIME)})


def _code(response: Any) -> str:
    return response.json()["detail"]["code"]


# ---------------------------------------------------------------------------
# Oddiy fayl
# ---------------------------------------------------------------------------


def _build_rich(prs: Any) -> None:
    s = prs.slides.add_slide(prs.slide_layouts[1])
    s.shapes.title.text = "Ro'yxatlar"
    tf = s.placeholders[1].text_frame
    tf.text = "Elementlar tartibi saqlanadi"
    p = tf.add_paragraph()
    p.text = "Indeks 0 dan"
    p.level = 1
    tf.add_paragraph().text = "Mutable"
    s.notes_slide.notes_text_frame.text = "Doskada chizing"

    s = prs.slides.add_slide(prs.slide_layouts[6])
    s.shapes.add_picture(_png(), Inches(1), Inches(2))
    s.shapes.add_picture(_png(), Inches(3), Inches(2))
    tb = s.shapes.add_textbox(Inches(1), Inches(0.2), Inches(4), Inches(0.5))
    tb.text_frame.text = "Erkin matn\u202e\x0bqator"
    t = s.shapes.add_table(2, 2, Inches(1), Inches(4), Inches(4), Inches(1)).table
    t.cell(0, 0).text, t.cell(0, 1).text = "Amal", "Murakkab"
    t.cell(1, 0).text, t.cell(1, 1).text = "a|b", "O(1)"


async def test_plain_pptx_imports_text_notes_table(client: AsyncClient) -> None:
    response = await _upload(client, make_pptx(_build_rich))
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"slides", "warnings", "skipped_images"}  # kontrakt §16.2
    first, second = body["slides"]

    assert first == {
        "index": 0,
        "type": "MARKDOWN",
        "title": "Ro'yxatlar",
        "content": "- Elementlar tartibi saqlanadi\n  - Indeks 0 dan\n- Mutable",
        "notes": "Doskada chizing",
    }
    assert second["index"] == 1 and second["title"] is None
    # O'qish tartibi (yuqoridan pastga) + jadval + xavfli belgilar tozalangan:
    assert second["content"] == "Erkin matn qator\n\n| Amal | Murakkab |\n|---|---|\n| a\\|b | O(1) |"
    assert "\u202e" not in second["content"]
    assert body["skipped_images"] == 2
    # Natija sxemadan o'tadi va indekslar ketma-ket:
    assert len(SlideDeck.model_validate(body["slides"]).root) == 2


async def test_warnings_are_uzbek_and_explicit(client: AsyncClient) -> None:
    body = (await _upload(client, make_pptx(_build_rich))).json()
    text = "\n".join(body["warnings"])
    assert body["warnings"][0].startswith("Faqat matn import qilindi")
    for expected in ("dizayn", "animatsiya", "PDF", "2 ta rasm o'tkazib yuborildi", "slaydlar: 2"):
        assert expected in text, expected


async def test_nothing_is_persisted_and_no_db_needed(client: AsyncClient) -> None:
    """Endpoint `db` dependency'siga ega emas — saqlashga imkon ham yo'q."""
    route = next(r for r in presentations_router.routes if getattr(r, "path", "") == "/import/pptx")
    calls = [d.call for d in route.dependant.dependencies]
    assert require_teacher in calls  # faqat TEACHER
    assert all(getattr(c, "__name__", "") != "get_db" for c in calls)


# ---------------------------------------------------------------------------
# Bo'sh / bo'lim / ko'p slaydlar
# ---------------------------------------------------------------------------


def _build_blank_and_divider(prs: Any) -> None:
    prs.slides.add_slide(prs.slide_layouts[6])  # to'liq bo'sh
    s = prs.slides.add_slide(prs.slide_layouts[5])  # faqat sarlavha
    s.shapes.title.text = "2-bo'lim"
    s = prs.slides.add_slide(prs.slide_layouts[6])  # faqat rasm
    s.shapes.add_picture(_png(), Inches(1), Inches(1))


async def test_empty_slides_are_kept_with_placeholder_and_warning(client: AsyncClient) -> None:
    body = (await _upload(client, make_pptx(_build_blank_and_divider))).json()
    blank, divider, image_only = body["slides"]
    assert blank["content"] == "_(Bu slaydda matn topilmadi)_" and blank["title"] is None
    assert divider["title"] == "2-bo'lim" and divider["content"] == "## 2-bo'lim"
    assert image_only["content"] == "_(Bu slaydda matn topilmadi)_"
    assert [s["index"] for s in body["slides"]] == [0, 1, 2]  # asl tartib saqlandi
    text = "\n".join(body["warnings"])
    assert "Matn topilmagan slaydlar" in text and "1, 3" in text
    assert body["skipped_images"] == 1


async def test_zero_slide_pptx_returns_empty_list(client: AsyncClient) -> None:
    response = await _upload(client, make_pptx(lambda prs: None))
    assert response.status_code == 200
    assert response.json()["slides"] == []


async def test_more_than_100_slides_are_cut_with_warning(client: AsyncClient) -> None:
    response = await _upload(client, make_pptx(slides=MAX_SLIDES + 5))
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["slides"]) == MAX_SLIDES
    assert any("105 ta slayd" in w and "5 tasi tashlandi" in w for w in body["warnings"])
    assert len(validate_slides_data(body["slides"])) == MAX_SLIDES


def test_overlong_text_is_truncated_not_rejected() -> None:
    def build(prs: Any) -> None:
        s = prs.slides.add_slide(prs.slide_layouts[6])
        tb = s.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1))
        tb.text_frame.text = "x" * 30_000

    result = import_pptx(io.BytesIO(make_pptx(build)))
    assert len(result.slides[0].content) == 20_000 and result.slides[0].content.endswith("…")
    assert any("Juda uzun matn qirqildi" in w for w in result.warnings)


# ---------------------------------------------------------------------------
# Hajm / buzuq fayl / kengaytma
# ---------------------------------------------------------------------------


async def test_file_over_25mb_is_rejected_413(client: AsyncClient) -> None:
    assert MAX_PPTX_BYTES == LIMIT
    blob = b"PK\x03\x04" + os.urandom(1024) * (LIMIT // 1024 + 2)
    response = await _upload(client, blob)
    assert response.status_code == 413
    assert _code(response) == "FILE_TOO_LARGE"


async def test_exactly_at_limit_is_not_a_size_error(client: AsyncClient) -> None:
    """Chegara 25 MB ni o'z ichiga oladi: shu hajmdagi (yaroqsiz) fayl hajm xatosi bermaydi."""
    response = await _upload(client, b"PK\x03\x04" + b"\0" * (LIMIT - 4 - 1024))
    assert response.status_code == 400 and _code(response) == "INVALID_PPTX"


@pytest.mark.parametrize(
    ("data", "name", "status", "code"),
    [
        pytest.param(b"", "dars.pptx", 400, "EMPTY_FILE", id="bo'sh"),
        pytest.param(b"hello world, not a zip", "dars.pptx", 400, "INVALID_PPTX", id="zip-emas"),
        pytest.param(b"\xd0\xcf\x11\xe0" + b"\0" * 2000, "eski.pptx", 400, "INVALID_PPTX", id="eski-ole-ppt"),
        pytest.param(make_pptx(), "dars.ppt", 400, "UNSUPPORTED_EXTENSION", id="ppt-kengaytma"),
        pytest.param(make_pptx(), "dars.pptm", 400, "UNSUPPORTED_EXTENSION", id="pptm-makro"),
        pytest.param(make_pptx()[: len(make_pptx()) // 2], "dars.pptx", 400, "INVALID_PPTX", id="yarim-kesilgan"),
    ],
)
async def test_invalid_uploads(client: AsyncClient, data: bytes, name: str, status: int, code: str) -> None:
    response = await _upload(client, data, name)
    assert response.status_code == status, response.text
    assert _code(response) == code
    assert response.json()["detail"]["message"]  # o'zbekcha izoh bor


async def test_zip_that_is_not_a_pptx(client: AsyncClient) -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", "<w/>")
    response = await _upload(client, buf.getvalue())
    assert response.status_code == 400 and _code(response) == "INVALID_PPTX"


async def test_corrupt_slide_xml_is_invalid_pptx_not_500(client: AsyncClient) -> None:
    broken = rewrite_zip(make_pptx(), replace={"ppt/slides/slide1.xml": b"<<< not xml"})
    response = await _upload(client, broken)
    assert response.status_code == 400 and _code(response) == "INVALID_PPTX"


async def test_corrupt_zip_member_crc(client: AsyncClient) -> None:
    data = bytearray(make_pptx())
    pos = data.find(b"ppt/slides/slide1.xml")
    data[pos + 60 : pos + 80] = b"\xff" * 20  # slayd ma'lumotlari ichiga axlat
    response = await _upload(client, bytes(data))
    assert response.status_code == 400 and _code(response) in {"INVALID_PPTX", "UNSAFE_PPTX"}


# ---------------------------------------------------------------------------
# Zip-bomb / traversal / symlink (zip_extractor himoyasi qayta ishlatilgan)
# ---------------------------------------------------------------------------


async def test_zip_bomb_by_ratio(client: AsyncClient) -> None:
    """15 MB nol -> ~15 KB: nisbat >> 100:1."""
    bomb = rewrite_zip(make_pptx(), add={"ppt/media/bomb.bin": b"\0" * (15 * 1024 * 1024)})
    assert len(bomb) < 1024 * 1024  # yuklash kichik, ochilishi katta
    response = await _upload(client, bomb)
    assert response.status_code == 400 and _code(response) == "ZIP_BOMB_DETECTED"
    assert "nisbati" in response.json()["detail"]["message"]


async def test_zip_bomb_by_total_uncompressed_size(client: AsyncClient) -> None:
    """Nisbat PAST (~8:1), lekin ochilgan hajm PPTX chegarasi 60 MB dan oshadi."""
    low_entropy = os.urandom(61 * 1024 * 1024).translate(bytes(i & 1 for i in range(256)))
    big = rewrite_zip(make_pptx(), add={"ppt/media/big.bin": low_entropy})
    assert len(big) < LIMIT  # yuklash chegarasidan o'tadi, shuning uchun guard ishga tushadi
    response = await _upload(client, big)
    assert response.status_code == 400 and _code(response) == "ZIP_BOMB_DETECTED"
    assert "ochilganda" in response.json()["detail"]["message"]


async def test_high_ratio_bomb_is_rejected_even_with_widened_pptx_limits(client: AsyncClient) -> None:
    """55 MB nol: 60 MB hajm chegarasi ICHIDA, lekin nisbat ~1000:1 -> endpoint darajasida rad.

    Kengaytirilgan `max_uncompressed_bytes` siqish nisbati tekshiruvini O'CHIRMASLIGINI isbotlaydi.
    """
    bomb = rewrite_zip(make_pptx(), add={"ppt/media/bomb.bin": b"\0" * (55 * 1024 * 1024)})
    assert len(bomb) < 2 * 1024 * 1024
    response = await _upload(client, bomb)
    assert response.status_code == 400
    assert _code(response) == "ZIP_BOMB_DETECTED"
    assert "nisbati" in response.json()["detail"]["message"]


async def test_too_many_entries(client: AsyncClient) -> None:
    many = rewrite_zip(make_pptx(), add={f"ppt/media/f{i}.txt": b"x" for i in range(2100)})
    response = await _upload(client, many)
    assert response.status_code == 400 and _code(response) == "ZIP_TOO_MANY_ENTRIES"


@pytest.mark.parametrize("evil", ["../../etc/passwd", "/etc/passwd", "ppt/../../x.xml", "C:/Windows/x.xml"])
async def test_path_traversal_entry_names(client: AsyncClient, evil: str) -> None:
    data = rewrite_zip(make_pptx(), add={evil: b"x"})
    response = await _upload(client, data)
    assert response.status_code == 400 and _code(response) == "UNSAFE_PPTX"


async def test_symlink_entry(client: AsyncClient) -> None:
    src = make_pptx()
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(src)) as zin, zipfile.ZipFile(out, "w") as zout:
        for info in zin.infolist():
            zout.writestr(info.filename, zin.read(info))
        link = zipfile.ZipInfo("ppt/media/link.png")
        link.external_attr = 0o120777 << 16
        zout.writestr(link, "/etc/passwd")
    response = await _upload(client, out.getvalue())
    assert response.status_code == 400 and _code(response) == "UNSAFE_PPTX"


async def test_encrypted_zip_member(client: AsyncClient) -> None:
    data = bytearray(make_pptx())
    # Birinchi local header va markaziy katalogdagi "shifrlangan" bitini yoqamiz.
    assert data[:4] == b"PK\x03\x04"
    data[6] |= 0x1
    cd = data.find(b"PK\x01\x02")
    data[cd + 8] |= 0x1
    response = await _upload(client, bytes(data))
    assert response.status_code == 400 and _code(response) == "ENCRYPTED_ZIP"


# ---------------------------------------------------------------------------
# XXE / entity expansion (billion laughs)
# ---------------------------------------------------------------------------

def _bomb_dtd(levels: int) -> str:
    """`levels` daraja x 10: `lol` 10**levels marta (levels=9 -> ~3 GB: haqiqiy billion laughs)."""
    entities = "".join(f'  <!ENTITY l{i} "{f"&l{i - 1};" * 10}">\n' for i in range(1, levels + 1))
    return f'<!DOCTYPE sld [\n  <!ENTITY l0 "lol">\n{entities}]>'


def _bomb_slide_xml(src_pptx: bytes, levels: int = 9, encoding: str = "utf-8") -> bytes:
    with zipfile.ZipFile(io.BytesIO(src_pptx)) as z:
        xml = z.read("ppt/slides/slide1.xml").decode("utf-8")
    head, _, rest = xml.partition("\n")
    assert head.startswith("<?xml")
    assert "<a:t>Slayd 1</a:t>" in rest
    rest = rest.replace("<a:t>Slayd 1</a:t>", f"<a:t>&l{levels};</a:t>")
    declared = head.replace("UTF-8", encoding.upper()) if encoding != "utf-8" else head
    return f"{declared}\n{_bomb_dtd(levels)}\n{rest}".encode(encoding)


def _bomb_pptx(levels: int, encoding: str = "utf-8") -> bytes:
    src = make_pptx()
    return rewrite_zip(src, replace={"ppt/slides/slide1.xml": _bomb_slide_xml(src, levels, encoding)})


def test_the_bomb_payload_is_a_real_bomb() -> None:
    """Nazorat: himoyasiz parser 4 darajali yukni HAQIQATAN kengaytiradi (aks holda isbot mazmunsiz).

    O'lchangan (lxml 6.1.3 / libxml2 2.14.6): 4 daraja = 30 000 belgi, himoyasiz parser kengaytiradi;
    5+ darajada libxml2 o'zi `Maximum entity amplification factor exceeded` beradi. 9 daraja
    ~3 GB bo'lardi — fayl hajmi esa 2 KB dan kam.
    """
    src = make_pptx()
    small = _bomb_slide_xml(src, levels=4)
    unsafe = etree.XMLParser(resolve_entities=True)
    root = etree.fromstring(small, unsafe)  # noqa: S320 — ATAYLAB himoyasiz parser
    assert len("".join(root.itertext())) == 3 * 10**4
    assert len(_bomb_slide_xml(src, levels=9)) < 2_000


@pytest.mark.parametrize("encoding", ["utf-8", "utf-16-le", "utf-16-be"])
async def test_billion_laughs_is_rejected_at_the_gate(client: AsyncClient, encoding: str) -> None:
    """1-qatlam: to'liq 9 darajali billion-laughs (~3 GB) parse qilinishidan OLDIN rad etiladi."""
    started = time.perf_counter()
    response = await _upload(client, _bomb_pptx(levels=9, encoding=encoding))
    assert time.perf_counter() - started < 5
    assert response.status_code == 400 and _code(response) == "UNSAFE_PPTX"


def test_python_pptx_parser_does_not_expand_entities(monkeypatch: pytest.MonkeyPatch) -> None:
    """2-qatlam: DTD darvozasi O'CHIRILGANDA ham python-pptx entity'ni kengaytirmaydi.

    `pptx.oxml.oxml_parser = XMLParser(resolve_entities=False)` (python-pptx 1.0.2,
    oxml/__init__.py:21). Himoyasiz parser xuddi shu yukda 30 000 belgi beradi
    (`test_the_bomb_payload_is_a_real_bomb`); python-pptx esa kengaytirmaydi.
    Agar yangi versiya bu sozlamani o'zgartirsa, shu test yiqiladi.
    """
    src = make_pptx()
    bomb = _bomb_slide_xml(src, levels=4)

    started = time.perf_counter()
    root = parse_xml(bomb)  # python-pptx ning HAQIQIY parseri
    assert len("".join(root.itertext())) < 100
    assert time.perf_counter() - started < 1

    # Butun import yo'li (DTD darvozasi atay o'chirilgan):
    monkeypatch.setattr(pptx_import, "_has_dtd", lambda data: False)
    result = import_pptx(io.BytesIO(rewrite_zip(src, replace={"ppt/slides/slide1.xml": bomb})))
    assert all(len(s.content) < 100 for s in result.slides)
    assert result.slides[0].title is None or len(result.slides[0].title) < 100


def test_libxml2_amplification_guard_is_the_third_layer(monkeypatch: pytest.MonkeyPatch) -> None:
    """3-qatlam: darvoza O'CHIQ + 9 daraja: libxml2 o'zi to'xtatadi -> 400 INVALID_PPTX (500 emas)."""
    monkeypatch.setattr(pptx_import, "_has_dtd", lambda data: False)
    started = time.perf_counter()
    with pytest.raises(AppError) as exc:
        import_pptx(io.BytesIO(_bomb_pptx(levels=9)))
    assert time.perf_counter() - started < 5
    assert exc.value.status_code == 400 and exc.value.detail["code"] == "INVALID_PPTX"


async def test_external_entity_xxe_file_read_is_rejected(client: AsyncClient) -> None:
    src = make_pptx()
    with zipfile.ZipFile(io.BytesIO(src)) as z:
        xml = z.read("ppt/slides/slide1.xml").decode()
    head, _, rest = xml.partition("\n")
    evil = f'{head}\n<!DOCTYPE sld [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n{rest}'
    evil = evil.replace("<a:t>Slayd 1</a:t>", "<a:t>&xxe;</a:t>")
    response = await _upload(client, rewrite_zip(src, replace={"ppt/slides/slide1.xml": evil.encode()}))
    assert response.status_code == 400 and _code(response) == "UNSAFE_PPTX"


def test_external_entity_never_reads_files_even_without_the_gate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """DTD darvozasi o'chirilgan bo'lsa ham `SYSTEM "file://..."` fayl o'qimaydi."""
    secret = f"TOPSECRET-{uuid.uuid4().hex}"
    secret_file = tmp_path / "secret.txt"
    secret_file.write_text(secret)

    src = make_pptx()
    with zipfile.ZipFile(io.BytesIO(src)) as z:
        xml = z.read("ppt/slides/slide1.xml").decode()
    head, _, rest = xml.partition("\n")
    evil = f'{head}\n<!DOCTYPE sld [<!ENTITY xxe SYSTEM "file://{secret_file}">]>\n{rest}'
    evil = evil.replace("<a:t>Slayd 1</a:t>", "<a:t>&xxe;</a:t>")

    monkeypatch.setattr(pptx_import, "_has_dtd", lambda data: False)
    result = import_pptx(io.BytesIO(rewrite_zip(src, replace={"ppt/slides/slide1.xml": evil.encode()})))

    dumped = repr([s.model_dump() for s in result.slides])
    assert secret not in dumped


# ---------------------------------------------------------------------------
# Zero-Disk
# ---------------------------------------------------------------------------


async def test_nothing_is_written_to_disk(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Yuklash + import davomida hech qanday vaqtinchalik fayl yaratilmaydi."""

    def forbidden(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("diskka yozishga urinish (tempfile)!")

    for name in ("SpooledTemporaryFile", "NamedTemporaryFile", "TemporaryFile", "mkstemp", "mkdtemp"):
        monkeypatch.setattr(tempfile, name, forbidden)

    before = set(os.listdir(tempfile.gettempdir()))
    response = await _upload(client, make_pptx(_build_rich))
    assert response.status_code == 200, response.text
    assert set(os.listdir(tempfile.gettempdir())) - before == set()


# ---------------------------------------------------------------------------
# Haqiqiy kattalikdagi taqdimot va zip himoyasi chegaralari
# ---------------------------------------------------------------------------


def _deck_with_pictures(slides: int) -> bytes:
    """Har slaydda BOSHQA rasm (python-pptx bir xil rasmni bitta entry'ga birlashtiradi)."""

    def build(prs: Any) -> None:
        for i in range(slides):
            s = prs.slides.add_slide(prs.slide_layouts[1])
            s.shapes.title.text = f"Slayd {i + 1}"
            s.placeholders[1].text_frame.text = "matn"
            s.notes_slide.notes_text_frame.text = "eslatma"
            buf = io.BytesIO()
            Image.frombytes("RGB", (24, 24), os.urandom(24 * 24 * 3)).save(buf, "PNG")
            buf.seek(0)
            s.shapes.add_picture(buf, Inches(1), Inches(3), width=Inches(2))

    return make_pptx(build)


async def test_100_slide_text_deck_passes_the_guard(client: AsyncClient) -> None:
    """Matnli 100 slayd (eslatmalar bilan) ~440 yozuv: 500 chegarasi ichida."""
    response = await _upload(client, make_pptx(slides=100))
    assert response.status_code == 200, response.text
    assert len(response.json()["slides"]) == 100


async def test_60_slide_deck_with_pictures_passes_the_guard(client: AsyncClient) -> None:
    """PDF yo'lidagi limit (60 sahifa) bilan teng: rasmli 60 slayd ~340 yozuv."""
    response = await _upload(client, _deck_with_pictures(60))
    assert response.status_code == 200, response.text
    assert response.json()["skipped_images"] == 60


async def test_100_slide_deck_with_pictures_passes_the_guard(client: AsyncClient) -> None:
    """Rasmli 100 slayd ~540 yozuv: PPTX uchun kengaytirilgan chegara (2000) ichida (avval CONTRACT_CONFLICT edi)."""
    response = await _upload(client, _deck_with_pictures(100))
    assert response.status_code == 200, response.text
