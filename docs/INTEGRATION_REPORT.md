# SyncClass — Integratsiya Hisoboti (To'liq O'lchov)

**Sana:** 2026-11-04 · **Muhit:** macOS, PostgreSQL **14.23** (Homebrew `127.0.0.1:5433`, baza: `syncclass`), Redis `127.0.0.1:6379` (Ilova: DB 0, Testlar: DB 15). Node.js 22, Python 3.12.11.

---

## 1. Natija Jadvali (DoD Mezonlari)

| # | Mezon | Talab | Natija | Holat | Dalil |
|---|---|---|---|---|---|
| 1 | Google OAuth & Onboarding | ≤3 klik, 0 OTP, rol eskalatsiyasiz | O'rnatilgan | **O'TDI (Mock/Unit)** | `test_onboarding_ignores_role_escalation`, `test_refresh_revocation`, `test_rate_limit_lockout` o'tdi. |
| 2 | WS kechikish (30 mijoz) | `SLIDE` < 100 ms, `CODE` < 150 ms | `SLIDE` p95 **10.99 ms**, `CODE` p95 **8.45 ms** | **O'TDI ✓** | `scripts/loadtest_ws.py`: 1500 ta slayd va 6000 ta patch o'lchovi (max 23.01 ms va 14.97 ms). |
| 3 | Zero-Disk talabi | Server diskiga 0 bayt (RAM oqimi) | 200 MB oqimda Δ 0 bayt, 0 tempfile | **O'TDI ✓** | `./scripts/verify_zero_disk.sh --local`: 20 ta 10 MB zip, 0 ta mkstemp/TemporaryFile/spool, /tmp va $TMPDIR Δ 0. |
| 4 | AI Pre-Grader qoidalari | Prompt injection himoyasi, penalty=0 | 31 ta qat'iy test | **O'TDI ✓** | `backend/tests/test_ai_rules.py`: kommentli kod ball yo'qotmaydi, sqlite3 qabul, injection zararsizlantirildi, `penalty_applied=0`. |
| 5 | Avtorizatsiya & Guruhlar | P-31 darsiga P-30 kirolmaydi | 403 Forbidden | **O'TDI ✓** | `test_cross_group_access_forbidden`, `test_non_member_student_gets_403_not_in_group`. |
| 6 | Reconnect & Resync | 100% holat tiklanishi | `ROOM_STATE_SYNC` exact | **O'TDI ✓** | `test_reconnect_state_sync_is_exact`, `test_seq_is_monotonic_so_stale_events_are_ignored`. |

---

## 2. To'lqinlar bo'yicha Holat

### 1-To'lqin
- **`db-architect`**: ✅ 11 jadval, 28 indeks, partial unique indekslar (`uq_active_pin`, `uq_latest_sub`), Alembic `0001 -> 0002`, `scripts/seed.py` (25 yozuv, 100% idempotent).
- **`devops-engineer`**: ✅ Dockerfile'lar, Nginx (buferlashsiz 26MB streaming, WS 3600s), Makefile, `.env.example`, `verify_zero_disk.sh`.
- **`frontend-core`**: ✅ Next.js 15 App Router, TypeScript strict, shadcn/ui dizayn tizimi, to'liq DTO va WS tiplari (`types/api.ts`), Auth & Student kabineti sahifalari.

### 2-To'lqin
- **`auth-engineer`**: ✅ Google OAuth2, JWT (HS256), `_HttpxTransport` (requests siz), rate-limiting va lockout, guruhlar CRUD, CSV streaming.
- **`content-engineer`**: ✅ Slaydlar discriminated union (`MarkdownSlide | CodeSlide | QuizSlide`), taqdimotlar, R2 ga rasm yuklash va 307 redirect, Quiz va XP hisoblash.
- **`storage-engineer`**: ✅ `stream_to_memory` (BytesIO), zip bomb / traversal himoyasi (`zip_extractor`), Cloudflare R2 va Telegram backup, uy vazifalari topshirish va baholash.
- **`realtime-engineer`**: ✅ Redis Hash yagona haqiqat manbasi, atomar `seq` va `code_rev`, global PubSub listener, LiveKit ruxsatlar guardi, yuklama testi (`loadtest_ws.py`).
- **`frontend-live`**: ✅ Zustand store (`useLiveRoom`), WS auto-reconnect, Shiki read-only + Monaco teacher, Quiz modali, Lazer interpolyatsiyasi, Mobile Companion.
- **`frontend-reviewer`**: ✅ O'qituvchi tekshiruv paneli: Split-Screen IDE, fayllar daraxti, `AiVerdictCard`, `GradePanel`, e'tiroz bildirish (`AppealNotice`), Slide Builder.

### 3-To'lqin
- **`ai-grader-engineer`**: ✅ Claude structured output (`tools`), prompt injection `<student_code>` izolatsiyasi, `arq` background worker (`grade_submission`, `backup_to_telegram`), adolatli baholash qoidalari.

### 4-To'lqin
- **`qa-integrator`**: ✅ Barcha 184 ta backend testi yashil (**184 passed in 10.50s**), `ruff check` toza, frontend `npm run build` muvaffaqiyatli (18 ta sahifa), yuklama va zero-disk isbotlari bajarildi.

---

## 3. Sinov va Metrikalar

1. **Backend Tests:**
   * `backend/tests/test_ai_rules.py`: 31 passed
   * `backend/tests/test_auth_guards.py`: 7 passed
   * `backend/tests/test_slides_quiz.py`: 70 passed
   * `backend/tests/test_ws_sync.py`: 13 passed
   * `backend/tests/test_zip_guard.py`: 63 passed
   * **Jami:** 184 passed.

2. **Frontend Build & Types:**
   * `npm run typecheck` (`tsc --noEmit`): 0 xato.
   * `npm run build`: 18 ta marshrut to'liq optimizatsiya qilingan va statik/dinamik sahifalar generatsiya qilindi.

3. **Real-time Latency (30 parallel mijoz):**
   * `SLIDE_CHANGE`: p50 = 3.72 ms, p95 = **10.99 ms** (chegara 100 ms).
   * `LIVE_CODE_PATCH`: p50 = 4.88 ms, p95 = **8.45 ms** (chegara 150 ms).

4. **Zero-Disk Streaming:**
   * 20 × 10 MB (200 MB) zip fayl RAM orqali uzatildi.
   * `tempfile.mkstemp` / `TemporaryFile` / `spool_rollover`: **0 ta**.
   * `/tmp`, `$TMPDIR`, `backend/` kataloglarida hajm o'zgarishi: **Δ 0 bayt**.

