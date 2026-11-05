"""Graceful shutdown hooks with a bounded flush (issue #532)."""

from __future__ import annotations

import asyncio
import threading
import time
import weakref
from datetime import datetime, timezone

import pytest

from apilens.client import ApiLensClient, ApiLensConfig
from apilens.client import _shutdown
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware
from apilens.client.models import RequestRecord


@pytest.fixture(autouse=True)
def _hooks_enabled(monkeypatch):
    monkeypatch.delenv("APILENS_FLUSH_ON_SHUTDOWN", raising=False)
    # Fresh registry per test, and never hook the real interpreter atexit.
    monkeypatch.setattr(_shutdown, "_atexit_clients", weakref.WeakKeyDictionary())
    monkeypatch.setattr(_shutdown, "_atexit_hooked", True)


class RecordingClient(ApiLensClient):
    """Real client (real queues and flush loop); the request-batch send is recorded."""

    def __init__(self, delay: float = 0.0) -> None:
        super().__init__(
            ApiLensConfig(api_key="test-key", max_retries=0, retry_backoff_base=0.0),
            start_worker=False,
        )
        self.sent: list[int] = []
        self.order: list[str] | None = None
        self.delay = delay
        self.release = threading.Event()

    def _send_batch(self, batch) -> None:
        if self.delay:
            self.release.wait(self.delay)  # ingest "hangs" until released
        if self.order is not None:
            self.order.append("flush")
        self.sent.append(len(batch))


def _record(path: str = "/orders") -> RequestRecord:
    return RequestRecord(
        timestamp=datetime.now(tz=timezone.utc),
        environment="test",
        method="GET",
        path=path,
        status_code=200,
        response_time_ms=1.0,
    )


def _lifespan_app(events: list[str], *, raise_on_shutdown: bool = False):
    async def app(scope, receive, send):
        assert scope["type"] == "lifespan"
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                events.append("app-shutdown-handlers")
                if raise_on_shutdown:
                    raise RuntimeError("boom")
                await send({"type": "lifespan.shutdown.complete"})
                return

    return app


def _run_lifespan(mw, events: list[str] | None = None) -> list[str]:
    """Drive startup + shutdown like an ASGI server; return the message types sent."""
    inbox = [{"type": "lifespan.startup"}, {"type": "lifespan.shutdown"}]
    sent = events if events is not None else []

    async def receive():
        return inbox.pop(0)

    async def send(message):
        sent.append(message["type"])

    async def main():
        try:
            await mw({"type": "lifespan", "asgi": {"version": "3.0"}}, receive, send)
        except RuntimeError:
            sent.append("raised")

    asyncio.run(main())
    return sent


def _asgi(app, client, **kwargs):
    return ApiLensASGIMiddleware(app, client, app_id="orders-api", capture_spans=False, **kwargs)


def test_lifespan_shutdown_drains_queue():
    client = RecordingClient()
    events: list[str] = []
    client.order = events
    mw = _asgi(_lifespan_app(events), client)
    for i in range(5):
        client.capture_record(_record(f"/orders/{i}"))

    _run_lifespan(mw, events)

    assert sum(client.sent) == 5
    assert len(client._queue) == 0
    # The app's own shutdown handlers run first; the flush happens before the
    # server is told shutdown is complete.
    assert events == [
        "lifespan.startup.complete",
        "app-shutdown-handlers",
        "flush",
        "lifespan.shutdown.complete",
    ]


def test_lifespan_flushes_even_when_app_raises_during_shutdown():
    client = RecordingClient()
    mw = _asgi(_lifespan_app([], raise_on_shutdown=True), client)
    client.capture_record(_record())
    sent = _run_lifespan(mw)
    assert sent[-1] == "raised"
    assert client.sent == [1]


def test_lifespan_shutdown_is_bounded_by_shutdown_timeout():
    client = RecordingClient(delay=10.0)
    mw = _asgi(_lifespan_app([]), client, shutdown_timeout=0.2)
    client.capture_record(_record())
    started = time.monotonic()
    sent = _run_lifespan(mw)
    elapsed = time.monotonic() - started
    client.release.set()
    assert sent[-1] == "lifespan.shutdown.complete"
    assert elapsed < 1.0


def test_shutdown_client_never_blocks_longer_than_timeout():
    client = RecordingClient(delay=10.0)
    client.capture_record(_record())
    started = time.monotonic()
    assert _shutdown.shutdown_client(client, 0.2) is False
    assert time.monotonic() - started < 0.6
    client.release.set()


