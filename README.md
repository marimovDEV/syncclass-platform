# SyncClass — Interaktiv Jonli Dars va LMS Platformasi

Monorepo: **FastAPI (async) + PostgreSQL 16 + Redis 7 + Next.js 15**.
Jonli dars slaydlari va kod video-striming orqali emas, **WebSocket + Redis** orqali
JSON holat sifatida uzatiladi (`<100 ms`). O'quvchi fayllari ilova diskida saqlanmaydi —
RAM orqali **Cloudflare R2** ga (asosiy) va **Telegram** kanaliga (zahira) ketadi.

## Hujjatlar — shu tartibda o'qing

| Fayl | Nima uchun |
|---|---|
| **`docs/AUDIT.md`** | TZ v1.0 ning chuqur muhandislik auditi: 40+ topilma, har biri qarori bilan. **Avval shuni o'qing.** |
| **`docs/CONTRACTS.md`** | O'zgarmas kontrakt: DB sxemasi, REST, WS protokoli, env, fayl egaligi. Kod yozishdan oldin majburiy. |
| `docs/WORKPLAN.md` | Jamoa, to'lqinlar, bajarilish holati. |
| `docs/INTEGRATION_REPORT.md` | QA integratori yozadi: DoD isboti. |

## Ishga tushirish

```bash
cp .env.example .env     # GOOGLE_*, ANTHROPIC_API_KEY, R2_* ni to'ldiring
make up                  # yoki: docker compose up -d --build
make migrate && make seed
```
- Frontend — http://localhost:3000 (Nginx orqali http://localhost)
- API hujjatlari — http://localhost:8000/docs
- Tirik/tayyor — `/healthz`, `/readyz`

Sirlarsiz ham ko'tariladi: Google OAuth, R2, Telegram va AI o'chirilgan holatda
ishlaydi (tegishli funksiyalar aniq xato qaytaradi, tizim yiqilmaydi).

## Arxitektura qisqacha

```
Brauzer ──HTTP──┐
                ├─> Nginx ──> FastAPI (uvicorn) ──> PostgreSQL
Brauzer ──WS────┘                 │                  Redis (state + Pub/Sub + queue)
                                  ├──> arq worker ──> AI Pre-Grader (Claude)
                                  │                └─> Telegram zahira
                                  └──> Cloudflare R2 (fayllar, presigned URL)
LiveKit SFU <── bir tomonlama ekran/ovoz (o'qituvchi publish, o'quvchi faqat subscribe)
```

### Uch tamoyil va ularning haqiqiy ma'nosi

1. **Zero-Latency Sync** — Redis Hash = yagona haqiqat manbasi; `seq`/`code_rev` versiyalash;
   reconnect da `ROOM_STATE_SYNC` 100% holatni qaytaradi.
2. **Zero-Disk** — "0 bayt" shiori emas, o'lchanadigan talab: Nginx buferlash o'chirilgan,
   `/tmp` tmpfs, oqim RAM ga, canonical nusxa R2 da. `make verify-zero-disk` isbotlaydi.
3. **Adolatli AI** — AI xulosasi **tavsiya**, hukm emas. `penalty_applied` ni faqat o'qituvchi
   yozadi; AI flag dalil (`file:line`) bilan keladi; o'quvchi e'tiroz yuborishi mumkin.

## TZ v1.0 dan ataylab chetlashishlar

| Nima | Nega |
|---|---|
| Telegram → zahira, R2 → asosiy | Telegram `getFile` 20 MB dan katta faylni qaytarmaydi → 25 MB limitda ma'lumot yo'qolardi (`AUDIT.md` §A1) |
| `ADMIN` roli qo'shildi, TEACHER allowlist orqali | Aks holda har kim o'zini o'qituvchi qilib baho qo'yardi (§C1) |
| `quiz_answers`, `grade_audit_log` jadvallari qo'shildi | XP ni cheksiz yig'ish va bahoni izsiz o'zgartirish mumkin edi (§D2, §D7) |
| AI jarimasi avtomatik emas | AI-detektorlar ishonchli emas; soxta ayblash o'quvchiga zarar (§E2) |
| O'quvchi mikrofoni LiveKit token darajasida bloklanadi | Server klient qurilmasini o'chira olmaydi; `canPublish:false` esa niyatni 100% bajaradi (§F) |

## Jamoa (`.claude/agents/`)

`db-architect` · `auth-engineer` · `realtime-engineer` · `content-engineer` ·
`storage-engineer` · `ai-grader-engineer` · `frontend-core` · `frontend-live` ·
`frontend-reviewer` · `devops-engineer` · `qa-integrator`

Har biri o'z fayllariga ega (`CONTRACTS.md` §0) — shu sababli parallel ishlaganda konflikt bo'lmaydi.
