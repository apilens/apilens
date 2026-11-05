"""``client.stats()``, the periodic stats log line and ``on_stats`` (issue #531)."""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone

import pytest

import apilens
from apilens.client import ApiLensClient, ApiLensConfig, ClientStats
from apilens.client import client as client_mod
from apilens.client.client import _NonRetryableIngestError, _RetryableIngestError
from apilens.client.models import LogRecord, RequestRecord


def _client(**overrides) -> ApiLensClient:
    cfg = dict(api_key="test-key", max_retries=0, retry_backoff_base=0.0)
    cfg.update(overrides)
    return ApiLensClient(ApiLensConfig(**cfg), start_worker=False)


def _request(path: str = "/r") -> RequestRecord:
    return RequestRecord(
        timestamp=datetime.now(tz=timezone.utc),
        environment="test",
        method="GET",
        path=path,
        status_code=200,
        response_time_ms=1.0,
    )


def _log() -> LogRecord:
    return LogRecord(
        timestamp=datetime.now(tz=timezone.utc), environment="test", level="ERROR",
        message="m",
        trace_id="t" * 32,
    )


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch) -> _Clock:
    c = _Clock()
    monkeypatch.setattr(client_mod.time, "monotonic", c)
    return c


def test_exported_from_package():
    assert apilens.ClientStats is ClientStats


def test_fresh_client_stats_are_zero():
    stats = _client().stats()
    assert isinstance(stats, ClientStats)
    assert (stats.queued_records, stats.queued_bytes) == (0, 0)
    assert (stats.sent_batches, stats.sent_records, stats.failed_batches) == (0, 0, 0)
    assert stats.dropped == 0
    assert set(stats.drop_counts) == {*client_mod.DROP_REASONS, client_mod.DROP_TRUNCATED}
    assert stats.last_error == ""
    assert stats.last_success_at is None


def test_queued_counts_all_three_queues():
    client = _client()
    client.capture_record(_request())
    client.capture_record(_request())
    client.capture_log(_log())
    stats = client.stats()
    assert stats.queued_records == 3
    assert stats.queued_bytes == client.queued_bytes > 0


def test_successful_flush_counts_batches_and_records(monkeypatch):
    client = _client(batch_size=2)
    monkeypatch.setattr(client, "_send_batch", lambda batch: None)
    for _ in range(3):
        client.capture_record(_request())
    assert client.flush_all() == 3
    stats = client.stats()
    assert stats.sent_batches == 2
    assert stats.sent_records == 3
    assert stats.failed_batches == 0
    assert stats.queued_records == 0
    assert stats.last_success_at is not None
    assert stats.last_success_at.tzinfo is timezone.utc


def test_non_retryable_failure_records_error_and_drop(monkeypatch):
    client = _client()

    def reject(batch):
        raise _NonRetryableIngestError("Non-retryable ingest error status=400", status=400, body="bad")

    monkeypatch.setattr(client, "_send_batch", reject)
    client.capture_record(_request())
    client.flush_once()
    stats = client.stats()
    assert stats.failed_batches == 1
    assert stats.sent_batches == 0
    assert stats.drop_counts["non_retryable"] == 1
    assert stats.dropped == 1
    assert stats.last_error == "Non-retryable ingest error status=400: bad"


def test_retries_exhausted_counts_one_failed_batch(monkeypatch):
    client = _client(max_retries=2)
    monkeypatch.setattr(client, "_sleep", lambda s: None)

    def fail(batch):
        raise _RetryableIngestError("Ingest network error: refused")

    monkeypatch.setattr(client, "_send_batch", fail)
    client.capture_record(_request())
    client.capture_record(_request())
    client.flush_once()
    stats = client.stats()
    assert stats.failed_batches == 1
    assert stats.drop_counts["retries_exhausted"] == 2
    assert stats.last_error == "Ingest network error: refused"


def test_last_error_is_kept_after_a_later_success(monkeypatch):
    client = _client()
    calls = iter([_RetryableIngestError("boom"), None])

    def flaky(batch):
        exc = next(calls)
        if exc:
            raise exc

    monkeypatch.setattr(client, "_send_batch", flaky)
    client.capture_record(_request())
    client.flush_once()
    client.capture_record(_request())
    client.flush_once()
    stats = client.stats()
    assert (stats.sent_batches, stats.failed_batches) == (1, 1)
    assert stats.last_error == "boom"
    assert stats.last_success_at is not None


def test_last_error_is_truncated():
    exc = _RetryableIngestError("x" * 5000)
    assert len(client_mod._describe_error(exc)) == client_mod.MAX_LAST_ERROR_CHARS


