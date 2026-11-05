"""HTTP proxy support and custom CA (issue #534).

Runs a real local forwarding proxy (stdlib only: absolute-form requests for
http, ``CONNECT`` tunnels for https) in front of a local ingest edge, so the
proxy path is exercised in CI without tinyproxy.
"""

from __future__ import annotations

import base64
import gzip
import http.client
import json
import select
import shutil
import socket
import ssl
import subprocess
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from pathlib import Path

import pytest

from apilens.client import ApiLensClient, ApiLensConfig
from apilens.client.client import ENV_PROXY

_PROXY_ENV = (
    ENV_PROXY,
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
)


@pytest.fixture(autouse=True)
def _clean_proxy_env(monkeypatch):
    for name in _PROXY_ENV:
        monkeypatch.delenv(name, raising=False)


class _Edge:
    """Ingest edge stand-in; optionally serves TLS with ``certfile``."""

    def __init__(self, certfile: str | None = None) -> None:
        self.received: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                if (self.headers.get("Content-Encoding") or "").lower() == "gzip":
                    raw = gzip.decompress(raw)
                outer.received.append({"path": self.path, "json": json.loads(raw)})
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *_a):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.scheme = "http"
        if certfile:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(certfile)
            self.server.socket = ctx.wrap_socket(self.server.socket, server_side=True)
            self.scheme = "https"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def base_url(self) -> str:
        return f"{self.scheme}://127.0.0.1:{self.server.server_address[1]}/v1"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class _Proxy:
    """Minimal forward proxy: records every request line and Proxy-Authorization."""

    def __init__(self) -> None:
        self.seen: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _record(self) -> None:
                outer.seen.append(
                    {
                        "method": self.command,
                        "target": self.path,
                        "proxy_auth": self.headers.get("Proxy-Authorization"),
                    }
                )

            def do_CONNECT(self):  # noqa: N802
                self._record()
                host, port = self.path.rsplit(":", 1)
                upstream = socket.create_connection((host, int(port)), timeout=5)
                self.send_response(200, "Connection established")
                self.end_headers()
                conns = [self.connection, upstream]
                try:
                    while True:
                        readable, _, _ = select.select(conns, [], [], 5)
                        if not readable:
                            break
                        done = False
                        for sock in readable:
                            data = sock.recv(65536)
                            if not data:
                                done = True
                                break
                            (upstream if sock is self.connection else self.connection).sendall(data)
                        if done:
                            break
                finally:
                    upstream.close()
                self.close_connection = True

            def do_POST(self):  # noqa: N802
                self._record()
                url = urllib.parse.urlsplit(self.path)
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                headers = {
                    k: v
                    for k, v in self.headers.items()
                    if k.lower() not in ("proxy-authorization", "proxy-connection", "connection", "host")
                }
                conn = http.client.HTTPConnection(url.hostname, url.port, timeout=5)
                conn.request("POST", url.path or "/", body=body, headers=headers)
                resp = conn.getresponse()
                payload = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                conn.close()

            def log_message(self, *_a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def edge():
    e = _Edge()
    yield e
    e.close()


@pytest.fixture
def proxy():
    p = _Proxy()
    yield p
    p.close()


def _send_one(config: ApiLensConfig) -> ApiLensClient:
    config.max_retries = 0
    client = ApiLensClient(config, start_worker=False)
    client.capture(method="GET", path="/orders", status_code=200, response_time_ms=1.0)
    client.flush_all()
    return client


def test_explicit_proxy_url_routes_ingest_through_proxy(edge, proxy):
    client = _send_one(ApiLensConfig(api_key="k", base_url=edge.base_url, proxy_url=proxy.url))
    assert [(s["method"], s["target"]) for s in proxy.seen] == [
        ("POST", f"{edge.base_url}/requests")
    ]
    assert edge.received[0]["json"]["requests"][0]["path"] == "/orders"
    assert client.dropped_count == 0


def test_env_apilens_proxy_is_used(edge, proxy, monkeypatch):
    monkeypatch.setenv(ENV_PROXY, proxy.url)
    config = ApiLensConfig(api_key="k", base_url=edge.base_url)
    assert config.proxy_url == proxy.url
    _send_one(config)
    assert len(proxy.seen) == 1
    assert len(edge.received) == 1


def test_explicit_proxy_url_wins_over_env(edge, proxy, monkeypatch):
    monkeypatch.setenv(ENV_PROXY, "http://127.0.0.1:1")  # nothing listens here
    _send_one(ApiLensConfig(api_key="k", base_url=edge.base_url, proxy_url=proxy.url))
    assert len(proxy.seen) == 1
    assert len(edge.received) == 1


def test_standard_http_proxy_env_is_honoured(edge, proxy, monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", proxy.url)
    monkeypatch.setenv("http_proxy", proxy.url)
    _send_one(ApiLensConfig(api_key="k", base_url=edge.base_url))
    assert len(proxy.seen) == 1
    assert len(edge.received) == 1


def test_no_proxy_configured_goes_direct(edge, proxy):
    _send_one(ApiLensConfig(api_key="k", base_url=edge.base_url))
    assert proxy.seen == []
    assert len(edge.received) == 1


def test_proxy_credentials_sent_as_basic_auth(edge, proxy):
    authed = proxy.url.replace("http://", "http://alice:s3cret@")
    _send_one(ApiLensConfig(api_key="k", base_url=edge.base_url, proxy_url=authed))
    expected = "Basic " + base64.b64encode(b"alice:s3cret").decode()
    assert proxy.seen[0]["proxy_auth"] == expected
    assert len(edge.received) == 1


def test_unreachable_proxy_is_retryable_network_error(edge):
    client = _send_one(
        ApiLensConfig(api_key="k", base_url=edge.base_url, proxy_url="http://127.0.0.1:1")
    )
    assert edge.received == []
    assert client.drop_counts()["retries_exhausted"] == 1


# --- https through a CONNECT tunnel, verified against a custom CA ----------


@pytest.fixture(scope="module")
def self_signed(tmp_path_factory) -> Path:
    if shutil.which("openssl") is None:
        pytest.skip("openssl CLI not available")
    d = tmp_path_factory.mktemp("tls")
    key, cert = d / "key.pem", d / "cert.pem"
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key), "-out", str(cert), "-days", "1",
            "-subj", "/CN=127.0.0.1",
            "-addext", "subjectAltName=IP:127.0.0.1",
            "-addext", "basicConstraints=critical,CA:TRUE",
            "-addext", "keyUsage=critical,digitalSignature,keyCertSign",
        ],
        check=True,
        capture_output=True,
    )
    combined = d / "server.pem"
    combined.write_text(cert.read_text() + key.read_text())
    return d


