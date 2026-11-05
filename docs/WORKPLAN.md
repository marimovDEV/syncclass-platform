# SyncClass — Ish Rejasi va Jamoa

## Nega bunday bo'lindi

11 ta mutaxassis **fayl egaligi** bo'yicha ajratilgan (`CONTRACTS.md` §0). Parallel
ishlaganda bir faylga ikki agent tegmaydi, demak merge konflikti ham bo'lmaydi.
Bog'liqlik faqat **kontrakt** darajasida: hamma `CONTRACTS.md` ga qaraydi, bir-birining
kodiga emas.

## To'lqinlar (dependency graph)

```
1-TO'LQIN (parallel, bog'liqliksiz)
├── db-architect ........... models, alembic, seed      → butun backend shunga tayanadi
├── devops-engineer ........ docker, nginx, env, make
└── frontend-core .......... config, types, api, auth UI → ikki frontend agenti shunga tayanadi

2-TO'LQIN (1-to'lqindan keyin, parallel)
├── auth-engineer .......... security, deps, auth, groups        [db kerak]
├── content-engineer ....... slide schema, presentations, quiz   [db kerak]
├── storage-engineer ....... upload guard, zip, r2, tg, homeworks[db kerak]
├── realtime-engineer ...... room_state, ws, rooms API           [db + quiz kerak]
├── frontend-live .......... store, hooks, live room             [types kerak]
└── frontend-reviewer ...... teacher panel, split-screen IDE     [types kerak]

3-TO'LQIN
└── ai-grader-engineer ..... ai_grader, worker, AI testlari      [db + storage kerak]

4-TO'LQIN
└── qa-integrator .......... kontrakt auditi, build, DoD isboti  [hammasi kerak]
```

## Holat

| To'lqin | Agent | Holat |
|---|---|---|
| 1 | db-architect | ✅ tugadi — 11 jadval, 28 index, migratsiya+seed Postgres 16 da tekshirilgan |
| 1 | devops-engineer | ✅ 14 fayl; **ikki image ham qurildi** (backend 564MB, frontend 350MB); host portlari env orqali |
| 1 | frontend-core | ✅ 53 fayl, `tsc`+`build`+`next lint` 0 xato, union exhaustiveness isbotlangan |
| 2 | auth-engineer | ✅ 7 test + qo'lda smoke (OAuth state, JWKS, invite, CSV) |
| 2 | content-engineer | ✅ 70 test (asset redirect + 8 ta traversal testi bilan) |
| 2 | storage-engineer | ✅ 63 test; zero-disk **determinant** isbotlangan (0 ta tempfile chaqiruvi, 200 MB oqimda) |
| 2 | realtime-engineer | ✅ tugadi — Redis Hash state, Pub/Sub fan-out, WS loadtest p95 10.99ms/8.45ms |
| 2 | frontend-live | ✅ tugadi — useLiveRoom, WS hooks, Shiki/Monaco, laser overlay, Mobile Companion |
| 2 | frontend-reviewer | ✅ tugadi — SplitScreenIDE, FileTree, AiVerdictCard, GradePanel, SlideBuilder |
| 3 | ai-grader-engineer | ✅ tugadi — Claude structured output, injection himoyasi, arq worker, 31 ta qoida testi |
| 4 | qa-integrator | ✅ tugadi — 184 ta pytest yashil, tsc 0 xato, npm run build (18 ta sahifa) toza |

## Lead (texnik rahbar) o'zi yozgan fayllar

`backend/app/core/{config,errors,logging}.py`, `backend/app/main.py`,
`backend/requirements.txt`, `docs/*`, `README.md`, `.claude/agents/*`.
Bu fayllar **umumiy** — agentlar faqat o'qiydi, o'zgartirmaydi.

## Lead aralashuvlari (tuzatilgan muammolar)

