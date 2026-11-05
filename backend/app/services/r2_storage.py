"""Cloudflare R2 (S3-mos) saqlash — ASOSIY (canonical) manba (AUDIT.md §A1).

Dizayn qoidalari:
  * `boto3` **sinxron**. Har bir tarmoq chaqiruvi `run_in_threadpool` da
    bajariladi, aks holda 25 MB yuklash paytida event loop muzlab qoladi.
  * Klient **lazy** yaratiladi: `R2_ACCESS_KEY_ID` bo'sh bo'lsa modul import
    paytida yiqilmaydi, faqat haqiqiy chaqiruvda `503 STORAGE_NOT_CONFIGURED`
    (`AppError`) qaytaradi. Shu sabab sirlarsiz muhitda ham ilova ko'tariladi.
  * Diskka hech narsa yozilmaydi: `put_object` to'g'ridan-to'g'ri `BytesIO` dan
    o'qiydi, `get_object` esa `BytesIO` ga yoziladi.

`content-engineer` shu moduldan faqat `upload_bytes()` va `presigned_url()`
ni import qiladi — bu ikki signatura barqaror.
"""

from __future__ import annotations

import io
import logging
import threading
import uuid
from typing import Any
from urllib.parse import quote

from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.errors import AppError, not_found

log = logging.getLogger("syncclass.r2")

#: `put_object` uchun default MIME.
DEFAULT_CONTENT_TYPE = "application/octet-stream"

_client: Any | None = None
_client_lock = threading.Lock()


# --- Konfiguratsiya --------------------------------------------------------


def endpoint_url() -> str:
    """R2 endpoint. `R2_ENDPOINT` bo'sh bo'lsa `R2_ACCOUNT_ID` dan yasaladi."""
    if settings.R2_ENDPOINT:
        return settings.R2_ENDPOINT.rstrip("/")
    if settings.R2_ACCOUNT_ID:
        return f"https://{settings.R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
    return ""


def missing_config() -> list[str]:
    """To'ldirilmagan majburiy sozlamalar ro'yxati."""
    missing: list[str] = []
    if not settings.R2_ACCESS_KEY_ID:
        missing.append("R2_ACCESS_KEY_ID")
    if not settings.R2_SECRET_ACCESS_KEY:
        missing.append("R2_SECRET_ACCESS_KEY")
    if not settings.R2_BUCKET:
        missing.append("R2_BUCKET")
    if not endpoint_url():
        missing.append("R2_ENDPOINT")
    return missing


def is_configured() -> bool:
    """R2 ishlashga tayyormi (sirlar bormi)."""
    return not missing_config()


def storage_not_configured(missing: list[str]) -> AppError:
    return AppError(
        503,
        "STORAGE_NOT_CONFIGURED",
        "Fayl saqlash xizmati sozlanmagan. Administratorga murojaat qiling.",
        {"missing": missing},
    )


def _require_config() -> None:
    missing = missing_config()
    if missing:
        raise storage_not_configured(missing)


def get_client() -> Any:
    """Bitta jarayon uchun bitta `boto3` S3 klienti (thread-safe, lazy).

    `boto3.client()` tarmoqqa chiqmaydi — faqat sozlamalarni tekshiradi,
    shuning uchun bu chaqiruv bloklovchi emas.
    """
    global _client
    _require_config()
    if _client is not None:
        return _client
    with _client_lock:
        if _client is None:
            import boto3
            from botocore.config import Config

            _client = boto3.session.Session().client(
                "s3",
                endpoint_url=endpoint_url(),
                aws_access_key_id=settings.R2_ACCESS_KEY_ID,
                aws_secret_access_key=settings.R2_SECRET_ACCESS_KEY,
                # R2 da region "auto"; SigV4 majburiy.
                region_name="auto",
                config=Config(
                    signature_version="s3v4",
                    s3={"addressing_style": "path"},
                    retries={"max_attempts": 3, "mode": "standard"},
                    connect_timeout=10,
                    read_timeout=60,
                ),
            )
    return _client


def reset_client() -> None:
    """Klientni tashlaydi (testlar va sozlama o'zgarishi uchun)."""
    global _client
    with _client_lock:
        _client = None


# --- Kalit yasash ----------------------------------------------------------


