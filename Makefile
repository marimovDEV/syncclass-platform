# SyncClass — lokal dev uchun buyruqlar (AUDIT.md §J1: `docker compose up` bilan ishga tushadi).
#   make          -> yordam
#   make up       -> noldan to'liq ko'tarish
# Har bir target .env mavjudligini kafolatlaydi (yo'q bo'lsa .env.example dan nusxa oladi).

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
DC := docker compose

# S=<servis> bilan ko'p target bitta servisga yo'naltiriladi (masalan: make logs S=backend)
S ?=
# NC=1 bo'lsa build keshsiz ketadi
NC ?=

.DEFAULT_GOAL := help
.PHONY: help up down logs build migrate seed shell psql redis-cli test lint \
        loadtest loadtest-force verify-zero-disk reset health config

# --------------------------------------------------------------------- .env ---
.env:
	@cp .env.example .env
	@echo "✅ .env yaratildi (.env.example dan). Sirlarni (GOOGLE_*, R2_*, ANTHROPIC_API_KEY) to'ldir."

# --------------------------------------------------------------------- help ---
help:
	@echo ""
	@echo "  SyncClass — mavjud buyruqlar"
	@echo ""
	@echo "  make up                 Noldan ko'tarish: build -> up -> migrate -> seed -> URL lar"
	@echo "  make down               Servislarni to'xtatish (ma'lumot saqlanadi)"
	@echo "  make logs               Loglar (follow). Bitta servis: make logs S=backend"
	@echo "  make build              Image larni qurish. Keshsiz: make build NC=1"
	@echo "  make migrate            alembic upgrade head"
	@echo "  make seed               Dev ma'lumotlari (scripts/seed.py)"
	@echo "  make shell              Backend konteynerida bash. Boshqasi: make shell S=frontend"
	@echo "  make psql               Postgres psql konsoli"
	@echo "  make redis-cli          Redis CLI"
	@echo "  make test               pytest (backend)"
	@echo "  make lint               ruff (backend) + tsc --noEmit (frontend)"
	@echo "  make loadtest           30 ta parallel WS klient yuklama testi (DoD #2)."
	@echo "                          Jonli /0 ga yozadi -> tasdiqlash so'raydi."
	@echo "  make loadtest-force     Shu test, tasdiqlashsiz (CI / avtomatik o'lchov)"
	@echo "  make verify-zero-disk   Fayl diskka yozilmasligini isbotlash (AUDIT §A3, DoD #3)"
	@echo "  make health             Stack holatini tekshirish"
	@echo "  make config             docker compose config — compose faylini tekshirish"
	@echo "  make reset              HAMMASINI o'chirish: konteyner + volume + image"
	@echo ""

# ----------------------------------------------------------------- hayot sikli ---
up: .env
	@./scripts/dev_up.sh

down:
	$(DC) down --remove-orphans

logs: .env
	$(DC) logs -f --tail=200 $(S)

build: .env
	$(DC) build $(if $(NC),--no-cache,)

config: .env
	$(DC) config

# ------------------------------------------------------------------ ma'lumot ---
migrate: .env
	$(DC) exec -T backend alembic upgrade head
	@$(DC) exec -T backend alembic current

# seed.py `Path(__file__)` ishlatadi -> stdin orqali uzatilmaydi, `docker cp` esa
# /tmp tmpfs mount ostiga tushadi. Shuning uchun compose ./scripts ni :ro mount qiladi.
seed: .env
	@test -f scripts/seed.py || { \
	  echo "XATO: scripts/seed.py yo'q (CONTRACTS.md §0 — db-architect agenti yozadi)."; \
	  exit 1; }
	$(DC) exec -T -w /app backend python /scripts/seed.py

# Foydalanuvchi/baza nomi postgres konteynerining O'ZIDAGI env dan olinadi.
psql: .env
	$(DC) exec postgres sh -lc 'exec psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'

redis-cli: .env
	$(DC) exec redis redis-cli

# ------------------------------------------------------------------- ishlash ---
shell: .env
	$(DC) exec $(if $(S),$(S),backend) sh -lc 'command -v bash >/dev/null && exec bash || exec sh'

# ---------------------------------------------------------------- sifat nazorati ---
# Testlar Redis'ni `flushdb()` bilan TO'LIQ tozalaydi (tests/test_auth_guards.py),
# Redis esa bu loyihada xona holatining yagona manbasi (AUDIT §B2) — ya'ni dev DB da
# test yugurtirish JONLI darslarning holatini o'chiradi.
# Shuning uchun REDIS_URL shu yerda QATTIQ yozilgan: `.env` dan OLINMAYDI.
# REDIS_TEST_DB ni o'zgartirish mumkin, lekin u hech qachon ilova DB si (0) bo'lmasin.
REDIS_TEST_DB := 15

test: .env
	@if [ "$(REDIS_TEST_DB)" = "0" ]; then \
	  echo "XATO: REDIS_TEST_DB=0 — bu ilova DB si, testlar uni flushdb bilan o'chiradi."; \
	  exit 1; fi
	$(DC) exec -T -w /app \
	  -e REDIS_URL=redis://redis:6379/$(REDIS_TEST_DB) \
	  backend python -m pytest -q tests

