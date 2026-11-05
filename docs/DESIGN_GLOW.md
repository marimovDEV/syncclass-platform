# SyncClass — "Glow" dizayn spetsifikatsiyasi (v1)

**Talab (foydalanuvchi):** saytni "glow" uslubida qaytadan yaxshilash.
**Manba:** `ui-ux-pro-max` (Aurora UI, Dark Mode OLED, Glassmorphism qatorlari) va `frontend-design` yo'riqnomalari. Quyidagi ranglar kontrast bo'yicha **hisoblab tekshirilgan** (pastda).

## 1. G'oya
Jonli dars — "chiroq yoqilgan xona". Qorong'i, chuqur asos; **yorug'lik faqat e'tibor kerak joyda**: jonli indikator, faol slayd, asosiy tugma, quiz taymeri, o'qituvchining aniq harakati. Hamma narsa porlasa, hech narsa ajralib turmaydi — shuning uchun glow **kam va ma'noli** ishlatiladi.

**Qoida №1 (frontend-design):** boylikni bitta joyga sarflang. Yagona "unutilmas" element — **jonli dars holati** (LIVE nishoni, faol slayd ramkasi, taymer halqasi). Qolgan hamma joy tinch va intizomli.

## 2. Qayerda glow BOR va qayerda YO'Q
| Qayerda | Glow | Sabab |
|---|---|---|
| Asosiy (`primary`) tugma, fokus halqasi | **bor** (kuchli) | harakat va klaviatura holati |
| LIVE nishoni, faol slayd ramkasi, quiz/poll taymer halqasi | **bor** (kuchli) | yagona "yorqin" moment |
| Login/onboarding fon (statik aurora) | **bor** (yumshoq) | birinchi taassurot |
| Modal, FloatingDock, yuqori navigatsiya | **shisha** (`backdrop-blur`) | faqat bitta qatlam |
| Kartochka, ro'yxat | nozik chegara nuri (hover/fokusda) | doim emas |
| **Split-Screen IDE (kod tekshiruv), jadvallar, hisobot, kod bloklari** | **YO'Q** | zich ma'lumot — skill: "data-heavy dashboardlarga mos emas"; o'qilish birinchi |
| Uzun matn / markdown | **YO'Q** | `text-shadow` o'qilishni buzadi |

## 3. Ranglar (mavjud tokenlarning qiymatlari almashadi — nomlar o'zgarmaydi)
`src/app/globals.css` dagi kanallar `R G B` formatida. **Yangi tokenlar** (`--surface-2`, `--glow-*`) qo'shiladi, mavjudlari saqlanadi.

**Qorong'i (asosiy; `:root[data-theme='dark']` va `prefers-color-scheme: dark` ikkalasida bir xil):**
| Token | RGB | HEX | Rol |
|---|---|---|---|
| `--bg` | `7 9 22` | #070916 | chuqur tungi ko'k |
| `--surface` | `14 17 38` | #0E1126 | kartochka |
| `--surface-2` *(yangi)* | `22 27 58` | #161B3A | ichma-ich yuza |
| `--border` | `40 46 88` | #282E58 | |
| `--fg` | `236 239 255` | #ECEFFF | |
| `--muted` | `160 168 210` | #A0A8D2 | |
| `--primary` | `139 124 255` | #8B7CFF | binafsha nur |
| `--primary-fg` | `10 8 32` | #0A0820 | |
| `--accent` | `34 211 238` | #22D3EE | firuza (LIVE, taymer) |
| `--accent-fg` | `2 28 34` | #021C22 | |
| `--danger` | `251 113 133` | #FB7185 | o'zgarishsiz |
| `--success` | `52 211 153` | #34D399 | o'zgarishsiz |

**Yorug' (`:root`):** `--bg 244 245 255`, `--surface 255 255 255`, `--surface-2 238 240 255`, `--border 218 221 245`, `--fg 18 22 58`, `--muted 84 92 138`, `--primary 84 66 245`, `--primary-fg 255 255 255`, `--accent 14 116 144`, `--accent-fg 255 255 255`, `--danger 190 18 60`, `--success 4 120 87`. Yorug' rejimda glow **sezilarli kuchsizroq** (soya sifatida, nur emas).

**Glow tokenlari (yangi):**
```css
--glow-primary: 0 0 0 1px rgb(var(--primary) / .45), 0 0 18px rgb(var(--primary) / .35), 0 0 48px rgb(var(--primary) / .18);
--glow-accent:  0 0 0 1px rgb(var(--accent) / .45),  0 0 18px rgb(var(--accent) / .35),  0 0 48px rgb(var(--accent) / .18);
--glow-soft:    0 0 0 1px rgb(var(--primary) / .25), 0 0 24px rgb(var(--primary) / .12);
```
Yorug' rejimda `.45/.35/.18` -> `.25/.15/.06`; `--glow-soft` uchun `.25/.12` -> `.14/.05` (frontend-core tanlagan, qorong'idagi nisbat saqlangan, tasdiqlangan).

