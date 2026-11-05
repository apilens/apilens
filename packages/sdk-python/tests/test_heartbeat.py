"""Heartbeat: POST /v1/heartbeat on start, every interval and on shutdown (issue #535).

The body carries SDK/runtime versions, instance id, pid, uptime and
``client.stats()``; the response's ``policy`` is kept as
``client.remote_policy``. Failures are silent and never affect data flush.
Contract: apps/docs/ingest/heartbeat.mdx.
"""

from __future__ import annotations

import gzip
import json
import logging
import platform
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from apilens._version import __version__
from apilens.client import ApiLensClient, ApiLensConfig
from apilens.client import client as client_mod

API_KEY = "apilens_test_HEARTBEATKEY"

POLICY = {
    "enabled": True,
    "sample_rate": 0.5,
    "capture_headers": False,
    "capture_request_body": True,
    "capture_response_body": False,
    "max_payload_bytes": 1024,
}


class _FakeIngest:
    """Records each POST (path, headers, decoded JSON). Heartbeats answer the
    next scripted ``(status, body, headers)`` (the last one repeats); every
    other path answers 202."""

    def __init__(self, replies: list[tuple[int, bytes, dict]]) -> None:
        self.replies = list(replies)
        self.requests: list[tuple[str, dict, dict]] = []
        self.lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                if self.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                with outer.lock:
                    outer.requests.append((self.path, dict(self.headers), json.loads(raw)))
                    beats = sum(1 for p, _, _ in outer.requests if p.endswith("/heartbeat"))
                if self.path.endswith("/heartbeat"):
                    status, body, headers = outer.replies[min(beats - 1, len(outer.replies) - 1)]
                else:
                    status, body, headers = 202, b"{}", {}
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def heartbeats(self) -> list[tuple[str, dict, dict]]:
        with self.lock:
            return [r for r in self.requests if r[0].endswith("/heartbeat")]

    def posts_to(self, suffix: str) -> list[tuple[str, dict, dict]]:
        with self.lock:
            return [r for r in self.requests if r[0].endswith(suffix)]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def _ok(policy: dict | None = None) -> tuple[int, bytes, dict]:
    return 200, json.dumps({"policy": policy or POLICY}).encode(), {"Content-Type": "application/json"}


@pytest.fixture
def ingest():
    servers: list[_FakeIngest] = []

    def make(*replies: tuple[int, bytes, dict]) -> _FakeIngest:
        server = _FakeIngest(list(replies) or [_ok()])
        servers.append(server)
        return server

    yield make
    for server in servers:
        server.close()


@pytest.fixture(autouse=True)
def heartbeat_enabled(monkeypatch):
    """Re-enable heartbeats (conftest turns them off) and allow sub-second
    intervals so the tests run fast."""
    monkeypatch.setenv("APILENS_SEND_HEARTBEAT", "true")
    monkeypatch.setattr(client_mod, "HEARTBEAT_MIN_INTERVAL_SECONDS", 0.0)


def _client(server: _FakeIngest, *, start_worker: bool = False, **overrides) -> ApiLensClient:
    cfg = dict(
        api_key=API_KEY,
        base_url=server.base_url,
        app_id="storefront",
        environment="staging",
        heartbeat_interval=60.0,
        flush_interval=0.05,
        timeout=2.0,
        retry_backoff_base=0.001,
        retry_backoff_max=0.002,
        release="2026.11.05",
        commit="9f2c1ab",
    )
    cfg.update(overrides)
    return ApiLensClient(ApiLensConfig(**cfg), start_worker=start_worker)


