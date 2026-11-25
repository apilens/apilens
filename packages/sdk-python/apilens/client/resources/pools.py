"""Database connection pools: SQLAlchemy ``QueuePool`` and Django connections.

Pools are discovered lazily. Nothing is imported: once the app itself has
imported SQLAlchemy (or ``django.db``), a hook records each engine on its
first connection (``engine_connect``) or each Django connection when it opens
(``connection_created``). Only weak references are kept, so a disposed engine
disappears from the list.

* SQLAlchemy: ``used`` = checked-out connections, ``idle`` = checked-in,
  ``max`` = ``pool_size + max_overflow`` (``None`` with unlimited overflow),
  ``pending`` = callers waiting for a connection when the pool's queue exposes
  them.
* Django: connections are per thread, so ``used`` is the open connections of
  the alias across all threads; Django has no idle pool or maximum.

No pool in use: no ``pools`` key at all.
"""

from __future__ import annotations

import sys
import threading
import weakref
from typing import Any

from ._window import Sample

MAX_POOLS = 10
MAX_NAME = 64

_lock = threading.Lock()
_engines: "weakref.WeakSet[Any]" = weakref.WeakSet()
_django_wrappers: "weakref.WeakSet[Any]" = weakref.WeakSet()
_hooked: set[str] = set()


def _on_engine_connect(conn, *args) -> None:
    try:
        engine = conn.engine
    except Exception:
        return
    if engine not in _engines:
        with _lock:
            _engines.add(engine)


def _on_django_connection(sender, connection, **kwargs) -> None:
    _django_wrappers.add(connection)


def hook_sqlalchemy() -> bool:
    if "sqlalchemy" in _hooked:
        return True
    if "sqlalchemy" not in sys.modules:
        return False
    try:
        from sqlalchemy import event
        from sqlalchemy.engine import Engine
    except Exception:
        return False
    with _lock:
        if "sqlalchemy" in _hooked:
            return True
        event.listen(Engine, "engine_connect", _on_engine_connect)
        _hooked.add("sqlalchemy")
    return True


def hook_django() -> bool:
    if "django" in _hooked:
        return True
    if "django.db" not in sys.modules:
        return False
    try:
        from django.db.backends.signals import connection_created
    except Exception:
        return False
    with _lock:
        if "django" in _hooked:
            return True
        connection_created.connect(
            _on_django_connection, weak=False, dispatch_uid="apilens.resources.pools"
        )
        _hooked.add("django")
    return True


def track_engine(engine: Any) -> None:
    """Report ``engine``'s pool now, without waiting for its next connect."""
    with _lock:
        _engines.add(engine)


def _sa_name(engine: Any) -> str:
    try:
        url = engine.url
        name = url.database or url.host or ""
    except Exception:
        name = ""
    name = str(name).rsplit("/", 1)[-1] if name else "default"
    return name[:MAX_NAME] or "default"


def _sa_waiters(pool: Any) -> float | None:
    queue = getattr(pool, "_pool", None)
    cond = getattr(queue, "not_empty", None)
    waiters = getattr(cond, "_waiters", None)
    try:
        return float(len(waiters)) if waiters is not None else None
    except TypeError:
        return None


def sqlalchemy_pools() -> list[dict]:
    out = []
    with _lock:
        engines = list(_engines)
    seen: dict[str, int] = {}
    for engine in engines:
        pool = getattr(engine, "pool", None)
        if pool is None or not callable(getattr(pool, "checkedout", None)):
            continue  # NullPool / StaticPool: nothing pooled to report
        try:
            used = float(pool.checkedout())
            idle = float(pool.checkedin()) if callable(getattr(pool, "checkedin", None)) else None
            size = pool.size() if callable(getattr(pool, "size", None)) else None
        except Exception:
            continue
        overflow = getattr(pool, "_max_overflow", None)
        cap = None
        if isinstance(size, int) and isinstance(overflow, int) and overflow >= 0:
            cap = float(size + overflow)
        name = _sa_name(engine)
        seen[name] = seen.get(name, 0) + 1
        if seen[name] > 1:
            name = f"{name}#{seen[name]}"[:MAX_NAME]
        out.append(
            {
                "name": name,
                "kind": "sqlalchemy",
                "used": used,
                "idle": idle,
                "max": cap,
                "pending": _sa_waiters(pool),
            }
        )
    return out


def django_pools() -> list[dict]:
    counts: dict[str, int] = {}
    for wrapper in list(_django_wrappers):
        alias = getattr(wrapper, "alias", None) or "default"
        counts.setdefault(alias, 0)
        if getattr(wrapper, "connection", None) is not None:
            counts[alias] += 1
    return [
        {"name": alias[:MAX_NAME], "kind": "django", "used": float(n), "idle": None, "max": None, "pending": None}
        for alias, n in sorted(counts.items())
    ]


class Pools:
    """``pools``: every pool the app has used, at most 10."""

    name = "pools"
    capability = "pools"
    every = 0.0
    expensive = False

    def __init__(self, ctx) -> None:
        self.ctx = ctx

    def reset(self) -> None:
        pass

    def collect(self, sample: Sample, now: float) -> bool:
        hook_sqlalchemy()
        hook_django()
        pools = (sqlalchemy_pools() + django_pools())[:MAX_POOLS]
        if not pools:
            return False
        meta = []
        for p in pools:
            sample.gauge(("pool", p["name"], "used"), p["used"])
            sample.gauge(("pool", p["name"], "pending"), p["pending"])
            meta.append({"name": p["name"], "kind": p["kind"], "idle": p["idle"], "max": p["max"]})
        sample.set_items("pools", meta)
        return True


__all__ = ["Pools", "django_pools", "hook_django", "hook_sqlalchemy", "sqlalchemy_pools", "track_engine"]