# `ruff check` BLOKLAYDI (konfig: backend/pyproject.toml), format esa ogohlantiradi.
lint: .env
	@echo "==> ruff (backend)"
	$(DC) exec -T -w /app backend ruff check app tests
	@echo "==> ruff format --check (ogohlantirish, bloklamaydi)"
	-@$(DC) exec -T -w /app backend ruff format --check app tests
	@echo "==> tsc --noEmit (frontend)"
	@if [ ! -f frontend/package.json ]; then \
	  echo "OGOHLIK: frontend/package.json yo'q (frontend-core agenti yozadi) — o'tkazib yuborildi."; \
	 elif command -v npx >/dev/null 2>&1; then \
	  cd frontend \
	    && { [ -d node_modules ] || npm install --no-audit --no-fund; } \
	    && npx --yes tsc --noEmit; \
	 else \
	  echo "   (hostda Node yo'q — konteynerda ishlatamiz)"; \
	  docker run --rm -v "$$PWD/frontend:/app" -v /app/node_modules -w /app node:22-alpine \
	    sh -lc 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund; npx --yes tsc --noEmit'; \
	 fi

# ----------------------------------------------------------------- tekshiruvlar ---
health: .env
	@./scripts/healthcheck.sh

verify-zero-disk: .env
	@./scripts/verify_zero_disk.sh

# Yuklama testi HAQIQIY ilovaga uriladi, ya'ni Redis ning ILOVA DB siga (/0) yozadi:
# vaqtincha xona ochiladi, 30 ta WS klient ulanadi, 250 ta event broadcast qilinadi.
# `make test` dan farqi shunda — uni izolyatsiya qilib bo'lmaydi, maqsadi aynan
# jonli yo'lni o'lchash (DoD #2). Shuning uchun interaktiv tasdiqlash so'raladi.
#
# So'rovni o'tkazib yuborish (CI, avtomatik o'lchov):
#   CI=1 make loadtest   ·   FORCE=1 make loadtest   ·   make loadtest-force
loadtest: .env
	@test -f scripts/loadtest_ws.py || { \
	  echo "XATO: scripts/loadtest_ws.py yo'q (AUDIT §I6 — realtime-engineer agenti yozadi)."; \
	  exit 1; }
	@if [ -n "$(CI)$(FORCE)" ]; then \
	  echo "==> tasdiqlash o'tkazib yuborildi (CI/FORCE belgilangan)"; \
	 elif [ ! -t 0 ]; then \
	  echo ""; \
	  echo "XATO: interaktiv terminal yo'q, tasdiqlash so'rab bo'lmaydi."; \
	  echo "Avtomatik yugurtirish uchun: CI=1 make loadtest  (yoki make loadtest-force)"; \
	  echo ""; \
	  exit 1; \
	 else \
	  echo ""; \
	  echo "  ⚠️  OGOHLIK — yuklama testi JONLI ma'lumotga yozadi"; \
	  echo ""; \
	  echo "  Nima bo'ladi:"; \
	  echo "    · Redis ning ILOVA DB siga (/0) yoziladi — test DB siga EMAS."; \
	  echo "    · Vaqtincha dars xonasi ochiladi, 30 ta WS klient ulanadi,"; \
	  echo "      250 ta event broadcast qilinadi, so'ng xona ENDED qilinadi."; \
	  echo "    · Postgres ga sessiya + davomat yozuvlari tushadi."; \
	  echo ""; \
	  echo "  Xavf:"; \
	  echo "    Hozir HAQIQIY dars ketayotgan bo'lsa — jonli xonalarning holati"; \
	  echo "    (slayd indeksi, jonli kod, quiz, davomat) buzilishi mumkin."; \
	  echo "    Redis bu loyihada kesh emas, xona holatining yagona manbasi."; \
	  echo ""; \
	  echo "  Nima qilish kerak:"; \
	  echo "    · Dars ketayotgan bo'lsa — YUGURTIRMANG, dars tugashini kuting."; \
	  echo "    · Toza muhitda o'lchash uchun: make reset && make up && make loadtest"; \
	  echo ""; \
	  read -r -p "  Davom etasizmi? [yes/N] " ans; \
	  [ "$$ans" = "yes" ] || { echo "  Bekor qilindi."; exit 1; }; \
	 fi
	$(DC) exec -T -w /app backend python /scripts/loadtest_ws.py

# So'rovsiz variant — `qa-integrator` va avtomatik o'lchovlar uchun.
loadtest-force: .env
	@$(MAKE) --no-print-directory loadtest FORCE=1

# ---------------------------------------------------------------------- reset ---
reset:
	@echo "⚠️  Bu konteynerlar, VOLUME lar (baza!) va image larni o'chiradi."
	@read -r -p "Davom etasizmi? [yes/N] " ans; [ "$$ans" = "yes" ] || { echo "Bekor qilindi."; exit 1; }
	$(DC) down --remove-orphans --volumes --rmi local
	@echo "Tozalandi. Qayta ko'tarish: make up"
