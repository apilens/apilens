"""Size-aware batching (issue #528): no POST body exceeds ``max_batch_bytes``;
a single oversized record is truncated (payloads first), not dropped."""

from __future__ import annotations

import gzip
import json
import random
import string
from datetime import datetime, timezone

import pytest

from apilens.client import ApiLensClient, ApiLensConfig
from apilens.client import client as client_mod
from apilens.client.client import MIN_BATCH_BYTES, TRUNCATION_MARKER
from apilens.client.models import LogRecord, RequestRecord, SpanRecord

KB = 1024
MB = 1024 * KB


class _Resp:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False


@pytest.fixture
def sent(monkeypatch):
    """Every POST as ``(path, wire_bytes, decoded_json_bytes)``."""
    bodies: list[tuple[str, bytes, bytes]] = []

    def fake_open(req, _config):
        wire = req.data
        raw = gzip.decompress(wire) if req.get_header("Content-encoding") == "gzip" else wire
        bodies.append((req.full_url, wire, raw))
        return _Resp()

    monkeypatch.setattr(client_mod, "_open", fake_open)
    return bodies


def _client(**overrides) -> ApiLensClient:
    cfg = dict(api_key="test-key", max_retries=0, retry_backoff_base=0.0)
    cfg.update(overrides)
    return ApiLensClient(ApiLensConfig(**cfg), start_worker=False)


def _request(payload: str = "", path: str = "/r") -> RequestRecord:
    return RequestRecord(
        timestamp=datetime.now(tz=timezone.utc),
        environment="test",
        method="POST",
        path=path,
        status_code=200,
        response_time_ms=1.0,
        request_payload=payload,
        response_payload=payload,
    )


def _noise(n: int, seed: int = 0) -> str:
    rnd = random.Random(seed)
    return "".join(rnd.choices(string.ascii_letters + string.digits, k=n))


def test_default_is_4_mb():
    assert ApiLensConfig(api_key="k").max_batch_bytes == 4 * MB


def test_rejects_tiny_max_batch_bytes():
    with pytest.raises(ValueError, match="max_batch_bytes"):
        _client(max_batch_bytes=MIN_BATCH_BYTES - 1)


@pytest.mark.parametrize("compress", [True, False])
def test_large_payloads_never_exceed_max_batch_bytes(sent, compress):
    """200 records x 2 x 128 KB would be ~50 MB in one POST; with a 4 MB cap
    every body stays under it and every record is still delivered."""
    limit = 4 * MB
    client = _client(max_batch_bytes=limit, batch_size=200, compress=compress)
    for i in range(200):
        client.capture_record(_request(_noise(128 * KB, seed=i), path=f"/r/{i}"))

    delivered = client.flush_all()

    assert delivered == 200
    assert len(sent) > 1
    paths: list[str] = []
    for _url, wire, raw in sent:
        assert len(raw) <= limit
        assert len(wire) <= limit
        paths += [r["path"] for r in json.loads(raw)["requests"]]
    assert paths == [f"/r/{i}" for i in range(200)]
    assert client.drop_counts()["truncated"] == 0
    assert client.dropped_count == 0


def test_json_escaping_is_measured_exactly(sent):
    """Control characters expand 6x in JSON; the size estimate misses that, the
    exact split must not."""
    limit = 64 * KB
    client = _client(max_batch_bytes=limit, compress=False)
    for _ in range(20):
        client.capture_record(_request("\x01" * (8 * KB)))

    assert client.flush_all() == 20
    assert all(len(raw) <= limit for _u, _w, raw in sent)


def test_count_limit_still_applies_to_small_records(sent):
    client = _client(batch_size=10, compress=False)
    for i in range(25):
        client.capture(method="GET", path=f"/r/{i}", status_code=200, response_time_ms=1.0)

    client.flush_all()

    assert [len(json.loads(raw)["requests"]) for _u, _w, raw in sent] == [10, 10, 5]


def test_oversized_record_is_truncated_payloads_first(sent):
    limit = MIN_BATCH_BYTES
    client = _client(max_batch_bytes=limit, compress=False)
    rec = _request("p" * (64 * KB), path="/big")
    rec.request_headers = json.dumps({"x-small": "1"})
    client.capture_record(rec)

    assert client.flush_all() == 1

    (_url, _wire, raw), = sent
    assert len(raw) <= limit
    (wire,) = json.loads(raw)["requests"]
    assert wire["path"] == "/big"
    assert wire["request_headers"] == rec.request_headers  # untouched: payloads went first
    assert wire["request_payload"] == "" or wire["request_payload"].endswith(TRUNCATION_MARKER)
    assert wire["response_payload"].endswith(TRUNCATION_MARKER)
    assert client.drop_counts()["truncated"] == 1
    assert client.dropped_count == 0  # truncated records are delivered, not dropped
    # The queued record itself is not mutated.
    assert rec.request_payload == "p" * (64 * KB)


def test_oversized_record_with_large_headers_and_path(sent):
    limit = MIN_BATCH_BYTES
    client = _client(max_batch_bytes=limit, compress=False)
    rec = _request("p" * (32 * KB))
    rec.request_headers = "h" * (32 * KB)
    rec.response_headers = "\x02" * (8 * KB)
    rec.raw_path = "/q?" + "a" * (32 * KB)
    client.capture_record(rec)

    assert client.flush_all() == 1
    (_url, _wire, raw), = sent
    assert len(raw) <= limit
    assert client.drop_counts()["truncated"] == 1


def test_oversized_span_and_log_are_truncated(sent):
    limit = MIN_BATCH_BYTES
    client = _client(max_batch_bytes=limit, compress=False)
    now = datetime.now(tz=timezone.utc)
    client.capture_span(
        SpanRecord(
            timestamp=now,
            environment="test",
            trace_id="t" * 32,
            span_id="s" * 16,
            name="db.query",
            attributes={"db.statement": "x" * (40 * KB)},
        )
    )
    client.capture_log(
        LogRecord(
            timestamp=now,
            environment="test",
            level="ERROR",
            message="boom " + "m" * (20 * KB),
            trace_id="t" * 32,
            payload="tb " * (20 * KB),
        )
    )

    assert client.flush_all() == 2
    assert len(sent) == 2
    for _url, _wire, raw in sent:
        assert len(raw) <= limit
    span = json.loads(sent[0][2])["spans"][0]
    assert span["name"] == "db.query" and span["trace_id"] == "t" * 32
    log = json.loads(sent[1][2])["logs"][0]
    assert log["message"].startswith("boom")
    assert client.drop_counts()["truncated"] == 2


def test_pop_respects_byte_estimate():
    client = _client(max_batch_bytes=64 * KB)
    for _ in range(10):
        client.capture_record(_request("x" * (10 * KB)))  # ~20.5 KB estimated each

    assert len(client._pop_batch(200)) == 3
    # A single record above the cap is still popped on its own.
    client2 = _client(max_batch_bytes=MIN_BATCH_BYTES)
    client2.capture_record(_request("x" * (64 * KB)))
    assert len(client2._pop_batch(200)) == 1
