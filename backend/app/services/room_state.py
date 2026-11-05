"""Room holati — **Redis Hash = yagona haqiqat manbasi** (AUDIT.md §B2).

Pub/Sub tarix saqlamaydi, shuning uchun u faqat "xabar berish" vositasi.
Haqiqiy holat `room:{session_id}:state` HASH ida yashaydi va har ulanish/
reconnect da `ROOM_STATE_SYNC` aynan shu HASH dan to'liq o'qiladi.

Kalitlar (CONTRACTS.md §5):
    room:{session_id}:state     HASH   slide_index, slide_type, code, code_rev,
                                       is_sharing, active_quiz(json), seq, status,
                                       active_quiz_secret(json),
                                       active_poll(json), active_open(json)
    room:{session_id}:poll:{poll_id}:votes     HASH  {student_id: variant} (HSETNX)
    room:{session_id}:poll:{poll_id}:dist      HASH  {variant: soni}
    room:{session_id}:poll:{poll_id}:deadline  STR   ends_at + grace (ms)
    room:{session_id}:open:{open_id}:by        HASH  {student_id: answer_id} (oxirgisi)
    room:{session_id}:open:{open_id}:cnt       HASH  {answer_id: soni}
    room:{session_id}:open:{open_id}:text      HASH  {answer_id: tozalangan matn}
    room:{session_id}:open:{open_id}:hidden    SET   yashirilgan answer_id lar
    room:{session_id}:open:{open_id}:deadline  STR   ends_at + grace (ms)
    room:{session_id}:open:{open_id}:rl:{sid}  STR   1 javob / 2 s (PX)
    room:{session_id}:interactive              SET   yuqoridagi poll/open kalitlari ro'yxati

`active_poll`/`active_open` — faqat `POLL_START`/`OPEN_START` dagi OMMAVIY
maydonlar. Jonli taqsimot va javoblar ALOHIDA kalitlarda: o'quvchi snapshoti
ularni o'qiydigan yo'lga ega emas (CONTRACTS.md §16.3).
    room:{session_id}:members   HASH   {user_id: json(Participant)}
    room:{session_id}:confused  ZSET   user_id -> ping vaqti (ms), 60 s oynasi
    room:{session_id}:channel   Pub/Sub kanal nomi

### Nega Lua?
`SLIDE_CHANGE` p95 < 100 ms o'lchanadigan talab. Har event uchun
"HINCRBY seq" → "HSET state" → "PUBLISH" uchta roundtrip bo'lardi. Lua
skriptlari uchalasini **bitta** roundtripda va **atomar** bajaradi, shu bilan
birga `seq` ning monotonikligini kafolatlaydi (bir nechta Uvicorn worker
bo'lsa ham — AUDIT.md §B5).

Envelope JSON i Lua ichida qo'lda yig'iladi: `data` Python tomonida allaqachon
to'g'ri JSON ga aylantirilgan (shuning uchun escape muammosi yo'q), `type` va
`ts` esa server nazoratidagi qiymatlar.
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Final

from redis.asyncio import Redis

from app.core.security import generate_ws_ticket
from app.schemas.room import ActiveQuiz, ConfusedStats, Participant

# ---------------------------------------------------------------------------
# Konstantalar
# ---------------------------------------------------------------------------

#: Xona holati Redis da shu muddatdan keyin o'zi o'chadi (dars 90 daqiqa + zaxira).
ROOM_TTL_SEC: Final[int] = 6 * 60 * 60

#: "Tushunmadim" pingi shu oyna ichida hisobga olinadi (CONTRACTS.md §5).
CONFUSED_WINDOW_SEC: Final[int] = 60

#: Bir o'quvchi `CONFUSED_PING` ni shu muddatda bir marta yuboradi.
CONFUSED_COOLDOWN_SEC: Final[int] = 30

#: Bitta global PubSub listener shu pattern ga subscribe bo'ladi (har room uchun emas).
CHANNEL_PATTERN: Final[str] = "room:*:channel"

#: Ticket TTL — AUDIT.md §B3 (bir martalik, JWT WS URL ga tushmaydi).
TICKET_TTL_SEC: Final[int] = 30

#: POLL/OPEN natijalari dars TUGAGACH shuncha saqlanadi (CONTRACTS.md §16.3).
#: DB ga yozilmaydi — hisobotga kirmaydi (MVP).
INTERACTIVE_RETAIN_SEC: Final[int] = 24 * 60 * 60

#: OPEN: bir o'quvchi — 1 javob / 2 s (§16.3).
OPEN_ANSWER_INTERVAL_MS: Final[int] = 2000


def state_key(session_id: str | uuid.UUID) -> str:
    return f"room:{session_id}:state"


def members_key(session_id: str | uuid.UUID) -> str:
    return f"room:{session_id}:members"


def confused_key(session_id: str | uuid.UUID) -> str:
    return f"room:{session_id}:confused"


def channel_key(session_id: str | uuid.UUID) -> str:
    return f"room:{session_id}:channel"


def interactive_registry_key(session_id: str | uuid.UUID) -> str:
    return f"room:{session_id}:interactive"


def poll_key(session_id: str | uuid.UUID, poll_id: str, part: str) -> str:
    return f"room:{session_id}:poll:{poll_id}:{part}"


def open_key(session_id: str | uuid.UUID, open_id: str, part: str) -> str:
    return f"room:{session_id}:open:{open_id}:{part}"


def open_answer_id(open_id: str, text: str) -> str:
    """`answer_id` — normallashtirilgan matnning hashi (CONTRACTS.md §16.5).

    `student_id` dan KELIB CHIQMAYDI: bir xil matn yozgan har kim bitta
    `answer_id` ga tushadi, ya'ni identifikator orqali muallifni topib bo'lmaydi.
    `open_id` qo'shilgani — turli savollardagi bir xil so'zlarni o'zaro
    bog'lab bo'lmasin.
    """
    digest = hashlib.blake2b(f"{open_id}\x00{text}".encode(), digest_size=6)
    return digest.hexdigest()


def confused_cooldown_key(session_id: str | uuid.UUID, student_id: str | uuid.UUID) -> str:
    return f"room:{session_id}:confused:cd:{student_id}"


def ticket_key(ticket: str) -> str:
    return f"ws:ticket:{ticket}"


def session_id_from_channel(channel: str) -> str | None:
    """`room:<uuid>:channel` → `<uuid>`. Boshqa shakl bo'lsa `None`."""
    if not channel.startswith("room:") or not channel.endswith(":channel"):
        return None
    return channel[5:-8] or None


def now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------------------
# Lua skriptlari
# ---------------------------------------------------------------------------