def build_submission_key(
    homework_id: Any,
    student_id: Any,
    attempt_no: int,
    file_name: str,
) -> str:
    """Submission obyekt kaliti.

    Shablon: `submissions/{homework_id}/{student_id}/{attempt_no}-{rand}-{nom}`
    Tasodifiy bo'lak — bir xil `attempt_no` bilan parallel urinishda
    obyektlar bir-birini ustiga yozmasligi uchun.
    """
    suffix = uuid.uuid4().hex[:8]
    safe_name = file_name.replace("/", "_").replace("\\", "_")
    return f"submissions/{homework_id}/{student_id}/{attempt_no}-{suffix}-{safe_name}"


def build_asset_key(presentation_id: Any, file_name: str) -> str:
    """Prezentatsiya rasmi uchun kalit (`content-engineer` ishlatadi)."""
    suffix = uuid.uuid4().hex[:8]
    safe_name = file_name.replace("/", "_").replace("\\", "_")
    return f"assets/{presentation_id}/{suffix}-{safe_name}"


# --- Sinxron ichki amallar -------------------------------------------------


def _sync_upload(key: str, data: bytes, content_type: str, file_name: str | None) -> str:
    client = get_client()
    extra: dict[str, Any] = {
        "Bucket": settings.R2_BUCKET,
        "Key": key,
        "Body": data,
        "ContentType": content_type or DEFAULT_CONTENT_TYPE,
    }
    if file_name:
        # RFC 5987: nolotin nomlar ham to'g'ri yuklab olinadi.
        extra["ContentDisposition"] = (
            f"attachment; filename*=UTF-8''{quote(file_name, safe='')}"
        )
    client.put_object(**extra)
    return key


def _sync_presign(key: str, ttl: int) -> str:
    client = get_client()
    return client.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.R2_BUCKET, "Key": key},
        ExpiresIn=ttl,
    )


def _sync_delete(key: str) -> None:
    client = get_client()
    client.delete_object(Bucket=settings.R2_BUCKET, Key=key)


def _sync_download(key: str) -> bytes:
    from botocore.exceptions import ClientError

    client = get_client()
    try:
        response = client.get_object(Bucket=settings.R2_BUCKET, Key=key)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in {"NoSuchKey", "404", "NotFound"}:
            raise not_found("FILE_UNAVAILABLE", "Fayl saqlashda topilmadi.") from exc
        raise
    body = response["Body"]
    try:
        return body.read()
    finally:
        body.close()


# --- Ommaviy async API -----------------------------------------------------


async def upload_bytes(
    key: str,
    buf: io.BytesIO,
    content_type: str = DEFAULT_CONTENT_TYPE,
    *,
    file_name: str | None = None,
) -> str:
    """RAM dagi buferni R2 ga yuklaydi va **kalitni** qaytaradi.

    BARQAROR SIGNATURA (`content-engineer` import qiladi):
        `await upload_bytes(key, buf, content_type) -> str`
    """
    pos = buf.tell()
    buf.seek(0)
    data = buf.read()
    buf.seek(pos)
    await run_in_threadpool(_sync_upload, key, data, content_type, file_name)
    log.info("r2.upload key=%s bytes=%d", key, len(data))
    return key


async def presigned_url(key: str, ttl: int | None = None) -> str:
    """Vaqtincha (`ttl` sekund) yuklab olish havolasi.

    BARQAROR SIGNATURA (`content-engineer` import qiladi):
        `await presigned_url(key, ttl) -> str`
    """
    seconds = settings.R2_PRESIGN_TTL_SEC if ttl is None else int(ttl)
    return await run_in_threadpool(_sync_presign, key, seconds)


async def delete(key: str) -> None:
    """Obyektni o'chiradi (idempotent — yo'q kalit ham xato bermaydi)."""
    await run_in_threadpool(_sync_delete, key)
    log.info("r2.delete key=%s", key)


async def download_bytes(key: str) -> io.BytesIO:
    """Obyektni RAM ga yuklab oladi (Telegram zahirasi va proxy uchun)."""
    data = await run_in_threadpool(_sync_download, key)
    return io.BytesIO(data)


__all__ = [
    "DEFAULT_CONTENT_TYPE",
    "build_asset_key",
    "build_submission_key",
    "delete",
    "download_bytes",
    "endpoint_url",
    "get_client",
    "is_configured",
    "missing_config",
    "presigned_url",
    "reset_client",
    "storage_not_configured",
    "upload_bytes",
]
