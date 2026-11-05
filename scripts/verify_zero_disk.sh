#!/usr/bin/env bash
# SyncClass — "ilova diskida o'quvchi faylining doimiy nusxasi saqlanmaydi"
# da'vosini AMALDA isbotlaydi (AUDIT.md §A3 + §I DoD #3).
#
# Nima qiladi:
#   1. backend/worker/nginx konteynerlarida /tmp va /app hajmini o'lchaydi.
#   2. N ta (default 20) M MB (default 10) zip faylni /api/v1/.../submit ga yuboradi.
#   3. Hajmlarni qaytadan o'lchab, O'ZGARMAGANini tekshiradi.
#   4. /tmp haqiqatan tmpfs (RAM) ekanini tasdiqlaydi.
#
# Ishlatish:
#   ./scripts/verify_zero_disk.sh                      # faqat strukturani tekshiradi
#   ./scripts/verify_zero_disk.sh --token <JWT> --homework <UUID>
#   COUNT=20 SIZE_MB=10 ./scripts/verify_zero_disk.sh --token ... --homework ...
#   ./scripts/verify_zero_disk.sh --local              # Docker'siz, backend/.venv bilan
#
# Token/homework berilmasa: upload bosqichi o'tkazib yuboriladi, lekin
# tmpfs + Nginx sozlamalari + boshlang'ich hajmlar baribir tekshiriladi.
#
# `--local` rejimi (storage-engineer): Docker, Postgres, R2 va token kerak emas.
# Backend upload qatlamini (`upload_guard` + `zip_extractor`) ASGI orqali
# to'g'ridan-to'g'ri chaqiradi, `tempfile` ni instrumentlab diskka yozish
# hodisalarini sanaydi va /tmp, $TMPDIR, ishchi katalog hajmini o'lchaydi.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
DC="docker compose"