# Universal "seq oshir → holatni yangila → e'lon qil".
# KEYS[1] = state hash, KEYS[2] = channel
# ARGV[1] = event type, ARGV[2] = data JSON, ARGV[3] = ts (ms), ARGV[4] = TTL
# ARGV[5..] = HSET uchun field/value juftliklari (bo'lmasa HSET chaqirilmaydi)
_LUA_PUBLISH: Final[str] = """
local seq = redis.call('HINCRBY', KEYS[1], 'seq', 1)
local n = #ARGV
if n > 4 then
  local fields = {}
  for i = 5, n do fields[#fields + 1] = ARGV[i] end
  redis.call('HSET', KEYS[1], unpack(fields))
end
redis.call('EXPIRE', KEYS[1], ARGV[4])
local env = '{"v":1,"type":"' .. ARGV[1] .. '","seq":' .. seq ..
            ',"ts":' .. ARGV[3] .. ',"data":' .. ARGV[2] .. '}'
redis.call('PUBLISH', KEYS[2], env)
return {seq, env}
"""

# `LIVE_CODE_PATCH`: `seq` va `code_rev` ikkisi ham atomar oshadi (AUDIT.md §B1).
# KEYS[1] = state, KEYS[2] = channel
# ARGV[1] = slide_index, ARGV[2] = xom kod, ARGV[3] = kod JSON (qo'shtirnoq bilan),
# ARGV[4] = cursor JSON, ARGV[5] = TTL, ARGV[6] = ts (ms)
_LUA_CODE_PATCH: Final[str] = """
local seq = redis.call('HINCRBY', KEYS[1], 'seq', 1)
local rev = redis.call('HINCRBY', KEYS[1], 'code_rev', 1)
redis.call('HSET', KEYS[1], 'slide_index', ARGV[1], 'code', ARGV[2], 'slide_type', 'CODE')
redis.call('EXPIRE', KEYS[1], ARGV[5])
local data = '{"slide_index":' .. ARGV[1] .. ',"code_rev":' .. rev ..
             ',"code":' .. ARGV[3] .. ',"cursor":' .. ARGV[4] .. '}'
local env = '{"v":1,"type":"LIVE_CODE_PATCH","seq":' .. seq ..
            ',"ts":' .. ARGV[6] .. ',"data":' .. data .. '}'
redis.call('PUBLISH', KEYS[2], env)
return {seq, rev, env}
"""

# To'liq snapshot — `ROOM_STATE_SYNC` uchun bitta roundtrip.
# KEYS[1] = state, KEYS[2] = members, KEYS[3] = confused
# ARGV[1] = eskirgan ping chegarasi, ARGV[2..] = o'qishga RUXSAT berilgan maydonlar
#
# ATAYLAB `HGETALL` EMAS: `HMGET` bilan faqat ommaviy maydonlar o'qiladi.
# Shu sababli `active_quiz_secret` (to'g'ri javob) snapshot kodiga JISMONAN
# yetib kelmaydi — uni to'sib turadigan filtr qatoriga ishonish kerak emas.
_LUA_SNAPSHOT: Final[str] = """
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', ARGV[1])
local fields = {}
for i = 2, #ARGV do fields[#fields + 1] = ARGV[i] end
local st = redis.call('HMGET', KEYS[1], unpack(fields))
local mem = redis.call('HVALS', KEYS[2])
local conf = redis.call('ZCARD', KEYS[3])
local exists = redis.call('EXISTS', KEYS[1])
return {st, mem, conf, exists}
"""

# ---------------------------------------------------------------------------
# v1.2 POLL / OPEN (CONTRACTS.md §16.3) — hammasi atomar, bitta roundtripda.
# ---------------------------------------------------------------------------
# Umumiy Lua prelude: envelope yig'ish/e'lon qilish va jonli ko'rinishlar.
# `active()` — faol poll/open ni xona HASH idan o'qiydi va ID ni solishtiradi:
# tekshiruv va yozish BITTA skriptda, ya'ni "tekshirib-keyin-yozish" poygasi yo'q
# (masalan `POLL_END` bilan bir vaqtda kelgan ovoz natijadan tashqarida
# "osilib" qolmaydi).
_LUA_IA_PRELUDE: Final[str] = """
local function emit(state, channel, ttl, ts, etype, data)
  local seq = redis.call('HINCRBY', state, 'seq', 1)
  redis.call('EXPIRE', state, ttl)
  local env = '{"v":1,"type":"' .. etype .. '","seq":' .. seq ..
              ',"ts":' .. ts .. ',"data":' .. data .. '}'
  redis.call('PUBLISH', channel, env)
  return seq, env
end

local function active(state, field, idfield, want)
  local raw = redis.call('HGET', state, field)
  if (not raw) or raw == '' then return nil end
  local ok, obj = pcall(cjson.decode, raw)
  if (not ok) or type(obj) ~= 'table' then return nil end
  if want and obj[idfield] ~= want then return nil end
  return obj
end

local function expired(deadline_key, now)
  local dl = tonumber(redis.call('GET', deadline_key) or '0') or 0
  return dl > 0 and tonumber(now) > dl
end

local function poll_dist(distkey, n)
  local out, sum = {}, 0
  for i = 0, n - 1 do
    local v = tonumber(redis.call('HGET', distkey, tostring(i)) or '0') or 0
    out[#out + 1] = v
    sum = sum + v
  end
  return out, sum
end

local function poll_progress(poll, voteskey, distkey, memberskey)
  local dist = poll_dist(distkey, #poll.options)
  return '{"poll_id":' .. cjson.encode(poll.poll_id) ..
         ',"voted":' .. redis.call('HLEN', voteskey) ..
         ',"total":' .. redis.call('HLEN', memberskey) ..
         ',"distribution":[' .. table.concat(dist, ',') .. ']}'
end

local function open_answers(cntkey, textkey, hiddenkey, with_id)
  local flat = redis.call('HGETALL', cntkey)
  local rows = {}
  for i = 1, #flat, 2 do
    local id, c = flat[i], tonumber(flat[i + 1]) or 0
    if c > 0 and redis.call('SISMEMBER', hiddenkey, id) == 0 then
      rows[#rows + 1] = {id = id, count = c, text = redis.call('HGET', textkey, id) or ''}
    end
  end
  table.sort(rows, function(a, b)
    if a.count ~= b.count then return a.count > b.count end
    return a.text < b.text
  end)
  local parts = {}
  for _, r in ipairs(rows) do
    if with_id then
      parts[#parts + 1] = '{"answer_id":' .. cjson.encode(r.id) .. ',"text":' ..
                          cjson.encode(r.text) .. ',"count":' .. r.count .. '}'
    else
      parts[#parts + 1] = '{"text":' .. cjson.encode(r.text) .. ',"count":' .. r.count .. '}'
    end
  end
  return '[' .. table.concat(parts, ',') .. ']'
end

local function open_update(open, bykey, cntkey, textkey, hiddenkey, memberskey)
  return '{"open_id":' .. cjson.encode(open.open_id) ..
         ',"answered":' .. redis.call('HLEN', bykey) ..
         ',"total":' .. redis.call('HLEN', memberskey) ..
         ',"answers":' .. open_answers(cntkey, textkey, hiddenkey, true) .. '}'
end
"""

