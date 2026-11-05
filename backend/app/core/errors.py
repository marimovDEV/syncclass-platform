"""Yagona xato formati.

Butun API `{"detail": {"code": ..., "message": ..., "fields": {...}}}` qaytaradi
(CONTRACTS.md §4). Frontend `code` bo'yicha tarmoqlanadi, `message` esa o'zbekcha.
"""

from typing import Any

from fastapi import HTTPException, status


class AppError(HTTPException):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        fields: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            status_code=status_code,
            detail={"code": code, "message": message, "fields": fields or {}},
        )


def bad_request(code: str, message: str, **fields: Any) -> AppError:
    return AppError(status.HTTP_400_BAD_REQUEST, code, message, fields or None)


def unauthorized(code: str = "UNAUTHORIZED", message: str = "Avtorizatsiya talab qilinadi.") -> AppError:
    return AppError(status.HTTP_401_UNAUTHORIZED, code, message)


def forbidden(code: str = "FORBIDDEN", message: str = "Bu amal uchun ruxsat yo'q.") -> AppError:
    return AppError(status.HTTP_403_FORBIDDEN, code, message)


def not_found(code: str = "NOT_FOUND", message: str = "Topilmadi.") -> AppError:
    return AppError(status.HTTP_404_NOT_FOUND, code, message)


def conflict(code: str, message: str) -> AppError:
    return AppError(status.HTTP_409_CONFLICT, code, message)


def too_large(message: str = "Fayl hajmi ruxsat etilgan chegaradan katta.") -> AppError:
    return AppError(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "FILE_TOO_LARGE", message)


def rate_limited(message: str = "Juda ko'p urinish. Birozdan keyin qayta urinib ko'ring.") -> AppError:
    return AppError(status.HTTP_429_TOO_MANY_REQUESTS, "RATE_LIMITED", message)
