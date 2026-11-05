"""SyncClass API — kirish nuqtasi.

KONTRAKT: har bir `app/api/*.py` va `app/ws/routes.py` moduli
`router: APIRouter` nomli obyektni eksport qilishi SHART.
"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from redis.asyncio import Redis
from sqlalchemy import text
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api import auth, groups, homeworks, presentations, rooms, users
from app.core.config import settings
from app.core.logging import RequestIdMiddleware, setup_logging
from app.db.session import engine
from app.ws import routes as ws_routes
from app.ws.manager import manager

log = logging.getLogger("syncclass.main")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    setup_logging(settings.LOG_LEVEL)
    app.state.redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    await app.state.redis.ping()
    log.info("SyncClass ishga tushdi (%s)", settings.APP_ENV)
    try:
        yield
    finally:
        # WS listener Redis ulanishidan OLDIN to'xtatiladi.
        await manager.stop()
        await app.state.redis.aclose()
        await engine.dispose()
        log.info("SyncClass to'xtadi")


app = FastAPI(
    title=f"{settings.APP_NAME} API",
    version="1.1.0",
    docs_url="/docs",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

app.add_middleware(RequestIdMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID"],
)

API = "/api/v1"
app.include_router(auth.router, prefix=f"{API}/auth", tags=["auth"])
app.include_router(groups.router, prefix=f"{API}/groups", tags=["groups"])
app.include_router(presentations.router, prefix=f"{API}/presentations", tags=["presentations"])
app.include_router(rooms.router, prefix=API, tags=["rooms"])
app.include_router(homeworks.router, prefix=API, tags=["homeworks"])
app.include_router(users.router, prefix=f"{API}/users", tags=["users"])
app.include_router(ws_routes.router, tags=["websocket"])


# ---------------------------------------------------------------------------
# Yagona xato konverti (CONTRACTS.md §4 va §5.1)
#
# `app.core.errors.AppError` allaqachon to'g'ri shaklda beradi, lekin Starlette
# o'zi ko'taradigan xatolar (marshrut topilmadi, metod ruxsat etilmagan) va
# Pydantic validatsiyasi `{"detail": "Not Found"}` kabi SATR qaytaradi.
# Frontend esa `detail.code` ga tayanadi — shuning uchun hammasini bir shaklga keltiramiz.
# ---------------------------------------------------------------------------

_STATUS_CODES: dict[int, str] = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    413: "FILE_TOO_LARGE",
    415: "UNSUPPORTED_MEDIA_TYPE",
    422: "VALIDATION_ERROR",
    429: "RATE_LIMITED",
    500: "INTERNAL_ERROR",
    503: "SERVICE_UNAVAILABLE",
}


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    detail = exc.detail
    # `AppError` dan kelgan to'g'ri konvertni qayta o'ramaymiz.
    if isinstance(detail, dict) and "code" in detail:
        payload = detail
    else:
        payload = {
            "code": _STATUS_CODES.get(exc.status_code, "HTTP_ERROR"),
            "message": str(detail) if detail else "So'rovni bajarib bo'lmadi.",
            "fields": {},
        }
    return JSONResponse({"detail": payload}, status_code=exc.status_code,
                        headers=getattr(exc, "headers", None))


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Pydantic xatolarini `fields` lug'atiga aylantiradi: {"maydon": "sabab"}."""
    fields: dict[str, str] = {}
    for error in exc.errors():
        location = [str(part) for part in error.get("loc", ()) if part not in ("body", "query")]
        fields[".".join(location) or "body"] = str(error.get("msg", "noto'g'ri qiymat"))
    return JSONResponse(
        {
            "detail": {
                "code": "VALIDATION_ERROR",
                "message": "Yuborilgan ma'lumotlar noto'g'ri.",
                "fields": fields,
            }
        },
        status_code=422,
    )


@app.get("/healthz", include_in_schema=False)
async def healthz() -> dict[str, str]:
    """Konteyner tirikligi — tashqi bog'liqliklarni tekshirmaydi."""
    return {"status": "ok"}


@app.get("/readyz", include_in_schema=False)
async def readyz() -> JSONResponse:
    """Postgres va Redis haqiqatan javob berayotganini tekshiradi."""
    checks: dict[str, str] = {}
    ok = True
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        checks["postgres"] = "ok"
    except Exception as exc:
        checks["postgres"] = f"error: {exc.__class__.__name__}"
        ok = False
    try:
        await app.state.redis.ping()
        checks["redis"] = "ok"
    except Exception as exc:
        checks["redis"] = f"error: {exc.__class__.__name__}"
        ok = False
    return JSONResponse({"status": "ok" if ok else "degraded", "checks": checks},
                        status_code=200 if ok else 503)
