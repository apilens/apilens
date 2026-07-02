"""Span capture — what happened *inside* a request.

The middleware records a root ``server`` span per request automatically.
Application code adds child spans with the :func:`span` context manager::

    from apilens import span

    with span("charge card", kind="db"):
        ...

Outbound HTTP calls made with ``requests`` or ``httpx`` are instrumented
automatically (child ``http`` spans + ``traceparent`` propagation) when the
middleware is installed with ``capture_spans=True``.

Spans are silently dropped when there is no active trace (e.g. background
jobs) or no middleware has been installed — ``span()`` is always safe to call.
"""

from __future__ import annotations

import contextvars
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

from .models import SpanRecord
from .trace import _trace_ctx, current_span_id, current_trace_id, generate_span_id

if TYPE_CHECKING:
    from .client import ApiLensClient

_MAX_ATTRIBUTES = 32
_MAX_ATTRIBUTE_VALUE_CHARS = 512


class _SpanRecorder:
    """Where span() sends finished spans; configured by the middleware."""

    def __init__(self, client: "ApiLensClient", *, app_id: str, environment: str, service_name: str) -> None:
        self.client = client
        self.app_id = app_id
        self.environment = environment
        self.service_name = service_name


_recorder: _SpanRecorder | None = None
_recorder_lock = threading.Lock()


def configure_spans(
    client: "ApiLensClient",
    *,
    app_id: str,
    environment: str | None = None,
    service_name: str = "",
    instrument_http: bool = True,
) -> None:
    """Register the destination for spans (called by the middlewares)."""
    global _recorder
    with _recorder_lock:
        _recorder = _SpanRecorder(
            client,
            app_id=app_id,
            environment=environment or client.config.environment,
            service_name=service_name,
        )
    if instrument_http:
        instrument_outbound_http()


def _clean_attributes(attributes: dict[str, Any] | None) -> dict[str, str]:
    if not attributes:
        return {}
    output: dict[str, str] = {}
    for key, value in attributes.items():
        if len(output) >= _MAX_ATTRIBUTES:
            break
        clean_key = str(key or "").strip()
        if not clean_key or isinstance(value, (dict, list, tuple, set)):
            continue
        output[clean_key] = str(value if value is not None else "")[:_MAX_ATTRIBUTE_VALUE_CHARS]
    return output


def record_span(
    *,
    name: str,
    kind: str,
    trace_id: str,
    span_id: str,
    parent_span_id: str,
    duration_ms: float,
    status: str = "ok",
    status_code: int = 0,
    attributes: dict[str, Any] | None = None,
    end_time: datetime | None = None,
) -> None:
    """Queue one finished span (no-op when spans are not configured)."""
    recorder = _recorder
    if recorder is None or not trace_id or not span_id:
        return
    ended = end_time or datetime.now(tz=timezone.utc)
    recorder.client.capture_span(
        SpanRecord(
            timestamp=ended - timedelta(milliseconds=max(duration_ms, 0.0)),
            environment=recorder.environment,
            trace_id=trace_id,
            span_id=span_id,
            parent_span_id=parent_span_id,
            name=(name or "")[:256],
            kind=(kind or "internal").lower()[:16],
            service_name=recorder.service_name,
            duration_ms=max(float(duration_ms or 0.0), 0.0),
            status="error" if status == "error" else "ok",
            status_code=int(status_code or 0),
            project_slug=recorder.client.config.project_slug,
            app_id=recorder.app_id,
            attributes=_clean_attributes(attributes),
        )
    )


@contextmanager
def span(name: str, *, kind: str = "internal", attributes: dict[str, Any] | None = None):
    """Record a child span of the current request.

    Safe anywhere: outside a request (or without middleware) it simply runs
    the body without recording. An exception marks the span as ``error`` and
    is re-raised.
    """
    trace_id = current_trace_id()
    if not trace_id or _recorder is None:
        yield None
        return

    parent = current_span_id()
    span_id = generate_span_id()
    token = _trace_ctx.set((trace_id, span_id))
    started = time.perf_counter()
    status = "ok"
    try:
        yield span_id
    except BaseException:
        status = "error"
        raise
    finally:
        _trace_ctx.reset(token)
        record_span(
            name=name,
            kind=kind,
            trace_id=trace_id,
            span_id=span_id,
            parent_span_id=parent,
            duration_ms=(time.perf_counter() - started) * 1000.0,
            status=status,
            attributes=attributes,
        )


# ── Outbound HTTP auto-instrumentation ──────────────────────────────────────

_http_instrumented = False
_http_lock = threading.Lock()