# POLL_VOTE — bir o'quvchi, bir ovoz: `HSETNX` + `HINCRBY` + `PUBLISH` atomar.
# KEYS: 1 state, 2 channel, 3 votes, 4 dist, 5 members, 6 deadline
# ARGV: 1 poll_id, 2 student_id, 3 variant, 4 ts, 5 ttl, 6 now_ms
_LUA_POLL_VOTE: Final[str] = _LUA_IA_PRELUDE + """
local poll = active(KEYS[1], 'active_poll', 'poll_id', ARGV[1])
if not poll then return {0, 'POLL_NOT_ACTIVE'} end
if expired(KEYS[6], ARGV[6]) then return {0, 'POLL_NOT_ACTIVE'} end
local idx = tonumber(ARGV[3])
if (not idx) or idx < 0 or idx >= #poll.options then return {0, 'INVALID_OPTION'} end
if redis.call('HSETNX', KEYS[3], ARGV[2], ARGV[3]) == 0 then return {0, 'ALREADY_VOTED'} end
redis.call('HINCRBY', KEYS[4], ARGV[3], 1)
redis.call('EXPIRE', KEYS[3], ARGV[5])
redis.call('EXPIRE', KEYS[4], ARGV[5])
local seq, env = emit(KEYS[1], KEYS[2], ARGV[5], ARGV[4], 'POLL_PROGRESS',
                      poll_progress(poll, KEYS[3], KEYS[4], KEYS[5]))
return {1, seq, env}
"""

# POLL_END — yakuniy taqsimotni o'qish, faol pollni tozalash va e'lon BIRGA.
# KEYS: 1 state, 2 channel, 3 dist
# ARGV: 1 poll_id, 2 ts, 3 ttl
_LUA_POLL_END: Final[str] = _LUA_IA_PRELUDE + """
local poll = active(KEYS[1], 'active_poll', 'poll_id', ARGV[1])
if not poll then return {0, 'POLL_NOT_ACTIVE'} end
local dist, sum = poll_dist(KEYS[3], #poll.options)
redis.call('HSET', KEYS[1], 'active_poll', '')
local data = '{"poll_id":' .. cjson.encode(poll.poll_id) ..
             ',"options":' .. cjson.encode(poll.options) ..
             ',"distribution":[' .. table.concat(dist, ',') .. ']' ..
             ',"total":' .. sum .. '}'
local seq, env = emit(KEYS[1], KEYS[2], ARGV[3], ARGV[2], 'POLL_RESULTS', data)
return {1, seq, env}
"""

# OPEN_ANSWER — oxirgi javob yoziladi (eskisining hisobi kamayadi), 1 javob / 2 s.
# KEYS: 1 state, 2 channel, 3 by, 4 cnt, 5 text, 6 hidden, 7 members, 8 rl, 9 deadline
# ARGV: 1 open_id, 2 student_id, 3 answer_id, 4 text, 5 ts, 6 ttl, 7 rate_ms, 8 now_ms
_LUA_OPEN_ANSWER: Final[str] = _LUA_IA_PRELUDE + """
local open = active(KEYS[1], 'active_open', 'open_id', ARGV[1])
if not open then return {0, 'OPEN_NOT_ACTIVE'} end
if expired(KEYS[9], ARGV[8]) then return {0, 'OPEN_NOT_ACTIVE'} end
if not redis.call('SET', KEYS[8], '1', 'NX', 'PX', ARGV[7]) then
  return {0, 'RATE_LIMITED'}
end
local prev = redis.call('HGET', KEYS[3], ARGV[2])
if prev ~= ARGV[3] then
  if prev then
    if redis.call('HINCRBY', KEYS[4], prev, -1) <= 0 then redis.call('HDEL', KEYS[4], prev) end
  end
  redis.call('HSET', KEYS[3], ARGV[2], ARGV[3])
  redis.call('HINCRBY', KEYS[4], ARGV[3], 1)
  redis.call('HSETNX', KEYS[5], ARGV[3], ARGV[4])
end
for i = 3, 6 do redis.call('EXPIRE', KEYS[i], ARGV[6]) end
local seq, env = emit(KEYS[1], KEYS[2], ARGV[6], ARGV[5], 'OPEN_UPDATE',
                      open_update(open, KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7]))
return {1, seq, env}
"""

# OPEN_HIDE — yashirilgan `answer_id` OPEN_UPDATE dan ham, OPEN_RESULTS dan ham
# chiqadi. Keyin xuddi shu matnni yozganlar ham yashirin qoladi (hash bir xil).
# KEYS: 1 state, 2 channel, 3 by, 4 cnt, 5 text, 6 hidden, 7 members
# ARGV: 1 open_id, 2 answer_id, 3 ts, 4 ttl
_LUA_OPEN_HIDE: Final[str] = _LUA_IA_PRELUDE + """
local open = active(KEYS[1], 'active_open', 'open_id', ARGV[1])
if not open then return {0, 'OPEN_NOT_ACTIVE'} end
redis.call('SADD', KEYS[6], ARGV[2])
redis.call('EXPIRE', KEYS[6], ARGV[4])
local seq, env = emit(KEYS[1], KEYS[2], ARGV[4], ARGV[3], 'OPEN_UPDATE',
                      open_update(open, KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7]))
return {1, seq, env}
"""

# OPEN_END — so'z buluti (yashirilganlarsiz, `answer_id` siz) + tozalash, atomar.
# KEYS: 1 state, 2 channel, 3 cnt, 4 text, 5 hidden
# ARGV: 1 open_id, 2 ts, 3 ttl
_LUA_OPEN_END: Final[str] = _LUA_IA_PRELUDE + """
local open = active(KEYS[1], 'active_open', 'open_id', ARGV[1])
if not open then return {0, 'OPEN_NOT_ACTIVE'} end
redis.call('HSET', KEYS[1], 'active_open', '')
local data = '{"open_id":' .. cjson.encode(open.open_id) ..
             ',"answers":' .. open_answers(KEYS[3], KEYS[4], KEYS[5], false) .. '}'
local seq, env = emit(KEYS[1], KEYS[2], ARGV[3], ARGV[2], 'OPEN_RESULTS', data)
return {1, seq, env}
"""

