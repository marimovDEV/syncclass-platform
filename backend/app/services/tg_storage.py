"""Telegram ZAHIRA saqlash + `arq` navbat yordamchilari (AUDIT.md §A1, §A2).

NEGA ZAHIRA, ASOSIY EMAS:
Bot API `sendDocument` 50 MB gacha yuklaydi, lekin `getFile` **20 MB** dan
katta faylni qaytarib bermaydi. Ya'ni 20-25 MB fayl yuklanadi, lekin hech
qachon ochilmaydi. Shuning uchun canonical manba — R2; Telegram faqat
`TELEGRAM_MAX_MB` (20) gacha arxiv nusxa.

FLOOD-CONTROL (§A2): bot bir chatga ~20 xabar/daqiqa yuboradi. Deadline
oldidan 100 o'quvchi bir vaqtda yuborsa `429` keladi. Shuning uchun:
  * zahira **sinxron emas** — `arq` navbati orqali (`max_jobs` worker tomonda);
  * `TelegramRetryAfter` ushlanadi va serverning `retry_after` i hurmat qilinadi;
  * muvaffaqiyatsizlik submission ni **buzmaydi** — `tg_backup_status=FAILED`,
    o'qituvchi faylni baribir R2 dan oladi.

ARQ TASK NOMLARI (worker `ai-grader-engineer` tomonidan ro'yxatdan o'tkaziladi):
  * `backup_to_telegram`  → shu moduldagi `backup_to_telegram_task(submission_id)`
  * `grade_submission`    → `app.services.ai_grader` (bu modul faqat navbatga qo'yadi)
"""

from __future__ import annotations

import asyncio
import io
import logging
import uuid
from typing import Any

from sqlalchemy import select

from app.core.config import settings
from app.core.errors import AppError, bad_request, not_found
from app.db.models import BackupStatus, Submission
from app.db.session import AsyncSessionLocal
from app.services import r2_storage

log = logging.getLogger("syncclass.telegram")

# --- Arq task nomlari (yagona haqiqat manbasi) -----------------------------

#: Telegram zahira taski — `worker.py` shu nom bilan ro'yxatdan o'tkazadi.
TELEGRAM_BACKUP_TASK: str = "backup_to_telegram"
#: AI pre-grader taski (`ai-grader-engineer` yozadi; biz faqat navbatga qo'yamiz).
AI_GRADE_TASK: str = "grade_submission"

#: Sendga urinishlar soni va boshlang'ich kutish (eksponensial backoff).
MAX_SEND_ATTEMPTS: int = 5
BACKOFF_BASE_SEC: float = 2.0
#: `retry_after` juda katta bo'lsa kutmaymiz — taskni FAILED qilamiz.
MAX_RETRY_AFTER_SEC: int = 120


# --- Konfiguratsiya --------------------------------------------------------


def missing_config() -> list[str]:
    missing: list[str] = []
    if not settings.TELEGRAM_BOT_TOKEN:
        missing.append("TELEGRAM_BOT_TOKEN")
    if not settings.TELEGRAM_STORAGE_CHANNEL_ID:
        missing.append("TELEGRAM_STORAGE_CHANNEL_ID")
    return missing


def is_configured() -> bool:
    """Token va kanal bormi."""
    return not missing_config()


def is_enabled() -> bool:
    """Zahira yoqilgan va sozlangan."""
    return settings.TELEGRAM_BACKUP_ENABLED and is_configured()


def fits_telegram(size_bytes: int) -> bool:
    """Fayl `getFile` chegarasiga sig'adimi (AUDIT.md §A1)."""
    return 0 < size_bytes <= settings.telegram_max_bytes


def _channel_id() -> int | str:
    """`-1001234567890` ko'rinishidagi ID butun songa, `@kanal` satr holida."""
    raw = settings.TELEGRAM_STORAGE_CHANNEL_ID.strip()
    try:
        return int(raw)
    except ValueError:
        return raw


# --- Bot (lazy) ------------------------------------------------------------


def _make_bot() -> Any:
    """`aiogram.Bot` yasaydi. Sirlar yo'q bo'lsa `AppError`.

    `aiogram` import ham lazy: sirlarsiz muhitda modul import paytida
    hech narsa yiqilmaydi.
    """
    missing = missing_config()
    if missing:
        raise AppError(
            503,
            "TELEGRAM_NOT_CONFIGURED",
            "Telegram zahira sozlanmagan.",
            {"missing": missing},
        )
    from aiogram import Bot
    from aiogram.client.default import DefaultBotProperties

    return Bot(
        token=settings.TELEGRAM_BOT_TOKEN,
        default=DefaultBotProperties(parse_mode=None),
    )


