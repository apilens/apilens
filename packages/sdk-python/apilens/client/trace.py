"""W3C Trace Context support for request capture.

Every captured request carries a ``trace_id`` (the whole distributed
transaction) and a ``span_id`` (this service's handling of it). When the
caller already propagates a valid ``traceparent`` header we continue that
trace; otherwise we start a new one.
"""

from __future__ import annotations

import contextvars
import re
import secrets

_TRACEPARENT_RE = re.compile(r"^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$")

_trace_ctx: contextvars.ContextVar[tuple[str, str] | None] = contextvars.ContextVar(
    "apilens_trace_ctx",
    default=None,
)


def parse_traceparent(header: str | None) -> tuple[str, str] | None:
    """Parse a W3C ``traceparent`` header into ``(trace_id, parent_span_id)``.

    Returns ``None`` for missing, malformed, or all-zero values (per spec,
    an invalid traceparent must be ignored and a new trace started).
    """
    if not header:
        return None
    match = _TRACEPARENT_RE.match(header.strip().lower())
    if not match:
        return None
    version, trace_id, span_id, _flags = match.groups()
    if version == "ff" or trace_id == "0" * 32 or span_id == "0" * 16:
        return None
    return trace_id, span_id


def generate_trace_id() -> str:
    return secrets.token_hex(16)


def generate_span_id() -> str:
    return secrets.token_hex(8)


def begin_request_trace(traceparent: str | None) -> tuple[str, str, str, contextvars.Token]:
    """Resolve the trace context for an incoming request.

    Continues the caller's trace when a valid ``traceparent`` is present,
    otherwise starts a new trace. Returns ``(trace_id, span_id,
    parent_span_id, token)`` — parent_span_id is the caller's span ("" for a
    new trace), which stitches cross-service traces together. The token must
    be passed to :func:`end_request_trace` when the request finishes.
    """
    parsed = parse_traceparent(traceparent)
    trace_id = parsed[0] if parsed else generate_trace_id()
    parent_span_id = parsed[1] if parsed else ""
    span_id = generate_span_id()
    token = _trace_ctx.set((trace_id, span_id))
    return trace_id, span_id, parent_span_id, token


def end_request_trace(token: contextvars.Token) -> None:
    _trace_ctx.reset(token)


def current_trace_id() -> str:
    """Trace id of the request currently being handled ("" outside a request).

    Use this to stamp your own log records so APILens can correlate them
    with the request that emitted them.
    """
    ctx = _trace_ctx.get()
    return ctx[0] if ctx else ""


def current_span_id() -> str:
    """Span id of the request currently being handled ("" outside a request)."""
    ctx = _trace_ctx.get()
    return ctx[1] if ctx else ""


def current_traceparent() -> str:
    """A ``traceparent`` header value for propagating to downstream services.

    Returns "" when called outside a request.
    """
    ctx = _trace_ctx.get()
    if not ctx:
        return ""
    return f"00-{ctx[0]}-{ctx[1]}-01"