env_get() { # $1=kalit  $2=default
  local v
  v="$(grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"'"' )"
  printf '%s' "${v:-$2}"
}
_HP="$(env_get HOST_HTTP_PORT 80)"
if [ "$_HP" = "80" ]; then BASE="${BASE_URL:-http://localhost}"
else BASE="${BASE_URL:-http://localhost:$_HP}"; fi
COUNT="${COUNT:-20}"
SIZE_MB="${SIZE_MB:-10}"
TOKEN=""
HOMEWORK=""
LOCAL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --token)    TOKEN="${2:-}"; shift 2 ;;
    --homework) HOMEWORK="${2:-}"; shift 2 ;;
    --base)     BASE="${2:-}"; shift 2 ;;
    --local)    LOCAL=1; shift ;;
    -h|--help)
      sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Noma'lum argument: $1" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then OKC=$'\033[32m'; ERC=$'\033[31m'; WNC=$'\033[33m'; Z=$'\033[0m'
else OKC=''; ERC=''; WNC=''; Z=''; fi
FAIL=0
pass() { printf '  %s[OK]%s     %s\n' "$OKC" "$Z" "$*"; }
fail() { printf '  %s[XATO]%s   %s\n' "$ERC" "$Z" "$*"; FAIL=1; }
warn() { printf '  %s[OGOH]%s   %s\n' "$WNC" "$Z" "$*"; }

# ===========================================================================
# LOKAL REJIM (--local): Docker'siz isbot (storage-engineer, AUDIT §A3)
# ===========================================================================
run_local() {
  PY="$ROOT/backend/.venv/bin/python"
  if [ ! -x "$PY" ]; then
    fail "backend/.venv topilmadi (kutilgan: $PY). Avval: python3.12 -m venv backend/.venv"
    return 1
  fi
  echo "SyncClass — zero-disk tekshiruvi (LOKAL, Docker'siz)"
  echo "  count=$COUNT  size=${SIZE_MB}MB  python=$PY"
  echo
  ZD_ROOT="$ROOT" COUNT="$COUNT" SIZE_MB="$SIZE_MB" "$PY" -I - <<'PYZD'
import io
import os
import pathlib
import subprocess
import sys
import tempfile
import zipfile

ROOT = pathlib.Path(os.environ["ZD_ROOT"])
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))
os.chdir(BACKEND)

COUNT = int(os.environ.get("COUNT") or 20)
SIZE_MB = int(os.environ.get("SIZE_MB") or 10)

# --- 1. `tempfile` ni instrumentlash: har qanday disk nusxasi sanaladi -----
# Starlette `UploadFile` 1 MB dan keyin SpooledTemporaryFile.rollover() ni
# chaqiradi va /tmp ga yozadi (AUDIT §A3, 2-qatlam). Bizning oqimimiz
# bu chaqiruvlarning BIRORTASINI ham qilmasligi kerak.
EVENTS: list[str] = []
_mkstemp, _tmpfile, _ntmpfile = tempfile.mkstemp, tempfile.TemporaryFile, tempfile.NamedTemporaryFile
_rollover = tempfile.SpooledTemporaryFile.rollover


def _hook(name, fn):
    def wrapper(*a, **k):
        EVENTS.append(name)
        return fn(*a, **k)
    return wrapper


tempfile.mkstemp = _hook("mkstemp", _mkstemp)
tempfile.TemporaryFile = _hook("TemporaryFile", _tmpfile)
tempfile.NamedTemporaryFile = _hook("NamedTemporaryFile", _ntmpfile)
tempfile.SpooledTemporaryFile.rollover = _hook("spool_rollover", _rollover)

import anyio  # noqa: E402
import httpx  # noqa: E402
from fastapi import FastAPI, Request  # noqa: E402

from app.services.upload_guard import (  # noqa: E402
    assert_allowed_extension,
    sanitize_file_name,
    stream_upload,
    upload_slot,
)
from app.services.zip_extractor import extract_async  # noqa: E402

# --- 2. Haqiqiy submit oqimining fayl qismi (DB/R2 siz) -------------------
probe = FastAPI()


@probe.post("/probe")
async def _probe(request: Request):
    async with upload_slot():
        up = await stream_upload(request)
        name = sanitize_file_name(up.file_name, default="solution.zip")
        assert_allowed_extension(name)
        result = await extract_async(up.buf)
    return {"size": up.size, "sha256": up.sha256, "files": len(result.files)}


# --- 3. O'lchash yordamchilari -------------------------------------------
def du_kb(path: str) -> int:
    try:
        out = subprocess.run(["du", "-sk", path], capture_output=True, text=True, timeout=120)
        return int(out.stdout.split()[0]) if out.stdout.strip() else -1
    except Exception:
        return -1


TMPDIR = tempfile.gettempdir()
# macOS da /tmp -> /private/tmp symlink; `du` symlink ni o'lchab 0 beradi.
TARGETS = {"/tmp": os.path.realpath("/tmp"), "$TMPDIR": TMPDIR, "backend/": str(BACKEND)}
BEFORE = {k: du_kb(v) for k, v in TARGETS.items()}
FILES_BEFORE = len(os.listdir(TMPDIR))

# --- 4. Siqilmaydigan zip (10 MB tasodifiy ma'lumot) ---------------------
payload = os.urandom(SIZE_MB * 1024 * 1024)
zbuf = io.BytesIO()
with zipfile.ZipFile(zbuf, "w", zipfile.ZIP_STORED) as zf:
    zf.writestr("payload.bin", payload)
zip_bytes = zbuf.getvalue()
del payload, zbuf

BOUNDARY = b"----ZeroDiskProbe"
body = (
    b"--" + BOUNDARY + b"\r\n"
    b'Content-Disposition: form-data; name="file"; filename="solution.zip"\r\n'
    b"Content-Type: application/zip\r\n\r\n" + zip_bytes + b"\r\n"
    b"--" + BOUNDARY + b"--\r\n"
)
headers = {"content-type": f"multipart/form-data; boundary={BOUNDARY.decode()}"}

OK = 0
BAD = 0


async def main() -> None:
    global OK, BAD
    transport = httpx.ASGITransport(app=probe)
    async with httpx.AsyncClient(transport=transport, base_url="http://probe") as client:
        for i in range(COUNT):
            r = await client.post("/probe", content=body, headers=headers, timeout=180)
            if r.status_code == 200 and r.json()["size"] == len(zip_bytes):
                OK += 1
            else:
                BAD += 1
                print(f"  #{i + 1} -> HTTP {r.status_code} {r.text[:120]}")


anyio.run(main)

AFTER = {k: du_kb(v) for k, v in TARGETS.items()}
FILES_AFTER = len(os.listdir(TMPDIR))
TOL_KB = 1024  # 1 MB "shovqin" (log, .pyc keshi) — fayl nusxasi emas
failed = False

print(f"1) {OK}/{COUNT} ta {SIZE_MB} MB zip oqimdan o'tdi "
      f"(jami {OK * len(zip_bytes) / 1048576:.0f} MB)")
if BAD or OK != COUNT:
    print(f"  [XATO]   {BAD} ta so'rov yiqildi")
    failed = True

print("2) tempfile hodisalari (0 bo'lishi SHART)")
if EVENTS:
    print(f"  [XATO]   diskka yozish hodisalari: {EVENTS[:10]} (jami {len(EVENTS)})")
    failed = True
else:
    print("  [OK]     0 ta vaqtinchalik fayl: mkstemp / TemporaryFile / spool_rollover chaqirilmadi")

print("3) katalog hajmlari (Δ <= 1 MB bo'lishi SHART)")
for key in TARGETS:
    b, a = BEFORE[key], AFTER[key]
    if b < 0 or a < 0:
        print(f"  [OGOH]   {key}: o'lchanmadi")
        continue
    delta = (a - b) * 1024
    mark = "OK" if abs(delta) <= TOL_KB * 1024 else "XATO"
    if mark == "XATO":
        failed = True
    print(f"  [{mark}]{' ' * (5 - len(mark))}{key}: {b * 1024} -> {a * 1024} bayt (Δ {delta})")
print(f"  [i]      $TMPDIR fayl soni: {FILES_BEFORE} -> {FILES_AFTER}")
if FILES_AFTER > FILES_BEFORE:
    print("  [XATO]   $TMPDIR da yangi fayl paydo bo'ldi")
    failed = True

print()
print("LOKAL zero-disk tekshiruvi " + ("YIQILDI." if failed else "o'tdi."))
sys.exit(1 if failed else 0)
PYZD
  return $?
}

if [ "$LOCAL" -eq 1 ]; then
  run_local
  exit $?
fi

# Konteyner ichidagi papka hajmi (bayt). `du -sb` BusyBox'da yo'q -> `du -s -k` * 1024.
dir_bytes() { # $1=servis  $2=papka
  $DC exec -T "$1" sh -c "du -s -k '$2' 2>/dev/null | awk '{print \$1*1024}'" 2>/dev/null | tr -d '\r'
}

echo "SyncClass — zero-disk tekshiruvi"
echo "  base=$BASE  count=$COUNT  size=${SIZE_MB}MB"
echo

# ---------------------------------------------------------- 1. tmpfs isboti ----
echo "1) /tmp tmpfs (RAM disk) ekanini tasdiqlash"
for svc in backend worker nginx; do
  ft="$($DC exec -T "$svc" sh -c 'stat -f -c %T /tmp 2>/dev/null' 2>/dev/null | tr -d '\r')"
  if [ "$ft" = "tmpfs" ]; then
    pass "$svc:/tmp -> tmpfs"
  elif [ -z "$ft" ]; then
    fail "$svc — konteyner ishlamayapti (avval: make up)"
  else
    fail "$svc:/tmp -> '$ft' (tmpfs BO'LISHI KERAK — AUDIT §A3)"
  fi
done
echo

# ------------------------------------------------- 2. Nginx buferlash sozlamalari ----
echo "2) Nginx body'ni diskka buferlamasligi"
CONF="$($DC exec -T nginx cat /etc/nginx/conf.d/syncclass.conf 2>/dev/null)"
echo "$CONF" | grep -q 'proxy_request_buffering[[:space:]]*off' \
  && pass "proxy_request_buffering off" || fail "proxy_request_buffering off YO'Q"
echo "$CONF" | grep -q 'client_body_buffer_size[[:space:]]*26m' \
  && pass "client_body_buffer_size 26m" || fail "client_body_buffer_size 26m YO'Q"
TMPFS_CACHE="$($DC exec -T nginx sh -c 'stat -f -c %T /var/cache/nginx 2>/dev/null' 2>/dev/null | tr -d '\r')"
[ "$TMPFS_CACHE" = "tmpfs" ] \
  && pass "nginx:/var/cache/nginx -> tmpfs (client_body_temp ham RAM da)" \
  || fail "nginx:/var/cache/nginx -> '$TMPFS_CACHE' (tmpfs kutilgan)"
echo

# ------------------------------------------------------- 3. boshlang'ich hajm ----
echo "3) Upload OLDIDAN hajmlar"
declare -a KEYS=() BEFORE=()
for pair in "backend /app" "backend /tmp" "worker /tmp" "nginx /var/cache/nginx"; do
  set -- $pair
  b="$(dir_bytes "$1" "$2")"
  if [ -z "$b" ]; then fail "$1:$2 — o'lchanmadi"; continue; fi
  KEYS+=("$1:$2"); BEFORE+=("$b")
  printf '  %-28s %s bayt\n' "$1:$2" "$b"
done
echo

# ------------------------------------------------------------- 4. upload ----
if [ -z "$TOKEN" ] || [ -z "$HOMEWORK" ]; then
  warn "--token / --homework berilmadi -> $COUNT ta zip yuklash bosqichi o'tkazib yuborildi."
  warn "To'liq DoD #3 uchun: ./scripts/verify_zero_disk.sh --token <JWT> --homework <UUID>"
else
  echo "4) $COUNT ta ${SIZE_MB}MB zip yuklanayapti"
  TMPDIR_LOCAL="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR_LOCAL"' EXIT
  # Siqilmaydigan (tasodifiy) ma'lumot — zip ichi ham ~${SIZE_MB}MB bo'ladi,
  # ya'ni haqiqiy tarmoq/RAM yuklamasi o'lchanadi.
  dd if=/dev/urandom of="$TMPDIR_LOCAL/payload.bin" bs=1m count="$SIZE_MB" status=none 2>/dev/null \
    || dd if=/dev/urandom of="$TMPDIR_LOCAL/payload.bin" bs=1M count="$SIZE_MB" status=none
  ( cd "$TMPDIR_LOCAL" && zip -q -0 solution.zip payload.bin )
  OK_N=0; BAD_N=0
  for i in $(seq 1 "$COUNT"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 \
      -H "Authorization: Bearer $TOKEN" \
      -F "file=@$TMPDIR_LOCAL/solution.zip;filename=solution_${i}.zip" \
      "$BASE/api/v1/homeworks/$HOMEWORK/submit")"
    case "$code" in
      200|201) OK_N=$((OK_N+1)) ;;
      *) BAD_N=$((BAD_N+1)); printf '  #%-3s -> HTTP %s\n' "$i" "$code" ;;
    esac
  done
  [ "$BAD_N" -eq 0 ] && pass "$OK_N/$COUNT upload muvaffaqiyatli" \
                     || fail "$OK_N muvaffaqiyatli, $BAD_N xato"
  echo "  (kesh/GC uchun 3 sekund kutamiz)"
  # tmpfs bo'shashi va GC uchun kichik pauza
  $DC exec -T backend sh -c 'sleep 3' >/dev/null 2>&1 || true
