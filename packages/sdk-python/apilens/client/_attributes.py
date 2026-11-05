"""Custom request attributes (``set_request_attribute``).

Application code attaches small key/value metadata to the request being
handled — ``set_request_attribute("tenant.id", "acme")`` — and the middleware
puts it on the request record (``attributes`` on ``/v1/requests``), on the
server span, and on the ``RequestInfo`` / ``ResponseInfo`` handed to body-mask
(and sampling) callbacks.

The store is a per-request dict held in a contextvar. The middleware installs
a fresh dict when a request starts and resets it when the request ends; the
handler mutates that same dict, so values set from a child task or a thread
that copied the context are still seen. Outside a request the call is a no-op.

Limits: at most :data:`MAX_ATTRIBUTES` keys per request and
:data:`MAX_VALUE_CHARS` characters per string value (longer strings are
truncated). Values must be ``str``, ``int``, ``float`` or ``bool``. Anything
over a limit or of the wrong type is dropped (or truncated) and logged once
per process — never raised, so instrumentation can't break a request.
"""

from __future__ import annotations

import contextvars
import logging
import math
import threading
from typing import Union

logger = logging.getLogger("apilens")

AttributeValue = Union[str, int, float, bool]

MAX_ATTRIBUTES = 32
MAX_VALUE_CHARS = 256
MAX_KEY_CHARS = 128

_attributes_ctx: contextvars.ContextVar[dict[str, AttributeValue] | None] = contextvars.ContextVar(
    "apilens_request_attributes",
    default=None,
)

_warned: set[str] = set()
_warned_lock = threading.Lock()


def _warn_once(kind: str, message: str, *args: object) -> None:
    with _warned_lock:
        if kind in _warned:
            return
        _warned.add(kind)
    logger.warning(message, *args)


def _reset_warnings() -> None:
    """Test hook: let every one-time warning fire again."""
    with _warned_lock:
        _warned.clear()


def begin_request_attributes() -> contextvars.Token:
    """Install an empty attribute store for the request starting now."""
    return _attributes_ctx.set({})


def end_request_attributes(token: contextvars.Token) -> None:
    """Restore the store that was active before :func:`begin_request_attributes`."""
    try:
        _attributes_ctx.reset(token)
    except ValueError:
        # Token from another context (e.g. a WSGI generator finished on a
        # different thread); clear instead so nothing leaks to the next request.
        _attributes_ctx.set(None)


def current_request_attributes() -> dict[str, AttributeValue]:
    """A snapshot (copy) of the current request's attributes; ``{}`` outside a request."""
    store = _attributes_ctx.get()
    return dict(store) if store else {}


def set_request_attribute(key: str, value: AttributeValue) -> None:
    """Attach a custom attribute to the request currently being handled.

    ``key`` is a non-empty string (dotted names like ``"tenant.id"`` are
    conventional); ``value`` is a ``str``, ``int``, ``float`` or ``bool``.
    Setting the same key again overwrites it. The attribute is sent as part
    of the ``attributes`` object on the request record, added to the request
    span, and visible to ``mask_request_body`` / ``mask_response_body``
    callbacks as ``info.attributes``::

        import apilens

        @app.get("/orders")
        async def list_orders(user=Depends(current_user)):
            apilens.set_request_attribute("tenant.id", user.tenant_id)
            apilens.set_request_attribute("plan", "enterprise")
            ...

    At most 32 keys per request and 256 characters per string value; extra
    keys are dropped and long strings truncated, with a one-time warning log.
    Calling it outside an instrumented request does nothing.
    """
    store = _attributes_ctx.get()
    if store is None:
        return
    if not isinstance(key, str) or not key.strip():
        _warn_once("key", "apilens: set_request_attribute key must be a non-empty string; got %r (ignored)", key)
        return
    key = key.strip()
    if len(key) > MAX_KEY_CHARS:
        _warn_once(
            "key_len",
            "apilens: set_request_attribute key longer than %d characters (ignored): %.40s...",
            MAX_KEY_CHARS,
            key,
        )
        return
    if not isinstance(value, (str, int, float, bool)):
        _warn_once(
            "type",
            "apilens: set_request_attribute value for %r must be str, int, float or bool; got %s (ignored)",
            key,
            type(value).__name__,
        )
        return
    if isinstance(value, float) and not math.isfinite(value):
        _warn_once("nan", "apilens: set_request_attribute value for %r is not a finite number (ignored)", key)
        return
    if isinstance(value, str) and len(value) > MAX_VALUE_CHARS:
        _warn_once(
            "value_len",
            "apilens: set_request_attribute values are capped at %d characters; truncating %r",
            MAX_VALUE_CHARS,
            key,
        )
        value = value[:MAX_VALUE_CHARS]
    if key not in store and len(store) >= MAX_ATTRIBUTES:
        _warn_once(
            "count",
            "apilens: at most %d request attributes per request; dropping %r and any further keys",
            MAX_ATTRIBUTES,
            key,
        )
        return
    store[key] = value


def span_attributes(attributes: dict[str, AttributeValue]) -> dict[str, str]:
    """Stringify attributes for a span (span attributes are string-valued).

    Booleans become ``"true"`` / ``"false"`` to match their JSON spelling on
    the request record.
    """
    out: dict[str, str] = {}
    for key, value in attributes.items():
        if isinstance(value, bool):
            out[key] = "true" if value else "false"
        else:
            out[key] = str(value)
    return out
