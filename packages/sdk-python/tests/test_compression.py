"""gzip request bodies to ingest (issue #529)."""

from __future__ import annotations

import gzip
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from apilens.client import ApiLensClient, ApiLensConfig


class _IngestEdge:
    """Minimal stand-in for the Go ingest edge: honours Content-Encoding
    (gzip / identity) like ``internal/ingest/edge.go`` ``readBody``."""

    def __init__(self) -> None:
        self.received: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                encoding = (self.headers.get("Content-Encoding") or "identity").lower()
                if encoding == "gzip":
                    body = gzip.decompress(raw)
                elif encoding == "identity":
                    body = raw
                else:
                    self.send_response(415)
                    self.end_headers()
                    return
                outer.received.append(
                    {
                        "path": self.path,
                        "encoding": encoding,
                        "wire_bytes": len(raw),
                        "json": json.loads(body),
                    }
                )
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *_a):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def edge():
    e = _IngestEdge()
    yield e
    e.close()


def _client(edge: _IngestEdge, **overrides) -> ApiLensClient:
    cfg = dict(api_key="test-key", base_url=edge.base_url, max_retries=0, retry_backoff_base=0.0)
    cfg.update(overrides)
    return ApiLensClient(ApiLensConfig(**cfg), start_worker=False)


def _capture(client: ApiLensClient, n: int = 20) -> None:
    for i in range(n):
        client.capture(
            method="POST",
            path=f"/orders/{i}",
            status_code=201,
            response_time_ms=3.0,
            app_id="storefront",
            request_payload=json.dumps({"sku": "abc", "qty": i, "note": "x" * 200}),
        )


def test_compress_defaults_on():
    assert ApiLensConfig(api_key="k").compress is True


def test_edge_receives_and_decodes_gzipped_batch(edge):
    client = _client(edge)
    _capture(client)
    assert client.flush_all() == 20

    [hit] = edge.received
    assert hit["path"] == "/v1/requests"
    assert hit["encoding"] == "gzip"
    requests = hit["json"]["requests"]
    assert len(requests) == 20
    assert requests[3]["path"] == "/orders/3"
    plain = len(json.dumps(hit["json"], separators=(",", ":")).encode())
    assert hit["wire_bytes"] < plain / 3


def test_compress_false_sends_plain_json(edge):
    client = _client(edge, compress=False)
    _capture(client, 5)
    assert client.flush_all() == 5

    [hit] = edge.received
    assert hit["encoding"] == "identity"
    assert len(hit["json"]["requests"]) == 5


def test_compression_error_falls_back_to_identity(edge, monkeypatch):
    def boom(*_a, **_kw):
        raise OSError("zlib unavailable")

    monkeypatch.setattr("apilens.client.client.gzip.compress", boom)
    client = _client(edge)
    _capture(client, 3)
    assert client.flush_all() == 3

    [hit] = edge.received
    assert hit["encoding"] == "identity"
    assert len(hit["json"]["requests"]) == 3
    assert client.dropped_count == 0


def test_gzip_level_five(edge, monkeypatch):
    levels: list[int] = []
    real = gzip.compress

    def spy(data, compresslevel=9, **kw):
        levels.append(compresslevel)
        return real(data, compresslevel=compresslevel, **kw)

    monkeypatch.setattr("apilens.client.client.gzip.compress", spy)
    client = _client(edge)
    _capture(client, 1)
    client.flush_all()
    assert levels == [5]


def test_compression_runs_on_flush_thread_not_request_path(edge, monkeypatch):
    real = gzip.compress
    threads: list[str] = []

    def spy(data, *a, **kw):
        threads.append(threading.current_thread().name)
        return real(data, *a, **kw)

    monkeypatch.setattr("apilens.client.client.gzip.compress", spy)
    client = ApiLensClient(
        ApiLensConfig(api_key="test-key", base_url=edge.base_url, flush_interval=0.05, max_retries=0)
    )
    try:
        _capture(client, 5)
        assert threads == []  # capture only enqueues; nothing is compressed inline

        deadline = time.monotonic() + 5
        while not edge.received and time.monotonic() < deadline:
            time.sleep(0.02)
    finally:
        client.shutdown(flush=False)

    assert edge.received and edge.received[0]["encoding"] == "gzip"
    assert threads and set(threads) == {"apilens-flush"}
