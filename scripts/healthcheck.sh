#!/usr/bin/env bash
# SyncClass — stack holatini tashqaridan tekshirish.
# Ishlatish:  ./scripts/healthcheck.sh [BASE_URL]
# Standart BASE_URL: http://localhost  (Nginx)
# Chiqish kodi: 0 — hammasi yaxshi, 1 — kamida bitta tekshiruv yiqildi.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
DC="docker compose"

# .env dan bitta kalitni o'qish (fayl oddiy KEY=VALUE — `source` qilmaymiz).
env_get() { # $1=kalit  $2=default
  local v
  v="$(grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"'"' )"
  printf '%s' "${v:-$2}"
}

# Nginx hostda qaysi portda turgani `.env` dagi HOST_HTTP_PORT bilan belgilanadi.
HOST_HTTP_PORT="$(env_get HOST_HTTP_PORT 80)"
if [ "$HOST_HTTP_PORT" = "80" ]; then
  DEFAULT_BASE="http://localhost"
else
  DEFAULT_BASE="http://localhost:$HOST_HTTP_PORT"
fi
BASE="${1:-${BASE_URL:-$DEFAULT_BASE}}"

if [ -t 1 ]; then
  OKC=$'\033[32m'; ERC=$'\033[31m'; WNC=$'\033[33m'; Z=$'\033[0m'
else
  OKC=''; ERC=''; WNC=''; Z=''
fi

FAIL=0
pass() { printf '  %s[OK]%s     %s\n' "$OKC" "$Z" "$*"; }
fail() { printf '  %s[XATO]%s   %s\n' "$ERC" "$Z" "$*"; FAIL=1; }
warn() { printf '  %s[OGOH]%s   %s\n' "$WNC" "$Z" "$*"; }

http_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null || echo 000
}

echo "SyncClass healthcheck — $BASE"
echo

# --- 1. Konteynerlar ---------------------------------------------------------
echo "1) Konteynerlar"
EXPECTED="postgres redis backend worker frontend nginx"
for svc in $EXPECTED; do
  state="$($DC ps --format '{{.Service}} {{.State}}' 2>/dev/null | awk -v s="$svc" '$1==s{print $2}')"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' \
            "syncclass-$svc" 2>/dev/null || echo '-')"
  if [ -z "$state" ]; then
    fail "$svc — ishlamayapti"
  elif [ "$state" != "running" ]; then
    fail "$svc — holat: $state"
  elif [ "$health" = "unhealthy" ]; then
    fail "$svc — running, lekin unhealthy"
  elif [ "$health" = "starting" ]; then
    warn "$svc — hali ko'tarilmoqda (starting)"
  else
    pass "$svc — running (${health})"
  fi
done
echo

# --- 2. HTTP endpointlar -----------------------------------------------------
echo "2) HTTP endpointlar"
for path in /nginx-health /healthz /docs /openapi.json /; do
  code="$(http_code "$BASE$path")"
  case "$code" in
    200|301|302|307|308) pass "GET $path -> $code" ;;
    000)                 fail "GET $path -> ulanmadi (servis ko'tarilmagan?)" ;;
    *)                   fail "GET $path -> $code" ;;
  esac
done
echo

# --- 3. /readyz (Postgres + Redis) -------------------------------------------
echo "3) Readiness (Postgres + Redis)"
READY="$(curl -s --max-time 10 "$BASE/readyz" 2>/dev/null)"
READY_CODE="$(http_code "$BASE/readyz")"
if [ "$READY_CODE" = "200" ]; then
  pass "/readyz -> 200  $READY"
elif [ "$READY_CODE" = "503" ]; then
  fail "/readyz -> 503 (degraded)  $READY"
else
  fail "/readyz -> $READY_CODE  $READY"
fi
echo

# --- 4. Bog'liqliklar bilan to'g'ridan-to'g'ri gaplashish --------------------
echo "4) Ma'lumot omborlari"
if $DC exec -T postgres pg_isready -U "${POSTGRES_USER:-syncclass}" -d "${POSTGRES_DB:-syncclass}" -h 127.0.0.1 >/dev/null 2>&1; then
  pass "postgres — pg_isready"
else
  fail "postgres — pg_isready javob bermadi"
fi
if [ "$($DC exec -T redis redis-cli ping 2>/dev/null | tr -d '\r')" = "PONG" ]; then
  pass "redis — PONG"
else
  fail "redis — PING javob bermadi"
fi
echo

# --- 5. Nginx kritik sozlamalari (AUDIT.md §A3, §B4) ------------------------
echo "5) Nginx kritik sozlamalari"
CONF="$($DC exec -T nginx sh -c 'cat /etc/nginx/conf.d/syncclass.conf' 2>/dev/null)"
if [ -z "$CONF" ]; then
  fail "nginx konfigi o'qilmadi"
else
  echo "$CONF" | grep -q 'proxy_request_buffering[[:space:]]*off' \
    && pass "proxy_request_buffering off  (body diskka buferlanmaydi)" \
    || fail "proxy_request_buffering off  YO'Q — AUDIT §A3.1 buzilgan"
  echo "$CONF" | grep -q 'client_body_buffer_size[[:space:]]*26m' \
    && pass "client_body_buffer_size 26m" \
    || fail "client_body_buffer_size 26m  YO'Q"
  echo "$CONF" | grep -q 'client_max_body_size[[:space:]]*26m' \
    && pass "client_max_body_size 26m" \
    || fail "client_max_body_size 26m  YO'Q"
  echo "$CONF" | grep -q 'proxy_read_timeout[[:space:]]*3600s' \
    && pass "proxy_read_timeout 3600s     (WS 60s'da uzilmaydi)" \
    || fail "proxy_read_timeout 3600s  YO'Q — AUDIT §B4 buzilgan"
  echo "$CONF" | grep -q 'Upgrade[[:space:]]*\$http_upgrade' \
    && pass "WebSocket Upgrade headerlari" \
    || fail "Upgrade headeri YO'Q"
fi
echo

# --- 6. /tmp tmpfs ekanini tasdiqlash (AUDIT.md §A3) ------------------------
echo "6) /tmp tmpfs (RAM disk)"
for svc in backend worker; do
  fstype="$($DC exec -T "$svc" sh -c "stat -f -c %T /tmp 2>/dev/null || df -T /tmp 2>/dev/null | tail -1 | awk '{print \$2}'" 2>/dev/null | tr -d '\r')"
  if [ "$fstype" = "tmpfs" ]; then
    pass "$svc:/tmp -> tmpfs"
  elif [ -z "$fstype" ]; then
    warn "$svc:/tmp -> aniqlanmadi (konteyner ko'tarilmagan?)"
  else
    fail "$svc:/tmp -> $fstype (tmpfs BO'LISHI KERAK)"
  fi
done
echo

if [ "$FAIL" -eq 0 ]; then
  printf '%sHammasi joyida.%s\n' "$OKC" "$Z"
else
  printf '%sKamida bitta tekshiruv yiqildi (yuqoridagi [XATO] larni ko%sring).%s\n' "$ERC" "'" "$Z"
fi
exit "$FAIL"
