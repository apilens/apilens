from __future__ import annotations

import contextvars
import time
from collections.abc import Awaitable, Callable
from typing import Any

from ._capture import (
    CaptureContext,
    _extract_ip,
    _extract_user_agent,
    _headers_to_dict,
    _normalize_path,
    _to_int,
    capture_response,
)
from .client import ApiLensClient

_consumer_ctx: contextvars.ContextVar[dict[str, str] | None] = contextvars.ContextVar(
    "apilens_consumer_ctx",
    default=None,
)


def track_consumer(
    request: Any | None = None,
    *,
    identifier: str,
    name: str | None = None,
    group: str | None = None,
) -> None:
    """
    Attach consumer identity to the current request.

    Works with FastAPI/Starlette when called from dependencies or handlers.
    """
    payload = {
        "consumer_id": str(identifier or "").strip(),
        "consumer_name": str(name or "").strip(),
        "consumer_group": str(group or "").strip(),
    }
    _consumer_ctx.set(payload)
    state = getattr(request, "state", None)
    if state is not None:
        setattr(state, "_apilens_consumer", payload)


def set_consumer(
    request: Any | None = None,
    *,
    identifier: str,
    name: str | None = None,
    group: str | None = None,
) -> None:
    """Backward-compatible alias for track_consumer."""
    track_consumer(request, identifier=identifier, name=name, group=group)


class ApiLensASGIMiddleware:
    """Generic ASGI middleware for HTTP request capture."""

    def __init__(
        self,
        app,
        client: ApiLensClient,
        *,
        environment: str | None = None,
        enable_request_logging: bool = True,
        log_request_body: bool = True,
        log_response_body: bool = True,
        capture_payloads: bool = True,
        max_payload_bytes: int = 8192,
    ) -> None:
        self.app = app
        self.client = client
        self.environment = environment
        self.enable_request_logging = enable_request_logging
        self.log_request_body = log_request_body
        self.log_response_body = log_response_body
        self.capture_payloads = capture_payloads and enable_request_logging
        self.max_payload_bytes = max(0, int(max_payload_bytes))

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        headers = _headers_to_dict(scope.get("headers", []))
        path = _normalize_path(scope.get("path", "/"))

        request_payload_chunks: list[bytes] = []
        request_payload_len = 0

        ctx = CaptureContext(
            method=(scope.get("method") or "GET").upper(),
            path=path,
            request_size=_to_int(headers.get("content-length"), 0),
            ip_address=_extract_ip(headers, fallback=(scope.get("client") or ("", 0))[0] or ""),
            user_agent=_extract_user_agent(headers),
        )

        started_at = time.perf_counter()
        status_code = 500
        response_size = 0
        response_payload_chunks: list[bytes] = []
        response_payload_len = 0
        token = _consumer_ctx.set(None)

        async def wrapped_receive():
            nonlocal request_payload_len
            message = await receive()
            if (
                self.capture_payloads
                and self.log_request_body
                and message.get("type") == "http.request"
                and self.max_payload_bytes > 0
            ):
                body = message.get("body") or b""
                if body and request_payload_len < self.max_payload_bytes:
                    remaining = self.max_payload_bytes - request_payload_len
                    part = body[:remaining]
                    request_payload_chunks.append(part)
                    request_payload_len += len(part)
            return message

        async def wrapped_send(message: dict[str, Any]) -> None:
            nonlocal status_code, response_size, response_payload_len
            msg_type = message.get("type")
            if msg_type == "http.response.start":
                status_code = int(message.get("status") or 500)
            elif msg_type == "http.response.body":
                body = message.get("body") or b""
                response_size += len(body)
                if self.capture_payloads and self.log_response_body and self.max_payload_bytes > 0 and response_payload_len < self.max_payload_bytes:
                    remaining = self.max_payload_bytes - response_payload_len
                    part = body[:remaining]
                    response_payload_chunks.append(part)
                    response_payload_len += len(part)
            await send(message)

        try:
            await self.app(scope, wrapped_receive, wrapped_send)
        finally:
            consumer = _consumer_ctx.get() or {}
            scope_state = scope.get("state")
            if isinstance(scope_state, dict):
                state_consumer = scope_state.get("_apilens_consumer")
                if isinstance(state_consumer, dict):
                    consumer = {**consumer, **state_consumer}
            request_payload = b"".join(request_payload_chunks).decode("utf-8", errors="replace")
            response_payload = b"".join(response_payload_chunks).decode("utf-8", errors="replace")
            ctx.request_payload = request_payload
            ctx.consumer_id = str(consumer.get("consumer_id") or "")
            ctx.consumer_name = str(consumer.get("consumer_name") or "")
            ctx.consumer_group = str(consumer.get("consumer_group") or "")
            capture_response(
                self.client,
                ctx,
                status_code=status_code,
                response_size=response_size,
                started_at=started_at,
                environment=self.environment,
                response_payload=response_payload,
            )
            _consumer_ctx.reset(token)


