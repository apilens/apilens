"""Retry policy for ingest batches (issue #530).

408/429/5xx/network errors retry with full-jitter backoff or the server's
Retry-After (capped at 60 s); any other 4xx drops the batch, counted as
``non_retryable`` and logged at most once per status per 5 minutes.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from apilens.client import ApiLensClient, ApiLensConfig
from apilens.client import client as client_mod
from apilens.client.client import (
    RETRY_AFTER_MAX_SECONDS,
    TROUBLESHOOTING_URL,
    backoff_delay,
    parse_retry_after,
)


class _FakeIngest:
    """Answers each POST with the next scripted response:
    ``(status, headers, body)`` or ``"hang"`` (sleeps past the client timeout)."""

    def __init__(self, script: list) -> None:
        self.script = list(script)
        self.hits = 0
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                idx = min(outer.hits, len(outer.script) - 1)
                outer.hits += 1
                step = outer.script[idx]
                if step == "hang":
                    time.sleep(0.5)
                    return
                status, headers, body = step
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def fake_ingest():
    servers: list[_FakeIngest] = []

    def make(*script) -> _FakeIngest:
        s = _FakeIngest(list(script))
        servers.append(s)
        return s

    yield make
    for s in servers:
        s.close()


def _client(server: _FakeIngest, **overrides) -> tuple[ApiLensClient, list[float]]:
    cfg = dict(api_key="test-key", base_url=server.base_url, max_retries=3, timeout=2.0)
    cfg.update(overrides)
    client = ApiLensClient(ApiLensConfig(**cfg), start_worker=False)
    sleeps: list[float] = []
    client._sleep = sleeps.append  # type: ignore[method-assign]
    return client, sleeps


def _capture(client: ApiLensClient, n: int = 2) -> None:
    for i in range(n):
        client.capture(method="GET", path=f"/r/{i}", status_code=200, response_time_ms=1.0)


OK = (200, {}, b"{}")


def test_401_is_not_retried_and_logs_one_troubleshooting_message(fake_ingest, caplog):
    server = fake_ingest((401, {}, b'{"detail":"invalid api key"}'))
    client, sleeps = _client(server)
    caplog.set_level(logging.DEBUG, logger="apilens")

    for _ in range(3):  # three batches, all rejected
        _capture(client, 2)
        client.flush_once()

    assert server.hits == 3
    assert sleeps == []
    assert client.drop_counts()["non_retryable"] == 6
    assert client.drop_counts()["retries_exhausted"] == 0
    problems = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(problems) == 1
    msg = problems[0].getMessage()
    assert "401" in msg and "api_key" in msg
    assert TROUBLESHOOTING_URL in msg


def test_422_is_dropped_and_body_logged_once_per_window(fake_ingest, caplog, monkeypatch):
    server = fake_ingest((422, {}, b'{"detail":"requests[0].method is required"}'))
    client, sleeps = _client(server)
    caplog.set_level(logging.WARNING, logger="apilens")
    clock = [1000.0]
    monkeypatch.setattr(client_mod.time, "monotonic", lambda: clock[0])

    _capture(client, 1)
    client.flush_once()
    _capture(client, 1)
    client.flush_once()  # same status within 5 min: silent
    assert server.hits == 2
    assert sleeps == []
    assert client.drop_counts()["non_retryable"] == 2
    assert len(caplog.records) == 1
    assert "422" in caplog.records[0].getMessage()
    assert "requests[0].method is required" in caplog.records[0].getMessage()

    clock[0] += 301  # window elapsed: logs again
    _capture(client, 1)
    client.flush_once()
    assert len(caplog.records) == 2


def test_403_project_paused_drops_each_batch_without_retrying(fake_ingest, caplog):
    """A paused project (issue #792): ingest answers 403 project_paused to
    every batch. Each batch is sent once, dropped as non_retryable, never
    retried, and the reason is logged once per window."""
    body = b'{"error":"project_paused","detail":"Ingest is paused for this project"}'
    server = fake_ingest((403, {}, body))
    client, sleeps = _client(server)
    caplog.set_level(logging.WARNING, logger="apilens")

    for _ in range(3):
        _capture(client, 2)
        client.flush_once()

    assert server.hits == 3
    assert sleeps == []
    assert client.drop_counts()["non_retryable"] == 6
    assert client.drop_counts()["retries_exhausted"] == 0
    assert len(caplog.records) == 1
    assert "403" in caplog.records[0].getMessage()
    assert "project_paused" in caplog.records[0].getMessage()


def test_different_statuses_are_rate_limited_independently(fake_ingest, caplog):
    server = fake_ingest((400, {}, b"bad"), (413, {}, b"too big"), (400, {}, b"bad"))
    client, _ = _client(server)
    caplog.set_level(logging.WARNING, logger="apilens")
    for _ in range(3):
        _capture(client, 1)
        client.flush_once()
    assert [r.getMessage().count("status 400") for r in caplog.records] == [1, 0]
    assert "status 413" in caplog.records[1].getMessage()


def test_429_honours_retry_after_seconds(fake_ingest):
    server = fake_ingest((429, {"Retry-After": "7"}, b""), OK)
    client, sleeps = _client(server)
    _capture(client, 2)
    assert client.flush_once() == 2
    assert server.hits == 2
    assert sleeps == [7.0]
    assert client.dropped_count == 0


def test_retry_after_http_date_and_cap(fake_ingest):
    future = datetime.now(tz=timezone.utc) + timedelta(seconds=30)
    server = fake_ingest(
        (429, {"Retry-After": format_datetime(future, usegmt=True)}, b""),
        (503, {"Retry-After": "3600"}, b""),
        OK,
    )
    client, sleeps = _client(server)
    _capture(client, 1)
    assert client.flush_once() == 1
    assert 25 <= sleeps[0] <= 30
    assert sleeps[1] == RETRY_AFTER_MAX_SECONDS


def test_503_retries_with_jittered_backoff_then_counts_exhausted(fake_ingest):
    server = fake_ingest((503, {}, b"down"))
    client, sleeps = _client(server, max_retries=3, retry_backoff_base=0.25, retry_backoff_max=5.0)
    _capture(client, 2)
    assert client.flush_once() == 0
    assert server.hits == 4
    assert len(sleeps) == 3
    for attempt, s in enumerate(sleeps):
        assert 0 <= s <= min(5.0, 0.25 * 2**attempt)
    assert client.drop_counts()["retries_exhausted"] == 2
    assert client.drop_counts()["non_retryable"] == 0


def test_408_is_retryable(fake_ingest):
    server = fake_ingest((408, {}, b""), OK)
    client, sleeps = _client(server)
    _capture(client, 1)
    assert client.flush_once() == 1
    assert server.hits == 2
    assert len(sleeps) == 1


def test_timeout_is_retried(fake_ingest):
    server = fake_ingest("hang", OK)
    client, sleeps = _client(server, timeout=0.1)
    _capture(client, 1)
    assert client.flush_once() == 1
    assert server.hits == 2
    assert len(sleeps) == 1
    assert client.dropped_count == 0


def test_connection_refused_is_retried_then_exhausted(fake_ingest):
    server = fake_ingest(OK)
    url = server.base_url
    server.close()
    client = ApiLensClient(
        ApiLensConfig(api_key="k", base_url=url, max_retries=2, timeout=0.5), start_worker=False
    )
    sleeps: list[float] = []
    client._sleep = sleeps.append  # type: ignore[method-assign]
    _capture(client, 1)
    assert client.flush_once() == 0
    assert len(sleeps) == 2
    assert client.drop_counts()["retries_exhausted"] == 1


def test_backoff_has_jitter_spread_over_100_runs():
    for attempt in range(4):
        ceiling = min(5.0, 0.25 * 2**attempt)
        samples = [backoff_delay(attempt, 0.25, 5.0) for _ in range(100)]
        assert all(0 <= s <= ceiling for s in samples)
        assert len(set(samples)) > 90
        # Full jitter covers the range rather than clustering at the ceiling.
        assert min(samples) < ceiling * 0.25
        assert max(samples) > ceiling * 0.75


def test_backoff_is_capped():
    assert all(backoff_delay(20, 0.25, 5.0) <= 5.0 for _ in range(100))


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, None),
        ("", None),
        ("garbage", None),
        ("0", 0.0),
        ("12", 12.0),
        ("-5", 0.0),
        ("999", RETRY_AFTER_MAX_SECONDS),
    ],
)
def test_parse_retry_after_seconds(value, expected):
    assert parse_retry_after(value) == expected


def test_parse_retry_after_http_date():
    now = datetime(2026, 11, 5, 12, 0, 0, tzinfo=timezone.utc)
    assert parse_retry_after("Thu, 05 Nov 2026 12:00:10 GMT", now=now) == 10.0
    assert parse_retry_after("Thu, 05 Nov 2026 11:00:00 GMT", now=now) == 0.0
    assert parse_retry_after("Thu, 05 Nov 2026 13:00:00 GMT", now=now) == RETRY_AFTER_MAX_SECONDS
