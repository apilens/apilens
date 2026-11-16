"""Full exception payloads for the ``apilens.exception`` log (M5 D3/D4).

An exception is described by its qualified type (``module.QualName``), its
message, the complete ``traceback.format_exception`` output (every chained
``__cause__``/``__context__`` and every ``ExceptionGroup`` sub-exception) and
the length of its cause chain.

Oversized text keeps its head **and** its tail around a
``\\n…[N chars truncated]…\\n`` marker. ``format_exception`` prints the root
cause first and the raised exception last, so both survive the cap.
"""

from __future__ import annotations

import traceback

# Exception payload cap (stack trace with every cause), in characters.
MAX_EXCEPTION_PAYLOAD = 64 * 1024
# Exception / error log message cap, in characters.
MAX_EXCEPTION_MESSAGE = 8 * 1024

# ExceptionGroup rendering limits: the stdlib defaults (15 sub-exceptions,
# depth 10) silently drop the rest; the head+tail cap bounds the size instead.
_MAX_GROUP_WIDTH = 1000
_MAX_GROUP_DEPTH = 100


def truncate_head_tail(text: str, limit: int) -> str:
    """Return ``text`` capped at ``limit`` characters, keeping the head and the
    tail with a ``\\n…[N chars truncated]…\\n`` marker in the middle."""
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    dropped = len(text)
    # The marker's own length depends on N; settle it in a couple of passes.
    for _ in range(3):
        marker = f"\n…[{dropped} chars truncated]…\n"
        keep = limit - len(marker)
        if keep <= 0:
            return text[:limit]
        new_dropped = len(text) - keep
        if new_dropped == dropped:
            break
        dropped = new_dropped
    marker = f"\n…[{dropped} chars truncated]…\n"
    keep = max(0, limit - len(marker))
    head = keep - keep // 2
    tail = keep // 2
    return text[:head] + marker + (text[len(text) - tail :] if tail else "")


def qualified_type(exc: BaseException) -> str:
    """``module.QualName`` of the exception's class (builtins stay bare)."""
    cls = type(exc)
    name = getattr(cls, "__qualname__", None) or cls.__name__
    module = getattr(cls, "__module__", None) or ""
    if module and module != "builtins":
        return f"{module}.{name}"
    return name


def chain_depth(exc: BaseException) -> int:
    """Number of exceptions in the ``__cause__`` / ``__context__`` chain,
    the raised exception included (1 when nothing is chained)."""
    depth = 0
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        depth += 1
        if current.__cause__ is not None:
            current = current.__cause__
        elif current.__context__ is not None and not current.__suppress_context__:
            current = current.__context__
        else:
            current = None
    return depth


def format_exception_full(exc: BaseException) -> str:
    """Full ``format_exception`` text: every frame, every chained cause and
    every ``ExceptionGroup`` sub-exception."""
    try:
        te = traceback.TracebackException(
            type(exc),
            exc,
            exc.__traceback__,
            max_group_width=_MAX_GROUP_WIDTH,
            max_group_depth=_MAX_GROUP_DEPTH,
        )
    except TypeError:  # Python 3.10: no ExceptionGroup, no group limits
        te = traceback.TracebackException(type(exc), exc, exc.__traceback__)
    return "".join(te.format())


def describe_exception(exc: BaseException) -> tuple[str, str, dict[str, str]]:
    """Build ``(message, payload, attributes)`` for an ``apilens.exception`` log.

    ``message`` is ``module.QualName: msg`` capped at 8 KiB, ``payload`` the
    full traceback capped at 64 KiB (head+tail), and ``attributes`` carry
    ``exception.type``, ``exception.message`` and ``exception.chain_depth``.
    """
    exc_type = qualified_type(exc)
    try:
        text = str(exc)
    except Exception:
        text = "<unprintable exception>"
    message = f"{exc_type}: {text}".strip() if text else exc_type
    payload = format_exception_full(exc)
    attributes = {
        "exception.type": exc_type,
        "exception.message": truncate_head_tail(text, MAX_EXCEPTION_MESSAGE),
        "exception.chain_depth": str(chain_depth(exc)),
    }
    return (
        truncate_head_tail(message, MAX_EXCEPTION_MESSAGE),
        truncate_head_tail(payload, MAX_EXCEPTION_PAYLOAD),
        attributes,
    )