# O'QITUVCHI snapshoti uchun jonli ko'rinish (CONTRACTS.md §16.3 K4). Hech narsa
# e'lon qilmaydi. Faqat `teacher_live_view()` chaqiradi — o'quvchi yo'li bu
# skriptga umuman murojaat qilmaydi.
# KEYS: 1 state, 2 members, 3 votes, 4 dist, 5 by, 6 cnt, 7 text, 8 hidden
# ARGV: 1 poll_id | '', 2 open_id | ''
_LUA_TEACHER_VIEW: Final[str] = _LUA_IA_PRELUDE + """
local pp, ou = 'null', 'null'
if ARGV[1] ~= '' then
  local poll = active(KEYS[1], 'active_poll', 'poll_id', ARGV[1])
  if poll then pp = poll_progress(poll, KEYS[3], KEYS[4], KEYS[2]) end
end
if ARGV[2] ~= '' then
  local open = active(KEYS[1], 'active_open', 'open_id', ARGV[2])
  if open then ou = open_update(open, KEYS[5], KEYS[6], KEYS[7], KEYS[8], KEYS[2]) end
end
return {pp, ou}
"""


# Snapshotga (ya'ni `ROOM_STATE_SYNC` ga) chiqishi mumkin bo'lgan maydonlar.
# `active_quiz_secret` bu ro'yxatda YO'Q va hech qachon bo'lmasligi kerak.
PUBLIC_STATE_FIELDS: Final[tuple[str, ...]] = (
    "seq",
    "status",
    "slide_index",
    "slide_type",
    "code",
    "code_rev",
    "is_sharing",
    "active_quiz",
    # v1.2: faqat `*_START` dagi ommaviy maydonlar. Jonli taqsimot (`dist`,
    # `votes`) va OPEN javoblari ALOHIDA kalitlarda — bu ro'yxatga KIRMAYDI.
    "active_poll",
    "active_open",
)

# Quiz ning sir maydonlari: Redis da ALOHIDA maydonda yashaydi va faqat
# `get_active_quiz()` orqali (javobni tekshirish uchun) serverda o'qiladi.
QUIZ_SECRET_FIELDS: Final[tuple[str, ...]] = (
    "correct_option",
    "started_at_ms",
    "points",
)

# `CONFUSED_PING`: 30 s cooldown + 60 s oyna + foiz hisobi, hammasi atomar.
# KEYS[1] = state, KEYS[2] = channel, KEYS[3] = confused, KEYS[4] = cooldown,
# KEYS[5] = members (foiz maxraji)
# ARGV[1] = student_id, ARGV[2] = now_ms, ARGV[3] = oyna chegarasi,
# ARGV[4] = ts, ARGV[5] = TTL, ARGV[6] = cooldown sek
_LUA_CONFUSED: Final[str] = """
if not redis.call('SET', KEYS[4], '1', 'NX', 'EX', ARGV[6]) then
  return {0, 0, 0, ''}
end
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[1])
redis.call('EXPIRE', KEYS[3], ARGV[5])
local count = redis.call('ZCARD', KEYS[3])
local total = redis.call('HLEN', KEYS[5])
local pct = 0
if total > 0 then pct = math.floor((count * 100 / total) + 0.5) end
local seq = redis.call('HINCRBY', KEYS[1], 'seq', 1)
local data = '{"confused_count":' .. count .. ',"percentage":' .. pct .. '}'
local env = '{"v":1,"type":"CONFUSED_PING","seq":' .. seq ..
            ',"ts":' .. ARGV[4] .. ',"data":' .. data .. '}'
redis.call('PUBLISH', KEYS[2], env)
return {1, count, pct, env}
"""

# A'zo qo'shish/o'chirish + e'lon, bitta roundtripda.
# KEYS[1] = state, KEYS[2] = channel, KEYS[3] = members
# ARGV[1] = event type, ARGV[2] = data JSON, ARGV[3] = ts, ARGV[4] = TTL,
# ARGV[5] = 'add'|'del', ARGV[6] = student_id, ARGV[7] = participant JSON ('del' da bo'sh)
_LUA_MEMBER: Final[str] = """
if ARGV[5] == 'add' then
  redis.call('HSET', KEYS[3], ARGV[6], ARGV[7])
else
  redis.call('HDEL', KEYS[3], ARGV[6])
end
redis.call('EXPIRE', KEYS[3], ARGV[4])
local seq = redis.call('HINCRBY', KEYS[1], 'seq', 1)
redis.call('EXPIRE', KEYS[1], ARGV[4])
local env = '{"v":1,"type":"' .. ARGV[1] .. '","seq":' .. seq ..
            ',"ts":' .. ARGV[3] .. ',"data":' .. ARGV[2] .. '}'
redis.call('PUBLISH', KEYS[2], env)
return {seq, env, redis.call('HLEN', KEYS[3])}
"""


# ---------------------------------------------------------------------------
# Snapshot
# ---------------------------------------------------------------------------


@dataclass(slots=True, frozen=True)
class InteractiveResult:
    """POLL/OPEN Lua skriptining natijasi.

    `error` — CONTRACTS.md §16.3 dagi xato kodi (`ALREADY_VOTED`,
    `POLL_NOT_ACTIVE`, `INVALID_OPTION`, `RATE_LIMITED` ...). Bu qatlam WS
    protokolini bilmaydi: kodni `ERROR` kadriga aylantirish `ws/routes.py` da.
    """

    ok: bool
    error: str | None = None
    seq: int = 0
    envelope: str = ""


def _ia_result(raw: Any) -> InteractiveResult:
    items = [x.decode() if isinstance(x, bytes) else x for x in raw]
    if _as_int(items[0]) != 1:
        return InteractiveResult(ok=False, error=str(items[1]))
    return InteractiveResult(ok=True, seq=_as_int(items[1]), envelope=str(items[2]))


@dataclass(slots=True)
class RoomSnapshot:
    """`room:{session_id}:state` ning to'liq o'qilgan nusxasi."""

    seq: int = 0
    status: str = "LOBBY"
    slide_index: int = 0
    slide_type: str = "MARKDOWN"
    code: str = ""
    code_rev: int = 0
    is_sharing: bool = False
    active_quiz: dict[str, Any] | None = None
    active_poll: dict[str, Any] | None = None
    active_open: dict[str, Any] | None = None
    participants: list[dict[str, Any]] = field(default_factory=list)
    confused: ConfusedStats = field(default_factory=ConfusedStats)
    exists: bool = False

    def to_sync_data(self) -> dict[str, Any]:
        """`ROOM_STATE_SYNC.data` — CONTRACTS.md §5 dagi maydonlar aynan."""
        return {
            "status": self.status,
            "slide_index": self.slide_index,
            "code_rev": self.code_rev,
            "code": self.code,
            "slide_type": self.slide_type,
            "is_sharing": self.is_sharing,
            "active_quiz": self.active_quiz,
            # §16.3: faqat `*_START` dagi ommaviy maydonlar. Jonli taqsimot bu
            # obyektga umuman kelmaydi (alohida kalitlarda yashaydi).
            "active_poll": self.active_poll,
            "active_open": self.active_open,
            "participants": self.participants,
            "confused": {
                "count": self.confused.count,
                "percentage": self.confused.percentage,
            },
        }


