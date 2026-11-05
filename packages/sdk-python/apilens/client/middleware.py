from __future__ import annotations

import contextvars
import time
import traceback
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
from ._exclusions import RequestExcluder
from ._routes import resolve_endpoint_path
from ._sanitize import (
    BodyMasker,
    Redactor,
    RequestInfo,
    ResponseInfo,
    lower_headers,
    mask_body,
    serialize_headers,
)
from ._shutdown import (
    DEFAULT_SHUTDOWN_TIMEOUT,
    env_flush_on_shutdown,
    register_atexit,
    revive_client,
    shutdown_client_async,
)
from .client import ApiLensClient
from .spans import configure_spans, env_spans_enabled, record_error_log, record_span
from .trace import begin_request_trace, end_request_trace


def _error_message(exc: BaseException | None, status_code: int, method: str, path: str) -> tuple[str, str]:
    """Build (message, payload) for the auto error log.

    ``payload`` carries the full traceback for exceptions; it is empty for a
    plain 5xx response that didn't raise.
    """
    if exc is not None:
        message = f"{type(exc).__name__}: {exc}".strip()
        payload = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        return message, payload
    return f"HTTP {status_code} on {method} {path}", ""


def _maybe_record_error(
    *,
    exc: BaseException | None,
    status_code: int,
    trace_id: str,
    span_id: str,
    method: str,
    path: str,
    consumer: dict[str, str] | None,
) -> None:
    """Emit one ERROR log when the request raised or returned 5xx."""
    if exc is None and status_code < 500:
        return
    message, payload = _error_message(exc, status_code, method, path)
    record_error_log(
        trace_id=trace_id,
        span_id=span_id,
        level="ERROR",
        message=message,
        method=method,
        path=path,
        status_code=status_code,
        consumer=consumer,
        payload=payload,
        logger_name="apilens.exception" if exc is not None else "apilens.http",
    )

_consumer_ctx: contextvars.ContextVar[dict[str, str] | None] = contextvars.ContextVar(
    "apilens_consumer_ctx",
    default=None,
)

# Attribute used to stash the consumer on a framework request object
# (Starlette `request.state`, Django/Flask `request`).
_CONSUMER_ATTR = "_apilens_consumer"

_EMPTY_CONSUMER = {"consumer_id": "", "consumer_name": "", "consumer_group": ""}