@pytest.fixture
def tls_edge(self_signed):
    e = _Edge(certfile=str(self_signed / "server.pem"))
    yield e
    e.close()


def test_https_via_connect_proxy_with_custom_ca(tls_edge, proxy, self_signed):
    port = tls_edge.server.server_address[1]
    client = _send_one(
        ApiLensConfig(
            api_key="k",
            base_url=tls_edge.base_url,
            proxy_url=proxy.url,
            ca_bundle_path=str(self_signed / "cert.pem"),
        )
    )
    assert [(s["method"], s["target"]) for s in proxy.seen] == [("CONNECT", f"127.0.0.1:{port}")]
    assert tls_edge.received[0]["json"]["requests"][0]["path"] == "/orders"
    assert client.dropped_count == 0


def test_https_without_custom_ca_fails_verification(tls_edge, proxy):
    client = _send_one(
        ApiLensConfig(api_key="k", base_url=tls_edge.base_url, proxy_url=proxy.url)
    )
    assert tls_edge.received == []
    assert client.dropped_count == 1


def test_standard_https_proxy_env_is_honoured(tls_edge, proxy, self_signed, monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", proxy.url)
    monkeypatch.setenv("https_proxy", proxy.url)
    _send_one(
        ApiLensConfig(
            api_key="k", base_url=tls_edge.base_url, ca_bundle_path=str(self_signed / "cert.pem")
        )
    )
    assert [s["method"] for s in proxy.seen] == ["CONNECT"]
    assert len(tls_edge.received) == 1
