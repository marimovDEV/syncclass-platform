#!/usr/bin/env python
"""Dev seed — IDEMPOTENT (AUDIT.md §H4).

Yaratadi:
  * 1 TEACHER  — teacher@syncclass.local
  * 2 guruh    — P-30 / P30-2026, P-31 / P31-2026
  * 10 o'quvchi — student01..student10@syncclass.local (5+5 guruhlarga bo'linadi)
  * 1 prezentatsiya — 6 slayd: 2 MARKDOWN + 2 CODE + 2 QUIZ (haqiqiy Python mazmuni)
  * 1 homework — deadline = now + 7 kun

Idempotentlik: har obyekt tabiiy kaliti bo'yicha izlanadi (`email`, `groups.name`,
`(teacher_id, title)`, `(group_id, title)`). Hech narsa `DELETE` qilinmaydi,
mavjud yozuvlar ustiga yozilmaydi. Qayta ishga tushirsa — 0 ta yangi yozuv.

Ishga tushirish:
    python scripts/seed.py
"""

from __future__ import annotations

import asyncio
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

# `app.*` ni import qilish uchun backend/ ni sys.path ga qo'shamiz.
_BACKEND = Path(__file__).resolve().parent.parent / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from sqlalchemy import select  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

from app.db.models import (  # noqa: E402
    Group,
    GroupMember,
    Homework,
    Presentation,
    User,
    UserRole,
)
from app.db.session import AsyncSessionLocal, engine  # noqa: E402

TEACHER_EMAIL = "teacher@syncclass.local"
PRESENTATION_TITLE = "Python asoslari — ro'yxatlar va lug'atlar"
HOMEWORK_TITLE = "Uy ishi #1 — Ro'yxat bilan amallar"

GROUPS: list[dict[str, str]] = [
    {"name": "P-30", "course_title": "Python Backend (asosiy oqim)", "invite_code": "P30-2026"},
    {"name": "P-31", "course_title": "Python Backend (kechki oqim)", "invite_code": "P31-2026"},
]

STUDENTS: list[dict[str, str]] = [
    {"email": "student01@syncclass.local", "full_name": "Aziza Karimova"},
    {"email": "student02@syncclass.local", "full_name": "Bekzod Rahimov"},
    {"email": "student03@syncclass.local", "full_name": "Dilnoza Yusupova"},
    {"email": "student04@syncclass.local", "full_name": "Eldor Qosimov"},
    {"email": "student05@syncclass.local", "full_name": "Farida Tosheva"},
    {"email": "student06@syncclass.local", "full_name": "G'ayrat Sobirov"},
    {"email": "student07@syncclass.local", "full_name": "Hilola Nazarova"},
    {"email": "student08@syncclass.local", "full_name": "Islom Tursunov"},
    {"email": "student09@syncclass.local", "full_name": "Jasmina Ortiqova"},
    {"email": "student10@syncclass.local", "full_name": "Kamron Ashurov"},
]

