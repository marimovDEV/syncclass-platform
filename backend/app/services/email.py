"""Email yuborish — ro'yxatdan o'tishda tasdiqlash kodi.

Nega stdlib `smtplib`: bitta kichik tranzaksion xat uchun qo'shimcha
kutubxona (aiosmtplib) kerak emas. Sinxron chaqiruv `run_in_threadpool`
bilan o'raladi — event loop bloklanmaydi.

Gmail bilan ishlatish: SMTP_USER = gmail manzil, SMTP_PASSWORD = App parol
(https://myaccount.google.com/apppasswords — 2 bosqichli tekshiruv yoqilgan
bo'lishi shart). Oddiy Gmail paroli ISHLAMAYDI.
"""

from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage

from starlette.concurrency import run_in_threadpool

from app.core.config import settings

log = logging.getLogger("syncclass.email")


def _send_sync(to: str, subject: str, body: str) -> None:
    msg = EmailMessage()
    msg["From"] = settings.SMTP_FROM or settings.SMTP_USER
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)

    with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=15) as smtp:
        smtp.starttls()
        smtp.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        smtp.send_message(msg)


async def send_email(to: str, subject: str, body: str) -> None:
    """Xat yuboradi; tarmoq/auth xatosi chaqiruvchiga exception bo'lib chiqadi."""
    await run_in_threadpool(_send_sync, to, subject, body)


async def send_verification_code(to: str, code: str) -> None:
    await send_email(
        to,
        subject=f"SyncClass tasdiqlash kodi: {code}",
        body=(
            f"Assalomu alaykum!\n\n"
            f"SyncClass da ro'yxatdan o'tish uchun tasdiqlash kodingiz: {code}\n\n"
            f"Kod 10 daqiqa amal qiladi. Agar bu siz bo'lmasangiz, xatni e'tiborsiz qoldiring."
        ),
    )
