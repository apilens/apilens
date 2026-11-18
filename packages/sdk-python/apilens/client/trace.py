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
import threading

_TRACEPARENT_RE = re.compile(r"^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$")

# Most child spans one request may record (D8); the rest are dropped and
# counted as ``span_cap``. The request's own server span is never capped.
MAX_SPANS_PER_REQUEST = 2000


class SpanBudget:
    """Child spans recorded so far by one request (shared by the tasks and
    copied contexts of that request)."""

    __slots__ = ("used", "lock")

    def __init__(self) -> None:
        self.used = 0
        self.lock = threading.Lock()

    def take(self) -> bool:
        """Claim one span slot; False once :data:`MAX_SPANS_PER_REQUEST` are used."""
        with self.lock:
            if self.used >= MAX_SPANS_PER_REQUEST:
                return False
            self.used += 1
            return True


class _RequestTrace:
    """The trace of the request being handled; ``ended`` once its response is done.

    Mutable on purpose: a task spawned during a request (a lazily started server,
    a worker loop) copies the context and would otherwise keep the request's
    trace forever, filing every later outbound call under a long-finished
    request. Marking the shared object ended hides it from those copies too.
    """

    __slots__ = ("trace_id", "span_id", "budget", "ended")

    def __init__(self, trace_id: str, span_id: str) -> None:
        self.trace_id = trace_id
        self.span_id = span_id
        self.budget = SpanBudget()
        self.ended = False


_trace_ctx: contextvars.ContextVar[_RequestTrace | None] = contextvars.ContextVar(
    "apilens_trace_ctx",
    default=None,
)


def _live_trace() -> _RequestTrace | None:
    """The current request's trace, or None outside a request or once it has ended."""
    trace = _trace_ctx.get()
    return trace if trace is not None and not trace.ended else None


# Whether the current request's detail (spans, logs) is sampled in. Child
# spans recorded during a sampled-out request are dropped; trace context is
# still propagated downstream either way.
_detail_sampled_ctx: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "apilens_detail_sampled",
    default=True,
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
    token = _trace_ctx.set(_RequestTrace(trace_id, span_id))
    return trace_id, span_id, parent_span_id, token


def end_request_trace(token: contextvars.Token) -> None:
    trace = _trace_ctx.get()
    if trace is not None:
        trace.ended = True
    _trace_ctx.reset(token)


def set_detail_sampled(sampled: bool) -> contextvars.Token:
    """Mark the current request as sampled in/out; undo with :func:`reset_detail_sampled`."""
    return _detail_sampled_ctx.set(bool(sampled))


def reset_detail_sampled(token: contextvars.Token) -> None:
    _detail_sampled_ctx.reset(token)


def detail_sampled() -> bool:
    """False while handling a request whose detail was sampled out."""
    return _detail_sampled_ctx.get()


def current_span_budget() -> SpanBudget | None:
    """Span budget of the request currently being handled (None outside one)."""
    ctx = _live_trace()
    return ctx.budget if ctx else None


def current_trace_id() -> str:
    """Trace id of the request currently being handled ("" outside a request).

    Use this to stamp your own log records so APILens can correlate them
    with the request that emitted them.
    """
    ctx = _live_trace()
    return ctx.trace_id if ctx else ""


def current_span_id() -> str:
    """Span id of the request currently being handled ("" outside a request)."""
    ctx = _live_trace()
    return ctx.span_id if ctx else ""


def current_traceparent() -> str:
    """A ``traceparent`` header value for propagating to downstream services.

    Returns "" when called outside a request.
    """
    ctx = _live_trace()
    if not ctx:
        return ""
    return f"00-{ctx.trace_id}-{ctx.span_id}-01"