# CONTRACTS.md §3 — discriminated union (`type` bo'yicha).
SLIDES: list[dict[str, Any]] = [
    {
        "index": 0,
        "type": "MARKDOWN",
        "title": "Ro'yxat (list) nima?",
        "content": (
            "## Ro'yxat — tartiblangan, o'zgaruvchan to'plam\n\n"
            "- Elementlar **tartibi saqlanadi**, indeks `0` dan boshlanadi\n"
            "- Ro'yxat **mutable**: yaratilgandan keyin o'zgartirish mumkin\n"
            "- Ichida har xil tipdagi qiymatlar bo'lishi mumkin\n\n"
            '```python\nkurs = ["Python", 2026, True]\nprint(kurs[0])  # Python\n```\n\n'
            "> Eslatma: `kurs[-1]` — oxirgi element."
        ),
        "notes": "Indeksni doskada chizib ko'rsatish: 0,1,2 va -1,-2,-3.",
    },
    {
        "index": 1,
        "type": "CODE",
        "title": "Ro'yxatga element qo'shish",
        "code_lang": "python",
        "starter_code": (
            "# Vazifa: ro'yxatga 3 ta shahar qo'shing va uzunligini chiqaring.\n"
            "shaharlar = []\n\n"
            'shaharlar.append("Toshkent")\n'
            'shaharlar.append("Samarqand")\n'
            'shaharlar.append("Buxoro")\n\n'
            "print(shaharlar)\n"
            'print("Jami:", len(shaharlar))\n'
        ),
        "notes": "append() bitta element qo'shadi, extend() esa butun ketma-ketlikni.",
    },
    {
        "index": 2,
        "type": "QUIZ",
        "title": "Indekslashni tekshiramiz",
        "question": "sonlar = [10, 20, 30, 40] bo'lsa, sonlar[-2] nimani qaytaradi?",
        "options": ["10", "20", "30", "40"],
        "correct_option": 2,
        "duration_sec": 30,
        "points": 100,
    },
    {
        "index": 3,
        "type": "MARKDOWN",
        "title": "Lug'at (dict) — kalit/qiymat",
        "content": (
            "## Lug'at — kalit orqali tez kirish\n\n"
            "| Amal | Sintaksis | Murakkablik |\n"
            "|---|---|---|\n"
            '| O\'qish | `d["kalit"]` | O(1) |\n'
            '| Yozish | `d["kalit"] = qiymat` | O(1) |\n'
            '| Xavfsiz o\'qish | `d.get("kalit", default)` | O(1) |\n\n'
            "Kalit **immutable** bo'lishi shart: `str`, `int`, `tuple` mumkin; "
            "`list` **mumkin emas**."
        ),
        "notes": "Nega list kalit bo'lolmaydi — hash qilinmaydi, deb tushuntirish.",
    },
    {
        "index": 4,
        "type": "CODE",
        "title": "Lug'at bo'yicha iteratsiya",
        "code_lang": "python",
        "starter_code": (
            "# Vazifa: har bir o'quvchining o'rtacha bahosini chiqaring.\n"
            "baholar = {\n"
            '    "Aziza": [90, 85, 100],\n'
            '    "Bekzod": [70, 75, 80],\n'
            "}\n\n"
            "for ism, royxat in baholar.items():\n"
            "    ortacha = sum(royxat) / len(royxat)\n"
            '    print(f"{ism}: {ortacha:.1f}")\n'
        ),
        "notes": "items() -> (kalit, qiymat) juftliklari. f-string formatlashni eslatish.",
    },
    {
        "index": 5,
        "type": "QUIZ",
        "title": "Xavfsiz o'qish",
        "question": ('d = {"a": 1} bo\'lsa, qaysi variant XATO (KeyError) BERMAYDI?'),
        "options": ['d["b"]', 'd.get("b")', 'd.pop("b")', 'del d["b"]'],
        "correct_option": 1,
        "duration_sec": 25,
        "points": 100,
    },
]


async def _get_or_create_user(
    db: AsyncSession, *, email: str, full_name: str, role: UserRole
) -> tuple[User, bool]:
    """`email` tabiiy kalit. Mavjud bo'lsa — qaytaradi, YANGILAMAYDI."""
    user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if user is not None:
        return user, False
    user = User(
        google_id=f"seed-{email}",
        email=email,
        full_name=full_name,
        role=role,
        is_onboarded=True,
        is_active=True,
    )
    db.add(user)
    await db.flush()
    return user, True


async def _get_or_create_group(
    db: AsyncSession, *, spec: dict[str, str], teacher: User
) -> tuple[Group, bool]:
    group = (await db.execute(select(Group).where(Group.name == spec["name"]))).scalar_one_or_none()
    if group is not None:
        return group, False
    group = Group(
        name=spec["name"],
        course_title=spec["course_title"],
        invite_code=spec["invite_code"],
        teacher_id=teacher.id,
        is_active=True,
    )
    db.add(group)
    await db.flush()
    return group, True


