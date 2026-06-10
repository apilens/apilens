from __future__ import annotations

import contextvars
import time
from collections.abc import Awaitable, Callable
from typing import Any

from ._capture import (
    CaptureContext,
    _detect_base_url_from_environ,
    _detect_base_url_from_headers,
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

# Attribute used to stash the consumer on a framework request object
# (Starlette `request.state`, Django/Flask `request`).
_CONSUMER_ATTR = "_apilens_consumer"

_EMPTY_CONSUMER = {"consumer_id": "", "consumer_name": "", "consumer_group": ""}


def normalize_consumer(value: Any) -> dict[str, str]:
    """
    Coerce a user-supplied consumer into the standard 3-key dict.

    Accepts:
        - a plain string  -> treated as consumer_id
        - a mapping       -> keys id/identifier/consumer_id, name/consumer_name,
                             group/consumer_group
        - an object       -> attributes id/identifier, name, group / username
        - None            -> empty consumer

    Nothing is inferred automatically; this only reshapes what the caller passes.
    """
    if value is None:
        return dict(_EMPTY_CONSUMER)
    if isinstance(value, str):
        return {"consumer_id": value.strip(), "consumer_name": "", "consumer_group": ""}
    if isinstance(value, dict):
        get = value.get
        cid = get("id") or get("identifier") or get("consumer_id") or ""
        cname = get("name") or get("username") or get("consumer_name") or ""
        cgroup = get("group") or get("consumer_group") or ""
    else:
        cid = (
            getattr(value, "id", None)
            or getattr(value, "identifier", None)
            or getattr(value, "consumer_id", None)
            or ""
        )
        cname = (
            getattr(value, "name", None)
            or getattr(value, "username", None)
            or getattr(value, "consumer_name", None)
            or ""
        )
        cgroup = getattr(value, "group", None) or getattr(value, "consumer_group", None) or ""
    return {
        "consumer_id": str(cid or "").strip(),
        "consumer_name": str(cname or "").strip(),
        "consumer_group": str(cgroup or "").strip(),
    }


def _store_consumer(request: Any | None, payload: dict[str, str]) -> None:
    """Stash the consumer on the contextvar and (best-effort) on the request."""
    _consumer_ctx.set(payload)
    if request is None:
        return
    state = getattr(request, "state", None)
    if state is not None:
        try:
            setattr(state, _CONSUMER_ATTR, payload)
        except Exception:
            pass
    # Django HttpRequest / Flask request have no `.state`; stash on the object.
    try:
        setattr(request, _CONSUMER_ATTR, payload)
    except Exception:
        pass


def _read_consumer(request: Any | None = None) -> dict[str, str]:
    """Resolve the consumer from the request object, then the contextvar."""
    if request is not None:
        state = getattr(request, "state", None)
        stored = getattr(state, _CONSUMER_ATTR, None) if state is not None else None
        if not isinstance(stored, dict):
            stored = getattr(request, _CONSUMER_ATTR, None)
        if isinstance(stored, dict):
            return stored
    ctx_value = _consumer_ctx.get()
    return ctx_value if isinstance(ctx_value, dict) else dict(_EMPTY_CONSUMER)


def _apply_consumer(ctx: Any, consumer: dict[str, str]) -> None:
    ctx.consumer_id = str(consumer.get("consumer_id") or "")
    ctx.consumer_name = str(consumer.get("consumer_name") or "")
    ctx.consumer_group = str(consumer.get("consumer_group") or "")


def track_consumer(
    request: Any | None = None,
    *,
    identifier: str,
    name: str | None = None,
    group: str | None = None,
) -> None:
    """
    Attach a consumer identity to the current request.

    Call this from your own code once you have resolved who the caller is
    (e.g. after auth). APILens never infers the consumer automatically —
    whatever you pass here is exactly what is reported.

    ``request`` is optional. Omit it (or pass ``None``) when calling from a
    hook that runs before the framework request object is available, such as
    Flask's ``@app.before_request``. The identity is stored on a contextvar
    and picked up by the middleware at response time::

        # Flask — called without request arg from before_request
        from flask import g
        from apilens.flask import set_consumer

        @app.before_request
        def identify_consumer():
            if g.current_user:
                set_consumer(
                    identifier=g.current_user["email"],
                    name=g.current_user.get("name"),
                    group=g.current_user.get("role"),
                )

        # FastAPI — pass the Request object from a dependency
        from fastapi import Depends, Request
        from apilens.fastapi import set_consumer

        async def consumer_dep(request: Request):
            user = getattr(request.state, "user", None)
            if user:
                set_consumer(request, identifier=user.id, name=user.username)

        @app.get("/orders")
        async def list_orders(_=Depends(consumer_dep)):
            ...

        # Django — call from a view or set APILENS_GET_CONSUMER in settings
        from apilens.django import set_consumer

        def my_view(request):
            if request.user.is_authenticated:
                set_consumer(request, identifier=request.user.email)
    """
    payload = {
        "consumer_id": str(identifier or "").strip(),
        "consumer_name": str(name or "").strip(),
        "consumer_group": str(group or "").strip(),
    }
    _store_consumer(request, payload)


def set_consumer(
    request: Any | None = None,
    *,
    identifier: str,
    name: str | None = None,
    group: str | None = None,
) -> None:
    """
    Attach a consumer identity to the current request.

    Alias for :func:`track_consumer`. Preferred name when following the
    ``before_request`` / dependency-injection pattern used in Flask, FastAPI,
    Django, and Starlette.

    ``request`` is optional — omit it when calling from a hook where the
    framework request object is not yet available (e.g. Flask's
    ``@app.before_request``). The value is stored on a contextvar and picked
    up by the middleware at response time.

    Example (Flask)::

        from flask import g
        from apilens.flask import set_consumer

        @app.before_request
        def identify_consumer():
            if g.current_user:
                set_consumer(
                    identifier=g.current_user["email"],
                    name=g.current_user.get("name"),
                    group=g.current_user.get("role"),
                )
    """
    track_consumer(request, identifier=identifier, name=name, group=group)


class ApiLensASGIMiddleware:
    """Generic ASGI middleware for HTTP request capture."""

    def __init__(
        self,
        app,
        client: ApiLensClient,
        *,
        project_slug: str = "",
        app_id: str = "",
        environment: str | None = None,
        enable_request_logging: bool = True,
        log_request_body: bool = True,
        log_response_body: bool = True,
        capture_payloads: bool = True,
        max_payload_bytes: int = 8192,
        get_consumer: Callable[..., Any] | None = None,
    ) -> None:
        self.app = app
        self.client = client
        self.project_slug = project_slug
        self.app_id = app_id
        self.environment = environment
        self.enable_request_logging = enable_request_logging
        self.log_request_body = log_request_body
        self.log_response_body = log_response_body
        self.capture_payloads = capture_payloads and enable_request_logging
        self.max_payload_bytes = max(0, int(max_payload_bytes))
        # Optional callback to centralize consumer extraction, e.g.
        #   get_consumer=lambda scope, headers: headers.get("x-user")
        # Return a str, dict, object or None. Never invoked automatically
        # against auth state — it only runs the resolver you provide.
        self.get_consumer = get_consumer

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
            project_slug=self.project_slug or self.client.config.project_slug,
            app_id=self.app_id,
            request_size=_to_int(headers.get("content-length"), 0),
            ip_address=_extract_ip(headers, fallback=(scope.get("client") or ("", 0))[0] or ""),
            user_agent=_extract_user_agent(headers),
            base_url=_detect_base_url_from_headers(headers, default_scheme=scope.get("scheme", "https")),
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
            consumer = dict(_read_consumer())
            scope_state = scope.get("state")
            if isinstance(scope_state, dict):
                state_consumer = scope_state.get(_CONSUMER_ATTR)
                if isinstance(state_consumer, dict):
                    consumer = {**consumer, **state_consumer}
            if self.get_consumer is not None and not consumer.get("consumer_id"):
                try:
                    resolved = self.get_consumer(scope, headers)
                except Exception:
                    resolved = None
                if resolved is not None:
                    consumer = normalize_consumer(resolved)
            request_payload = b"".join(request_payload_chunks).decode("utf-8", errors="replace")
            response_payload = b"".join(response_payload_chunks).decode("utf-8", errors="replace")
            ctx.request_payload = request_payload
            _apply_consumer(ctx, consumer)
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
        project_slug: str = "",
        app_id: str = "",
        environment: str | None = None,
        enable_request_logging: bool = True,
        log_request_body: bool = True,
        log_response_body: bool = True,
        capture_payloads: bool = True,
        max_payload_bytes: int = 8192,
        get_consumer: Callable[..., Any] | None = None,
    ) -> None:
        self.app = app
        self.client = client
        self.project_slug = project_slug
        self.app_id = app_id
        self.environment = environment
        self.enable_request_logging = enable_request_logging
        self.log_request_body = log_request_body
        self.log_response_body = log_response_body
        self.capture_payloads = capture_payloads and enable_request_logging
        self.max_payload_bytes = max(0, int(max_payload_bytes))
        # Optional callback to centralize consumer extraction, e.g.
        #   get_consumer=lambda environ: environ.get("HTTP_X_USER")
        # Return a str, dict, object or None. Prefer calling track_consumer()
        # inside your view when you have the framework request object.
        self.get_consumer = get_consumer

    def __call__(self, environ: dict[str, Any], start_response: Callable) -> Any:
        started_at = time.perf_counter()
        consumer_token = _consumer_ctx.set(None)

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
            project_slug=self.project_slug or self.client.config.project_slug,
            app_id=self.app_id,
            request_size=_to_int(environ.get("CONTENT_LENGTH"), 0),
            ip_address=ip_address,
            user_agent=(environ.get("HTTP_USER_AGENT") or "").strip(),
            request_payload=request_payload,
            base_url=_detect_base_url_from_environ(environ),
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
            consumer = dict(_read_consumer())
            if self.get_consumer is not None and not consumer.get("consumer_id"):
                try:
                    resolved = self.get_consumer(environ)
                except Exception:
                    resolved = None
                if resolved is not None:
                    consumer = normalize_consumer(resolved)
            _apply_consumer(ctx, consumer)
            _consumer_ctx.reset(consumer_token)
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