def _as_int(raw: Any, default: int = 0) -> int:
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def _as_bool(raw: Any) -> bool:
    return str(raw) in {"1", "true", "True"}


def _dumps(data: dict[str, Any]) -> str:
    """Redis HASH ga yoziladigan ixcham JSON."""
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def _public_quiz(parsed: dict[str, Any] | None) -> dict[str, Any] | None:
    """Snapshotga chiqadigan quiz qismi — sir maydonlarsiz.

    ASOSIY himoya bu EMAS: `start_quiz()` sirni alohida maydonga yozadi va
    snapshot Lua si uni o'qiydigan ro'yxatga ham kiritmaydi. Bu qator faqat
    MIGRATSIYA uchun: ikkiga bo'linishdan OLDIN yozilgan `active_quiz`
    kalitlarida (deploy paytida ketayotgan dars) to'liq model turadi, ya'ni
    eski kalit yangi kod ostida ham oqib ketmasligi kerak.
    """
    if parsed is None:
        return None
    return {k: v for k, v in parsed.items() if k not in QUIZ_SECRET_FIELDS}


def _loads_or_none(raw: Any) -> dict[str, Any] | None:
    if not raw or raw in {"null", "{}"}:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


# ---------------------------------------------------------------------------
# RoomState
# ---------------------------------------------------------------------------