def test_shutdown_client_is_idempotent():
    client = RecordingClient()
    client.capture_record(_record())
    assert _shutdown.shutdown_client(client, 1.0) is True
    client.capture_record(_record())  # arrives after shutdown: not flushed again
    assert _shutdown.shutdown_client(client, 1.0) is True
    assert client.sent == [1]


def test_flush_on_shutdown_false_passes_lifespan_through():
    client = RecordingClient()
    mw = _asgi(_lifespan_app([]), client, flush_on_shutdown=False)
    client.capture_record(_record())
    assert _run_lifespan(mw)[-1] == "lifespan.shutdown.complete"
    assert client.sent == []
    assert client not in _shutdown._atexit_clients


def test_env_kill_switch_disables_hooks(monkeypatch):
    monkeypatch.setenv("APILENS_FLUSH_ON_SHUTDOWN", "false")
    client = RecordingClient()
    mw = _asgi(_lifespan_app([]), client)
    client.capture_record(_record())
    _run_lifespan(mw)
    assert client.sent == []
    assert client not in _shutdown._atexit_clients


def test_asgi_and_wsgi_register_atexit_with_timeout():
    asgi_client, wsgi_client = RecordingClient(), RecordingClient()
    _asgi(_lifespan_app([]), asgi_client, shutdown_timeout=2.5)
    ApiLensWSGIMiddleware(lambda environ, start: [], wsgi_client, app_id="w", capture_spans=False)
    assert _shutdown._atexit_clients[asgi_client] == 2.5
    assert _shutdown._atexit_clients[wsgi_client] == _shutdown.DEFAULT_SHUTDOWN_TIMEOUT


def test_atexit_flushes_all_clients_concurrently_within_largest_timeout():
    fast, slow_a, slow_b = RecordingClient(), RecordingClient(delay=10.0), RecordingClient(delay=10.0)
    for c in (fast, slow_a, slow_b):
        c.capture_record(_record())
        _shutdown.register_atexit(c, 0.3)
    started = time.monotonic()
    _shutdown._shutdown_registered()
    elapsed = time.monotonic() - started
    slow_a.release.set()
    slow_b.release.set()
    assert fast.sent == [1]
    assert elapsed < 0.8  # one shared deadline, not 3 x 0.3 s


def test_atexit_after_lifespan_does_not_flush_twice():
    client = RecordingClient()
    mw = _asgi(_lifespan_app([]), client)
    client.capture_record(_record())
    _run_lifespan(mw)
    client.capture_record(_record())
    _shutdown._shutdown_registered()
    assert client.sent == [1]


def test_new_lifespan_revives_client_after_shutdown():
    client = RecordingClient()
    mw = _asgi(_lifespan_app([]), client)
    client.capture_record(_record())
    _run_lifespan(mw)
    client.capture_record(_record())
    _run_lifespan(mw)  # same app served again (e.g. a second TestClient)
    assert client.sent == [1, 1]
    client.shutdown(flush=False)


def test_django_registers_atexit_from_settings(monkeypatch):
    django = pytest.importorskip("django")
    from django.conf import settings

    if not settings.configured:
        settings.configure(
            DEBUG=False,
            ALLOWED_HOSTS=["*"],
            ROOT_URLCONF=__name__,
            APILENS_API_KEY="apilens_test",
            APILENS_APP_ID="orders-api",
        )
        django.setup()

    import apilens.django as apilens_django
    from django.http import HttpResponse

    client = RecordingClient()
    monkeypatch.setattr(apilens_django, "_client_singleton", client)
    monkeypatch.setattr(settings, "APILENS_SHUTDOWN_TIMEOUT", 1.5, raising=False)
    apilens_django.ApiLensDjangoMiddleware(lambda request: HttpResponse("ok"))
    assert _shutdown._atexit_clients[client] == 1.5

    other = RecordingClient()
    monkeypatch.setattr(apilens_django, "_client_singleton", other)
    monkeypatch.setattr(settings, "APILENS_FLUSH_ON_SHUTDOWN", False, raising=False)
    apilens_django.ApiLensDjangoMiddleware(lambda request: HttpResponse("ok"))
    assert other not in _shutdown._atexit_clients


def test_starlette_app_lifespan_drains_queue():
    pytest.importorskip("httpx")
    pytest.importorskip("starlette")
    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route
    from starlette.testclient import TestClient

    from apilens.starlette import instrument_app

    client = RecordingClient()
    app = Starlette(routes=[Route("/orders", lambda request: PlainTextResponse("ok"))])
    instrument_app(app, client, app_id="orders-api", capture_spans=False)

    with TestClient(app) as tc:  # runs lifespan startup ... shutdown
        assert tc.get("/orders").status_code == 200
        assert client.sent == []
    assert client.sent == [1]
    assert len(client._queue) == 0


urlpatterns: list = []