# --- Navbat (arq) ----------------------------------------------------------


async def get_arq_pool() -> Any:
    """`arq` Redis puli. Har chaqiruvda yangi pul — qisqa umrli, yopiladi."""
    from arq.connections import RedisSettings, create_pool

    return await create_pool(RedisSettings.from_dsn(settings.REDIS_URL))


async def enqueue_job(task_name: str, *args: Any) -> bool:
    """Navbatga qo'yadi. Redis yiqilsa ham so'rov buzilmaydi (best-effort).

    `True` — navbatga tushdi, `False` — tushmadi (log yoziladi).
    """
    pool = None
    try:
        pool = await get_arq_pool()
        await pool.enqueue_job(task_name, *args)
        return True
    except Exception as exc:  # navbat ixtiyoriy, so'rov oqimini buzmaydi
        log.warning("arq enqueue_job(%s) muvaffaqiyatsiz: %r", task_name, exc)
        return False
    finally:
        if pool is not None:
            try:
                await pool.aclose()
            except Exception:  # yopishdagi xato ahamiyatsiz
                log.debug("arq pool yopilmadi", exc_info=True)


async def enqueue_telegram_backup(submission_id: str) -> bool:
    """`backup_to_telegram` taskini navbatga qo'yadi."""
    return await enqueue_job(TELEGRAM_BACKUP_TASK, str(submission_id))


async def enqueue_ai_grading(submission_id: str) -> bool:
    """`grade_submission` taskini navbatga qo'yadi (AI grader kodini biz yozmaymiz)."""
    return await enqueue_job(AI_GRADE_TASK, str(submission_id))


# --- Yuborish --------------------------------------------------------------


async def send_document(
    data: bytes,
    file_name: str,
    caption: str | None = None,
) -> tuple[str, int]:
    """Kanalga hujjat yuboradi → `(file_id, message_id)`.

    `TelegramRetryAfter` da server aytgan vaqtni kutadi, boshqa tarmoq
    xatolarida eksponensial backoff bilan `MAX_SEND_ATTEMPTS` marta urinadi.
    """
    if not fits_telegram(len(data)):
        raise bad_request(
            "TELEGRAM_SIZE_LIMIT",
            f"Telegram zahirasi faqat {settings.TELEGRAM_MAX_MB} MB gacha "
            "fayllarni qaytarib bera oladi.",
            size_bytes=len(data),
            limit_bytes=settings.telegram_max_bytes,
        )

    from aiogram.exceptions import TelegramAPIError, TelegramRetryAfter
    from aiogram.types import BufferedInputFile

    bot = _make_bot()
    try:
        last_error: Exception | None = None
        for attempt in range(1, MAX_SEND_ATTEMPTS + 1):
            try:
                message = await bot.send_document(
                    chat_id=_channel_id(),
                    document=BufferedInputFile(data, filename=file_name),
                    caption=caption,
                    disable_notification=True,
                )
                document = message.document
                if document is None:  # pragma: no cover - Telegram javobi buzuq
                    raise AppError(
                        502,
                        "TELEGRAM_BACKUP_FAILED",
                        "Telegram hujjatni qabul qildi, lekin file_id qaytarmadi.",
                    )
                return document.file_id, message.message_id
            except TelegramRetryAfter as exc:
                last_error = exc
                wait = min(int(exc.retry_after) + 1, MAX_RETRY_AFTER_SEC)
                if int(exc.retry_after) > MAX_RETRY_AFTER_SEC:
                    log.warning("Telegram flood: retry_after=%ss — urinish to'xtatildi",
                                exc.retry_after)
                    break
                log.warning("Telegram flood: %s s kutamiz (urinish %d)", wait, attempt)
                await asyncio.sleep(wait)
            except TelegramAPIError as exc:
                last_error = exc
                if attempt == MAX_SEND_ATTEMPTS:
                    break
                wait = BACKOFF_BASE_SEC ** attempt
                log.warning("Telegram xatosi (%d/%d): %r — %.0f s", attempt,
                            MAX_SEND_ATTEMPTS, exc, wait)
                await asyncio.sleep(wait)
        raise AppError(
            502,
            "TELEGRAM_BACKUP_FAILED",
            "Telegram zahirasi muvaffaqiyatsiz tugadi.",
            {"error": repr(last_error) if last_error else None},
        )
    finally:
        await bot.session.close()


