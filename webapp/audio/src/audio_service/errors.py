"""Flat error format of the contract: {"error": "<code>", "message": "..."}; only 400, 404 and 502 are used."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def error_response(status: int, code: str, message: str) -> JSONResponse:
    headers = {"Cache-Control": "no-store"} if status == 404 else None
    return JSONResponse({"error": code, "message": message}, status_code=status, headers=headers)


def install_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError):
        return error_response(exc.status, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
        detail = f"{where}: {first.get('msg', 'invalid')}" if where else first.get("msg", "invalid request")
        return error_response(400, "invalid_request", detail)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException):
        if exc.status_code == 404:
            return error_response(404, "not_found", "Unknown path or audio id.")
        return error_response(400, "invalid_request", str(exc.detail))
