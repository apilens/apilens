"""Full exception payloads for the ``apilens.exception`` log (M5 D3/D4).

An exception is described by its qualified type (``module.QualName``), its
message, the complete ``traceback.format_exception`` output (every chained
``__cause__``/``__context__`` and every ``ExceptionGroup`` sub-exception) and
the length of its cause chain.

With ``capture_locals`` (opt-in, M5 D5) each of the innermost
:data:`MAX_LOCALS_FRAMES` frames of every exception in the chain gets a
``Locals:`` section: up to :data:`MAX_LOCALS_PER_FRAME` names, each value's
``repr`` masked by the redaction rules (sensitive *names* become
``[redacted]``, sensitive ``key=value`` pairs inside a repr too) and then
capped at :data:`MAX_LOCAL_REPR` characters. Modules, functions, classes and
dunder names are skipped.

Oversized text keeps its head **and** its tail around a
``\\n…[N chars truncated]…\\n`` marker. ``format_exception`` prints the root
cause first and the raised exception last, so both survive the cap.
"""

from __future__ import annotations

import reprlib
import traceback
import types
from typing import Any

from ._sanitize import _DEFAULT_LOG_NAME_RE, REDACTED, Redactor, mask_log_text

# Exception payload cap (stack trace with every cause), in characters.
MAX_EXCEPTION_PAYLOAD = 64 * 1024
# Exception / error log message cap, in characters.
MAX_EXCEPTION_MESSAGE = 8 * 1024

# ExceptionGroup rendering limits: the stdlib defaults (15 sub-exceptions,
# depth 10) silently drop the rest; the head+tail cap bounds the size instead.
_MAX_GROUP_WIDTH = 1000
_MAX_GROUP_DEPTH = 100

# capture_locals caps (M5 D5): innermost frames per exception, names per
# frame, characters per value.
MAX_LOCALS_FRAMES = 10
MAX_LOCALS_PER_FRAME = 20
MAX_LOCAL_REPR = 256

# Bounded repr: a huge container is never rendered in full just to be cut to
# MAX_LOCAL_REPR characters afterwards.
_REPR = reprlib.Repr()
_REPR.maxlevel = 3
_REPR.maxdict = _REPR.maxlist = _REPR.maxtuple = _REPR.maxset = _REPR.maxfrozenset = 32
_REPR.maxdeque = _REPR.maxarray = 32
_REPR.maxstring = _REPR.maxother = _REPR.maxlong = MAX_LOCAL_REPR * 4

_SKIPPED_LOCAL_TYPES = (
    types.ModuleType,
    types.FunctionType,
    types.BuiltinFunctionType,
    types.MethodType,
    type,
)


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


def _sensitive_local(name: str, redactor: Redactor | None) -> bool:
    if _DEFAULT_LOG_NAME_RE.search(name):
        return True
    if redactor is None:
        return False
    return redactor.body_fields.search(name) is not None or redactor.query_params.search(name) is not None


def _local_repr(value: Any) -> str:
    try:
        text = _REPR.repr(value)
    except Exception:
        text = f"<unrepresentable {type(value).__name__}>"
    # Mask before truncating, so a cut never leaves half a secret behind.
    text = mask_log_text(text)
    if len(text) > MAX_LOCAL_REPR:
        text = text[: MAX_LOCAL_REPR - 1] + "…"
    return text


def frame_locals(frame: types.FrameType, redactor: Redactor | None = None) -> list[tuple[str, str]]:
    """``(name, masked capped repr)`` for up to :data:`MAX_LOCALS_PER_FRAME`
    locals of ``frame``, in definition order."""
    out: list[tuple[str, str]] = []
    try:
        items = list(frame.f_locals.items())
    except Exception:
        return out
    for name, value in items:
        if len(out) >= MAX_LOCALS_PER_FRAME:
            break
        name = str(name)
        if name.startswith("__") or isinstance(value, _SKIPPED_LOCAL_TYPES):
            continue
        if _sensitive_local(name, redactor):
            out.append((name, REDACTED))
        else:
            out.append((name, _local_repr(value)))
    return out