**Qo'shimcha tokenlar (frontend-core qo'shgan):** `--shadow-color` (soyalarni literal `rgb(0 0 0)` siz yozish uchun), `--aurora-a1/a2/a3` (aurora kuchi; yorug'da ancha past). Utilitalar: `.glass` (blur 16px, `backdrop-filter` yo'q bo'lsa qattiq fon), `.aurora` (statik), `.hit-44`, `.interactive-glow`.

**Tailwind v3 shkala tuzog'i:** `bg-primary/12` kabi klasslar standart shkalada YO'Q va **jimgina generatsiya bo'lmaydi** — `tsc` ham, lint ham ushlamaydi. Tailwind 3.4.19 shkalasi (`config.full.js` dan o'qilgan): **0 dan 100 gacha 5 qadam** (`/5 /10 /15 ... /95`), ya'ni `/35`, `/45`, `/55` HAQIQIY; `/12`, `/8`, `/14` YO'Q. Boshqa qiymat kerak bo'lsa `[0.12]` ko'rinishi. *(Avvalgi versiyada shkala noto'g'ri, to'liq emas ro'yxat bilan berilgan edi; frontend-reviewer tuzatdi.)*

## 4. Kontrast (hisoblangan, WCAG 2.x)
Qorong'i: fg/bg **17.3**, fg/surface **16.3**, muted/surface **8.0**, muted/surface-2 **7.2**, primary matn/bg **6.1**, primary-fg/primary **6.0**, accent/bg **11.0**, accent-fg/accent **9.8**, danger/surface **6.9**, success/surface **9.7**.
Yorug': fg/bg **16.1**, muted/surface **6.4**, primary/bg **5.6**, primary-fg/primary **6.0**, accent/bg **4.9**, accent-fg/accent **5.4**, danger **6.3**, success **5.5**. Hammasi >= 4.5:1 (asosiy matn >= 7:1).
**Glow kontrast o'rnini bosmaydi:** nur ostidagi matn hisoblangan juftlik bo'yicha o'qiladi; glow'ni matn *ustiga* qo'ymang.

## 5. Shisha va tezlik (kompyuter 8 GB, mobil o'quvchilar)
- `backdrop-filter: blur()` **faqat** modal, FloatingDock, yuqori navigatsiyada va **bir vaqtda ko'pi bilan bitta qatlam**. Kartochkalarda, ro'yxat elementlarida va IDE da YO'Q.
- `blur` qiymati <= 16px. **Animatsiyalanmasin.** Animatsiya faqat `transform` va `opacity`.
- Aurora fon: **statik** `radial-gradient` (2-3 ta) — login/onboarding/landing da. Davomiy animatsiya (8-12 s) faqat bosh sahifa hero da va `prefers-reduced-motion: no-preference` bo'lganda.
- `@media (prefers-reduced-motion: reduce)`: glow **qoladi** (statik), pulsatsiya va aurora animatsiyasi o'chadi.
- Fokus halqasi: `outline` yo'qolmasin; glow unga **qo'shimcha**. Ko'rinadigan klaviatura fokusi shart.
- Tegish maydonlari >= 44x44 px.

## 6. Shrift
**Inter + JetBrains Mono saqlanadi.** Yangi shrift qo'shilmaydi: `next/font/google` build vaqtida tarmoqdan yuklaydi, bu loyihada Docker konteynerlari ichida tarmoq muammosi bo'lgan (PAC proxy). Shriftni o'zgartirish kerak bo'lsa — lokal fayl sifatida (`next/font/local`), alohida qaror bilan. Shaxsiyat shriftdan emas, **o'lcham, og'irlik va oraliqdan** keladi: sarlavhalar `tracking-tight`, katta o'lcham farqi.

## 7. Qilinmasin (frontend-design: "AI tell"lar)
Har kartochkada bir xil nur · har sarlavha ustida KATTA HARFLI eyebrow · hamma joyda gradient matn · bitta so'zni rangli qilib ajratish · har bo'limda fade-slide-up kirish animatsiyasi · hamma narsaga `rounded-2xl` va bir xil soya. Glow — ierarxiya vositasi, bezak emas.

## 8. Qamrov va egalik
| Agent | Fayllar |
|---|---|
| `frontend-core` | `globals.css`, `tailwind.config.*`, `src/components/ui/*`, `src/components/shared/*` (AppShell, LiveShell, ThemeToggle), `(auth)`, `(student)`, `teacher/page.tsx`, login/onboarding |
| `frontend-live` | `src/components/live/*`, `src/app/live/**` (LIVE nishoni, faol slayd ramkasi, taymer halqasi, dock) |
| `frontend-reviewer` | `src/components/reviewer/**`, `src/app/(teacher)/teacher/**` — **faqat tokenlar orqali meros**; IDE va jadvallarga glow QO'SHILMAYDI |

**Hardcoded rang taqiqi:** `#hex`, `rgb()`, `bg-blue-500` kabilar YO'Q — faqat tokenlar. Bosqich oxirida `grep -rnE "#[0-9a-fA-F]{3,8}\b|rgb\(|bg-(red|blue|green|...)-[0-9]" src` natijasi (istisnolar sababi bilan) hisobotga yoziladi.

## 9. Qabul mezoni
1. `tsc` 0 xato, `next lint` toza, `rm -rf .next && npm run build` o'tadi.
2. Kontrast jadvali (4-bo'lim) `globals.css` dagi haqiqiy qiymatlar bilan qayta hisoblanadi.
3. Qorong'i va yorug' rejimda asosiy ekranlar **brauzerda ko'rib** tekshiriladi (skrinshot). Brauzersiz "chiroyli bo'ldi" deb aytilmaydi.
4. `prefers-reduced-motion` va klaviatura bilan yurish tekshiriladi.