async def _ensure_member(db: AsyncSession, *, group: Group, student: User) -> bool:
    exists = (
        await db.execute(
            select(GroupMember.id).where(
                GroupMember.group_id == group.id, GroupMember.student_id == student.id
            )
        )
    ).scalar_one_or_none()
    if exists is not None:
        return False
    db.add(GroupMember(group_id=group.id, student_id=student.id))
    await db.flush()
    return True


async def seed() -> dict[str, int]:
    created = {
        "users": 0,
        "groups": 0,
        "group_members": 0,
        "presentations": 0,
        "homeworks": 0,
    }

    async with AsyncSessionLocal() as db:
        # --- 1. O'qituvchi ---
        teacher, is_new = await _get_or_create_user(
            db, email=TEACHER_EMAIL, full_name="Ogabek Ustoz", role=UserRole.TEACHER
        )
        created["users"] += int(is_new)

        # --- 2. Guruhlar ---
        groups: list[Group] = []
        for spec in GROUPS:
            group, is_new = await _get_or_create_group(db, spec=spec, teacher=teacher)
            created["groups"] += int(is_new)
            groups.append(group)

        # --- 3. O'quvchilar + a'zolik (5 ta P-30 ga, 5 ta P-31 ga) ---
        for i, spec in enumerate(STUDENTS):
            student, is_new = await _get_or_create_user(
                db, email=spec["email"], full_name=spec["full_name"], role=UserRole.STUDENT
            )
            created["users"] += int(is_new)
            target = groups[0] if i < 5 else groups[1]
            created["group_members"] += int(await _ensure_member(db, group=target, student=student))

        # --- 4. Prezentatsiya (6 slayd: 2 MARKDOWN + 2 CODE + 2 QUIZ) ---
        presentation = (
            await db.execute(
                select(Presentation).where(
                    Presentation.teacher_id == teacher.id,
                    Presentation.title == PRESENTATION_TITLE,
                )
            )
        ).scalar_one_or_none()
        if presentation is None:
            presentation = Presentation(
                teacher_id=teacher.id,
                title=PRESENTATION_TITLE,
                module_number=1,
                lesson_number=4,
                schema_version=1,
                slides_data=SLIDES,
            )
            db.add(presentation)
            await db.flush()
            created["presentations"] += 1

        # --- 5. Uy ishi (deadline +7 kun) ---
        homework = (
            await db.execute(
                select(Homework).where(
                    Homework.group_id == groups[0].id, Homework.title == HOMEWORK_TITLE
                )
            )
        ).scalar_one_or_none()
        if homework is None:
            db.add(
                Homework(
                    group_id=groups[0].id,
                    session_id=None,
                    title=HOMEWORK_TITLE,
                    description=(
                        "`shaharlar` ro'yxatini yarating, unga kamida 5 ta shahar qo'shing, "
                        "so'ng:\n"
                        "1. ro'yxatni alifbo tartibida saralang;\n"
                        "2. nomi 10 harfdan uzun shaharlarni alohida ro'yxatga ajratib oling;\n"
                        "3. natijani lug'at ko'rinishida chiqaring: "
                        '`{"jami": N, "uzun": [...]}`.\n\n'
                        "Faylni `main.py` nomi bilan yoki zip arxiv ko'rinishida yuklang."
                    ),
                    deadline=datetime.now(UTC) + timedelta(days=7),
                    max_score=100,
                    ai_penalty_points=30,
                    allow_resubmit=True,
                    created_by=teacher.id,
                )
            )
            created["homeworks"] += 1

        await db.commit()

    return created


async def main() -> None:
    created = await seed()
    total = sum(created.values())
    print("--- SyncClass seed ---")
    for key, value in created.items():
        print(f"  {key:<16} yangi: {value}")
    if total == 0:
        print("Natija: hammasi allaqachon mavjud edi — DUBLIKAT YARATILMADI (idempotent).")
    else:
        print(f"Natija: jami {total} ta yangi yozuv yaratildi.")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
