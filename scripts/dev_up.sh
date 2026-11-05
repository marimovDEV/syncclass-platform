#!/usr/bin/env bash
# SyncClass — noldan to'liq ko'tarish: .env -> build -> up -> migrate -> seed -> URL lar.
# Ishlatish:  ./scripts/dev_up.sh          (odatiy)
#             ./scripts/dev_up.sh --fresh  (volume'larni ham o'chirib, toza boshlash)
#             ./scripts/dev_up.sh --no-seed
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FRESH=0
SEED=1
for arg in "$@"; do
  case "$arg" in
    --fresh)   FRESH=1 ;;
    --no-seed) SEED=0 ;;
    -h|--help)
      echo "Ishlatish: $0 [--fresh] [--no-seed]"
      exit 0 ;;
    *) echo "Noma'lum argument: $arg" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else
  C_OK=''; C_WARN=''; C_ERR=''; C_B=''; C_0=''
fi
step() { printf '\n%s==>%s %s%s%s\n' "$C_OK" "$C_0" "$C_B" "$*" "$C_0"; }
warn() { printf '%s[ogohlik]%s %s\n' "$C_WARN" "$C_0" "$*"; }
die()  { printf '%s[xato]%s %s\n' "$C_ERR" "$C_0" "$*" >&2; exit 1; }

DC="docker compose"
command -v docker >/dev/null 2>&1 || die "docker topilmadi. Docker Desktop'ni ishga tushir."
docker info >/dev/null 2>&1 || die "Docker demoni javob bermayapti. Docker Desktop ishlayaptimi?"

# ---------------------------------------------------------------- 1. .env ----
step "1/7  .env tekshirilayapti"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "    .env yaratildi (.env.example dan nusxa)."
  warn "Sirlar bo'sh: GOOGLE_CLIENT_ID/SECRET, R2_*, ANTHROPIC_API_KEY, LIVEKIT_*."
  warn "Ularni to'ldirmasa ham tizim ko'tariladi, lekin tegishli funksiyalar o'chiq bo'ladi."
else
  echo "    .env allaqachon bor — tegilmadi."
fi
# .env.example da bor, lekin .env da yo'q kalitlarni ogohlantirib o'tamiz.
MISSING="$(comm -23 \
  <(grep -oE '^[A-Z][A-Z0-9_]*=' .env.example | tr -d '=' | sort -u) \
  <(grep -oE '^[A-Z][A-Z0-9_]*=' .env         | tr -d '=' | sort -u) | tr '\n' ' ')"
[ -n "${MISSING// /}" ] && warn ".env da yetishmayotgan kalitlar: $MISSING"

# .env dan bitta kalitni o'qish (fayl oddiy KEY=VALUE — `source` qilmaymiz).
env_get() { # $1=kalit  $2=default
  local v
  v="$(grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"'"' )"
  printf '%s' "${v:-$2}"
}

HOST_HTTP_PORT="$(env_get HOST_HTTP_PORT 80)"
HOST_FRONTEND_PORT="$(env_get HOST_FRONTEND_PORT 3000)"
HOST_API_PORT="$(env_get HOST_API_PORT 8000)"
HOST_POSTGRES_PORT="$(env_get HOST_POSTGRES_PORT 5432)"
HOST_REDIS_PORT="$(env_get HOST_REDIS_PORT 6379)"

# ------------------------------------------------------- 1b. port bandligi ----
step "1b/7  Host portlari bo'shligini tekshirish"
port_busy() { # $1=port -> 0 agar BAND
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
  else
    return 1   # tekshirib bo'lmadi — davom etamiz
  fi
}
BUSY=""
# Bizning konteynerlarimiz allaqachon shu portni ushlab turgan bo'lishi mumkin —
# ular 2-qadamda to'xtatiladi, shuning uchun ularni band deb hisoblamaymiz.
OURS="$($DC ps -q 2>/dev/null | tr '\n' ' ')"
for pair in "HTTP:$HOST_HTTP_PORT" "FRONTEND:$HOST_FRONTEND_PORT" "API:$HOST_API_PORT" \
            "POSTGRES:$HOST_POSTGRES_PORT" "REDIS:$HOST_REDIS_PORT"; do
  name="${pair%%:*}"; port="${pair#*:}"
  if port_busy "$port"; then
    if [ -n "${OURS// /}" ] && docker inspect --format '{{json .NetworkSettings.Ports}}' $OURS 2>/dev/null \
         | grep -q "\"HostPort\":\"$port\""; then
      echo "    $name ($port) — bizning eski konteynerimizda, 2-qadamda bo'shatiladi."
    else
      BUSY="$BUSY $name=$port"
    fi
  else
    echo "    $name ($port) — bo'sh."
  fi
done
if [ -n "${BUSY// /}" ]; then
  warn "Quyidagi host portlari BAND:$BUSY"
  warn "Kim ushlab turganini ko'rish:  lsof -nP -iTCP:<port> -sTCP:LISTEN"
  die ".env dagi tegishli HOST_*_PORT qiymatini bo'sh portga o'zgartir va qaytadan ishga tushir."
