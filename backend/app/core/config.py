"""Markazlashgan konfiguratsiya.

QAT'IY QOIDA: butun loyihada `os.environ` ga to'g'ridan-to'g'ri murojaat qilinmaydi.
Barcha sozlamalar faqat shu moduldagi `settings` obyekti orqali o'qiladi.
"""

import json
from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, computed_field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- Ilova ---
    APP_ENV: Literal["development", "staging", "production"] = "development"
    APP_NAME: str = "SyncClass"
    # Faqat lokal dev uchun. Prod da `.env` dan majburiy beriladi.
    SECRET_KEY: str = "dev-only-insecure-secret-change-me"  # noqa: S105
    JWT_ALGORITHM: Literal["HS256"] = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30
    FRONTEND_ORIGIN: str = "http://localhost:3000"
    BACKEND_PUBLIC_URL: str = "http://localhost:8000"
    LOG_LEVEL: str = "INFO"

    # --- PostgreSQL ---
    POSTGRES_USER: str = "syncclass"
    POSTGRES_PASSWORD: str = "syncclass"  # noqa: S105 — lokal dev konteyneri
    POSTGRES_DB: str = "syncclass"
    POSTGRES_HOST: str = "localhost"
    POSTGRES_PORT: int = 5432
    DATABASE_URL: str | None = None

    # --- Redis ---
    REDIS_URL: str = "redis://localhost:6379/0"

    # --- Google OAuth2 ---
    GOOGLE_CLIENT_ID: str = ""
    GOOGLE_CLIENT_SECRET: str = ""
    GOOGLE_REDIRECT_URI: str = "http://localhost:8000/api/v1/auth/google/callback"

    # --- Email (ro'yxatdan o'tishda tasdiqlash kodi) ---
    # Bo'sh bo'lsa tasdiqlash O'CHIQ: ro'yxatdan o'tish kodsiz ishlayveradi.
    # Gmail uchun: SMTP_USER = gmail manzil, SMTP_PASSWORD = App parol
    # (myaccount.google.com/apppasswords, oddiy parol EMAS).
    SMTP_HOST: str = "smtp.gmail.com"
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = ""  # bo'sh bo'lsa SMTP_USER ishlatiladi
    # Faqat shu email'lar TEACHER bo'lib ro'yxatdan o'tadi (AUDIT.md §C1).
    # `NoDecode` SHART: pydantic-settings murakkab tipni dotenv manbasida JSON deb
    # dekod qilishga urinadi va validatordan OLDIN yiqiladi. `NoDecode` bilan xom
    # satr bizning validatorimizga yetib keladi va vergul bilan ajratiladi.
    TEACHER_EMAIL_ALLOWLIST: Annotated[list[str], NoDecode] = Field(default_factory=list)

    # --- Storage (gibrid: R2 asosiy, Telegram zahira) ---
    STORAGE_PRIMARY: Literal["r2", "telegram"] = "r2"
    R2_ACCOUNT_ID: str = ""
    R2_ACCESS_KEY_ID: str = ""
    R2_SECRET_ACCESS_KEY: str = ""
    R2_BUCKET: str = "syncclass-submissions"
    R2_ENDPOINT: str = ""
    R2_PRESIGN_TTL_SEC: int = 900

    TELEGRAM_BACKUP_ENABLED: bool = False
    TELEGRAM_BOT_TOKEN: str = ""
    TELEGRAM_STORAGE_CHANNEL_ID: str = ""
    # Bot API `getFile` 20 MB dan katta faylni QAYTARIB BERMAYDI (AUDIT.md §A1).
    TELEGRAM_MAX_MB: int = 20

    # --- Upload himoyasi ---
    MAX_UPLOAD_MB: int = 25
    MAX_CONCURRENT_UPLOADS: int = 8
    ZIP_MAX_ENTRIES: int = 500
    ZIP_MAX_UNCOMPRESSED_MB: int = 20
    ZIP_MAX_RATIO: int = 100
    EXTRACT_MAX_FILE_CHARS: int = 200_000
    EXTRACT_MAX_TOTAL_CHARS: int = 1_000_000

    # --- AI Pre-Grader ---
    AI_PROVIDER: Literal["anthropic"] = "anthropic"
    ANTHROPIC_API_KEY: str = ""
    # Eng kuchli model default: soxta "AI ishlatgan" aybloviga yo'l qo'ymaslik uchun
    # sifat kritik (AUDIT.md §E2). Arzonroq modelga o'tish — `.env` orqali, markaz qarori.
    AI_MODEL: str = "claude-opus-5-5"
    AI_MAX_INPUT_CHARS: int = 60_000
    AI_TIMEOUT_SEC: int = 90

    # --- LiveKit (bir tomonlama ekran ulashish) ---
    LIVEKIT_URL: str = ""
    LIVEKIT_API_KEY: str = ""
    LIVEKIT_API_SECRET: str = ""

    # --- Real-time sozlamalari ---
    WS_HEARTBEAT_SEC: int = 25
    LIVE_CODE_THROTTLE_MS: int = 50
    MAX_CODE_CHARS: int = 20_000

    @field_validator("TEACHER_EMAIL_ALLOWLIST", mode="before")
    @classmethod
    def _split_emails(cls, v: object) -> object:
        """Vergul bilan ajratilgan satrni ham, JSON massivni ham qabul qiladi."""
        if isinstance(v, str):
            raw = v.strip()
            if raw.startswith("["):
                try:
                    raw_list = json.loads(raw)
                except json.JSONDecodeError:
                    raw_list = []
                return [str(e).strip().lower() for e in raw_list if str(e).strip()]
            return [e.strip().lower() for e in raw.split(",") if e.strip()]
        return v

    @computed_field  # type: ignore[prop-decorator]
    @property
    def sqlalchemy_url(self) -> str:
        if self.DATABASE_URL:
            return self.DATABASE_URL
        return (
            f"postgresql+asyncpg://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}"
            f"@{self.POSTGRES_HOST}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
        )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def max_upload_bytes(self) -> int:
        return self.MAX_UPLOAD_MB * 1024 * 1024

    @computed_field  # type: ignore[prop-decorator]
    @property
    def telegram_max_bytes(self) -> int:
        return self.TELEGRAM_MAX_MB * 1024 * 1024

    @computed_field  # type: ignore[prop-decorator]
    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.FRONTEND_ORIGIN.split(",") if o.strip()]

    @property
    def email_verification_enabled(self) -> bool:
        """SMTP sozlanmagan bo'lsa ro'yxatdan o'tish kodsiz ishlaydi (sayt yiqilmasin)."""
        return bool(self.SMTP_USER and self.SMTP_PASSWORD)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_dev(self) -> bool:
        return self.APP_ENV == "development"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