def test_snapshot_is_detached_from_live_counters():
    client = _client(max_queue_size=1)
    stats = client.stats()
    client.capture_record(_request())
    client.capture_record(_request())  # evicts one: queue_full
    assert stats.drop_counts["queue_full"] == 0
    assert client.stats().drop_counts["queue_full"] == 1


def test_to_dict_is_json_ready():
    import json

    stats = ClientStats(
        queued_records=1,
        sent_batches=2,
        drop_counts={"queue_full": 3, "truncated": 4},
        last_success_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    data = json.loads(json.dumps(stats.to_dict()))
    assert data["dropped"] == 3  # truncated excluded
    assert data["drop_counts"] == {"queue_full": 3, "truncated": 4}
    assert data["last_success_at"] == "2026-01-01T00:00:00+00:00"
    assert ClientStats().to_dict()["last_success_at"] is None


def test_summary_is_one_line():
    line = ClientStats(drop_counts={"queue_full": 2}, last_error="a\nb").summary()
    assert "\n" not in line
    assert "dropped=2" in line and "queue_full=2" in line and "last_error=" in line


def test_on_stats_called_with_snapshot(clock):
    seen: list[ClientStats] = []
    client = _client(on_stats=seen.append)
    client.capture_record(_request())
    client._report_stats()
    assert len(seen) == 1
    assert seen[0].queued_records == 1


def test_report_is_rate_limited_to_flush_interval(clock):
    seen: list[ClientStats] = []
    client = _client(on_stats=seen.append, flush_interval=3.0)
    client._report_stats()
    clock.now += 1.0  # e.g. an early wakeup because the batch filled
    client._report_stats()
    assert len(seen) == 1
    clock.now += 2.0
    client._report_stats()
    assert len(seen) == 2


def test_on_stats_exception_is_swallowed(clock, caplog):
    def boom(stats):
        raise RuntimeError("exporter down")

    client = _client(on_stats=boom)
    with caplog.at_level(logging.DEBUG, logger="apilens"):
        client._report_stats()  # must not raise
    assert "on_stats callback raised" in caplog.text


def test_debug_summary_every_interval(clock, caplog):
    client = _client()
    with caplog.at_level(logging.DEBUG, logger="apilens"):
        client._report_stats()
    records = [r for r in caplog.records if r.getMessage().startswith("API Lens stats:")]
    assert len(records) == 1
    assert records[0].levelno == logging.DEBUG
    assert "queued=0" in records[0].getMessage()


def test_drops_logged_at_info_and_rate_limited(clock, caplog):
    client = _client(max_queue_size=1, flush_interval=1.0)

    def infos():
        return [r for r in caplog.records if r.levelno == logging.INFO]

    with caplog.at_level(logging.INFO, logger="apilens"):
        client._report_stats()
        assert infos() == []  # no drops yet

        client.capture_record(_request())
        client.capture_record(_request())  # 1 drop
        clock.now += 1.0
        client._report_stats()
        assert len(infos()) == 1
        assert "dropped 1 record(s)" in infos()[0].getMessage()

        client.capture_record(_request())  # another drop, inside the 60 s window
        clock.now += 1.0
        client._report_stats()
        assert len(infos()) == 1

        clock.now += client_mod.DROP_LOG_INTERVAL_SECONDS
        client._report_stats()
        assert len(infos()) == 2
        assert "dropped 1 record(s)" in infos()[1].getMessage()

        clock.now += client_mod.DROP_LOG_INTERVAL_SECONDS
        client._report_stats()  # no new drops: nothing at INFO
        assert len(infos()) == 2


def test_worker_reports_stats_each_flush_interval(monkeypatch):
    called = threading.Event()
    client = ApiLensClient(
        ApiLensConfig(api_key="k", flush_interval=0.01, on_stats=lambda s: called.set()),
        start_worker=False,
    )
    monkeypatch.setattr(client, "_send_batch", lambda batch: None)
    client.start()
    try:
        assert called.wait(2.0)
    finally:
        client.shutdown(flush=False, timeout=1.0)


def test_stats_thread_safe_under_concurrent_capture(monkeypatch):
    client = _client(max_queue_size=100_000)
    stop = threading.Event()
    errors: list[BaseException] = []

    def reader():
        try:
            while not stop.is_set():
                s = client.stats()
                assert s.queued_records >= 0
        except BaseException as exc:  # pragma: no cover
            errors.append(exc)

    t = threading.Thread(target=reader)
    t.start()
    for _ in range(2000):
        client.capture_record(_request())
    stop.set()
    t.join()
    assert errors == []
    assert client.stats().queued_records == 2000
