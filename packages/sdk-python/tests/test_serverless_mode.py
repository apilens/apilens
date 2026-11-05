"""Serverless mode: ``mode="inline"`` starts no thread; ``flush()`` sends
synchronously and the middlewares call it after the response (issue #533)."""

from __future__ import annotations

import asyncio
import json
import threading
from datetime import datetime, timezone

import pytest

from apilens.client import ApiLensClient, ApiLensConfig
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware
from apilens.client.models import RequestRecord
from apilens.fastapi import ApiLensGatewayMiddleware


@pytest.fixture(autouse=True)
def _no_env_mode(monkeypatch):
    monkeypatch.delenv("APILENS_MODE", raising=False)


class RecordingClient(ApiLensClient):
    """Real client; the request-batch POST is recorded instead of sent."""

    def __init__(self, mode: str = "inline", events: list[str] | None = None, **kwargs) -> None:
        super().__init__(
            ApiLensConfig(api_key="test-key", mode=mode, max_retries=0, retry_backoff_base=0.0, **kwargs)
        )
        self.sent: list[list[str]] = []
        self.send_threads: list[str] = []
        self.events = events

    def _send_batch(self, batch) -> None:
        self.send_threads.append(threading.current_thread().name)
        self.sent.append([json.loads(r)["path"] if isinstance(r, bytes) else r.path for r in batch])
        if self.events is not None:
            self.events.append("flush")


def _record(path: str = "/orders") -> RequestRecord:
    return RequestRecord(
        timestamp=datetime.now(tz=timezone.utc),
        environment="test",
        method="GET",
        path=path,
        status_code=200,
        response_time_ms=1.0,
    )


# --- client -----------------------------------------------------------------


def test_inline_mode_starts_no_thread():
    client = RecordingClient("inline")
    assert client.inline
    assert client._thread is None
    client.start()  # e.g. a revived lifespan or ``with client:``
    assert client._thread is None


def test_inline_flush_sends_synchronously_on_the_calling_thread():
    client = RecordingClient("inline")
    client.capture_record(_record("/a"))
    client.capture_record(_record("/b"))
    assert client.sent == []  # nothing goes out until flush()

    assert client.flush() == 2

    assert client.sent == [["/a", "/b"]]
    assert client.send_threads == [threading.current_thread().name]
    assert client.stats().queued_records == 0
    assert client.flush() == 0  # empty queue: nothing sent


def test_inline_flush_drains_more_than_one_batch():
    client = RecordingClient("inline", batch_size=2)
    for i in range(5):
        client.capture_record(_record(f"/r{i}"))
    assert client.flush() == 5
    assert [len(b) for b in client.sent] == [2, 2, 1]


def test_inline_flush_sends_due_heartbeat(monkeypatch):
    monkeypatch.setenv("APILENS_SEND_HEARTBEAT", "true")
    client = RecordingClient("inline", app_id="orders-api")
    beats: list[bool] = []
    monkeypatch.setattr(client, "_heartbeat_one", lambda app, env, final=False: beats.append(final) or True)
    client.flush()
    assert beats == [False]


def test_thread_mode_unchanged():
    client = RecordingClient("thread")
    try:
        assert not client.inline
        assert client._thread is not None and client._thread.is_alive()
        assert client._thread.daemon and client._thread.name == "apilens-flush"
    finally:
        client.shutdown(flush=False, timeout=1.0)


def test_default_mode_is_thread():
    config = ApiLensConfig(api_key="k")
    assert config.mode == "thread"


def test_env_mode(monkeypatch):
    monkeypatch.setenv("APILENS_MODE", "Inline")
    assert ApiLensConfig(api_key="k").mode == "inline"
    # Explicit config wins over the env var.
    assert ApiLensConfig(api_key="k", mode="thread").mode == "thread"


def test_bad_env_mode_raises_naming_the_variable(monkeypatch):
    monkeypatch.setenv("APILENS_MODE", "lambda")
    with pytest.raises(ValueError, match="APILENS_MODE"):
        ApiLensConfig(api_key="k")


def test_env_mode_reaches_gateway_middleware(monkeypatch):
    monkeypatch.setenv("APILENS_MODE", "inline")
    mw = ApiLensGatewayMiddleware(lambda s, r, se: None, api_key="k", app_id="a")
    assert mw.client.inline


def test_bad_explicit_mode_rejected():
    with pytest.raises(ValueError, match="mode must be one of"):
        ApiLensClient(ApiLensConfig(api_key="k", mode="sync"), start_worker=False)


def test_gateway_middleware_mode_kwarg():
    mw = ApiLensGatewayMiddleware(lambda s, r, se: None, api_key="k", app_id="a", mode="inline")
    assert mw.client.inline and mw.client._thread is None


# --- middlewares ------------------------------------------------------------


def _asgi_app(events: list[str]):
    async def app(scope, receive, send):
        await receive()
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]})
        await send({"type": "http.response.body", "body": b"ok", "more_body": False})
        events.append("response-sent")

    return app


def _run_asgi(mw, events: list[str]) -> None:
    scope = {"type": "http", "method": "GET", "path": "/orders", "headers": [], "query_string": b""}

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        if message["type"] == "http.response.body" and not message.get("more_body"):
            events.append("client-got-body")

    asyncio.run(mw(scope, receive, send))


def test_asgi_inline_flushes_after_response_is_sent():
    events: list[str] = []
    client = RecordingClient("inline", events=events)
    mw = ApiLensASGIMiddleware(_asgi_app(events), client, app_id="orders-api", capture_spans=False)
    _run_asgi(mw, events)
    assert events == ["client-got-body", "response-sent", "flush"]
    assert client.sent == [["/orders"]]
    # The blocking POST ran off the event loop thread.
    assert client.send_threads[0] != threading.current_thread().name


def test_asgi_thread_mode_does_not_flush_inline():
    events: list[str] = []
    client = RecordingClient("thread", events=events, flush_interval=60.0)
    try:
        mw = ApiLensASGIMiddleware(_asgi_app(events), client, app_id="orders-api", capture_spans=False)
        _run_asgi(mw, events)
        assert events == ["client-got-body", "response-sent"]
        assert client.sent == []
        assert client.stats().queued_records == 1
    finally:
        client.shutdown(flush=False, timeout=1.0)


def test_wsgi_inline_flushes_after_body_is_handed_to_server():
    events: list[str] = []
    client = RecordingClient("inline", events=events)

    def app(environ, start_response):
        start_response("200 OK", [("Content-Type", "text/plain")])
        return [b"o", b"k"]

    mw = ApiLensWSGIMiddleware(app, client, app_id="w", capture_spans=False)
    environ = {"REQUEST_METHOD": "GET", "PATH_INFO": "/orders", "wsgi.input": None}
    for chunk in mw(environ, lambda status, headers, exc_info=None: None):
        events.append(f"server-wrote:{chunk.decode()}")
    assert events == ["server-wrote:o", "server-wrote:k", "flush"]
    assert client.sent == [["/orders"]]


def test_inline_flush_failure_never_reaches_the_app():
    client = RecordingClient("inline")

    def boom(batch):
        raise RuntimeError("ingest down")

    client._send_batch = boom  # type: ignore[method-assign]
    events: list[str] = []
    mw = ApiLensASGIMiddleware(_asgi_app(events), client, app_id="orders-api", capture_spans=False)
    _run_asgi(mw, events)  # does not raise
    assert "response-sent" in events