fi

# -------------------------------------------------------------- 2. fresh? ----
if [ "$FRESH" -eq 1 ]; then
  step "2/7  --fresh: konteyner va volume'lar o'chirilayapti"
  $DC down --remove-orphans --volumes
else
  step "2/7  Eski konteynerlar to'xtatilayapti (volume'lar saqlanadi)"
  $DC down --remove-orphans
fi

# --------------------------------------------------------------- 3. config ----
step "3/7  docker compose config tekshiruvi"
$DC config --quiet
echo "    compose fayli yaroqli."

# ---------------------------------------------------------------- 4. build ----
step "4/7  Image'lar qurilayapti (backend, frontend)"
$DC build

# ------------------------------------------------------------------- 5. up ----
step "5/7  Servislar ko'tarilayapti (healthcheck kutiladi)"
UP_FAILED=0
if ! $DC up -d --wait --wait-timeout 300; then
  UP_FAILED=1
  warn "Kamida bitta servis healthy bo'lmadi. Quyida holat va loglar ko'rsatiladi."
  warn "Eng ko'p uchraydigan sabab: tegishli agent kodi hali yozilmagan"
  warn "(masalan \`app/worker.py\` yo'q bo'lsa worker ko'tarilmaydi)."
fi

# -------------------------------------------------------------- 6. migrate ----
# Backend entrypoint migratsiyani o'zi bajaradi (AUDIT.md §H3).
# Shu yerda holatni tasdiqlab, log'ga chop etamiz.
step "6/7  Migratsiya holati"
if $DC exec -T backend alembic current 2>/dev/null; then
  echo "    Alembic javob berdi."
else
  warn "alembic current ishlamadi — migratsiyalar hali yozilmagan bo'lishi mumkin."
fi

# ----------------------------------------------------------------- 7. seed ----
step "7/7  Dev ma'lumotlari (seed)"
if [ "$SEED" -eq 0 ]; then
  echo "    --no-seed berildi, o'tkazib yuborildi."
elif [ ! -f scripts/seed.py ]; then
  warn "scripts/seed.py topilmadi (CONTRACTS.md §0: u \`db-architect\` fayli) — o'tkazib yuborildi."
else
  # seed.py image ichida yo'q (u loyiha ildizidagi scripts/ da turadi) va
  # `Path(__file__)` ishlatadi, shuning uchun stdin orqali uzatib bo'lmaydi.
  # `docker cp ... :/tmp/` ham ishlamaydi — /tmp tmpfs mount. Shuning uchun
  # compose ./scripts ni backend ga /scripts:ro qilib mount qiladi.
  if $DC exec -T -w /app backend python /scripts/seed.py; then
    echo "    seed bajarildi."
  else
    warn "seed muvaffaqiyatsiz tugadi — scripts/seed.py ni tekshir."
  fi
fi

# ------------------------------------------------------------------- xulosa ----
step "Holat"
$DC ps

if [ "$UP_FAILED" -eq 1 ]; then
  step "Sog'lom bo'lmagan servislarning oxirgi loglari"
  for svc in postgres redis backend worker frontend nginx; do
    state="$($DC ps --format '{{.Service}} {{.State}}' | awk -v s="$svc" '$1==s{print $2}')"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' \
              "syncclass-$svc" 2>/dev/null || echo '-')"
    if [ "$state" != "running" ] || [ "$health" = "unhealthy" ]; then
      printf '\n--- %s (state=%s health=%s) ---\n' "$svc" "${state:-topilmadi}" "$health"
      $DC logs --tail=25 "$svc" 2>&1 || true
    fi
  done
fi

# Nginx 80-portda bo'lsa URL da port ko'rsatilmaydi.
if [ "$HOST_HTTP_PORT" = "80" ]; then APP="http://localhost"; else APP="http://localhost:$HOST_HTTP_PORT"; fi
WSAPP="${APP/http:/ws:}"

cat <<URLS

  ✅ SyncClass ko'tarildi.

  Ilova (Nginx orqali)   $APP
  API hujjatlari         $APP/docs
  OpenAPI sxemasi        $APP/openapi.json
  Liveness               $APP/healthz
  Readiness              $APP/readyz
  WebSocket              $WSAPP/ws/room/{pin}?ticket={ticket}

  To'g'ridan-to'g'ri (debug uchun):
  Backend                http://localhost:$HOST_API_PORT
  Frontend               http://localhost:$HOST_FRONTEND_PORT
  Postgres               localhost:$HOST_POSTGRES_PORT  (syncclass / syncclass)
  Redis                  localhost:$HOST_REDIS_PORT

  Loglar:     make logs
  To'xtatish: make down
  Holat:      make health
  Tekshiruv:  make verify-zero-disk

URLS

if [ "$UP_FAILED" -eq 1 ]; then
  printf '\n%s[xato]%s Stack to%sliq ko%starilmadi (yuqoridagi loglarga qara). Tekshiruv: make health\n' \
    "$C_ERR" "$C_0" "'" "'" >&2
  exit 1
fi