class RoomState:
    """Bitta xonaning Redis holati bilan ishlaydigan fasad.

    Har bir `publish*` metodi `(seq, envelope_json)` qaytaradi: `envelope_json`
    allaqachon Pub/Sub ga ketgan to'liq matn, shuning uchun chaqiruvchi uni
    qayta yig'ishi (va qayta seriyalashi) kerak emas.
    """

    __slots__ = (
        "_redis",
        "_sh_code",
        "_sh_confused",
        "_sh_member",
        "_sh_open_answer",
        "_sh_open_end",
        "_sh_open_hide",
        "_sh_poll_end",
        "_sh_poll_vote",
        "_sh_pub",
        "_sh_snap",
        "_sh_teacher_view",
        "session_id",
    )

    def __init__(self, redis: Redis, session_id: str | uuid.UUID) -> None:
        self._redis = redis
        self.session_id = str(session_id)
        self._sh_pub = redis.register_script(_LUA_PUBLISH)
        self._sh_code = redis.register_script(_LUA_CODE_PATCH)
        self._sh_snap = redis.register_script(_LUA_SNAPSHOT)
        self._sh_confused = redis.register_script(_LUA_CONFUSED)
        self._sh_member = redis.register_script(_LUA_MEMBER)
        self._sh_poll_vote = redis.register_script(_LUA_POLL_VOTE)
        self._sh_poll_end = redis.register_script(_LUA_POLL_END)
        self._sh_open_answer = redis.register_script(_LUA_OPEN_ANSWER)
        self._sh_open_hide = redis.register_script(_LUA_OPEN_HIDE)
        self._sh_open_end = redis.register_script(_LUA_OPEN_END)
        self._sh_teacher_view = redis.register_script(_LUA_TEACHER_VIEW)

    # -- kalitlar --------------------------------------------------------

    @property
    def state_key(self) -> str:
        return state_key(self.session_id)

    @property
    def members_key(self) -> str:
        return members_key(self.session_id)

    @property
    def confused_key(self) -> str:
        return confused_key(self.session_id)

    @property
    def channel(self) -> str:
        return channel_key(self.session_id)

    # -- ishga tushirish -------------------------------------------------

    async def ensure(
        self,
        *,
        slide_index: int = 0,
        slide_type: str = "MARKDOWN",
        code: str = "",
        status: str = "LOBBY",
    ) -> None:
        """Xona HASH ini yaratadi. Mavjud maydonlarni **buzmaydi** (`HSETNX`).

        `POST /rooms` da ham, WS ulanishida ham chaqirilishi xavfsiz: Redis
        qayta ishga tushsa holat DB dagi `current_slide_index` dan tiklanadi.
        """
        pipe = self._redis.pipeline(transaction=True)
        pipe.hsetnx(self.state_key, "slide_index", str(slide_index))
        pipe.hsetnx(self.state_key, "slide_type", slide_type)
        pipe.hsetnx(self.state_key, "code", code)
        pipe.hsetnx(self.state_key, "code_rev", "0")
        pipe.hsetnx(self.state_key, "is_sharing", "0")
        pipe.hsetnx(self.state_key, "active_quiz", "")
        pipe.hsetnx(self.state_key, "active_quiz_secret", "")
        pipe.hsetnx(self.state_key, "active_poll", "")
        pipe.hsetnx(self.state_key, "active_open", "")
        pipe.hsetnx(self.state_key, "seq", "0")
        pipe.hsetnx(self.state_key, "status", status)
        pipe.expire(self.state_key, ROOM_TTL_SEC)
        await pipe.execute()

    async def destroy(self) -> None:
        """Sessiya `ENDED` bo'lgach butun xona holatini o'chiradi."""
        await self._redis.delete(self.state_key, self.members_key, self.confused_key)

    # -- o'qish ----------------------------------------------------------

    async def snapshot(self) -> RoomSnapshot:
        """State + members + confused — **bitta** roundtripda."""
        cutoff = now_ms() - CONFUSED_WINDOW_SEC * 1000
        raw_state, raw_members, confused_count, raw_exists = await self._sh_snap(
            keys=[self.state_key, self.members_key, self.confused_key],
            args=[cutoff, *PUBLIC_STATE_FIELDS],
        )
        # `HMGET` tartibni saqlaydi, ya'ni javob `PUBLIC_STATE_FIELDS` bilan
        # pozitsiya bo'yicha mos keladi. Ro'yxatda yo'q maydon (masalan
        # `active_quiz_secret`) bu dict ga tusha olmaydi.
        state: dict[str, str] = {}
        for name, value in zip(PUBLIC_STATE_FIELDS, raw_state, strict=False):
            if value is None:
                continue
            state[name] = value.decode() if isinstance(value, bytes) else str(value)

        participants: list[dict[str, Any]] = []
        for item in raw_members:
            text = item.decode() if isinstance(item, bytes) else item
            parsed = _loads_or_none(text)
            if parsed is not None:
                participants.append(parsed)
        participants.sort(key=lambda p: str(p.get("full_name", "")))

        total = len(participants)
        count = _as_int(confused_count)
        percentage = round(count * 100 / total) if total else 0

        return RoomSnapshot(
            seq=_as_int(state.get("seq")),
            status=state.get("status") or "LOBBY",
            slide_index=_as_int(state.get("slide_index")),
            slide_type=state.get("slide_type") or "MARKDOWN",
            code=state.get("code") or "",
            code_rev=_as_int(state.get("code_rev")),
            is_sharing=_as_bool(state.get("is_sharing")),
            active_quiz=_public_quiz(_loads_or_none(state.get("active_quiz"))),
            active_poll=_loads_or_none(state.get("active_poll")),
            active_open=_loads_or_none(state.get("active_open")),
            participants=participants,
            confused=ConfusedStats(count=count, percentage=percentage),
            exists=bool(_as_int(raw_exists)),
        )

    async def current_seq(self) -> int:
        return _as_int(await self._redis.hget(self.state_key, "seq"))

    async def active_open(self) -> dict[str, Any] | None:
        """Faol OPEN ning ommaviy qismi (`max_chars` ni server o'zi yozgan)."""
        return _loads_or_none(await self._redis.hget(self.state_key, "active_open"))

    async def current_status(self) -> str:
        """Sessiya holati Redis Hash dan (yagona haqiqat manbasi)."""
        raw = await self._redis.hget(self.state_key, "status")  # type: ignore[misc]
        if raw is None:
            return ""
        return raw.decode() if isinstance(raw, bytes) else str(raw)

    async def set_status(self, status: str) -> None:
        """Sessiya holatini Hash da yangilaydi.

        ATAYLAB broadcast QILMAYDI: CONTRACTS.md §5 da holat o'zgarishi uchun
        alohida server→klient eventi yo'q va MVP da protokol yuzasi
        kattalashtirilmaydi. `status` faqat `ROOM_STATE_SYNC` snapshotida
        kerak — qayta ulangan klient dars ketayotganini DARHOL biladi va
        lobbida qotib qolmaydi.
        """
        await self._redis.hset(self.state_key, "status", status)

    async def get_active_quiz(self) -> ActiveQuiz | None:
        """To'liq `ActiveQuiz` — ommaviy va sir qismlar birga yig'iladi.

        Faqat SERVER ishlatadi: javobni tekshirish (`correct_option`) va
        `answer_ms` ni hisoblash (`started_at_ms`). Bu yo'l snapshotdan
        butunlay ajratilgan, shuning uchun sir klientga chiqmaydi.
        """
        raw_public, raw_secret = await self._redis.hmget(  # type: ignore[misc]
            self.state_key, ["active_quiz", "active_quiz_secret"]
        )
        parsed = _loads_or_none(raw_public)
        if parsed is None:
            return None
        # Sir maydoni bo'sh bo'lishi mumkin: ikkiga bo'linishdan OLDIN
        # boshlangan quiz (deploy paytida) butun modelni `active_quiz` da
        # saqlagan. Shunda baholash buzilmasligi uchun eski joydan olinadi.
        secret = _loads_or_none(raw_secret) or {}
        try:
            return ActiveQuiz.model_validate({**parsed, **secret})
        except ValueError:
            return None

    async def member_count(self) -> int:
        return _as_int(await self._redis.hlen(self.members_key))

    # -- umumiy e'lon ----------------------------------------------------

    async def publish(
        self,
        event_type: str,
        data: dict[str, Any],
        *,
        state_updates: dict[str, str] | None = None,
    ) -> tuple[int, str]:
        """`seq` ni atomar oshiradi, holatni yangilaydi va e'lon qiladi."""
        args: list[Any] = [
            event_type,
            json.dumps(data, ensure_ascii=False, separators=(",", ":")),
            now_ms(),
            ROOM_TTL_SEC,
        ]
        for key, value in (state_updates or {}).items():
            args.extend((key, value))
        seq, env = await self._sh_pub(keys=[self.state_key, self.channel], args=args)
        return _as_int(seq), env.decode() if isinstance(env, bytes) else env

    # -- aniq eventlar ---------------------------------------------------

    async def set_slide(self, slide_index: int, slide_type: str) -> tuple[int, str]:
        """`SLIDE_CHANGE` — eng "issiq" yo'l: bitta Lua, bitta roundtrip."""
        return await self.publish(
            "SLIDE_CHANGE",
            {"slide_index": slide_index, "slide_type": slide_type},
            state_updates={"slide_index": str(slide_index), "slide_type": slide_type},
        )

    async def patch_code(
        self, slide_index: int, code: str, cursor: dict[str, int] | None
    ) -> tuple[int, int, str]:
        """`LIVE_CODE_PATCH` — `code_rev` ham atomar oshadi. → `(seq, code_rev, env)`."""
        seq, rev, env = await self._sh_code(
            keys=[self.state_key, self.channel],
            args=[
                str(slide_index),
                code,
                json.dumps(code, ensure_ascii=False),
                json.dumps(cursor, ensure_ascii=False, separators=(",", ":"))
                if cursor
                else "null",
                ROOM_TTL_SEC,
                now_ms(),
            ],
        )
        return _as_int(seq), _as_int(rev), env.decode() if isinstance(env, bytes) else env

    async def laser_move(self, x: float, y: float, drawing: bool) -> tuple[int, str]:
        """`LASER_MOVE` — holatda saqlanmaydi (o'tkinchi), faqat e'lon qilinadi."""
        return await self.publish("LASER_MOVE", {"x": x, "y": y, "drawing": drawing})

    async def set_sharing(self, is_sharing: bool, room_name: str) -> tuple[int, str]:
        return await self.publish(
            "SCREEN_SHARE_STATE",
            {"is_sharing": is_sharing, "room_name": room_name},
            state_updates={"is_sharing": "1" if is_sharing else "0"},
        )

    async def start_quiz(self, quiz: ActiveQuiz) -> tuple[int, str]:
        """`QUIZ_START` — `ends_at` server tomonidan belgilangan (AUDIT.md §G3).

        Holat Redis da ATAYLAB IKKIGA bo'linadi (AUDIT.md §G3, anti-cheat):
        `active_quiz` — snapshotga chiqadigan ommaviy qism,
        `active_quiz_secret` — `correct_option`, `started_at_ms`, `points`.
        Snapshot ikkinchisini o'qimaydi, ya'ni o'quvchi sahifani yangilab
        `ROOM_STATE_SYNC` freymidan to'g'ri javobni ko'rib ola olmaydi.
        """
        public = quiz.to_event_data()
        secret = {field: getattr(quiz, field) for field in QUIZ_SECRET_FIELDS}
        return await self.publish(
            "QUIZ_START",
            public,
            state_updates={
                "active_quiz": _dumps(public),
                "active_quiz_secret": _dumps(secret),
                "slide_index": str(quiz.slide_index),
                "slide_type": "QUIZ",
            },
        )

    async def finish_quiz(self, results: dict[str, Any]) -> tuple[int, str]:
        """`QUIZ_RESULTS` + quiz holati (ommaviy va sir qismi) tozalanadi."""
        return await self.publish(
            "QUIZ_RESULTS",
            results,
            state_updates={"active_quiz": "", "active_quiz_secret": ""},
        )

    # -- v1.2: POLL (CONTRACTS.md §16.3) ---------------------------------

    def _poll_keys(self, poll_id: str) -> tuple[str, str, str]:
        return (
            poll_key(self.session_id, poll_id, "votes"),
            poll_key(self.session_id, poll_id, "dist"),
            poll_key(self.session_id, poll_id, "deadline"),
        )

    def _open_keys(self, open_id: str) -> tuple[str, str, str, str, str]:
        return (
            open_key(self.session_id, open_id, "by"),
            open_key(self.session_id, open_id, "cnt"),
            open_key(self.session_id, open_id, "text"),
            open_key(self.session_id, open_id, "hidden"),
            open_key(self.session_id, open_id, "deadline"),
        )

    async def _register(self, keys: tuple[str, ...], deadline_key: str, deadline_ms: int) -> None:
        """Muddatni yozadi va kalitlarni dars oxiridagi 24 soatlik TTL uchun ro'yxatga oladi."""
        registry = interactive_registry_key(self.session_id)
        pipe = self._redis.pipeline(transaction=True)
        pipe.set(deadline_key, str(deadline_ms), ex=ROOM_TTL_SEC)
        pipe.sadd(registry, *keys)
        pipe.expire(registry, ROOM_TTL_SEC)
        await pipe.execute()

    async def start_poll(self, public: dict[str, Any], deadline_ms: int) -> tuple[int, str]:
        """`POLL_START` — `public` aynan kontraktdagi maydonlar (§16.3).

        `deadline_ms` = `ends_at` + grace; u ommaviy obyektga KIRMAYDI, alohida
        kalitda turadi va ovozni Lua ichida rad etish uchun ishlatiladi.
        Yangi poll faolini almashtiradi (§16.5).
        """
        votes, dist, deadline = self._poll_keys(str(public["poll_id"]))
        await self._register((votes, dist, deadline), deadline, deadline_ms)
        return await self.publish(
            "POLL_START",
            public,
            state_updates={
                "active_poll": _dumps(public),
                "slide_index": str(public["slide_index"]),
                "slide_type": "POLL",
            },
        )

    async def vote_poll(self, poll_id: str, student_id: str, selected_index: int) -> InteractiveResult:
        """Bir o'quvchi — bir ovoz. Tekshiruv va yozish BITTA Lua skriptida."""
        votes, dist, deadline = self._poll_keys(poll_id)
        raw = await self._sh_poll_vote(
            keys=[self.state_key, self.channel, votes, dist, self.members_key, deadline],
            args=[poll_id, student_id, str(selected_index), now_ms(), ROOM_TTL_SEC, now_ms()],
        )
        return _ia_result(raw)

    async def end_poll(self, poll_id: str) -> InteractiveResult:
        """`POLL_RESULTS` — `total = sum(distribution)` (§16.5)."""
        _, dist, _ = self._poll_keys(poll_id)
        raw = await self._sh_poll_end(
            keys=[self.state_key, self.channel, dist],
            args=[poll_id, now_ms(), ROOM_TTL_SEC],
        )
        return _ia_result(raw)

    # -- v1.2: OPEN (CONTRACTS.md §16.3) ---------------------------------

    async def start_open(self, public: dict[str, Any], deadline_ms: int) -> tuple[int, str]:
        by, cnt, text, hidden, deadline = self._open_keys(str(public["open_id"]))
        await self._register((by, cnt, text, hidden, deadline), deadline, deadline_ms)
        return await self.publish(
            "OPEN_START",
            public,
            state_updates={
                "active_open": _dumps(public),
                "slide_index": str(public["slide_index"]),
                "slide_type": "OPEN",
            },
        )

    async def answer_open(self, open_id: str, student_id: str, text: str) -> InteractiveResult:
        """`text` — allaqachon TOZALANGAN matn (`sanitize_open_text`).

        `student_id` faqat ichki `by` HASH ida (oxirgi javobni almashtirish
        uchun) — hech qaysi eventga chiqmaydi (§16.3, anonimlik).
        """
        by, cnt, text_key, hidden, deadline = self._open_keys(open_id)
        rate_key = open_key(self.session_id, open_id, f"rl:{student_id}")
        raw = await self._sh_open_answer(
            keys=[
                self.state_key, self.channel, by, cnt, text_key, hidden,
                self.members_key, rate_key, deadline,
            ],
            args=[
                open_id, student_id, open_answer_id(open_id, text), text, now_ms(),
                ROOM_TTL_SEC, OPEN_ANSWER_INTERVAL_MS, now_ms(),
            ],
        )
        return _ia_result(raw)

    async def hide_open(self, open_id: str, answer_id: str) -> InteractiveResult:
        by, cnt, text_key, hidden, _ = self._open_keys(open_id)
        raw = await self._sh_open_hide(
            keys=[self.state_key, self.channel, by, cnt, text_key, hidden, self.members_key],
            args=[open_id, answer_id, now_ms(), ROOM_TTL_SEC],
        )
        return _ia_result(raw)

    async def end_open(self, open_id: str) -> InteractiveResult:
        _, cnt, text_key, hidden, _ = self._open_keys(open_id)
        raw = await self._sh_open_end(
            keys=[self.state_key, self.channel, cnt, text_key, hidden],
            args=[open_id, now_ms(), ROOM_TTL_SEC],
        )
        return _ia_result(raw)

    # -- v1.2: o'qituvchi snapshoti (CONTRACTS.md §16.3 K4) -------------

    async def teacher_live_view(self) -> dict[str, Any]:
        """FAQAT o'qituvchi uchun: `{poll_progress, open_update}`.

        `snapshot()` ga ATAYLAB qo'shilmagan: o'quvchi yo'li bu metodga umuman
        murojaat qilmaydi va jonli taqsimot kalitlarini jismonan o'qiy olmaydi.
        Shakllar `POLL_PROGRESS`/`OPEN_UPDATE` data si bilan aynan bir xil —
        qayta ulangan o'qituvchi diagrammani yo'qotmaydi (alohida
        `POLL_PROGRESS` yuborish ishlamasdi: §5.3, `seq <= last_seq` tashlanadi).
        """
        raw_poll, raw_open = await self._redis.hmget(  # type: ignore[misc]
            self.state_key, ["active_poll", "active_open"]
        )
        poll = _loads_or_none(raw_poll) or {}
        open_ = _loads_or_none(raw_open) or {}
        poll_id = str(poll.get("poll_id") or "")
        open_id = str(open_.get("open_id") or "")
        if not poll_id and not open_id:
            return {"poll_progress": None, "open_update": None}

        votes, dist, _ = self._poll_keys(poll_id or "-")
        by, cnt, text_key, hidden, _ = self._open_keys(open_id or "-")
        raw = await self._sh_teacher_view(
            keys=[self.state_key, self.members_key, votes, dist, by, cnt, text_key, hidden],
            args=[poll_id, open_id],
        )
        progress, update = (x.decode() if isinstance(x, bytes) else x for x in raw)
        return {"poll_progress": json.loads(progress), "open_update": json.loads(update)}

    async def retain_interactive(self, ttl_sec: int = INTERACTIVE_RETAIN_SEC) -> int:
        """Dars TUGAGACH poll/open kalitlariga 24 soatlik TTL (§16.3).

        `destroy()` bu kalitlarni o'chirmaydi — ular xona HASH idan alohida.
        """
        registry = interactive_registry_key(self.session_id)
        members = await self._redis.smembers(registry)  # type: ignore[misc]
        keys = [m.decode() if isinstance(m, bytes) else str(m) for m in members]
        pipe = self._redis.pipeline(transaction=False)
        for key in keys:
            pipe.expire(key, ttl_sec)
        pipe.expire(registry, ttl_sec)
        await pipe.execute()
        return len(keys)

    async def quiz_progress(self, quiz_id: str, answered: int, total: int) -> tuple[int, str]:
        return await self.publish(
            "QUIZ_PROGRESS", {"quiz_id": quiz_id, "answered": answered, "total": total}
        )

    async def focus_change(
        self, student_id: str, is_focused: bool, tab_switches_count: int
    ) -> tuple[int, str]:
        return await self.publish(
            "FOCUS_CHANGE",
            {
                "student_id": student_id,
                "is_focused": is_focused,
                "tab_switches_count": tab_switches_count,
            },
        )

    async def session_ended(self) -> tuple[int, str]:
        return await self.publish("SESSION_ENDED", {"session_id": self.session_id})

    # -- a'zolar ---------------------------------------------------------

    async def add_member(self, participant: Participant) -> tuple[int, str, int]:
        """`STUDENT_JOINED` + members HASH. → `(seq, env, a'zolar soni)`."""
        data = participant.model_dump(mode="json")
        seq, env, total = await self._sh_member(
            keys=[self.state_key, self.channel, self.members_key],
            args=[
                "STUDENT_JOINED",
                json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                now_ms(),
                ROOM_TTL_SEC,
                "add",
                str(participant.student_id),
                json.dumps(data, ensure_ascii=False, separators=(",", ":")),
            ],
        )
        return _as_int(seq), env.decode() if isinstance(env, bytes) else env, _as_int(total)

    async def remove_member(self, student_id: str | uuid.UUID) -> tuple[int, str, int]:
        """`STUDENT_LEFT` + members HASH dan o'chirish."""
        seq, env, total = await self._sh_member(
            keys=[self.state_key, self.channel, self.members_key],
            args=[
                "STUDENT_LEFT",
                json.dumps({"student_id": str(student_id)}, separators=(",", ":")),
                now_ms(),
                ROOM_TTL_SEC,
                "del",
                str(student_id),
                "",
            ],
        )
        return _as_int(seq), env.decode() if isinstance(env, bytes) else env, _as_int(total)

    # -- confused --------------------------------------------------------

    async def mark_confused(
        self, student_id: str | uuid.UUID
    ) -> tuple[bool, int, int, str]:
        """→ `(qabul_qilindi, count, percentage, env)`.

        `qabul_qilindi=False` bo'lsa — 30 s cooldown hali tugamagan, hech narsa
        e'lon qilinmadi. Ping **anonim**: `student_id` faqat ZSET ichida qoladi,
        e'londa chiqmaydi.
        """
        accepted, count, pct, env = await self._sh_confused(
            keys=[
                self.state_key,
                self.channel,
                self.confused_key,
                confused_cooldown_key(self.session_id, student_id),
                self.members_key,
            ],
            args=[
                str(student_id),
                now_ms(),
                now_ms() - CONFUSED_WINDOW_SEC * 1000,
                now_ms(),
                ROOM_TTL_SEC,
                CONFUSED_COOLDOWN_SEC,
            ],
        )
        text = env.decode() if isinstance(env, bytes) else env
        return bool(_as_int(accepted)), _as_int(count), _as_int(pct), text


