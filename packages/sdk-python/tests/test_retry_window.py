"""Retry window, drop reporting and partial accept (issue #928, D7 of #897).

A batch that fails with 408/429/5xx or a network error goes back to the
front of its queue and is retried with backoff until ``max_retry_seconds``
has passed since its first failure; every drop is reported per signal and
reason in the next heartbeat; records a 2xx names as invalid are counted,
never retried.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

import pytest

from apilens.client import ApiLensClient, ApiLensConfig
from apilens.client import client as client_mod
from apilens.client.client import (
    DEFAULT_MAX_RETRY_SECONDS,
    MIN_BATCH_BYTES,
    _RetryableIngestError,
    _shrink,
)
from apilens.client.models import LogRecord, RequestRecord, SpanRecord


@pytest.fixture(autouse=True)
def heartbeat_enabled(monkeypatch):
    # conftest turns heartbeats off; drop reporting rides on them.
    monkeypatch.setenv("APILENS_SEND_HEARTBEAT", "true")


@pytest.fixture
def clock(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(client_mod.time, "monotonic", lambda: now[0])
    return now


class _Ingest:
    """Stands in for the three batch senders and the heartbeat POST; down
    while ``down`` is true."""

    def __init__(self, client: ApiLensClient) -> None:
        self.down = False
        self.reply = b"{}"
        self.received: dict[str, list[dict]] = {"requests": [], "spans": [], "logs": []}
        self.calls = 0
        self.heartbeats: list[dict] = []
        self.heartbeat_ok = True
        for key, name in (
            ("requests", "_send_batch"),
            ("spans", "_send_span_batch"),
            ("logs", "_send_log_batch"),
        ):
            setattr(client, name, self._sender(key))
        real_post = client._post_body

        def post(path, body, *, read_response=False):
            if path != client.config.heartbeat_path:
                return real_post(path, body, read_response=read_response)
            self.heartbeats.append(json.loads(body))
            if not self.heartbeat_ok:
                raise _RetryableIngestError("Retryable ingest error status=503", status=503)
            return b"{}"

        client._post_body = post  # type: ignore[method-assign]

    def _sender(self, key: str):
        def send(batch):
            self.calls += 1
            if self.down:
                raise _RetryableIngestError("Retryable ingest error status=503", status=503)
            self.received[key].extend(json.loads(b) for b in batch)
            return self.reply

        return send


def _client(**overrides) -> tuple[ApiLensClient, _Ingest]:
    cfg = dict(api_key="test-key", app_id="shop", batch_size=50)
    cfg.update(overrides)
    client = ApiLensClient(ApiLensConfig(**cfg), start_worker=False)
    return client, _Ingest(client)


def _request(i: int, app_id: str = "shop") -> RequestRecord:
    return RequestRecord(
        timestamp=datetime.now(tz=timezone.utc),
        environment="test",
        method="GET",
        path=f"/r/{i}",
        status_code=200,
        response_time_ms=1.0,
        app_id=app_id,
    )


def _span(i: int) -> SpanRecord:
    return SpanRecord(
        timestamp=datetime.now(tz=timezone.utc),
        environment="test",
        trace_id="t" * 32,
        span_id=f"{i:016d}",
        name=f"span-{i}",
        app_id="shop",
    )


def _log(i: int, payload: str = "") -> LogRecord:
    return LogRecord(
        timestamp=datetime.now(tz=timezone.utc),
        environment="test",
        level="ERROR",
        trace_id="t" * 32,
        message=f"log-{i}",
        payload=payload,
        app_id="shop",
    )


def test_default_window_and_max_retries_alias():
    client, _ = _client()
    assert client.config.max_retry_seconds == DEFAULT_MAX_RETRY_SECONDS == 300.0
    assert client.config.max_retries is None
    assert client.retry_window() == 300.0
    # The alias maps to the longest wait that many backoff retries took.
    client.config.max_retries = 3
    assert client.retry_window() == 0.25 + 0.5 + 1.0
    client.config.max_retries = 0
    assert client.retry_window() == 0.0
    client, _ = _client(max_retries=10, max_retry_seconds=999)
    assert client.retry_window() == 0.25 + 0.5 + 1 + 2 + 4 + 5 * 5  # alias wins, capped backoff


def test_server_down_60s_then_up_loses_nothing(clock):
    client, ingest = _client()
    ingest.down = True
    n = 0
    # 60 s outage, ~3 s flush interval, records arriving the whole time.
    while clock[0] < 1060.0:
        for _ in range(5):
            client.capture_record(_request(n))
            client.capture_span(_span(n))
            client.capture_log(_log(n))
            n += 1
        client.flush_once()
        clock[0] += 3.0
    assert ingest.calls > 3  # it kept trying
    assert all(not v for v in ingest.received.values())

    ingest.down = False
    clock[0] += 5.0  # past the last backoff (capped at retry_backoff_max)
    client.flush_all()

    assert [r["path"] for r in ingest.received["requests"]] == [f"/r/{i}" for i in range(n)]
    assert [s["name"] for s in ingest.received["spans"]] == [f"span-{i}" for i in range(n)]
    assert [g["message"] for g in ingest.received["logs"]] == [f"log-{i}" for i in range(n)]
    assert client.dropped_count == 0
    stats = client.stats()
    assert stats.queued_records == 0 and stats.queued_bytes == 0
    assert client._failed_at == {}


def test_failed_records_go_back_to_the_front_with_backoff(clock):
    client, ingest = _client(retry_backoff_base=1.0, retry_backoff_max=4.0)
    ingest.down = True
    client.capture_record(_request(0))
    assert client.flush_once() == 0
    delay = client._retry_at[id(client._queue)] - clock[0]
    assert 0.0 <= delay <= 1.0
    client.capture_record(_request(1))
    assert [r.path for r in client._queue] == ["/r/0", "/r/1"]
    calls = ingest.calls
    clock[0] += delay - 0.001 if delay > 0.001 else 0.0
    if delay > 0.001:
        assert client.flush_once() == 0
        assert ingest.calls == calls  # held for the backoff
    ingest.down = False
    clock[0] += 1.0
    assert client.flush_once() == 2
    assert [r["path"] for r in ingest.received["requests"]] == ["/r/0", "/r/1"]


def test_window_exceeded_drops_and_reports_them_in_the_heartbeat(clock, caplog):
    caplog.set_level(logging.WARNING, logger="apilens")
    client, ingest = _client(max_retry_seconds=30)
    ingest.down = True
    for i in range(3):
        client.capture_record(_request(i))
    client.capture_span(_span(0))
    for _ in range(40):
        client.flush_once()
        clock[0] += 3.0
    assert client.drop_counts()["retries_exhausted"] == 4
    assert client.stats().failed_batches == 2
    assert not client._queue and not client._span_queue
    assert any("max_retry_seconds=30" in r.getMessage() for r in caplog.records)

    body = client.heartbeat_payload("shop")
    assert body["dropped"] == {"requests": {"retries_exhausted": 3}, "spans": {"retries_exhausted": 1}}

    # A failed heartbeat keeps the counts for the next one.
    ingest.heartbeat_ok = False
    assert client.send_heartbeat() is False
    assert ingest.heartbeats[-1]["dropped"]["requests"] == {"retries_exhausted": 3}
    ingest.heartbeat_ok = True
    client.capture_log(_log(0))
    client._count_drops_locked("queue_full", client._log_queue, [client._log_queue[0]])
    assert client.send_heartbeat() is True
    assert ingest.heartbeats[-1]["dropped"] == {
        "requests": {"retries_exhausted": 3},
        "spans": {"retries_exhausted": 1},
        "logs": {"queue_full": 1},
    }
    # Accepted: the next heartbeat starts from zero.
    assert "dropped" not in client.heartbeat_payload("shop")
    # Cumulative local counters are untouched.
    assert client.drop_counts()["retries_exhausted"] == 4


def test_queue_drops_are_reported_per_signal(clock):
    client, _ = _client(max_queue_size=2)
    for i in range(5):
        client.capture_log(_log(i))
    assert client.heartbeat_payload("shop")["dropped"] == {"logs": {"queue_full": 3}}


def test_drops_of_an_app_without_heartbeat_ride_on_the_first_app(clock):
    client, _ = _client(max_queue_size=1)
    client.register_app("billing")
    client.capture_record(_request(0, app_id="other"))
    client.capture_record(_request(1, app_id="other"))
    client.capture_record(_request(2, app_id="billing"))
    client.capture_record(_request(3, app_id="billing"))
    assert client.heartbeat_payload("shop")["dropped"] == {"requests": {"queue_full": 2}}
    assert client.heartbeat_payload("billing")["dropped"] == {"requests": {"queue_full": 1}}


def test_partial_accept_counts_invalid_records_and_does_not_retry(clock, caplog):
    caplog.set_level(logging.WARNING, logger="apilens")
    client, ingest = _client()
    ingest.reply = json.dumps(
        {"invalid": 2, "errors": [{"index": 0, "reason": "method is required"}, {"index": 3, "reason": "x"}]}
    ).encode()
    for i in range(5):
        client.capture_record(_request(i))
    assert client.flush_all() == 5
    assert ingest.calls == 1  # not retried
    stats = client.stats()
    assert stats.drop_counts["invalid"] == 2
    assert stats.sent_records == 3
    assert stats.dropped == 2
    assert not client._queue
    # Ingest counts refused records itself: not reported again by the SDK.
    assert "dropped" not in client.heartbeat_payload("shop")
    (warning,) = [r.getMessage() for r in caplog.records]
    assert "refused 2 of 5" in warning and "method is required" in warning


@pytest.mark.parametrize("reply", [b"", b"not json", b"[]", b'{"invalid": 0}', b'{"invalid": true}'])
def test_plain_2xx_counts_nothing_invalid(clock, reply):
    client, ingest = _client()
    ingest.reply = reply
    client.capture_record(_request(0))
    assert client.flush_all() == 1
    assert client.drop_counts()["invalid"] == 0
    assert client.stats().sent_records == 1


def test_shutdown_counts_and_reports_what_could_not_be_sent(clock):
    client, ingest = _client()
    ingest.down = True
    client.capture_record(_request(0))
    client.capture_span(_span(0))
    client.shutdown(timeout=0.0)
    assert client.drop_counts()["shutdown"] == 2
    assert client.stats().queued_records == 0
    final = ingest.heartbeats[-1]
    assert final["final"] is True
    assert final["dropped"] == {"requests": {"shutdown": 1}, "spans": {"shutdown": 1}}


def test_shutdown_waits_out_a_short_backoff(clock, monkeypatch):
    client, ingest = _client(timeout=1.0)
    ingest.down = True
    client.capture_record(_request(0))
    client.flush_once()

    def sleep(seconds):
        clock[0] += seconds
        ingest.down = False

    monkeypatch.setattr(client, "_sleep", sleep)
    client.shutdown(timeout=10.0)
    assert [r["path"] for r in ingest.received["requests"]] == ["/r/0"]
    assert client.dropped_count == 0


def test_oversize_record_keeps_head_and_tail(clock):
    client, ingest = _client(max_batch_bytes=MIN_BATCH_BYTES, compress=False)
    payload = "Traceback head\n" + "x" * (64 * 1024) + "\nRootCause: db down"
    client.capture_log(_log(0, payload=payload))
    assert client.flush_all() == 1
    (sent,) = ingest.received["logs"]
    assert sent["payload"].startswith("Traceback head\n")
    assert sent["payload"].endswith("RootCause: db down")
    assert " chars truncated]" in sent["payload"]
    assert client.drop_counts()["truncated"] == 1
    assert client.dropped_count == 0


@pytest.mark.parametrize("excess", [1, 10, 100, 5000])
def test_shrink_frees_at_least_excess_bytes(excess):
    value = "é" * 3000 + "a" * 3000
    out = _shrink(value, excess)
    assert len(json.dumps(out)) <= len(json.dumps(value)) - excess
    removed = int(out.split("[", 1)[1].split(" ", 1)[0])
    assert len(out) - len(client_mod.TRUNCATION_MARKER.format(n=removed)) == len(value) - removed
