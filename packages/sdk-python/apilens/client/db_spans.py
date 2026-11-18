"""Database spans — one ``db`` child span per statement run during a request.

Installed by the middlewares (through :func:`.spans.configure_spans`) when span
capture is on, unless ``capture_db_spans=False`` (``APILENS_CAPTURE_DB_SPANS``).
Covered drivers, each only when it is importable:

* SQLAlchemy — ``before/after_cursor_execute`` and ``handle_error`` engine
  events, registered on the ``Engine`` class so every engine is covered.
* Django ORM — ``connection.execute_wrapper`` installed on every connection
  (existing ones and those opened later, via ``connection_created``).
* psycopg (3) — ``Cursor`` / ``AsyncCursor`` ``execute`` and ``executemany``.
* asyncpg — ``Connection`` ``execute``, ``executemany``, ``fetch``,
  ``fetchrow`` and ``fetchval``.

Every span carries ``db.system``, ``db.operation`` and ``db.statement``: the
statement with every literal (strings, numbers, comments) replaced by ``?``
and capped at 2 KiB, so values never leave the app. Bound parameters are never
read. A statement that raised makes an ``error`` span with ``error.type``.

A statement run through two layers (SQLAlchemy or Django on top of psycopg)
becomes one span: the outermost layer records it, inner ones see it in flight.
"""

from __future__ import annotations

import contextvars
import re
import sys
import threading
import time
from typing import Any

from . import spans as _spans
from .trace import current_span_id, current_trace_id, generate_span_id

MAX_STATEMENT_CHARS = 2048

_enabled = False
_lock = threading.Lock()
_installed: set[str] = set()

# The trace id while a statement is being recorded, so an inner driver layer
# does not record the same statement twice. Holding the trace id (not a bool)
# means a pair of events that never closed cannot mute later requests.
_in_db_span: contextvars.ContextVar[str] = contextvars.ContextVar("apilens_in_db_span", default="")


# ── Statement obfuscation ──────────────────────────────────────────────────

# One pass, left to right: comments and literals become ``?``; quoted
# identifiers are kept as they are (and shield their content from the number
# rule); bind placeholders ($1, %s, %(name)s, :name, ?) are untouched.
_TOKEN_RE = re.compile(
    r"""
    (?P<comment>--[^\n]*|/\*.*?(?:\*/|\Z))
  | (?P<dollar>\$\$.*?(?:\$\$|\Z)|\$(?P<tag>[A-Za-z_][A-Za-z0-9_]*)\$.*?(?:\$(?P=tag)\$|\Z))
  | (?P<string>(?<![A-Za-z0-9_])[EeNnBbXx]?'(?:[^'\\]|\\.|'')*(?:'|\Z))
  | (?P<ident>"(?:[^"]|"")*"|`[^`]*`)
  | (?P<hex>(?<![\w$])0[xX][0-9A-Fa-f]+)
  | (?P<number>(?<![\w$:])(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)
  | (?P<word>[A-Za-z_][\w$]*)
    """,
    re.VERBOSE | re.DOTALL,
)
_IN_LIST_RE = re.compile(r"\bIN\s*\(\s*\?(?:\s*,\s*\?)+\s*\)", re.IGNORECASE)
_SPACE_RE = re.compile(r"\s+")


def _keep_quoted(match: re.Match[str]) -> str:
    group = match.lastgroup
    if group in ("ident", "word"):
        return match.group(0)
    if group == "comment":
        return " "
    return "?"


def _mysql_quoted(match: re.Match[str]) -> str:
    # MySQL (default sql_mode) reads "..." as a string literal, not a name.
    if match.lastgroup == "ident" and match.group(0).startswith('"'):
        return "?"
    return _keep_quoted(match)


def obfuscate_statement(statement: Any, system: str = "") -> str:
    """``statement`` with every literal replaced by ``?``, whitespace
    collapsed, ``IN (?, ?, ?)`` lists folded to ``(?)``, capped at
    :data:`MAX_STATEMENT_CHARS`. ``system`` (``db.system``) only changes how
    double quotes read: identifiers everywhere but MySQL/MariaDB."""
    if isinstance(statement, (bytes, bytearray, memoryview)):
        text = bytes(statement).decode("utf-8", "replace")
    else:
        text = str(statement or "")
    replace = _mysql_quoted if system in ("mysql", "mariadb") else _keep_quoted
    text = _TOKEN_RE.sub(replace, text)
    text = _IN_LIST_RE.sub("IN (?)", text)
    text = _SPACE_RE.sub(" ", text).strip()
    if len(text) > MAX_STATEMENT_CHARS:
        text = text[: MAX_STATEMENT_CHARS - 3] + "..."
    return text