fi
echo

# ------------------------------------------------------- 5. keyingi hajmlar ----
echo "5) Upload KEYIN hajmlar (o'zgarmasligi shart)"
i=0
for key in "${KEYS[@]}"; do
  svc="${key%%:*}"; dir="${key#*:}"
  after="$(dir_bytes "$svc" "$dir")"
  before="${BEFORE[$i]}"
  i=$((i+1))
  if [ -z "$after" ]; then fail "$key — o'lchanmadi"; continue; fi
  delta=$((after - before))
  # Log fayllari va Python .pyc keshi tufayli kichik o'sish bo'lishi mumkin;
  # 1 MB dan kichik farq "shovqin" hisoblanadi, fayl nusxasi emas.
  if [ "$delta" -le 1048576 ] && [ "$delta" -ge -1048576 ]; then
    printf '  %s[OK]%s     %-28s %s -> %s (Δ %s bayt)\n' "$OKC" "$Z" "$key" "$before" "$after" "$delta"
  else
    printf '  %s[XATO]%s   %-28s %s -> %s (Δ %s bayt — DISKKA YOZILDI!)\n' "$ERC" "$Z" "$key" "$before" "$after" "$delta"
    FAIL=1
  fi
done
echo

if [ "$FAIL" -eq 0 ]; then
  printf '%sZero-disk tekshiruvi o%stdi.%s\n' "$OKC" "'" "$Z"
else
  printf '%sZero-disk tekshiruvi YIQILDI.%s\n' "$ERC" "$Z"
fi
exit "$FAIL"
