# syntax=docker/dockerfile:1.7
# SyncClass backend — FastAPI + Uvicorn (va shu image'dan `arq` worker ham ishlaydi).
# Multi-stage: `builder` da wheel'lar yig'iladi, `runtime` da faqat venv qoladi.

# ---------------------------------------------------------------- builder ----
FROM python:3.12-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

# asyncpg/cryptography/pillow uchun kompilyatsiya vositalari (runtime'ga ketmaydi).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      libffi-dev \
      libjpeg-dev \
      zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /app
COPY requirements.txt ./
RUN pip install --upgrade pip setuptools wheel \
 && pip install -r requirements.txt

# ---------------------------------------------------------------- runtime ----
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    PATH="/opt/venv/bin:${PATH}" \
    TMPDIR=/tmp \
    APP_PORT=8000 \
    # /app non-root `appuser` uchun yozilmaydi (xavfsizlik). Vositalarning keshi
    # /tmp ga (compose'da tmpfs = RAM) yo'naltiriladi, aks holda `ruff` yiqiladi:
    #   error: Failed to initialize cache at /app/.ruff_cache: Permission denied
    RUFF_CACHE_DIR=/tmp/.ruff_cache \
    PYTEST_ADDOPTS="-p no:cacheprovider"

# `libpq` kerak emas (asyncpg sof Python/C, libpq'ga bog'liq emas),
# lekin `curl` konteyner ichidagi diagnostika uchun foydali.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 appuser \
 && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin appuser

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY --chown=appuser:appuser . /app

# `/tmp` compose'da tmpfs (RAM disk) — AUDIT.md §A3: Starlette spool fayllari
# diskka tegmasin. Shu yerda papkani egasi bilan tayyorlab qo'yamiz.
RUN mkdir -p /tmp && chown appuser:appuser /tmp

USER appuser

EXPOSE 8000

# `/healthz` tashqi bog'liqliklarni tekshirmaydi — konteyner tirikligi uchun aynan shu kerak.
HEALTHCHECK --interval=10s --timeout=5s --start-period=45s --retries=6 \
  CMD python -c "import sys,urllib.request;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=4).status==200 else 1)"

# AUDIT.md §H3: migratsiya konteyner startida. So'ng `--proxy-headers` bilan uvicorn
# (Nginx orqasida turgani uchun X-Forwarded-* headerlariga ishonamiz).
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*' --no-server-header"]
