"""`arq` background worker (AUDIT.md §E3).

`docker compose` da shunday ishga tushadi:

    arq app.worker.WorkerSettings

IKKI TASK:
  * `grade_submission`    — AI pre-grader (shu modul + `app.services.ai_grader`)
  * `backup_to_telegram`  — `storage-engineer` ning `tg_storage` funksiyasi

IDEMPOTENTLIK (AUDIT.md §E3, CONTRACTS.md §2.2):
Status o'tishi HAR DOIM atomar:

    UPDATE submissions SET status='READY_FOR_REVIEW', ...
    WHERE id = :id AND status = 'PENDING_AI' RETURNING id

`RETURNING` bo'sh qaytsa — demak boshqa worker (yoki o'sha taskning retry'i)
allaqachon yozgan; biz hech narsa yozmaymiz. Shuning uchun bir submission
ikki marta baholansa ham natija **bir marta** yoziladi.

AI yiqilsa → `AI_FAILED`. O'qituvchi baholashi **bloklanmaydi**: `final_score`
va `penalty_applied` ustunlariga bu worker hech qachon tegmaydi.

QIZIL CHIZIQ (AUDIT.md §E2): bu modul `penalty_applied` ni **hech qachon**
yozmaydi. U faqat o'qituvchining `POST /submissions/{id}/grade` chaqiruvida
yoziladi. `recommended_penalty` esa faqat tavsiya bo'lib `ai_review_summary`
matni ichida qoladi.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar

from arq import cron
from arq.connections import RedisSettings
from arq.cron import CronJob
from arq.worker import Function, func
from sqlalchemy import select, update

from app.core.config import settings
from app.core.logging import setup_logging
from app.db.models import Homework, Submission, SubmissionStatus
from app.db.session import AsyncSessionLocal
from app.schemas.ai import AiVerdict, GradedFile, GradeRequest
from app.services import ai_grader, tg_storage
from app.services.tg_storage import AI_GRADE_TASK, TELEGRAM_BACKUP_TASK

log = logging.getLogger("syncclass.worker")

#: Shu muddatdan oshgan `PENDING_AI` lar cron bilan qayta navbatga qo'yiladi.
STALE_PENDING_AFTER = timedelta(minutes=10)
#: Bir cron yugurishida nechta submission qayta navbatga qo'yiladi (flood himoyasi).
STALE_BATCH_LIMIT = 200


def _as_uuid(value: str | uuid.UUID) -> uuid.UUID:
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


def _now() -> datetime:
    return datetime.now(UTC)


# ---------------------------------------------------------------------------
# Atomar status o'tishi
# ---------------------------------------------------------------------------


async def claim_transition(
    db: Any,
    submission_id: uuid.UUID,
    new_status: SubmissionStatus,
    values: dict[str, Any],
) -> bool:
    """`PENDING_AI` dan `new_status` ga ATOMAR o'tish (CONTRACTS.md §2.2).

    `True` — biz yozdik; `False` — allaqachon boshqasi yozgan (idempotent).

    `values` ga `penalty_applied`, `final_score`, `graded_at` KIRITILMAYDI —
    ular o'qituvchining hududi (AUDIT.md §E2).
    """
    forbidden_keys = {"penalty_applied", "final_score", "teacher_comment", "graded_at"}
    overlap = forbidden_keys & set(values)
    if overlap:  # pragma: no cover - programmchi xatosini darhol ko'rsatadi
        raise RuntimeError(f"AI worker o'qituvchi ustunlariga yozmaydi: {sorted(overlap)}")

    result = await db.execute(
        update(Submission)
        .where(
            Submission.id == submission_id,
            Submission.status == SubmissionStatus.PENDING_AI,
        )
        .values(status=new_status, **values)
        .returning(Submission.id)
    )
    claimed = result.first() is not None
    await db.commit()
    return claimed


def build_review_summary(verdict: AiVerdict, homework_max_score: int) -> str:
    """`submissions.ai_review_summary` matni (o'zbekcha, o'qituvchi uchun)."""
    lines: list[str] = [verdict.summary.strip()]
    if verdict.strengths:
        lines += ["", "Kuchli tomonlari:"]
        lines += [f"• {s}" for s in verdict.strengths]
    if verdict.issues:
        lines += ["", "Kamchiliklari:"]
        lines += [f"• {s}" for s in verdict.issues]
    lines += ["", f"Tavsiya etilgan ball: {verdict.suggested_score} / {homework_max_score}"]
    if verdict.ai_suspected:
        # TAVSIYA, qo'llanmaydi. Jarimani faqat o'qituvchi yozadi (AUDIT.md §E2).
        lines += [
            "",
            f"AI gumoni: {verdict.ai_confidence_percent}% "
            f"(tavsiya etilgan jarima: {verdict.recommended_penalty} ball — "
            "AVTOMATIK QO'LLANMAYDI).",
            "Bu — ehtimollik, isbot emas. Ball kamaytirishdan oldin o'quvchi bilan gaplashing.",
        ]
    if verdict.injection_suspected:
        lines += [
            "",
            "Diqqat: topshiriq ichida tekshiruv tizimiga ko'rsatma berish urinishi aniqlandi.",
        ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# AI pre-grader taski
# ---------------------------------------------------------------------------


async def grade_submission_task(submission_id: str) -> str:
    """`grade_submission` taskining butun mantiqi (ctx siz — test qilish uchun).

    Qaytaradi: `"graded"` | `"ai_failed"` | `"skipped"` | `"not_found"`.
    Hech qachon exception tashlamaydi — AI yiqilsa `AI_FAILED` yoziladi.
    """
    sid = _as_uuid(submission_id)

    async with AsyncSessionLocal() as db:
        row = (
            await db.execute(
                select(Submission, Homework)
                .join(Homework, Homework.id == Submission.homework_id)
                .where(Submission.id == sid)
            )
        ).first()
        if row is None:
            log.warning("grade_submission: submission %s topilmadi", submission_id)
            return "not_found"
        submission: Submission = row[0]
        homework: Homework = row[1]

        # Tez yo'l: allaqachon baholangan/baholanayotgan bo'lsa LLM ni chaqirmaymiz
        # (xarajat nazorati, AUDIT.md §E4). Haqiqiy himoya — pastdagi atomar UPDATE.
        if submission.status != SubmissionStatus.PENDING_AI:
            log.info(
                "grade_submission: %s allaqachon %s — o'tkazib yuborildi",
                submission_id,
                submission.status.value,
            )
            return "skipped"

        payload = GradeRequest(
            submission_id=str(submission.id),
            homework_title=homework.title,
            homework_description=homework.description or "",
            max_score=homework.max_score,
            attempt_no=submission.attempt_no,
            extract_truncated=bool(submission.extract_truncated),
            files=[
                GradedFile(path=str(f.get("path", "?")), content=str(f.get("content", "")))
                for f in (submission.extracted_files or [])
                if isinstance(f, dict)
            ],
        )

        try:
            verdict = await ai_grader.grade(payload)
        except Exception as exc:  # AI yiqilishi o'qituvchini BLOKLAMAYDI (§E3)
            log.warning("AI grading yiqildi (submission=%s): %r", submission_id, exc)
            claimed = await claim_transition(
                db,
                sid,
                SubmissionStatus.AI_FAILED,
                {
                    "ai_review_summary": (
                        "AI tekshiruvi bajarilmadi (texnik xato). Iltimos, ishni "
                        "qo'lda baholang — bu o'quvchining aybi emas."
                    ),
                    "ai_suspected": False,
                    "ai_confidence_percent": 0,
                    "ai_evidence": [],
                    "ai_strengths": [],
                    "ai_issues": [],
                },
            )
            return "ai_failed" if claimed else "skipped"

        claimed = await claim_transition(
            db,
            sid,
            SubmissionStatus.READY_FOR_REVIEW,
            {
                "ai_suspected": verdict.ai_suspected,
                "ai_confidence_percent": verdict.ai_confidence_percent,
                "ai_review_summary": build_review_summary(verdict, homework.max_score),
                # `MutableList` EMAS — joyida o'zgartirish (`.append`) SQLAlchemy
                # tomonidan sezilmaydi. Shuning uchun BUTUN ro'yxat tayinlanadi
                # (`values` dict bilan yozish allaqachon shunday ishlaydi).
                "ai_strengths": list(verdict.strengths),
                "ai_issues": list(verdict.issues),
                "ai_evidence": verdict.evidence_as_jsonb(),
                "ai_injection_suspected": verdict.injection_suspected,
                "suggested_score": verdict.suggested_score,
                # `penalty_applied` ATAYLAB YO'Q — faqat o'qituvchi yozadi (§E2).
            },
        )
        if not claimed:
            log.info("grade_submission: %s natijasi allaqachon yozilgan", submission_id)
            return "skipped"
        log.info(
            "grade_submission OK: %s score=%s ai_suspected=%s injection=%s",
            submission_id,
            verdict.suggested_score,
            verdict.ai_suspected,
            verdict.injection_suspected,
        )
        return "graded"


async def requeue_stale_pending_task() -> int:
    """10 daqiqadan oshgan `PENDING_AI` larni qayta navbatga qo'yadi (§E3).

    Nega kerak: `enqueue` paytida Redis yiqilsa yoki worker job ni yo'qotsa,
    submission abadiy `PENDING_AI` da qolib ketardi.
    """
    cutoff = _now() - STALE_PENDING_AFTER
    async with AsyncSessionLocal() as db:
        ids = list(
            (
                await db.execute(
                    select(Submission.id)
                    .where(
                        Submission.status == SubmissionStatus.PENDING_AI,
                        Submission.submitted_at < cutoff,
                    )
                    .order_by(Submission.submitted_at)
                    .limit(STALE_BATCH_LIMIT)
                )
            )
            .scalars()
            .all()
        )

    requeued = 0
    for sid in ids:
        if await tg_storage.enqueue_job(AI_GRADE_TASK, str(sid)):
            requeued += 1
    if ids:
        log.info("Reconciliation: %d/%d PENDING_AI qayta navbatga qo'yildi", requeued, len(ids))
    return requeued


# ---------------------------------------------------------------------------
# arq task adapterlari (nomlar `tg_storage` dagi konstantalardan)
# ---------------------------------------------------------------------------


async def grade_submission(ctx: dict[str, Any], submission_id: str) -> str:
    """ARQ TASK `grade_submission`."""
    return await grade_submission_task(submission_id)


async def backup_to_telegram(ctx: dict[str, Any], submission_id: str) -> None:
    """ARQ TASK `backup_to_telegram` — `storage-engineer` ning tayyor funksiyasi."""
    await tg_storage.backup_to_telegram_task(submission_id)


async def requeue_stale_pending(ctx: dict[str, Any]) -> int:
    """CRON: yo'qolgan `PENDING_AI` larni qaytarish."""
    return await requeue_stale_pending_task()