def statement_operation(statement: str) -> str:
    """First keyword of an (obfuscated) statement, upper-cased: ``SELECT``."""
    match = re.search(r"[A-Za-z]+", statement or "")
    return match.group(0).upper() if match else ""


# ── Span lifecycle ─────────────────────────────────────────────────────────


class _DbSpan:
    __slots__ = ("token", "trace_id", "span_id", "parent", "started", "system", "statement")

    def __init__(self, token, trace_id, span_id, parent, started, system, statement) -> None:
        self.token = token
        self.trace_id = trace_id
        self.span_id = span_id
        self.parent = parent
        self.started = started
        self.system = system
        self.statement = statement


def start_db_span(system: str, statement: Any) -> _DbSpan | None:
    """Begin a span for one statement; ``None`` when nothing should be
    recorded (db spans off, no request in flight, or an outer layer already
    records this statement). Pass the result to :func:`finish_db_span`."""
    if not _enabled or _spans._recorder is None:
        return None
    trace_id = current_trace_id()
    if not trace_id or _in_db_span.get() == trace_id:
        return None
    system = system or "other_sql"
    try:
        text = obfuscate_statement(statement, system)
    except Exception:
        text = ""
    return _DbSpan(
        _in_db_span.set(trace_id),
        trace_id,
        generate_span_id(),
        current_span_id(),
        time.perf_counter(),
        system,
        text,
    )


def finish_db_span(span: _DbSpan | None, error: BaseException | None = None) -> None:
    """Record ``span`` (no-op for ``None``); ``error`` marks it failed."""
    if span is None:
        return
    try:
        _in_db_span.reset(span.token)
    except ValueError:
        # Finished in another context (an event pair split across tasks).
        _in_db_span.set("")
    try:
        operation = statement_operation(span.statement)
        attributes = {
            "db.system": span.system,
            "db.operation": operation,
            "db.statement": span.statement,
        }
        if error is not None:
            attributes["error.type"] = f"{type(error).__module__}.{type(error).__qualname__}"
        _spans.record_span(
            name=span.statement[:256] or operation or span.system,
            kind="db",
            trace_id=span.trace_id,
            span_id=span.span_id,
            parent_span_id=span.parent,
            duration_ms=(time.perf_counter() - span.started) * 1000.0,
            status="error" if error is not None else "ok",
            attributes=attributes,
        )
    except Exception:
        pass


# ── Installation ───────────────────────────────────────────────────────────


def set_db_spans_enabled(enabled: bool) -> None:
    """Turn db spans on or off process-wide; turning them on installs the
    driver hooks once (idempotent, never raises)."""
    global _enabled
    _enabled = bool(enabled)
    if _enabled:
        instrument_databases()


def db_spans_enabled() -> bool:
    return _enabled


def instrument_databases() -> None:
    """Install the hooks for every importable driver (each at most once)."""
    for name, patch in (
        ("sqlalchemy", _patch_sqlalchemy),
        ("django", _patch_django),
        ("psycopg", _patch_psycopg),
        ("asyncpg", _patch_asyncpg),
    ):
        with _lock:
            if name in _installed:
                continue
        try:
            if patch():
                with _lock:
                    _installed.add(name)
        except Exception:
            pass


# SQLAlchemy ────────────────────────────────────────────────────────────────

_SA_KEY = "apilens_db_spans"


def _sa_before(conn, cursor, statement, parameters, context, executemany) -> None:
    span = start_db_span(_sa_system(conn), statement)
    if span is not None:
        conn.info.setdefault(_SA_KEY, []).append(span)


def _sa_after(conn, cursor, statement, parameters, context, executemany) -> None:
    stack = conn.info.get(_SA_KEY)
    if stack:
        finish_db_span(stack.pop())


def _sa_error(exception_context) -> None:
    conn = getattr(exception_context, "connection", None)
    stack = conn.info.get(_SA_KEY) if conn is not None else None
    if stack:
        finish_db_span(stack.pop(), exception_context.original_exception)


def _sa_system(conn) -> str:
    try:
        return _system_name(conn.engine.dialect.name)
    except Exception:
        return "other_sql"


def _patch_sqlalchemy() -> bool:
    try:
        from sqlalchemy import event
        from sqlalchemy.engine import Engine
    except ImportError:
        return False
    event.listen(Engine, "before_cursor_execute", _sa_before)
    event.listen(Engine, "after_cursor_execute", _sa_after)
    event.listen(Engine, "handle_error", _sa_error)
    return True


# Django ────────────────────────────────────────────────────────────────────