# ---------------------------------------------------------------------------
# Bir martalik WS ticket (AUDIT.md §B3)
# ---------------------------------------------------------------------------


async def issue_ticket(redis: Redis, user_id: str | uuid.UUID) -> str:
    """`ws:ticket:{ticket}` → `user_id`, TTL 30 s. JWT WS URL ga tushmaydi.

    Ticket ning o'zi `app.core.security.generate_ws_ticket()` (crypto-secure,
    auth-engineer) orqali yaratiladi — bu yerda qayta ixtiro qilinmaydi.
    """
    ticket = generate_ws_ticket()
    await redis.set(ticket_key(ticket), str(user_id), ex=TICKET_TTL_SEC)
    return ticket


# `GETDEL` Redis >= 6.2 da bor; prod serverlarda 6.0 ham uchraydi (Ubuntu 22.04
# apt paketi), shuning uchun bir martalik o'qish Lua bilan — xuddi shunday atomar.
_LUA_GETDEL: Final[str] = """
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v
"""


async def atomic_getdel(redis: Redis, key: str) -> str | None:
    """GET + DEL bitta atomar qadamda (Redis 6.0 bilan ham mos)."""
    raw = await redis.eval(_LUA_GETDEL, 1, key)  # type: ignore[misc]
    if raw is None:
        return None
    return raw.decode() if isinstance(raw, bytes) else str(raw)


async def consume_ticket(redis: Redis, ticket: str) -> str | None:
    """Bir martalik ticket. Ikkinchi marta ishlatilsa `None`."""
    if not ticket:
        return None
    return await atomic_getdel(redis, ticket_key(ticket))


__all__ = [
    "CHANNEL_PATTERN",
    "CONFUSED_COOLDOWN_SEC",
    "CONFUSED_WINDOW_SEC",
    "INTERACTIVE_RETAIN_SEC",
    "OPEN_ANSWER_INTERVAL_MS",
    "PUBLIC_STATE_FIELDS",
    "QUIZ_SECRET_FIELDS",
    "ROOM_TTL_SEC",
    "TICKET_TTL_SEC",
    "InteractiveResult",
    "RoomSnapshot",
    "RoomState",
    "channel_key",
    "confused_key",
    "consume_ticket",
    "interactive_registry_key",
    "issue_ticket",
    "members_key",
    "now_ms",
    "open_answer_id",
    "open_key",
    "poll_key",
    "session_id_from_channel",
    "state_key",
    "ticket_key",
]
