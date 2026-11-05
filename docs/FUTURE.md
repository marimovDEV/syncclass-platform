# SyncClass — MVP dan keyingi ishlar

> Bu ro'yxat "esdan chiqdi" emas — har biri **ongli ravishda** MVP dan tashqariga chiqarilgan,
> sababi bilan. `docs/AUDIT.md` va `docs/CONTRACTS.md` dagi qarorlarning davomi.

| # | Ish | Nega MVP da yo'q | Nima kerak |
|---|---|---|---|
| 1 | **Confused cho'qqilari tarixi** (dars hisobotida) | Redis ZSET ataylab vaqtinchalik va anonim (CONTRACTS §12.2). Jonli indikator ishlaydi | `confused_events(session_id, slide_index, count, at)` jadvali + agregatsiya |
| 2 | **Haqiqiy delta/OT jonli kod** | MVP da 50 ms throttle + `code_rev` kafolatlangan `<100 ms` ni ushlaydi (AUDIT §B1) | CRDT yoki OT (Yjs/ShareDB), konflikt hal qilish |
| 3 | **Prod deploy** (Nginx SSL, Certbot, GitHub Actions deploy) | Foydalanuvchi "lokal Docker dev" ni tanladi | Domen, server, sertifikat, secrets |
| 4 | **Prometheus/Grafana metrikalari** | MVP da strukturaviy JSON log + `X-Request-ID` yetarli (AUDIT §H1) | `/metrics` endpoint, WS gauge lar |
| 5 | **i18n (ru/en)** | UI to'liq o'zbekcha, auditoriya bir tilli | Matnlarni `messages/*.json` ga chiqarish |
| 6 | **O'quvchi kamerasi/mikrofoni (ikki tomonlama)** | TZ ataylab bir tomonlama (shovqin va trafik) | LiveKit tokenida `canPublish` ni rol/ruxsat bilan boshqarish |
| 7 | **Ma'lumotlarni saqlash muddati avtomatizatsiyasi** | Siyosat yozilgan (focus 30 kun, fayllar 1 o'quv yili), cron hali yo'q | `arq` cron: eski `attendances.focus_*` va R2 obyektlarini tozalash |
| 8 | **Slayd turini o'zgartirish (Builder da)** | Ma'lumot yo'qolishi xavfi — frontend-reviewer ataylab qo'ymadi | Migratsiya dialogi (MARKDOWN↔CODE matnini saqlash) |
| 9 | **`BIGINT` PK** (`attendances`, `quiz_answers`) | Kontrakt `INTEGER` deydi, ~2.1 mlrd yetadi (db-architect ogohlantirdi) | `ALTER TYPE` migratsiyasi, o'sish kuzatilgach |
| 10 | **Klient so'rovi bilan `ROOM_STATE_SYNC`** | `seq` uzilishida majburiy qayta ulanish aynan shu natijani beradi (CONTRACTS §13.4) | Yangi klient→server event + versiyalash + test |
| 11 | **Alohida `syncclass_test` Postgres bazasi** | Redis ajratildi (§13.9). Postgres ifloslanishi **o'lchandi: 0** — fixture'lar `uuid4()` suffiks + aniq `DELETE` teardown ishlatadi, `TRUNCATE`/`drop_all` yo'q. Shoshilinch emas | Eng kuchli dalil ifloslanish **emas**, balki `uq_active_pin`: test o'rtada yiqilsa `status <> 'ENDED'` li yetim sessiya qoladi va o'sha PIN haqiqiy darsga to'g'ri kelsa o'qituvchi xona ocha olmaydi (ehtimolligi ~1/900 000, oqibati qaytariladigan). Kerak: `POSTGRES_DB_TEST`, `make test` da alohida bazaga `alembic upgrade head` + seed (testlar seed aktyorlarini **o'qiydi**), `DATABASE_URL` override |