class ApiLensWSGIMiddleware:
    """WSGI wrapper for Flask and other WSGI applications."""

    def __init__(
        self,
        app: Callable,
        client: ApiLensClient,
        *,
        environment: str | None = None,
        enable_request_logging: bool = True,
        log_request_body: bool = True,
        log_response_body: bool = True,
        capture_payloads: bool = True,
        max_payload_bytes: int = 8192,
    ) -> None:
        self.app = app
        self.client = client
        self.environment = environment
        self.enable_request_logging = enable_request_logging
        self.log_request_body = log_request_body
        self.log_response_body = log_response_body
        self.capture_payloads = capture_payloads and enable_request_logging
        self.max_payload_bytes = max(0, int(max_payload_bytes))

    def __call__(self, environ: dict[str, Any], start_response: Callable) -> Any:
        started_at = time.perf_counter()

        path = _normalize_path(environ.get("PATH_INFO") or "/")
        query = environ.get("QUERY_STRING")
        if query:
            path = f"{path}?{query}"

        xff = (environ.get("HTTP_X_FORWARDED_FOR") or "").strip()
        if xff:
            ip_address = xff.split(",", 1)[0].strip()
        else:
            ip_address = (environ.get("HTTP_X_REAL_IP") or "").strip() or (environ.get("REMOTE_ADDR") or "")

        request_payload = ""
        if self.capture_payloads and self.log_request_body and self.max_payload_bytes > 0:
            stream = environ.get("wsgi.input")
            if stream is not None and hasattr(stream, "read"):
                body = stream.read(self.max_payload_bytes)
                if body:
                    request_payload = body.decode("utf-8", errors="replace")
                # Reset stream so app can consume the same bytes.
                try:
                    import io

                    environ["wsgi.input"] = io.BytesIO(body + stream.read())
                except Exception:
                    pass

        ctx = CaptureContext(
            method=(environ.get("REQUEST_METHOD") or "GET").upper(),
            path=path,
            request_size=_to_int(environ.get("CONTENT_LENGTH"), 0),
            ip_address=ip_address,
            user_agent=(environ.get("HTTP_USER_AGENT") or "").strip(),
            request_payload=request_payload,
        )

        status_code = 500
        response_size = 0
        response_payload_chunks: list[bytes] = []
        response_payload_len = 0

        def wrapped_start_response(status: str, headers: list[tuple[str, str]], exc_info=None):
            nonlocal status_code
            status_code = _to_int(status.split(" ", 1)[0], 500)
            return start_response(status, headers, exc_info)

        result = self.app(environ, wrapped_start_response)

        try:
            for chunk in result:
                response_size += len(chunk or b"")
                if self.capture_payloads and self.log_response_body and self.max_payload_bytes > 0 and response_payload_len < self.max_payload_bytes:
                    piece = chunk or b""
                    remaining = self.max_payload_bytes - response_payload_len
                    part = piece[:remaining]
                    response_payload_chunks.append(part)
                    response_payload_len += len(part)
                yield chunk
        finally:
            close = getattr(result, "close", None)
            if callable(close):
                close()
            response_payload = b"".join(response_payload_chunks).decode("utf-8", errors="replace")
            capture_response(
                self.client,
                ctx,
                status_code=status_code,
                response_size=response_size,
                started_at=started_at,
                environment=self.environment,
                response_payload=response_payload,
            )