| Kim topdi | Muammo | Tuzatish |
|---|---|---|
| db-architect | `config.py` `TEACHER_EMAIL_ALLOWLIST: list[str]` — pydantic-settings dotenv manbasida JSON deb dekod qilib **butun backendni yiqitardi** (`SettingsError`), validator esa undan keyin ishlaydi → o'lik kod | `Annotated[list[str], NoDecode]` + validator vergulli satr va JSON ni ham qabul qiladi. Uchala formatda tekshirildi |
| db-architect | Kontrakt FK `ON DELETE` ni ko'rsatmagan | `CONTRACTS.md` §2.1 qo'shildi |
| db-architect | `uq_latest_sub` / `uq_active_pin` partial unique ni buzadigan yozuv tartibi hech qayerda yozilmagan | `CONTRACTS.md` §2.2 "Yozish qoidalari" qo'shildi — storage va realtime agentlariga brifingda berildi |
| db-architect | Bu mashinada host 5432 porti band (native Postgres) | Test konteyneri `sc-pg` → **55432**. `.env` da `POSTGRES_PORT=55432` kerak (devops ga uzatildi) |
| db-architect | `alembic.ini` `post_write_hooks` da `ruff` → `Could not find entrypoint` (ruff Rust binary) | Hook bo'sh qoldirildi |
| db-architect | Python 3.14 da `greenlet`/`pydantic-core` wheel yo'q | venv `python3.12`; Dockerfile ham 3.12 |
| devops-engineer | `backend/requirements.txt`: `aiogram==3.15.0` → `pydantic<2.10` talab qiladi, loyihada `pydantic==2.10.4` → `ResolutionImpossible`, `docker compose build backend` va CI yiqilardi | `aiogram==3.16.0`. `pip install --dry-run` bilan tasdiqlandi (exit=0) |
| devops-engineer | `backend/` da ruff konfigi yo'q edi → 6 agentning stil farqi CI ni qizartirardi | `backend/pyproject.toml` yozildi: `[tool.ruff]` (E/W/F/I/UP/B/**ASYNC**/**S**/C4/SIM/RUF) + `[tool.pytest.ini_options] asyncio_mode="auto"` |
| devops-engineer | `LOG_LEVEL` kodda bor, kontraktda yo'q | `CONTRACTS.md` §1 ga qo'shildi |
| lead o'zi | `config.py`/`main.py` da 4 ta lint xatosi (S105 hardcoded dev parol, UP035 `typing.AsyncIterator`, 2× o'lik `noqa`) | Tuzatildi, `ruff check` toza |
| lead o'zi | Host portlari band: 6379 (lokal Redis), 8000, 55432 → `docker compose up` yiqilardi | devops ga topshirildi: barcha host portlari `HOST_*_PORT` env orqali, lokal `.env` ga ishlaydigan qiymatlar |
| frontend-core | 🔴 **Route group to'qnashuvi** — Next.js `(guruh)` URL ga segment qo'shmaydi, shuning uchun `app/page.tsx` va `app/(teacher)/page.tsx` ikkisi ham `/` ga, `(student)/homeworks` va `(teacher)/homeworks` esa `/homeworks` ga tushib **build ni yiqitardi** | `CONTRACTS.md` §10 "marshrut kartasi" yozildi: o'qituvchi sahifalari `(teacher)/teacher/**` ostida. §0 egaligi ham yangilandi |
| frontend-core | 🔴 OAuth callback yo'li kontraktga mos emas edi (`/callback` ≠ `/auth/callback`) | Fayl `(auth)/auth/callback/` ga qo'yildi; §10 ga yozildi |
| frontend-core | 🟠 O'quvchi o'z submissionlarini **ko'ra olmaydi** — §4 da listing faqat TEACHER ga berilgan edi → baho, AI xulosasi va e'tiroz oqimi ishlamay qolardi (DoD #4 buzilishi) | §4 yangilandi: STUDENT ham so'rov yuboradi, javob `student_id = current_user.id` bilan filtrlanadi. `storage-engineer` ga uzatildi |
| frontend-core | 🟡 §0 ziddiyatli: `lib/**` frontend-core ga berilgan, lekin izohda `lib/api.ts` "lead yozadi" deyilgan | §0 tuzatildi — butun `lib/**` frontend-core egaligida |
| lead o'zi | Frontend agentlariga 53 faylni qayta o'qish kerak edi | `docs/FRONTEND_HANDOFF.md` yozildi — barcha eksportlar, UI kit, dizayn tokenlari, doimiylar xaritasi |
| content-engineer | 🟠 `POST /presentations/{id}/assets` presigned URL qaytarardi → **15 daqiqada o'ladi**, slayddagi rasm keyingi darsda ochilmaydi | §4 yangilandi: barqaror `BACKEND_PUBLIC_URL/api/v1/presentations/{id}/assets/{key}` + `GET` → 307 redirect yangi presigned URL ga. Bucket xususiy qoladi |
| auth-engineer | `google-auth` ning `transport.requests` moduli `requests` paketini talab qiladi, u `requirements.txt` da yo'q → `ImportError` | Agent `httpx` ustida `_HttpxTransport` yozdi (google interfeysiga mos) va JWKS dan 200 javob olinishini isbotladi. Qo'shimcha dependency kerak emas |
| auth-engineer | Redis kalitlari (`revoked:token:*`, `ratelimit:*:fail/lock`) va **xato kodlari ro'yxati** kontraktda yo'q edi | `CONTRACTS.md` §5 to'ldirildi + **§5.1 xato kodlari** bo'limi yozildi (frontend `ERROR_CODE_LABELS` shunga tayanadi) |
| lead o'zi | `app/db/` da 4 ta ruff xatosi (RUF022, I001, RUF002 en-dash, UP035) | Tuzatildi → `ruff check app/` **All checks passed**, `pytest tests` → **119 passed** |

## Test holati (lead o'lchagan)

| Qatlam | Natija |
|---|---|
| `ruff check app/` | ✅ All checks passed |
| `pytest tests` | ✅ **119 passed** (auth 7 + slides/quiz 60 + zip guard va boshqalar) |
| `frontend`: `tsc` + `build` + `next lint` | ✅ 0 xato |
| `docker compose config` | ✅ exit 0, 6 servis |
| Alembic upgrade/downgrade/seed | ✅ Postgres 16 da, idempotent, drift yo'q |
| devops-engineer | 🔴 `backend/Dockerfile`: `WORKDIR /app` papkani **root** nomidan yaratadi, `COPY --chown` faqat fayllarni o'zgartiradi → non-root `appuser` `/app/.ruff_cache` ni yarata olmaydi, `make lint` va CI ning konteyner lint'i **har doim yiqilardi** | `RUFF_CACHE_DIR=/tmp/.ruff_cache` + `PYTEST_ADDOPTS="-p no:cacheprovider"` — kesh tmpfs da, `/app` yozuvga ochilmadi (zero-disk ga ham mos) |
| devops-engineer | Host portlari: lead taklif qilgan 8001/6380/5433 ham **band** edi | Agent `lsof` bilan tekshirib bo'sh portlarni tanladi (8002/6381/5434) va `dev_up.sh` ga **port pre-check qadami** qo'shdi — jonli sinaldi |
| devops-engineer | 🟠 `HOST_*` portlari va `POSTGRES_PORT` ning ikki vazifasi kontraktda yo'q | `CONTRACTS.md` **§1.1 infratuzilma o'zgaruvchilari** yozildi; `POSTGRES_PORT` endi faqat konteyner ichidagi port |
| devops-engineer | 🟠 `ruff`: o'zbek imlosidagi `ʻ` (U+2018) ni RUF001/002/003 "ambiguous unicode" deb bloklaydi | `pyproject.toml` da shu uchta qoida o'chirildi — **matn emas, qoida** o'zgartirildi (aks holda imlo buziladi) |
| devops-engineer | 🔴 da'vo: `requests` yo'qligidan `app/api/auth.py` import'da yiqiladi | **ESKIRGAN DA'VO** — lead konteyner ichida hozirgi kod bilan tekshirdi: `app.api.auth` va `app.main` `requests` **siz** import bo'ladi (`_HttpxTransport` orqali). `requirements.txt` ga o'zgartirish kerak emas |

## Konteyner ichida import tekshiruvi (lead, hozirgi kod bilan)

```
OK    app.core.{config,security,deps} · app.db.{models,session}
OK    app.api.{auth,groups,presentations,rooms,homeworks}
OK    app.ws.routes · app.main
OK    app.services.{r2_storage,tg_storage,zip_extractor,upload_guard,quiz}
XATO  app.worker · app.services.ai_grader   -> ai-grader-engineer yozmoqda (oxirgi bo'lak)
```
| storage-engineer | 🔵 **Telegram `getFile` havolasi ichida bot token bo'ladi** — kontraktdagi "fallback Telegram" uni brauzerga berishni ko'zda tutgan edi, bu esa yopiq kanalni to'liq egallashga teng | 10-chi endpoint `GET /submissions/{id}/download` — server proxy, fayl RAM orqali, token klientga chiqmaydi. §4 ga sababi bilan yozildi |
| storage-engineer | Deadline o'tgandan keyingi topshirish bo'yicha kontraktda **qoida yo'q** edi | §11.1: **qabul qilinadi** (pedagogik qaror), `is_late` **hisoblangan** maydon (`submitted_at > deadline`) — migratsiya kerak emas. Ball avtomatik tushmaydi |
| content-engineer | `main.py` (lead fayli): Starlette o'zi ko'taradigan xatolar `{"detail":"Not Found"}` — satr qaytaradi, `{detail:{code,...}}` konverti emas; frontend `code` ga tayanadi | `main.py` ga global `StarletteHTTPException` + `RequestValidationError` handlerlari qo'shildi; Pydantic xatolari `fields` lug'atiga aylanadi |
| content-engineer | Asset GET uchun lead `get_current_user` tavsiya qilgan edi — agent asosli chetlashdi: brauzer `<img>` tegi `Authorization` sarlavhasini **yubormaydi**, ya'ni har bir slayd rasmi 401 bo'lardi | Qabul qilindi: tasodifiy UUID li "capability URL" modeli (presigned URL ham shunday ishlaydi) + qat'iy shablon + prefiks serverda |
