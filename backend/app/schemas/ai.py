"""AI Pre-Grader kontrakt sxemalari (CONTRACTS.md §7).

Bu yerdagi nomlar kontraktdan **bir harf ham** farq qilmaydi: frontend
`AiVerdict` tipini aynan shu maydonlar bilan kutadi.

QIZIL CHIZIQ (AUDIT.md §E2): bu modulda `penalty_applied` degan maydon
**yo'q va bo'lmaydi**. AI faqat `recommended_penalty` (TAVSIYA) qaytaradi;
haqiqiy jarima `submissions.penalty_applied` ga FAQAT o'qituvchining
`POST /submissions/{id}/grade` chaqiruvida yoziladi.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

#: Model javobini majburlash uchun tool nomi (tool-use / structured output).
AI_VERDICT_TOOL_NAME: str = "submit_verdict"


class AiEvidence(BaseModel):
    """Bitta flag uchun DALIL. Dalilsiz flag UI da ko'rsatilmaydi (AUDIT.md §E2)."""

    model_config = ConfigDict(extra="ignore")

    file: str
    line_start: int = Field(ge=0)
    line_end: int = Field(ge=0)
    reason: str

    @field_validator("file", "reason")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("bo'sh bo'lmasligi kerak")
        return v


class AiVerdict(BaseModel):
    """LLM ning strukturalangan xulosasi (CONTRACTS.md §7).

    `suggested_score` va `recommended_penalty` — **tavsiya**. Hech biri
    o'qituvchi tasdiqlamaguncha bahoga aylanmaydi.
    """

    model_config = ConfigDict(extra="ignore")

    ai_suspected: bool
    ai_confidence_percent: int = Field(ge=0, le=100)
    injection_suspected: bool = False
    summary: str  # o'zbekcha, 3-6 gap
    strengths: list[str] = Field(default_factory=list)
    issues: list[str] = Field(default_factory=list)  # kommentga olingan kod BU YERGA TUSHMAYDI
    evidence: list[AiEvidence] = Field(default_factory=list)
    suggested_score: int = Field(ge=0)  # 0..max_score ga `ai_grader` clamp qiladi
    recommended_penalty: int = Field(default=0, ge=0)  # TAVSIYA, avtomatik qo'llanmaydi

    @field_validator("summary")
    @classmethod
    def _summary_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("summary bo'sh bo'lmasligi kerak")
        return v

    def evidence_as_jsonb(self) -> list[dict[str, Any]]:
        """`submissions.ai_evidence` ustuni uchun ko'rinish."""
        return [e.model_dump() for e in self.evidence]


class GradedFile(BaseModel):
    """`submissions.extracted_files` elementining grader uchun minimal ko'rinishi."""

    model_config = ConfigDict(extra="ignore")

    path: str
    content: str = ""


class GradeRequest(BaseModel):
    """`ai_grader.grade(payload)` kirishi.

    `extract_truncated` — zip extractor allaqachon qirqgan bo'lsa promptda
    shuni aytamiz, aks holda model "fayl tugamagan" deb xato topadi.
    """

    model_config = ConfigDict(extra="ignore")

    submission_id: str
    homework_title: str
    homework_description: str = ""
    max_score: int = Field(default=100, ge=1)
    files: list[GradedFile] = Field(default_factory=list)
    extract_truncated: bool = False
    attempt_no: int = 1


#: Anthropic tool-use sxemasi — model javobi SHU shaklga majburlanadi.
#: `AiVerdict` bilan bir xil bo'lishi SHART (qo'lda sinxron saqlanadi, chunki
#: Pydantic JSON-schema `$defs` ishlatadi, Anthropic esa yassi sxemani yaxshi
#: tushunadi).
#:
#: `strict: True` — **top-level** maydon (`tool_choice` da emas, beta header
#: kerak emas). Yangi modellar (`claude-opus-5-5`, `claude-sonnet-5-5`, Fable)
#: majburiy `tool_choice` ni **rad etadi** (400), shuning uchun sxemaga
#: moslikni API darajasida kafolatlaydigan yagona mexanizm shu: `tool_use.input`
#: aynan shu sxemaga valid bo'ladi → Pydantic qayta so'rashi (va puli) kamayadi.
#: Talablari: `additionalProperties: False` + to'liq `required` ro'yxati.
AI_VERDICT_TOOL: dict[str, Any] = {
    "name": AI_VERDICT_TOOL_NAME,
    "description": (
        "Tekshiruv xulosasini qaytaradi. Faqat shu tool orqali javob berasan; "
        "oddiy matn javobi qabul qilinmaydi."
    ),
    "strict": True,
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "ai_suspected": {
                "type": "boolean",
                "description": "Kod AI tomonidan yozilgan degan gumon bormi (DALIL bilan).",
            },
            "ai_confidence_percent": {
                "type": "integer",
                "minimum": 0,
                "maximum": 100,
                "description": "Gumon ishonchi. Dalil bo'lmasa 0.",
            },
            "injection_suspected": {
                "type": "boolean",
                "description": "Kod ichida senga ko'rsatma berish urinishi bormi.",
            },
            "summary": {
                "type": "string",
                "description": "O'ZBEKCHA xulosa, 3-6 gap. O'quvchiga hurmat bilan.",
            },
            "strengths": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Ishning kuchli tomonlari (o'zbekcha).",
            },
            "issues": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Haqiqiy kamchiliklar (o'zbekcha). Kommentga olingan kod "
                    "BU YERGA TUSHMAYDI."
                ),
            },
            "evidence": {
                "type": "array",
                "description": "Har bir flag uchun dalil. Dalilsiz flag ko'rsatilmaydi.",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "file": {"type": "string"},
                        "line_start": {"type": "integer", "minimum": 0},
                        "line_end": {"type": "integer", "minimum": 0},
                        "reason": {"type": "string"},
                    },
                    "required": ["file", "line_start", "line_end", "reason"],
                },
            },
            "suggested_score": {
                "type": "integer",
                "minimum": 0,
                "description": "TAVSIYA etilgan ball (0..max_score).",
            },
            "recommended_penalty": {
                "type": "integer",
                "minimum": 0,
                "description": (
                    "TAVSIYA etilgan jarima. Avtomatik QO'LLANMAYDI — "
                    "faqat o'qituvchi qaror qiladi."
                ),
            },
        },
        "required": [
            "ai_suspected",
            "ai_confidence_percent",
            "injection_suspected",
            "summary",
            "strengths",
            "issues",
            "evidence",
            "suggested_score",
            "recommended_penalty",
        ],
    },
}


__all__ = [
    "AI_VERDICT_TOOL",
    "AI_VERDICT_TOOL_NAME",
    "AiEvidence",
    "AiVerdict",
    "GradeRequest",
    "GradedFile",
]