def _wait_for(predicate, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def test_heartbeat_sent_on_start_with_the_contract_fields(ingest):
    server = ingest()
    client = _client(server, start_worker=True)
    try:
        assert _wait_for(lambda: len(server.heartbeats()) >= 1)
        path, headers, body = server.heartbeats()[0]
    finally:
        client.shutdown(flush=False, timeout=2.0)

    assert path == "/v1/heartbeat"
    assert {k.lower(): v for k, v in headers.items()}["x-api-key"] == API_KEY
    assert body["app_id"] == "storefront"
    assert body["environment"] == "staging"
    assert body["instance_id"] == client.instance_id
    assert body["sdk_name"] == "apilenss"
    assert body["sdk_version"] == __version__
    assert body["runtime"] == f"python {platform.python_version()}"
    assert body["release"] == "2026.11.05"
    assert body["commit"] == "9f2c1ab"
    assert isinstance(body["pid"], int) and body["pid"] > 0
    assert isinstance(body["uptime_s"], int) and body["uptime_s"] >= 0
    assert set(body["stats"]) >= {"queued_records", "sent_records", "dropped", "last_error"}
    assert "final" not in body
    assert "api_key" not in json.dumps(body).lower().replace("-", "_")


def test_heartbeat_repeats_every_interval_with_one_instance_id(ingest):
    server = ingest()
    client = _client(server, start_worker=True, heartbeat_interval=0.15)
    try:
        assert _wait_for(lambda: len(server.heartbeats()) >= 3)
    finally:
        client.shutdown(flush=False, timeout=2.0)
    beats = [body for _, _, body in server.heartbeats()]
    assert {b["instance_id"] for b in beats} == {client.instance_id}
    uptimes = [b["uptime_s"] for b in beats]
    assert uptimes == sorted(uptimes)


def test_heartbeat_not_resent_before_the_interval(ingest):
    server = ingest()
    client = _client(server, heartbeat_interval=60.0)
    client._maybe_heartbeat()
    client._maybe_heartbeat()
    assert len(server.heartbeats()) == 1


def test_shutdown_sends_final_heartbeat(ingest):
    server = ingest()
    client = _client(server, start_worker=True)
    assert _wait_for(lambda: len(server.heartbeats()) >= 1)
    client.shutdown(flush=True, timeout=2.0)
    beats = [body for _, _, body in server.heartbeats()]
    assert beats[-1]["final"] is True
    assert all("final" not in b for b in beats[:-1])


def test_response_policy_is_kept_as_remote_policy(ingest):
    server = ingest(_ok())
    client = _client(server)
    assert client.remote_policy is None
    assert client.send_heartbeat() is True
    assert client.remote_policy == POLICY


@pytest.mark.parametrize(
    "reply",
    [
        (503, b'{"error":"unavailable"}', {"Retry-After": "1"}),
        (500, b"oops", {}),
        (422, b'{"error":"validation"}', {}),
        (401, b'{"error":"unauthorized"}', {}),
        (200, b"not json", {}),
        (200, b'{"nope":1}', {}),
    ],
)
def test_failed_heartbeat_keeps_the_previous_policy(ingest, reply):
    server = ingest(_ok(), reply)
    client = _client(server)
    assert client.send_heartbeat() is True
    client.send_heartbeat()  # never raises
    assert client.remote_policy == POLICY


def test_retry_after_reschedules_the_next_heartbeat(ingest, monkeypatch):
    server = ingest((429, b'{"error":"rate_limited"}', {"Retry-After": "7"}))
    client = _client(server, heartbeat_interval=60.0)
    before = time.monotonic()
    assert client.send_heartbeat() is False
    due = client._heartbeat_due[("storefront", "staging")]
    assert before + 6.5 <= due <= time.monotonic() + 7.5


def test_rejection_is_logged_once(ingest, caplog):
    server = ingest((401, b'{"error":"unauthorized"}', {}))
    client = _client(server)
    with caplog.at_level(logging.WARNING, logger="apilens"):
        for _ in range(3):
            assert client.send_heartbeat() is False
    warnings = [r for r in caplog.records if "heartbeat" in r.getMessage()]
    assert len(warnings) == 1
    assert "401" in warnings[0].getMessage()


def test_network_error_is_silent(caplog):
    client = ApiLensClient(
        ApiLensConfig(api_key=API_KEY, base_url="http://127.0.0.1:9/v1", app_id="a", timeout=0.5),
        start_worker=False,
    )
    with caplog.at_level(logging.INFO, logger="apilens"):
        assert client.send_heartbeat() is False
    assert not [r for r in caplog.records if r.levelno >= logging.INFO]


def test_failing_heartbeat_does_not_affect_data_flush(ingest):
    server = ingest((503, b'{"error":"unavailable"}', {}))
    client = _client(server, start_worker=True)
    try:
        client.capture(
            timestamp=datetime.now(tz=timezone.utc),
            method="GET",
            path="/ok",
            status_code=200,
            response_time_ms=1.0,
            app_id="storefront",
        )
        assert _wait_for(lambda: len(server.posts_to("/requests")) == 1)
    finally:
        client.shutdown(flush=True, timeout=2.0)
    assert client.stats().sent_records == 1
    assert client.stats().failed_batches == 0
    assert len(server.heartbeats()) >= 1


def test_stats_snapshot_rides_on_the_heartbeat(ingest):
    server = ingest()
    client = _client(server)
    client.capture(method="GET", path="/x", status_code=200, response_time_ms=1.0, app_id="storefront")
    client.flush_all()
    client.send_heartbeat()
    stats = server.heartbeats()[-1][2]["stats"]
    assert stats["sent_records"] == 1
    assert stats["sent_batches"] == 1


def test_middleware_registers_its_app(ingest):
    """Framework middlewares enrol their app_id through ``report_metadata``,
    even with metadata reporting switched off."""
    server = ingest()
    client = _client(server, app_id="", send_metadata=False)
    assert client.send_heartbeat() is False  # nothing registered yet
    assert client.report_metadata(lambda: None, app_id="checkout", environment="prod") is False
    assert client.send_heartbeat() is True
    body = server.heartbeats()[-1][2]
    assert (body["app_id"], body["environment"]) == ("checkout", "prod")


def test_register_app_is_idempotent_and_per_environment(ingest):
    server = ingest()
    client = _client(server, app_id="")
    client.register_app("checkout")
    client.register_app("checkout")
    client.register_app("checkout", "canary")
    client.send_heartbeat()
    sent = sorted((b["app_id"], b["environment"]) for _, _, b in server.heartbeats())
    assert sent == [("checkout", "canary"), ("checkout", "staging")]


@pytest.mark.parametrize("off", ["config", "env"])
def test_heartbeat_can_be_turned_off(ingest, monkeypatch, off):
    if off == "env":
        monkeypatch.setenv("APILENS_SEND_HEARTBEAT", "false")
    server = ingest()
    client = _client(server, start_worker=True, send_heartbeat=(off != "config"))
    time.sleep(0.2)
    client.shutdown(flush=True, timeout=2.0)
    assert server.heartbeats() == []


def test_disabled_client_sends_no_heartbeat(ingest):
    server = ingest()
    client = _client(server, start_worker=True, enabled=False)
    client.shutdown(flush=True, timeout=2.0)
    assert server.heartbeats() == []


def test_forked_process_gets_a_new_instance(ingest, monkeypatch):
    server = ingest()
    client = _client(server)
    parent = client.instance_id
    monkeypatch.setattr(client_mod.os, "getpid", lambda: 999_999)
    client.send_heartbeat()
    body = server.heartbeats()[-1][2]
    assert body["pid"] == 999_999
    assert body["instance_id"] != parent
    assert body["uptime_s"] == 0


def test_interval_below_the_ingest_rate_limit_is_refused(monkeypatch):
    monkeypatch.setattr(client_mod, "HEARTBEAT_MIN_INTERVAL_SECONDS", 10.0)
    with pytest.raises(ValueError, match="heartbeat_interval"):
        ApiLensClient(ApiLensConfig(api_key=API_KEY, heartbeat_interval=5), start_worker=False)