def _finish_http_span(
    *,
    method: str,
    url: str,
    trace_id: str,
    span_id: str,
    parent: str,
    started: float,
    status_code: int,
    error: bool,
) -> None:
    record_span(
        name=f"{method.upper()} {url}",
        kind="http",
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent,
        duration_ms=(time.perf_counter() - started) * 1000.0,
        status="error" if error or status_code >= 500 else "ok",
        status_code=status_code,
        attributes={"http.url": url, "http.method": method.upper()},
    )


def _strip_url(url: str) -> str:
    # Drop query string and userinfo — span names must not leak secrets.
    text = str(url)
    q = text.find("?")
    if q != -1:
        text = text[:q]
    if "@" in text:
        scheme, _, rest = text.partition("://")
        if rest and "@" in rest.split("/", 1)[0]:
            rest = rest.split("@", 1)[1]
            text = f"{scheme}://{rest}"
    return text[:512]


def instrument_outbound_http() -> None:
    """Patch ``requests`` and ``httpx`` (when installed) so outbound calls
    made during a request become child ``http`` spans and carry a
    ``traceparent`` header downstream. Idempotent; never raises."""
    global _http_instrumented
    with _http_lock:
        if _http_instrumented:
            return
        _http_instrumented = True

    try:
        _patch_requests()
    except Exception:
        pass
    try:
        _patch_httpx()
    except Exception:
        pass


def _skips_own_ingest(url: str) -> bool:
    # Never trace the SDK's own telemetry uploads.
    return url.endswith("/requests") or url.endswith("/traces") or url.endswith("/logs")


def _patch_requests() -> None:
    try:
        from requests.sessions import Session
    except ImportError:
        return

    original = Session.send

    def send(self, request, **kwargs):
        trace_id = current_trace_id()
        url = _strip_url(request.url or "")
        if not trace_id or _recorder is None or _skips_own_ingest(url):
            return original(self, request, **kwargs)

        parent = current_span_id()
        span_id = generate_span_id()
        request.headers.setdefault("traceparent", f"00-{trace_id}-{span_id}-01")
        method = request.method or "GET"
        started = time.perf_counter()
        try:
            response = original(self, request, **kwargs)
        except BaseException:
            _finish_http_span(
                method=method, url=url, trace_id=trace_id, span_id=span_id,
                parent=parent, started=started, status_code=0, error=True,
            )
            raise
        _finish_http_span(
            method=method, url=url, trace_id=trace_id, span_id=span_id,
            parent=parent, started=started, status_code=int(response.status_code or 0), error=False,
        )
        return response

    Session.send = send


def _patch_httpx() -> None:
    try:
        import httpx
    except ImportError:
        return

    original_sync = httpx.Client.send

    def send(self, request, **kwargs):
        trace_id = current_trace_id()
        url = _strip_url(str(request.url))
        if not trace_id or _recorder is None or _skips_own_ingest(url):
            return original_sync(self, request, **kwargs)

        parent = current_span_id()
        span_id = generate_span_id()
        request.headers.setdefault("traceparent", f"00-{trace_id}-{span_id}-01")
        method = request.method or "GET"
        started = time.perf_counter()
        try:
            response = original_sync(self, request, **kwargs)
        except BaseException:
            _finish_http_span(
                method=method, url=url, trace_id=trace_id, span_id=span_id,
                parent=parent, started=started, status_code=0, error=True,
            )
            raise
        _finish_http_span(
            method=method, url=url, trace_id=trace_id, span_id=span_id,
            parent=parent, started=started, status_code=int(response.status_code or 0), error=False,
        )
        return response

    httpx.Client.send = send

    original_async = httpx.AsyncClient.send

    async def send_async(self, request, **kwargs):
        trace_id = current_trace_id()
        url = _strip_url(str(request.url))
        if not trace_id or _recorder is None or _skips_own_ingest(url):
            return await original_async(self, request, **kwargs)

        parent = current_span_id()
        span_id = generate_span_id()
        request.headers.setdefault("traceparent", f"00-{trace_id}-{span_id}-01")
        method = request.method or "GET"
        started = time.perf_counter()
        try:
            response = await original_async(self, request, **kwargs)
        except BaseException:
            _finish_http_span(
                method=method, url=url, trace_id=trace_id, span_id=span_id,
                parent=parent, started=started, status_code=0, error=True,
            )
            raise
        _finish_http_span(
            method=method, url=url, trace_id=trace_id, span_id=span_id,
            parent=parent, started=started, status_code=int(response.status_code or 0), error=False,
        )
        return response

    httpx.AsyncClient.send = send_async