def _django_wrapper(execute, sql, params, many, context):
    connection = context.get("connection") if isinstance(context, dict) else None
    span = start_db_span(_system_name(getattr(connection, "vendor", "")), sql)
    try:
        result = execute(sql, params, many, context)
    except BaseException as exc:
        finish_db_span(span, exc)
        raise
    finish_db_span(span)
    return result


def _install_django_wrapper(connection) -> None:
    wrappers = getattr(connection, "execute_wrappers", None)
    if wrappers is not None and _django_wrapper not in wrappers:
        wrappers.append(_django_wrapper)


def _on_connection_created(sender, connection, **kwargs) -> None:
    _install_django_wrapper(connection)


def _patch_django() -> bool:
    # Only for an app that uses Django: importing it here would cost a
    # Flask/FastAPI app that merely has it installed (retried on the next
    # configure otherwise).
    if "django" not in sys.modules:
        return False
    try:
        from django.conf import settings
        from django.db import connections
        from django.db.backends.signals import connection_created
    except ImportError:
        return False
    connection_created.connect(_on_connection_created, weak=False, dispatch_uid="apilens.db_spans")
    # Connections already initialised get the wrapper too; ``execute_wrappers``
    # lives on the wrapper object (one per thread), not on the DB socket.
    if settings.configured:
        for alias in connections:
            _install_django_wrapper(connections[alias])
    return True


# psycopg (3) ───────────────────────────────────────────────────────────────

_WRAPPED = "__apilens_db_wrapped__"


def _psycopg_text(cursor, query) -> Any:
    if isinstance(query, (str, bytes)):
        return query
    try:
        return query.as_string(cursor.connection)
    except Exception:
        return ""


def _wrap_sync(original, system: str, text_of):
    if getattr(original, _WRAPPED, False):
        return original

    def wrapper(self, query, *args, **kwargs):
        span = start_db_span(system, text_of(self, query))
        try:
            result = original(self, query, *args, **kwargs)
        except BaseException as exc:
            finish_db_span(span, exc)
            raise
        finish_db_span(span)
        return result

    setattr(wrapper, _WRAPPED, True)
    wrapper.__wrapped__ = original  # type: ignore[attr-defined]
    wrapper.__name__ = getattr(original, "__name__", "execute")
    return wrapper


def _wrap_async(original, system: str, text_of):
    if getattr(original, _WRAPPED, False):
        return original

    async def wrapper(self, query, *args, **kwargs):
        span = start_db_span(system, text_of(self, query))
        try:
            result = await original(self, query, *args, **kwargs)
        except BaseException as exc:
            finish_db_span(span, exc)
            raise
        finish_db_span(span)
        return result

    setattr(wrapper, _WRAPPED, True)
    wrapper.__wrapped__ = original  # type: ignore[attr-defined]
    wrapper.__name__ = getattr(original, "__name__", "execute")
    return wrapper


def _patch_psycopg() -> bool:
    try:
        import psycopg
    except ImportError:
        return False
    for cls_name, wrap in (("Cursor", _wrap_sync), ("AsyncCursor", _wrap_async)):
        cls = getattr(psycopg, cls_name, None)
        if cls is None:
            continue
        for method in ("execute", "executemany"):
            original = getattr(cls, method, None)
            if original is not None:
                setattr(cls, method, wrap(original, "postgresql", _psycopg_text))
    return True


# asyncpg ───────────────────────────────────────────────────────────────────


def _asyncpg_text(connection, query) -> Any:
    return query if isinstance(query, (str, bytes)) else ""


def _patch_asyncpg() -> bool:
    try:
        from asyncpg.connection import Connection
    except ImportError:
        return False
    for method in ("execute", "executemany", "fetch", "fetchrow", "fetchval"):
        original = getattr(Connection, method, None)
        if original is not None:
            setattr(Connection, method, _wrap_async(original, "postgresql", _asyncpg_text))
    return True


_SYSTEMS = {
    "postgresql": "postgresql",
    "postgres": "postgresql",
    "sqlite": "sqlite",
    "mysql": "mysql",
    "mariadb": "mariadb",
    "oracle": "oracle",
    "mssql": "mssql",
    "microsoft": "mssql",
}


def _system_name(raw: str) -> str:
    return _SYSTEMS.get(str(raw or "").lower(), str(raw or "").lower() or "other_sql")


__all__ = [
    "MAX_STATEMENT_CHARS",
    "db_spans_enabled",
    "finish_db_span",
    "instrument_databases",
    "obfuscate_statement",
    "set_db_spans_enabled",
    "start_db_span",
    "statement_operation",
]
