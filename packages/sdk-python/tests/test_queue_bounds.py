"""Byte-bounded queues and per-reason drop counters (issue #527)."""

from __future__ import annotations

import io
import tracemalloc
import urllib.error
from datetime import datetime, timezone

import pytest

from apilens.client import ApiLensClient, ApiLensConfig
from apilens.client.client import RECORD_OVERHEAD_BYTES, estimate_record_bytes
from apilens.client.models import LogRecord, RequestRecord, SpanRecord

KB = 1024
MB = 1024 * KB


def _client(**overrides) -> ApiLensClient:
    cfg = dict(api_key="test-key", max_retries=0, retry_backoff_base=0.0)
    cfg.update(overrides)
    return ApiLensClient(ApiLensConfig(**cfg), start_worker=False)


def _request(payload: str = "", path: str = "/r") -> RequestRecord:
    return RequestRecord(
        timestamp=datetime.now(tz=timezone.utc),
        environment="test",
        method="GET",
        path=path,
        status_code=200,
        response_time_ms=1.0,
        request_payload=payload,
    )


def _span(name: str = "s") -> SpanRecord:
    return SpanRecord(
        timestamp=datetime.now(tz=timezone.utc),
        environment="test",
        trace_id="t" * 32,
        span_id="s" * 16,
        name=name,
    )


def _log(message: str = "m") -> LogRecord:
    return LogRecord(
        timestamp=datetime.now(tz=timezone.utc),
        environment="test",
        level="ERROR",
        message=message,
        trace_id="t" * 32,
    )


def test_estimate_counts_strings_plus_fixed_overhead():
    rec = _request("x" * 1000, path="/abc")
    rec.response_headers = "h" * 10
    # payload + headers + path + raw_path ("" until capture fills it) + overhead
    assert estimate_record_bytes(rec) == RECORD_OVERHEAD_BYTES + 1000 + 10 + 4
    log = _log("boom")
    log.attributes = {"k": "vv"}
    assert estimate_record_bytes(log) == RECORD_OVERHEAD_BYTES + 4 + 3


def test_defaults_and_validation():
    assert ApiLensConfig(api_key="k").max_queue_bytes == 64 * MB
    with pytest.raises(ValueError):
        _client(max_queue_bytes=0)


def test_memory_stays_under_max_queue_bytes_with_10k_64kb_records():
    max_bytes = 8 * MB
    client = _client(max_queue_bytes=max_bytes, max_batch_bytes=max_bytes)
    n = 10_000
    record_bytes = estimate_record_bytes(_request("x" * (64 * KB)))

    tracemalloc.start()
    try:
        baseline, _ = tracemalloc.get_traced_memory()
        tracemalloc.reset_peak()
        for i in range(n):
            # A fresh 64 KB string per record so retained memory is real.
            client.capture_record(_request(str(i % 10) * (64 * KB)))
            assert client.queued_bytes <= max_bytes
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    # Actual heap growth stays within the budget (plus small bookkeeping slack).
    assert peak - baseline < max_bytes + 2 * MB

    kept = len(client._queue)
    assert kept == max_bytes // record_bytes
    counts = client.drop_counts()
    assert counts["queue_bytes"] == n - kept
    assert counts["queue_full"] == 0
    assert client.dropped_count == n - kept

    # Drop-oldest: the newest records are the ones still queued.
    batch = client._pop_batch(n)
    assert batch[-1].request_payload[0] == str((n - 1) % 10)
    assert client.queued_bytes == 0


def test_max_queue_size_still_applies_and_counts_queue_full():
    client = _client(max_queue_size=3)
    for i in range(5):
        client.capture_record(_request(path=f"/{i}"))
    assert [r.path for r in client._pop_batch(10)] == ["/2", "/3", "/4"]
    assert client.drop_counts()["queue_full"] == 2
    assert client.dropped_count == 2


def test_byte_cap_is_shared_and_applies_to_span_and_log_queues():
    unit = estimate_record_bytes(_span("x" * 1000))
    client = _client(max_queue_bytes=unit * 3)
    for _ in range(3):
        client.capture_span(_span("x" * 1000))
    # Log queue is empty, so a new log evicts from the largest other queue.
    client.capture_log(_log("y" * 1000))
    assert client.queued_bytes <= unit * 3
    assert len(client._span_queue) == 2
    assert len(client._log_queue) == 1
    # Same queue first: a second log evicts the first log, not a span.
    client.capture_log(_log("z" * 1000))
    assert len(client._span_queue) == 2
    assert [r.message[0] for r in client._pop_log_batch(10)] == ["z"]
    assert client.drop_counts()["queue_bytes"] == 2


def test_single_oversized_record_is_dropped_without_evicting():
    client = _client(max_queue_bytes=4 * KB)
    client.capture_record(_request("a"))
    client.capture_record(_request("b" * (8 * KB)))
    assert len(client._queue) == 1
    assert client.drop_counts()["queue_bytes"] == 1


def test_non_retryable_failure_is_not_retried_and_counted(monkeypatch):
    client = _client(max_retries=3)
    calls = []

    def urlopen(*_a, **_kw):
        calls.append(1)
        raise urllib.error.HTTPError("http://x", 400, "bad", {}, io.BytesIO(b""))

    monkeypatch.setattr("urllib.request.urlopen", urlopen)
    client.capture_record(_request())
    client.capture_record(_request())
    client.flush_once()
    assert len(calls) == 1
    assert client.drop_counts()["non_retryable"] == 2
    assert client.dropped_count == 2


def test_retryable_failure_counts_retries_exhausted(monkeypatch):
    client = _client(max_retries=2)
    calls = []

    def urlopen(*_a, **_kw):
        calls.append(1)
        raise urllib.error.HTTPError("http://x", 503, "down", {}, io.BytesIO(b""))

    monkeypatch.setattr("urllib.request.urlopen", urlopen)
    client.capture_span(_span())
    client.flush_once()
    assert len(calls) == 3
    assert client.drop_counts() == {
        "queue_full": 0,
        "queue_bytes": 0,
        "non_retryable": 0,
        "retries_exhausted": 1,
        "truncated": 0,
    }