async def on_startup(ctx: dict[str, Any]) -> None:
    setup_logging(settings.LOG_LEVEL)
    log.info(
        "SyncClass worker ishga tushdi: model=%s tasks=%s",
        settings.AI_MODEL,
        [AI_GRADE_TASK, TELEGRAM_BACKUP_TASK],
    )


async def on_shutdown(ctx: dict[str, Any]) -> None:
    log.info("SyncClass worker to'xtadi")


class WorkerSettings:
    """`arq app.worker.WorkerSettings` — docker-compose `worker` servisi."""

    functions: ClassVar[list[Function]] = [
        func(grade_submission, name=AI_GRADE_TASK, timeout=settings.AI_TIMEOUT_SEC * 3),
        func(backup_to_telegram, name=TELEGRAM_BACKUP_TASK, timeout=300),
    ]
    cron_jobs: ClassVar[list[CronJob]] = [
        # Har 5 daqiqada reconciliation (AUDIT.md §E3).
        cron(requeue_stale_pending, minute={0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55}),
    ]
    redis_settings = RedisSettings.from_dsn(settings.REDIS_URL)
    on_startup = staticmethod(on_startup)
    on_shutdown = staticmethod(on_shutdown)
    #: Deadline paytida Telegram flood bo'lmasin (AUDIT.md §A2).
    max_jobs = 5
    #: Idempotent bo'lgani uchun retry xavfsiz.
    max_tries = 3
    job_timeout = settings.AI_TIMEOUT_SEC * 3
    keep_result = 3600


__all__ = [
    "WorkerSettings",
    "backup_to_telegram",
    "build_review_summary",
    "claim_transition",
    "grade_submission",
    "grade_submission_task",
    "requeue_stale_pending",
    "requeue_stale_pending_task",
]