async def download_file_bytes(file_id: str) -> io.BytesIO:
    """`getFile` + yuklab olish → RAM. 20 MB chegarasi tekshiriladi."""
    from aiogram.exceptions import TelegramAPIError

    bot = _make_bot()
    try:
        try:
            file = await bot.get_file(file_id)
        except TelegramAPIError as exc:
            raise not_found(
                "FILE_UNAVAILABLE",
                "Telegram zahirasidan faylni olish imkoni bo'lmadi.",
            ) from exc
        if file.file_size and not fits_telegram(file.file_size):
            raise AppError(
                409,
                "TELEGRAM_SIZE_LIMIT",
                f"Telegram {settings.TELEGRAM_MAX_MB} MB dan katta faylni "
                "qaytarib bermaydi.",
                {"size_bytes": file.file_size},
            )
        if not file.file_path:  # pragma: no cover - Telegram javobi buzuq
            raise not_found("FILE_UNAVAILABLE", "Telegram fayl yo'lini bermadi.")
        stream = await bot.download_file(file.file_path)
        if stream is None:  # pragma: no cover
            raise not_found("FILE_UNAVAILABLE", "Telegram fayl mazmunini bermadi.")
        data = stream.read()
        return io.BytesIO(data)
    finally:
        await bot.session.close()


# --- Arq task --------------------------------------------------------------


async def backup_to_telegram_task(submission_id: str) -> None:
    """ARQ TASK (`backup_to_telegram`): submission faylini Telegram ga zahiralaydi.

    `worker.py` da shunday ro'yxatdan o'tkaziladi:

        from app.services.tg_storage import backup_to_telegram_task

        async def backup_to_telegram(ctx, submission_id: str) -> None:
            await backup_to_telegram_task(submission_id)

    IDEMPOTENT: `tg_backup_status == OK` bo'lsa darhol qaytadi.
    Hech qachon exception tashlamaydi — xato bo'lsa `FAILED` yoziladi,
    submission yaroqli qoladi (AUDIT.md §A2).
    """
    async with AsyncSessionLocal() as db:
        submission = await db.scalar(
            select(Submission).where(Submission.id == _as_uuid(submission_id))
        )
        if submission is None:
            log.warning("backup_to_telegram: submission %s topilmadi", submission_id)
            return
        if submission.tg_backup_status == BackupStatus.OK:
            return

        if not is_enabled():
            submission.tg_backup_status = BackupStatus.NONE
            await db.commit()
            log.info("Telegram zahira o'chirilgan/sozlanmagan — %s", submission_id)
            return
        if not fits_telegram(submission.file_size_bytes):
            submission.tg_backup_status = BackupStatus.NONE
            await db.commit()
            log.info(
                "Fayl Telegram chegarasidan katta (%d bayt) — zahira o'tkazib yuborildi",
                submission.file_size_bytes,
            )
            return
        if not submission.r2_object_key:
            submission.tg_backup_status = BackupStatus.FAILED
            await db.commit()
            log.warning("backup_to_telegram: %s uchun r2_object_key yo'q", submission_id)
            return

        try:
            buf = await r2_storage.download_bytes(submission.r2_object_key)
            caption = (
                f"submission={submission.id}\n"
                f"homework={submission.homework_id}\n"
                f"student={submission.student_id}\n"
                f"attempt={submission.attempt_no}\n"
                f"sha256={submission.content_sha256}"
            )
            file_id, message_id = await send_document(
                buf.getvalue(), submission.file_name, caption=caption
            )
        except Exception as exc:  # best-effort: submission yaroqli qoladi
            submission.tg_backup_status = BackupStatus.FAILED
            await db.commit()
            log.warning("Telegram zahira yiqildi (%s): %r", submission_id, exc)
            return

        submission.tg_file_id = file_id
        submission.tg_message_id = message_id
        submission.tg_backup_status = BackupStatus.OK
        await db.commit()
        log.info("Telegram zahira OK: submission=%s message=%s", submission_id, message_id)


def _as_uuid(value: str | uuid.UUID) -> uuid.UUID:
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


__all__ = [
    "AI_GRADE_TASK",
    "MAX_SEND_ATTEMPTS",
    "TELEGRAM_BACKUP_TASK",
    "backup_to_telegram_task",
    "download_file_bytes",
    "enqueue_ai_grading",
    "enqueue_job",
    "enqueue_telegram_backup",
    "fits_telegram",
    "get_arq_pool",
    "is_configured",
    "is_enabled",
    "missing_config",
    "send_document",
]
