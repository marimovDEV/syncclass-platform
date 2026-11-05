"""Prezentatsiya CRUD + rasm yuklash — CONTRACTS.md §4 (`/presentations`).

`app/main.py` bu modulni `prefix="/api/v1/presentations"` bilan ulaydi,
shuning uchun yo'llar shu yerda prefikssiz yoziladi.

Qoidalar:
  * HAR BIR endpointda `teacher_id == current_user.id` guard —
    aks holda 403 `NOT_OWNER` (begona deck o'qilmaydi, o'zgartirilmaydi);
  * `slides_data` yozishdan oldin discriminated union dan o'tadi (AUDIT.md §D5);
  * `commit` endpointning o'zida (CONTRACTS.md §2.3);
  * rasm R2 ga `storage-engineer` ning `services/r2_storage.py` moduli orqali
    yuklanadi — bu yerda qayta yozilmaydi.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.deps import require_teacher
from app.core.errors import AppError, bad_request, conflict, forbidden, not_found
from app.db.models import Presentation, User
from app.db.session import get_db
from app.schemas.presentation import (
    SCHEMA_VERSION,
    AssetOut,
    PptxImportOut,
    PresentationBrief,
    PresentationCreate,
    PresentationOut,
    PresentationUpdate,
    brief_from_row,
)
from app.schemas.slide import (
    ASSET_KEY_RE,
    assert_images_belong_to,
    dump_slides_data,
    stable_asset_url,
)
from app.services.pptx_import import MAX_PPTX_BYTES, import_pptx_async
from app.services.r2_storage import get_client, presigned_url, upload_bytes
from app.services.upload_guard import stream_upload, upload_slot

router = APIRouter()

#: Rasm uchun alohida (kichikroq) chegara: deck ichidagi rasm 25 MB bo'lmasligi kerak.
MAX_ASSET_MB = 8
MAX_ASSET_BYTES = MAX_ASSET_MB * 1024 * 1024

#: Faqat haqiqiy raster formatlar. SVG ATAYLAB yo'q — unda skript bo'lishi mumkin.
ALLOWED_IMAGE_TYPES: dict[str, str] = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
}
#: Kanonik `Content-Type` — R2 ga klient aytgani emas, biz aniqlagani yoziladi.
MIME_BY_EXT: dict[str, str] = {ext: mime for mime, ext in ALLOWED_IMAGE_TYPES.items()}

#: `Content-Type` ga ishonmaymiz — sarlavha baytlari bo'yicha tekshiramiz.
_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpg"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
)


def _sniff_image(data: bytes) -> str | None:
    """Rasm formatini sarlavha baytlaridan aniqlaydi (`None` — rasm emas)."""
    for prefix, ext in _MAGIC:
        if data.startswith(prefix):
            return ext
    # WEBP: "RIFF" .... "WEBP"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def _ensure_images_are_ours(slides: list, presentation_id: uuid.UUID | None) -> None:
    """IMAGE slaydlari faqat O'ZIMIZNING va AYNAN SHU taqdimot assetlariga ishora qilsin.

    Aks holda tashqi `image_url` har bir o'quvchi brauzerini begona serverga yuborardi
    (IP sizib chiqishi, kuzatuv, aralash kontent; CONTRACTS.md §16.1). Xato shakli
    Pydantic 422 si bilan bir xil: `VALIDATION_ERROR` + `fields`.
    """
    problems = assert_images_belong_to(slides, presentation_id)
    if problems:
        raise AppError(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "VALIDATION_ERROR",
            "Yuborilgan ma'lumotlar noto'g'ri.",
            {f"slides_data.{index}.image_url": reason for index, reason in problems},
        )


async def _asset_exists(key: str) -> bool:
    """R2 da obyekt bor-yo'qligini `HEAD` bilan tekshiradi.

    `r2_storage` da tayyor `exists()` yo'q, shuning uchun uning
    `get_client()` fabrikasi ishlatiladi (boto3 sinxron → `run_in_threadpool`).
    """

    def _head() -> bool:
        from botocore.exceptions import ClientError

        client = get_client()
        try:
            client.head_object(Bucket=settings.R2_BUCKET, Key=key)
        except ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            if code in {"NoSuchKey", "NotFound", "404"}:
                return False
            raise
        return True

    return await run_in_threadpool(_head)


def _asset_not_found() -> Exception:
    """Nosoz kalit ham, yo'q fayl ham AYNI xatoni beradi.

    Sabab: (1) `CONTRACTS.md §5.1` dagi kodlar ro'yxatiga yangi kod qo'shilmaydi
    (frontend `ERROR_CODE_LABELS` shu ro'yxatga tayanadi), (2) hujumchiga
    "kalit formati to'g'ri, lekin fayl yo'q" degan ma'lumot berilmaydi.
    """
    return not_found("ASSET_NOT_FOUND", "Rasm topilmadi.")


async def _get_owned(
    db: AsyncSession, presentation_id: uuid.UUID, teacher: User
) -> Presentation:
    """Prezentatsiyani oladi va egalikni tekshiradi (404 → 403 tartibida)."""
    row = await db.get(Presentation, presentation_id)
    if row is None:
        raise not_found("PRESENTATION_NOT_FOUND", "Prezentatsiya topilmadi.")
    if row.teacher_id != teacher.id:
        raise forbidden("NOT_OWNER", "Bu prezentatsiya sizga tegishli emas.")
    return row


@router.post(
    "/import/pptx",
    response_model=PptxImportOut,
    summary="PPTX dan matn import (saqlamaydi)",
)
async def import_pptx(
    request: Request,
    teacher: User = Depends(require_teacher),
) -> PptxImportOut:
    """Tayyor PPTX ni MARKDOWN slaydlarga aylantiradi (CONTRACTS.md §16.2). SAQLAMAYDI.

    Zero-Disk: `UploadFile` ishlatilmaydi (u 1 MB dan keyin `/tmp` ga yozadi) —
    `upload_guard.stream_upload()` `request.stream()` ni to'g'ridan-to'g'ri `BytesIO`
    ga oqizadi; `python-pptx` ham `BytesIO` dan ochadi. Hajm <= 25 MB (`Content-Length`
    bo'yicha oldindan + oqim bo'yicha hisob). Zip-bomb, traversal va XML-entity
    himoyasi: `services/pptx_import.py`. Faqat matn olinadi; yo'qolganlar `warnings` da.
    """
    async with upload_slot():
        upload = await stream_upload(request, MAX_PPTX_BYTES, field_name="file")
        if upload.size == 0:
            raise bad_request("EMPTY_FILE", "Bo'sh fayl yuborildi.")
        name = (upload.file_name or "").lower()
        if name and not name.endswith(".pptx"):
            raise bad_request(
                "UNSUPPORTED_EXTENSION",
                "Faqat .pptx fayl qabul qilinadi (eski .ppt ni PowerPoint'da .pptx qilib saqlang).",
                file_name=upload.file_name,
            )
        result = await import_pptx_async(upload.buf)
    return PptxImportOut(
        slides=result.slides, warnings=result.warnings, skipped_images=result.skipped_images
    )


@router.get("", response_model=list[PresentationBrief], summary="O'z prezentatsiyalari")
async def list_presentations(
    db: AsyncSession = Depends(get_db),
    teacher: User = Depends(require_teacher),
) -> list[PresentationBrief]:
    """Faqat joriy o'qituvchining decklari. `slides_data` qaytarilmaydi.

    Slayd soni SQL darajasida (`jsonb_array_length`) hisoblanadi — yuzlab
    slaydni Python ga ko'chirib o'tirmaymiz.
    """
    rows = (
        await db.execute(
            select(
                Presentation.id,
                Presentation.title,
                Presentation.module_number,
                Presentation.lesson_number,
                Presentation.schema_version,
                Presentation.updated_at,
                func.jsonb_array_length(Presentation.slides_data).label("slides_count"),
            )
            .where(Presentation.teacher_id == teacher.id)
            .order_by(
                Presentation.module_number.asc(),
                Presentation.lesson_number.asc(),
                Presentation.updated_at.desc(),
            )
        )
    ).all()
    return [brief_from_row(row, int(row.slides_count or 0)) for row in rows]


@router.post(
    "",
    response_model=PresentationOut,
    status_code=status.HTTP_201_CREATED,
    summary="Yangi prezentatsiya",
)
async def create_presentation(
    payload: PresentationCreate,
    db: AsyncSession = Depends(get_db),
    teacher: User = Depends(require_teacher),
) -> PresentationOut:
    """`teacher_id` TANADAN olinmaydi — faqat tokendagi foydalanuvchi.

    Yangi taqdimotning ID si hali yo'q, demak unga tegishli asset ham yo'q: IMAGE
    slaydi bu yerda rad etiladi (avval saqlang, rasm yuklang, keyin PATCH qiling).
    """
    _ensure_images_are_ours(payload.slides_data, None)
    row = Presentation(
        teacher_id=teacher.id,
        title=payload.title,
        module_number=payload.module_number,
        lesson_number=payload.lesson_number,
        schema_version=SCHEMA_VERSION,
        slides_data=dump_slides_data(payload.slides_data),
    )
    db.add(row)
    await db.flush()
    await db.refresh(row)
    await db.commit()
    return PresentationOut.model_validate(row)


@router.get("/{presentation_id}", response_model=PresentationOut, summary="Bitta prezentatsiya")
async def get_presentation(
    presentation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    teacher: User = Depends(require_teacher),
) -> PresentationOut:
    row = await _get_owned(db, presentation_id, teacher)
    return PresentationOut.model_validate(row)


@router.patch("/{presentation_id}", response_model=PresentationOut, summary="Tahrirlash")
async def update_presentation(
    presentation_id: uuid.UUID,
    payload: PresentationUpdate,
    db: AsyncSession = Depends(get_db),
    teacher: User = Depends(require_teacher),
) -> PresentationOut:
    """Faqat yuborilgan maydonlar o'zgaradi (`exclude_unset`)."""
    row = await _get_owned(db, presentation_id, teacher)
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise bad_request("EMPTY_PATCH", "O'zgartirish uchun hech qanday maydon yuborilmadi.")

    if "slides_data" in changes:
        slides = payload.slides_data
        if slides is None:
            raise bad_request("INVALID_SLIDES", "slides_data `null` bo'lishi mumkin emas.")
        _ensure_images_are_ours(slides, row.id)
        row.slides_data = dump_slides_data(slides)
        row.schema_version = SCHEMA_VERSION
    for field in ("title", "module_number", "lesson_number"):
        if field in changes and changes[field] is not None:
            setattr(row, field, changes[field])

    await db.flush()
    await db.refresh(row)
    await db.commit()
    return PresentationOut.model_validate(row)


@router.delete(
    "/{presentation_id}", status_code=status.HTTP_204_NO_CONTENT, summary="O'chirish"
)
async def delete_presentation(
    presentation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    teacher: User = Depends(require_teacher),
) -> Response:
    """Dars sessiyasida ishlatilgan deck o'chmaydi → 409 `PRESENTATION_IN_USE`.

    `lesson_sessions.presentation_id` FK `NO ACTION` (CONTRACTS.md §2.1) —
    tarix yo'qolmasligi uchun ataylab shunday.
    """
    row = await _get_owned(db, presentation_id, teacher)
    await db.delete(row)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise conflict(
            "PRESENTATION_IN_USE",
            "Bu prezentatsiya dars sessiyasida ishlatilgan, shuning uchun o'chirilmaydi.",
        ) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{presentation_id}/assets", response_model=AssetOut, summary="Rasm yuklash (R2)")
async def upload_asset(
    presentation_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    teacher: User = Depends(require_teacher),
) -> AssetOut:
    """Slayd uchun rasmni R2 ga yuklaydi va `{url}` qaytaradi.

    Zero-disk (AUDIT.md §A3): `UploadFile` ATAYLAB ishlatilmaydi — u 1 MB dan
    keyin `/tmp` ga yozadi. Fayl `upload_guard.stream_upload()` orqali
    `request.stream()` ustida o'qilib, faqat RAM dagi `BytesIO` ga tushadi;
    `upload_slot()` esa parallel yuklamalar sonini cheklaydi (§A4).

    Himoya: hajm ≤ `MAX_ASSET_MB`, format sarlavha BAYTLARI bo'yicha aniqlanadi
    (klient `Content-Type` iga ishonilmaydi), SVG qabul qilinmaydi.
    """
    await _get_owned(db, presentation_id, teacher)

    async with upload_slot():
        upload = await stream_upload(request, MAX_ASSET_BYTES, field_name="file")

    if upload.size == 0:
        raise bad_request("EMPTY_FILE", "Bo'sh fayl yuborildi.")

    head = upload.buf.read(16)
    upload.buf.seek(0)
    sniffed = _sniff_image(head)
    if sniffed is None:
        raise bad_request(
            "INVALID_IMAGE",
            "Faqat PNG, JPEG, GIF yoki WEBP rasm yuklash mumkin.",
        )

    declared = (upload.content_type or "").split(";")[0].strip().lower()
    if declared and declared not in ALLOWED_IMAGE_TYPES:
        raise bad_request(
            "UNSUPPORTED_MEDIA_TYPE",
            "Faqat PNG, JPEG, GIF yoki WEBP rasm yuklash mumkin.",
            content_type=declared,
        )
    if declared and ALLOWED_IMAGE_TYPES[declared] != sniffed:
        raise bad_request(
            "INVALID_IMAGE",
            "Fayl mazmuni ko'rsatilgan rasm formatiga mos kelmadi.",
            declared=declared,
            detected=sniffed,
        )

    # `asset_key` — kalitning faqat oxirgi, xavfsiz bo'lagi; prefiks URL ga chiqmaydi.
    asset_key = f"{uuid.uuid4().hex}.{sniffed}"
    await upload_bytes(
        f"presentations/{presentation_id}/{asset_key}", upload.buf, MIME_BY_EXT[sniffed]
    )

    # Presigned URL EMAS: u `R2_PRESIGN_TTL_SEC` dan keyin o'ladi va slayd
    # markdown'idagi rasm keyingi darsda ochilmay qoladi (v1.1.1 qarori).
    return AssetOut(url=stable_asset_url(presentation_id, asset_key))


@router.get(
    "/{presentation_id}/assets/{asset_key}",
    response_class=RedirectResponse,
    status_code=status.HTTP_307_TEMPORARY_REDIRECT,
    summary="Rasmni ko'rish (307 → presigned R2)",
)
async def get_asset(
    presentation_id: uuid.UUID,
    asset_key: str,
    db: AsyncSession = Depends(get_db),
) -> RedirectResponse:
    """Barqaror havolani har safar YANGI presigned R2 havolasiga yo'naltiradi.

    AVTORIZATSIYA — ataylab `Depends` YO'Q. Sabab: bu URL slayd markdown'iga
    `![rasm](url)` bo'lib tushadi va brauzerning `<img>` tegi `Authorization`
    sarlavhasini YUBORMAYDI — ya'ni `get_current_user` qo'yilsa rasm hech
    qachon ko'rinmaydi (aynan shu nuqson uchun bu endpoint yaratilgan).
    Himoya shu bilan ta'minlanadi:
      * `asset_key` — 128-bitli tasodifiy UUID (taxmin qilinmaydi), ya'ni
        "capability URL"; redirect oxirida turgan presigned URL ham aynan
        shunday modelda ishlaydi (havola borga ochiq);
      * kalit qat'iy shablon bilan tekshiriladi va R2 prefiksi SERVERDA
        yasaladi — boshqa prezentatsiya yoki `submissions/` ga chiqib
        bo'lmaydi;
      * rasm — dars materiali, shaxsiy ma'lumot emas (submission fayllari
        esa `GET /submissions/{id}/download-url` orqali, auth bilan beriladi).
    Agar lead qat'iyroq variantni xohlasa — `Depends(get_current_user)`
    qo'shish bir satr, lekin frontend rasmni `fetch` + `blob:` orqali
    yuklashi kerak bo'ladi.
    """
    if not ASSET_KEY_RE.fullmatch(asset_key):
        raise _asset_not_found()

    exists = (
        await db.execute(select(Presentation.id).where(Presentation.id == presentation_id))
    ).scalar_one_or_none()
    if exists is None:
        raise not_found("PRESENTATION_NOT_FOUND", "Prezentatsiya topilmadi.")

    # Kalit SERVERDA yasaladi — klient prefiksni boshqarmaydi.
    key = f"presentations/{presentation_id}/{asset_key}"
    if not await _asset_exists(key):
        raise _asset_not_found()

    url = await presigned_url(key, settings.R2_PRESIGN_TTL_SEC)
    return RedirectResponse(
        url,
        status_code=status.HTTP_307_TEMPORARY_REDIRECT,
        # Presigned havola TTL yarmida eskiradi — brauzer keshi undan oshmasin.
        headers={"Cache-Control": f"private, max-age={settings.R2_PRESIGN_TTL_SEC // 2}"},
    )