# Python 3.11+ formats each frame through StackSummary.format_frame_summary.
_PER_FRAME_HOOK = hasattr(traceback.StackSummary, "format_frame_summary")


class _LocalsStack(traceback.StackSummary):
    """A ``StackSummary`` that prints a ``Locals:`` section under the frames
    it has locals for (keyed by frame-summary identity)."""

    _apilens_locals: dict[int, list[tuple[str, str]]]

    def _locals_text(self, frame_summary: Any) -> str:
        pairs = self._apilens_locals.get(id(frame_summary))
        if not pairs:
            return ""
        return "    Locals:\n" + "".join(f"      {name} = {value}\n" for name, value in pairs)

    def format_frame_summary(self, frame_summary, *args, **kwargs):  # type: ignore[override]
        text = super().format_frame_summary(frame_summary, *args, **kwargs)
        if text is None:
            return text
        return text + self._locals_text(frame_summary)

    if not _PER_FRAME_HOOK:  # Python 3.10: no per-frame hook, format frame by frame

        def format(self):  # type: ignore[override]
            out: list[str] = []
            for frame_summary in self:
                out.extend(traceback.StackSummary.from_list([frame_summary]).format())
                text = self._locals_text(frame_summary)
                if text:
                    out.append(text)
            return out


def _attach_locals(te: traceback.TracebackException, exc: BaseException, redactor: Redactor | None) -> None:
    """Attach the innermost frames' locals to ``te`` and to every chained /
    grouped exception, walking ``exc`` alongside it."""
    seen: set[int] = set()
    pending: list[tuple[Any, BaseException | None]] = [(te, exc)]
    while pending:
        node, err = pending.pop()
        if node is None or err is None or id(node) in seen:
            continue
        seen.add(id(node))
        frames = [frame for frame, _ in traceback.walk_tb(err.__traceback__)]
        stack = node.stack
        if frames and len(frames) == len(stack):
            captured: dict[int, list[tuple[str, str]]] = {}
            start = max(0, len(frames) - MAX_LOCALS_FRAMES)
            for frame, summary in zip(frames[start:], list(stack)[start:]):
                pairs = frame_locals(frame, redactor)
                if pairs:
                    captured[id(summary)] = pairs
            if captured:
                new_stack = _LocalsStack(stack)
                new_stack._apilens_locals = captured
                node.stack = new_stack
        pending.append((getattr(node, "__cause__", None), err.__cause__))
        pending.append((getattr(node, "__context__", None), err.__context__))
        for sub_node, sub_err in zip(getattr(node, "exceptions", None) or (), getattr(err, "exceptions", None) or ()):
            pending.append((sub_node, sub_err))


def format_exception_full(
    exc: BaseException, *, capture_locals: bool = False, redactor: Redactor | None = None
) -> str:
    """Full ``format_exception`` text: every frame, every chained cause and
    every ``ExceptionGroup`` sub-exception (plus per-frame ``Locals:`` when
    ``capture_locals``)."""
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
    if capture_locals:
        try:
            _attach_locals(te, exc, redactor)
        except Exception:  # never lose the trace over its locals
            pass
    return "".join(te.format())


def describe_exception(
    exc: BaseException, *, capture_locals: bool = False, redactor: Redactor | None = None
) -> tuple[str, str, dict[str, str]]:
    """Build ``(message, payload, attributes)`` for an ``apilens.exception`` log.

    ``message`` is ``module.QualName: msg`` capped at 8 KiB, ``payload`` the
    full traceback capped at 64 KiB (head+tail), and ``attributes`` carry
    ``exception.type``, ``exception.message`` and ``exception.chain_depth``.
    ``capture_locals`` adds each innermost frame's masked locals to the payload.
    """
    exc_type = qualified_type(exc)
    try:
        text = str(exc)
    except Exception:
        text = "<unprintable exception>"
    message = f"{exc_type}: {text}".strip() if text else exc_type
    payload = format_exception_full(exc, capture_locals=capture_locals, redactor=redactor)
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
