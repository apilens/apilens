"""Graceful shutdown: drain the queue once, with a hard deadline.

The framework integrations call into here from the ASGI ``lifespan``
shutdown event and from ``atexit`` (Django, Flask/WSGI and as a fallback for
ASGI servers that never send a lifespan shutdown). Both paths may fire in the
same process, so a client is shut down at most once (a new ASGI lifespan
startup revives it).

``client.shutdown(flush=True)`` can block for a long time when ingest is slow
or down (per-request HTTP timeout × retries × batches). It therefore runs on a
helper daemon thread that the caller waits on for at most ``timeout`` seconds:
whatever has not been delivered by then is abandoned and the process exits on
schedule. A daemon thread never keeps the interpreter alive.
"""

from __future__ import annotations

import asyncio
import atexit
import logging
import os
import threading
import time
import weakref

from .client import ApiLensClient

logger = logging.getLogger("apilens")

DEFAULT_SHUTDOWN_TIMEOUT = 5.0

_FALSEY = {"0", "false", "no", "off"}

_lock = threading.Lock()
# Client -> the thread running its shutdown (started at most once per client).
_started: "weakref.WeakKeyDictionary[ApiLensClient, threading.Thread]" = weakref.WeakKeyDictionary()
# Clients to flush at interpreter exit -> their shutdown timeout.
_atexit_clients: "weakref.WeakKeyDictionary[ApiLensClient, float]" = weakref.WeakKeyDictionary()
_atexit_hooked = False


def env_flush_on_shutdown() -> bool:
    """Global kill-switch for the automatic shutdown hooks.

    ``APILENS_FLUSH_ON_SHUTDOWN=false`` (or ``0``/``no``/``off``) disables the
    lifespan and ``atexit`` flush for the whole process; it can only turn the
    hooks OFF, never override an explicit ``flush_on_shutdown=False``.
    """
    raw = os.getenv("APILENS_FLUSH_ON_SHUTDOWN")
    if raw is None:
        return True
    return raw.strip().lower() not in _FALSEY


def _normalize_timeout(timeout: float | None) -> float:
    if timeout is None:
        return DEFAULT_SHUTDOWN_TIMEOUT
    return max(0.0, float(timeout))


def _run_shutdown(client: ApiLensClient, timeout: float) -> None:
    try:
        client.shutdown(flush=True, timeout=timeout)
    except Exception:  # pragma: no cover - never raise out of shutdown
        logger.exception("API Lens: error while flushing on shutdown")


def _start(client: ApiLensClient, timeout: float) -> threading.Thread | None:
    """Start the (single) shutdown thread for ``client``; return it.

    Returns ``None`` when the shutdown already ran synchronously because a
    thread could not be started (e.g. late interpreter finalization).
    """
    with _lock:
        thread = _started.get(client)
        if thread is not None:
            return thread
        thread = threading.Thread(
            target=_run_shutdown,
            args=(client, timeout),
            daemon=True,
            name="apilens-shutdown",
        )
        _started[client] = thread
        try:
            thread.start()
        except RuntimeError:
            # Threads can't be started any more: best-effort inline flush.
            _run_shutdown(client, timeout)
            return None
        return thread


def _log_timeout(thread: threading.Thread | None, timeout: float) -> bool:
    if thread is not None and thread.is_alive():
        logger.warning(
            "API Lens: flush did not finish within shutdown_timeout=%.1fs; "
            "undelivered records are dropped",
            timeout,
        )
        return False
    return True


def shutdown_client(client: ApiLensClient, timeout: float | None = DEFAULT_SHUTDOWN_TIMEOUT) -> bool:
    """Flush and stop ``client``, blocking for at most ``timeout`` seconds.

    Idempotent: a second call waits on the first one's flush (again bounded by
    its own ``timeout``) instead of flushing twice. Returns ``True`` when the
    flush completed in time.
    """
    timeout = _normalize_timeout(timeout)
    thread = _start(client, timeout)
    if thread is not None:
        thread.join(timeout)
    return _log_timeout(thread, timeout)


async def shutdown_client_async(client: ApiLensClient, timeout: float | None = DEFAULT_SHUTDOWN_TIMEOUT) -> bool:
    """Async variant of :func:`shutdown_client` that never blocks the event loop."""
    timeout = _normalize_timeout(timeout)
    thread = _start(client, timeout)
    deadline = time.monotonic() + timeout
    while thread is not None and thread.is_alive() and time.monotonic() < deadline:
        await asyncio.sleep(0.01)
    return _log_timeout(thread, timeout)


def revive_client(client: ApiLensClient) -> None:
    """Undo a completed shutdown so ``client`` delivers again.

    Called on ASGI ``lifespan.startup``: the same app (and client) can go
    through several lifespans in one process, e.g. a test suite entering
    ``TestClient(app)`` repeatedly. A shutdown still in progress is left alone.
    """
    with _lock:
        thread = _started.get(client)
        if thread is None or thread.is_alive():
            return
        del _started[client]
    if client.config.enabled:
        client.start()


def register_atexit(client: ApiLensClient, timeout: float | None = DEFAULT_SHUTDOWN_TIMEOUT) -> None:
    """Flush ``client`` (bounded by ``timeout``) when the interpreter exits.

    Registering the same client again only updates its timeout. All registered
    clients are flushed concurrently, so exit waits for at most the largest
    timeout rather than their sum.
    """
    global _atexit_hooked
    timeout = _normalize_timeout(timeout)
    with _lock:
        _atexit_clients[client] = timeout
        if not _atexit_hooked:
            atexit.register(_shutdown_registered)
            _atexit_hooked = True


def _shutdown_registered() -> None:
    with _lock:
        pending = list(_atexit_clients.items())
        _atexit_clients.clear()
    started = [(_start(client, timeout), timeout) for client, timeout in pending]
    begin = time.monotonic()
    for thread, timeout in started:
        if thread is not None:
            thread.join(max(0.0, timeout - (time.monotonic() - begin)))
        _log_timeout(thread, timeout)


__all__ = [
    "DEFAULT_SHUTDOWN_TIMEOUT",
    "env_flush_on_shutdown",
    "register_atexit",
    "revive_client",
    "shutdown_client",
    "shutdown_client_async",
]