def _wsgi_request_headers(environ: dict[str, Any]) -> dict[str, str]:
    """Reconstruct request headers from a WSGI environ (HTTP_* + CONTENT_*)."""
    out: dict[str, str] = {}
    for key, value in environ.items():
        if key.startswith("HTTP_"):
            name = key[5:].replace("_", "-").lower()
        elif key in ("CONTENT_TYPE", "CONTENT_LENGTH"):
            name = key.replace("_", "-").lower()
        else:
            continue
        if value is not None:
            out[name] = str(value)
    return out


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
        capture_headers: bool = True,
        capture_spans: bool = True,
        service_name: str = "",
        max_payload_bytes: int = 65536,
        redact_query_params: list[str] | None = None,
        redact_headers: list[str] | None = None,
        redact_body_fields: list[str] | None = None,
        mask_request_body: BodyMasker | None = None,
        mask_response_body: BodyMasker | None = None,
        exclude_paths: list[str] | None = None,
        exclude_user_agents: list[str] | None = None,
        default_exclusions: bool = True,
        get_consumer: Callable[..., Any] | None = None,
        route_resolver: Callable[[dict], str | None] | None = None,
        parametrize_paths: bool = True,
        flush_on_shutdown: bool = True,
        shutdown_timeout: float = DEFAULT_SHUTDOWN_TIMEOUT,
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
        self.capture_headers = capture_headers and enable_request_logging
        self.max_payload_bytes = max(0, int(max_payload_bytes))
        # PII redaction: regexes matched (case-insensitive) against query
        # parameter / header / JSON body field NAMES; matched values become
        # ``[redacted]`` before anything leaves the app. Anchor for exact
        # matches (r"^card_number$"). Built-in SENSITIVE_HEADERS always apply.
        self.redactor = Redactor(
            query_params=redact_query_params or (),
            headers=redact_headers or (),
            body_fields=redact_body_fields or (),
        )
        # Body mask callbacks ``(RequestInfo | ResponseInfo, bytes) -> bytes |
        # None`` run on the truncated raw bytes BEFORE the regex field masking
        # above (which, with its built-ins, still applies to their output).
        # ``None`` or an exception stores the whole body as ``[masked]``.
        self.mask_request_body = mask_request_body
        self.mask_response_body = mask_response_body
        # Regexes (case-insensitive, matched against the path without query
        # string) whose requests bypass capture entirely — no record, span or
        # log. Compiled once here; APILENS_EXCLUDE_PATHS adds to them.
        # ``exclude_user_agents`` does the same for the User-Agent header
        # (APILENS_EXCLUDE_USER_AGENTS adds to it). Built-in health/probe
        # exclusions apply first unless ``default_exclusions=False``.
        self.excluder = RequestExcluder(
            exclude_paths, exclude_user_agents, default_exclusions=default_exclusions
        )
        # Framework hook that maps a matched request scope to its route template
        # (``/product/{id}``). Runs after the app handled the request, when
        # routing has resolved. Heuristic fallback applies when it returns None.
        self.route_resolver = route_resolver
        self.parametrize_paths = parametrize_paths
        # Optional callback to centralize consumer extraction, e.g.
        #   get_consumer=lambda scope, headers: headers.get("x-user")
        # Return a str, dict, object or None. Never invoked automatically
        # against auth state — it only runs the resolver you provide.
        self.get_consumer = get_consumer
        # Spans need an app_id to be ingestible; skip configuration without one.
        # APILENS_CAPTURE_SPANS=false is a global kill-switch (env wins over code).
        self.capture_spans = capture_spans and bool(app_id) and env_spans_enabled()
        if self.capture_spans:
            configure_spans(
                client,
                app_id=app_id,
                environment=environment,
                service_name=service_name or app_id,
            )
        # Graceful shutdown: flush on the ASGI ``lifespan`` shutdown event, with
        # an ``atexit`` fallback for servers that never send one. Bounded by
        # ``shutdown_timeout`` seconds. APILENS_FLUSH_ON_SHUTDOWN=false disables.
        self.shutdown_timeout = shutdown_timeout
        self.flush_on_shutdown = flush_on_shutdown and env_flush_on_shutdown()
        if self.flush_on_shutdown:
            register_atexit(client, shutdown_timeout)

    async def _lifespan(self, scope, receive, send) -> None:
        """Pass the lifespan protocol through, draining the queue on shutdown.

        The flush runs after the app's own shutdown handlers (so anything they
        log is delivered) and before the server is told shutdown is complete.
        """
        shutting_down = False
        flushed = False

        async def flush() -> None:
            nonlocal flushed
            if not flushed:
                flushed = True
                await shutdown_client_async(self.client, self.shutdown_timeout)

        async def wrapped_receive():
            nonlocal shutting_down
            message = await receive()
            if message.get("type") == "lifespan.startup":
                revive_client(self.client)
            elif message.get("type") == "lifespan.shutdown":
                shutting_down = True
            return message

        async def wrapped_send(message: dict[str, Any]) -> None:
            if message.get("type") in ("lifespan.shutdown.complete", "lifespan.shutdown.failed"):
                await flush()
            await send(message)

        try:
            await self.app(scope, wrapped_receive, wrapped_send)
        finally:
            # The app raised (or returned) mid-shutdown without completing it.
            if shutting_down:
                await flush()

    def _excluded(self, scope) -> bool:
        user_agent = None
        if self.excluder.checks_user_agent:
            for key, value in scope.get("headers") or ():
                if key.lower() == b"user-agent":
                    user_agent = value.decode("latin-1")
                    break
        return self.excluder.matches(scope.get("path"), user_agent)

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") == "lifespan" and self.flush_on_shutdown:
            await self._lifespan(scope, receive, send)
            return
        if scope.get("type") != "http" or self._excluded(scope):
            await self.app(scope, receive, send)
            return

        headers = _headers_to_dict(scope.get("headers", []))
        path = _normalize_path(scope.get("path", "/"))
        # raw_path keeps the exact request URL incl. query string (with any
        # matching parameter values redacted); `path` stays query-free for
        # endpoint-template resolution.
        query = (scope.get("query_string") or b"").decode("latin-1")
        raw_path = f"{path}?{self.redactor.redact_query(query)}" if query else path
        trace_id, span_id, parent_span_id, trace_token = begin_request_trace(headers.get("traceparent"))

        request_payload_chunks: list[bytes] = []
        request_payload_len = 0

        ctx = CaptureContext(
            method=(scope.get("method") or "GET").upper(),
            path=path,
            raw_path=raw_path,
            project_slug=self.project_slug or self.client.config.project_slug,
            app_id=self.app_id,
            request_size=_to_int(headers.get("content-length"), 0),
            ip_address=_extract_ip(headers, fallback=(scope.get("client") or ("", 0))[0] or ""),
            user_agent=_extract_user_agent(headers),
            base_url=_detect_base_url_from_headers(headers, default_scheme=scope.get("scheme", "https")),
            request_headers=serialize_headers(headers, redactor=self.redactor) if self.capture_headers else "",
            trace_id=trace_id,
            span_id=span_id,
        )

        started_at = time.perf_counter()
        status_code = 500
        response_size = 0
        response_payload_chunks: list[bytes] = []
        response_payload_len = 0
        response_headers_json = ""
        response_headers: dict[str, str] = {}
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
            nonlocal status_code, response_size, response_payload_len, response_headers_json, response_headers
            msg_type = message.get("type")
            if msg_type == "http.response.start":
                status_code = int(message.get("status") or 500)
                response_headers = _headers_to_dict(message.get("headers") or [])
                if self.capture_headers:
                    response_headers_json = serialize_headers(response_headers, redactor=self.redactor)
            elif msg_type == "http.response.body":
                body = message.get("body") or b""
                response_size += len(body)
                if self.capture_payloads and self.log_response_body and self.max_payload_bytes > 0 and response_payload_len < self.max_payload_bytes:
                    remaining = self.max_payload_bytes - response_payload_len
                    part = body[:remaining]
                    response_payload_chunks.append(part)
                    response_payload_len += len(part)
            await send(message)

        captured_exc: BaseException | None = None
        try:
            await self.app(scope, wrapped_receive, wrapped_send)
        except BaseException as exc:
            captured_exc = exc
            raise
        finally:
            # Routing has resolved now, so ask the framework for the matched
            # route template and group under it. raw_path keeps the real URL.
            if self.route_resolver is not None:
                try:
                    template = self.route_resolver(scope)
                except Exception:
                    template = None
            else:
                template = None
            ctx.path = resolve_endpoint_path(template, path, self.parametrize_paths)
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
            request_info = RequestInfo(
                method=ctx.method, path=path, raw_path=raw_path, headers=lower_headers(headers)
            )
            request_payload = mask_body(
                b"".join(request_payload_chunks),
                redactor=self.redactor,
                masker=self.mask_request_body,
                info=request_info,
            )
            response_payload = mask_body(
                b"".join(response_payload_chunks),
                redactor=self.redactor,
                masker=self.mask_response_body,
                info=ResponseInfo(
                    request=request_info,
                    status_code=status_code,
                    headers=lower_headers(response_headers),
                ),
            )
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
                response_headers=response_headers_json,
            )
            if self.capture_spans:
                is_error = captured_exc is not None or status_code >= 500
                record_span(
                    name=f"{ctx.method} {ctx.path}",
                    kind="server",
                    trace_id=trace_id,
                    span_id=span_id,
                    parent_span_id=parent_span_id,
                    duration_ms=(time.perf_counter() - started_at) * 1000.0,
                    status="error" if is_error else "ok",
                    status_code=status_code,
                )
                _maybe_record_error(
                    exc=captured_exc,
                    status_code=status_code,
                    trace_id=trace_id,
                    span_id=span_id,
                    method=ctx.method,
                    path=ctx.path,
                    consumer=consumer,
                )
            _consumer_ctx.reset(token)
            end_request_trace(trace_token)


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
        capture_headers: bool = True,
        capture_spans: bool = True,
        service_name: str = "",
        max_payload_bytes: int = 65536,
        redact_query_params: list[str] | None = None,
        redact_headers: list[str] | None = None,
        redact_body_fields: list[str] | None = None,
        mask_request_body: BodyMasker | None = None,
        mask_response_body: BodyMasker | None = None,
        exclude_paths: list[str] | None = None,
        exclude_user_agents: list[str] | None = None,
        default_exclusions: bool = True,
        get_consumer: Callable[..., Any] | None = None,
        route_resolver: Callable[[dict], str | None] | None = None,
        parametrize_paths: bool = True,
        flush_on_shutdown: bool = True,
        shutdown_timeout: float = DEFAULT_SHUTDOWN_TIMEOUT,
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
        self.capture_headers = capture_headers and enable_request_logging
        self.max_payload_bytes = max(0, int(max_payload_bytes))
        # PII redaction — same semantics as the ASGI middleware (regexes on
        # names; values become ``[redacted]`` before anything leaves the app).
        self.redactor = Redactor(
            query_params=redact_query_params or (),
            headers=redact_headers or (),
            body_fields=redact_body_fields or (),
        )
        # Body mask callbacks — same semantics as the ASGI middleware.
        self.mask_request_body = mask_request_body
        self.mask_response_body = mask_response_body
        # Excluded paths / user agents (plus the built-in defaults) bypass
        # capture entirely — same semantics as ASGI.
        self.excluder = RequestExcluder(
            exclude_paths, exclude_user_agents, default_exclusions=default_exclusions
        )
        # Framework hook that maps a WSGI environ to its route template. Runs
        # after the app handled the request. Heuristic fallback when None.
        self.route_resolver = route_resolver
        self.parametrize_paths = parametrize_paths
        # Optional callback to centralize consumer extraction, e.g.
        #   get_consumer=lambda environ: environ.get("HTTP_X_USER")
        # Return a str, dict, object or None. Prefer calling track_consumer()
        # inside your view when you have the framework request object.
        self.get_consumer = get_consumer
        # Spans need an app_id to be ingestible; skip configuration without one.
        # APILENS_CAPTURE_SPANS=false is a global kill-switch (env wins over code).
        self.capture_spans = capture_spans and bool(app_id) and env_spans_enabled()
        if self.capture_spans:
            configure_spans(
                client,
                app_id=app_id,
                environment=environment,
                service_name=service_name or app_id,
            )
        # Graceful shutdown: WSGI has no lifespan, so flush from ``atexit``
        # (gunicorn/uwsgi workers exit normally on SIGTERM), bounded by
        # ``shutdown_timeout`` seconds. APILENS_FLUSH_ON_SHUTDOWN=false disables.
        self.shutdown_timeout = shutdown_timeout
        self.flush_on_shutdown = flush_on_shutdown and env_flush_on_shutdown()
        if self.flush_on_shutdown:
            register_atexit(client, shutdown_timeout)

    def __call__(self, environ: dict[str, Any], start_response: Callable) -> Any:
        # Excluded requests go straight to the app: no wrapping, no body buffering.
        user_agent = environ.get("HTTP_USER_AGENT") if self.excluder.checks_user_agent else None
        if self.excluder.matches(environ.get("PATH_INFO"), user_agent):
            return self.app(environ, start_response)
        return self._capture(environ, start_response)

    def _capture(self, environ: dict[str, Any], start_response: Callable) -> Any:
        started_at = time.perf_counter()
        consumer_token = _consumer_ctx.set(None)
        trace_id, span_id, parent_span_id, trace_token = begin_request_trace(environ.get("HTTP_TRACEPARENT"))

        clean_path = _normalize_path(environ.get("PATH_INFO") or "/")
        query = environ.get("QUERY_STRING")
        path = f"{clean_path}?{self.redactor.redact_query(query)}" if query else clean_path

        xff = (environ.get("HTTP_X_FORWARDED_FOR") or "").strip()
        if xff:
            ip_address = xff.split(",", 1)[0].strip()
        else:
            ip_address = (environ.get("HTTP_X_REAL_IP") or "").strip() or (environ.get("REMOTE_ADDR") or "")

        request_headers = _wsgi_request_headers(environ)
        request_info = RequestInfo(
            method=(environ.get("REQUEST_METHOD") or "GET").upper(),
            path=clean_path,
            raw_path=path,
            headers=request_headers,
        )
        request_payload = ""
        if self.capture_payloads and self.log_request_body and self.max_payload_bytes > 0:
            stream = environ.get("wsgi.input")
            if stream is not None and hasattr(stream, "read"):
                body = stream.read(self.max_payload_bytes)
                if body:
                    request_payload = mask_body(
                        body,
                        redactor=self.redactor,
                        masker=self.mask_request_body,
                        info=request_info,
                    )
                # Reset stream so app can consume the same bytes.
                try:
                    import io

                    environ["wsgi.input"] = io.BytesIO(body + stream.read())
                except Exception:
                    pass

        request_headers_json = (
            serialize_headers(request_headers, redactor=self.redactor)
            if self.capture_headers
            else ""
        )

        ctx = CaptureContext(
            method=(environ.get("REQUEST_METHOD") or "GET").upper(),
            path=path,
            raw_path=path,
            project_slug=self.project_slug or self.client.config.project_slug,
            app_id=self.app_id,
            request_size=_to_int(environ.get("CONTENT_LENGTH"), 0),
            ip_address=ip_address,
            user_agent=(environ.get("HTTP_USER_AGENT") or "").strip(),
            request_payload=request_payload,
            request_headers=request_headers_json,
            base_url=_detect_base_url_from_environ(environ),
            trace_id=trace_id,
            span_id=span_id,
        )

        status_code = 500
        response_size = 0
        response_payload_chunks: list[bytes] = []
        response_payload_len = 0
        response_headers_json = ""
        response_headers: dict[str, str] = {}

        def wrapped_start_response(status: str, headers: list[tuple[str, str]], exc_info=None):
            nonlocal status_code, response_headers_json, response_headers
            status_code = _to_int(status.split(" ", 1)[0], 500)
            response_headers = {str(k): str(v) for k, v in (headers or [])}
            if self.capture_headers:
                response_headers_json = serialize_headers(response_headers, redactor=self.redactor)
            return start_response(status, headers, exc_info)

        result = None
        captured_exc: BaseException | None = None
        try:
            result = self.app(environ, wrapped_start_response)
            for chunk in result:
                response_size += len(chunk or b"")
                if self.capture_payloads and self.log_response_body and self.max_payload_bytes > 0 and response_payload_len < self.max_payload_bytes:
                    piece = chunk or b""
                    remaining = self.max_payload_bytes - response_payload_len
                    part = piece[:remaining]
                    response_payload_chunks.append(part)
                    response_payload_len += len(part)
                yield chunk
        except BaseException as exc:
            captured_exc = exc
            raise
        finally:
            close = getattr(result, "close", None)
            if callable(close):
                close()
            # Group under the matched route template; raw_path keeps the real
            # URL (query string included) for the request log.
            if self.route_resolver is not None:
                try:
                    template = self.route_resolver(environ)
                except Exception:
                    template = None
            else:
                template = None
            ctx.path = resolve_endpoint_path(template, clean_path, self.parametrize_paths)
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
            end_request_trace(trace_token)
            if self.capture_spans:
                is_error = captured_exc is not None or status_code >= 500
                record_span(
                    name=f"{ctx.method} {ctx.path}",
                    kind="server",
                    trace_id=trace_id,
                    span_id=span_id,
                    parent_span_id=parent_span_id,
                    duration_ms=(time.perf_counter() - started_at) * 1000.0,
                    status="error" if is_error else "ok",
                    status_code=status_code,
                )
                _maybe_record_error(
                    exc=captured_exc,
                    status_code=status_code,
                    trace_id=trace_id,
                    span_id=span_id,
                    method=ctx.method,
                    path=ctx.path,
                    consumer=consumer,
                )
            response_payload = mask_body(
                b"".join(response_payload_chunks),
                redactor=self.redactor,
                masker=self.mask_response_body,
                info=ResponseInfo(
                    request=request_info,
                    status_code=status_code,
                    headers=lower_headers(response_headers),
                ),
            )
            capture_response(
                self.client,
                ctx,
                status_code=status_code,
                response_size=response_size,
                started_at=started_at,
                environment=self.environment,
                response_payload=response_payload,
                response_headers=response_headers_json,
            )
