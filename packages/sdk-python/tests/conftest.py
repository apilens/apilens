"""Test-session defaults and the shared middleware harness."""

import asyncio
import io
import os
from types import SimpleNamespace

import pytest

from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware

# Middlewares built by the test suite would otherwise register an atexit flush
# for their (fake or real) clients and try to deliver leftovers to the default
# ingest URL when pytest exits. Tests that exercise the hooks unset this.
os.environ.setdefault("APILENS_FLUSH_ON_SHUTDOWN", "false")

# Likewise every middleware would start an app metadata report (POST
# /v1/metadata) to the default ingest URL. test_metadata.py re-enables it.
os.environ.setdefault("APILENS_SEND_METADATA", "false")

# And every client with a registered app would send heartbeats (POST
# /v1/heartbeat) from its flush thread. test_heartbeat.py re-enables them.
os.environ.setdefault("APILENS_SEND_HEARTBEAT", "false")

# OTEL_SERVICE_NAME is an app_id fallback; a value from the developer's shell
# would leak into every middleware built here. test_app_id.py sets it itself.
os.environ.pop("OTEL_SERVICE_NAME", None)


# ── Shared harness: a stub client and fake ASGI / WSGI apps ─────────────────
#
# Used by the option-matrix suites (test_exclusions.py, test_masking.py). The
# ``harness`` fixture is parametrised over both middlewares, so every test
# that takes it runs once against ApiLensASGIMiddleware and once against
# ApiLensWSGIMiddleware with the same request.

_REASONS = {200: "OK", 201: "Created", 404: "Not Found", 500: "Internal Server Error"}


class StubClient:
    """Stands in for ``ApiLensClient``: records what the middleware captures.

    ``config`` carries only what the middlewares read; ``capture_ip`` /
    ``anonymize_ip`` can be set per test.
    """

    def __init__(self, **config) -> None:
        self.config = SimpleNamespace(project_slug="", environment="test", **config)
        self.records: list[dict] = []
        self.spans: list = []
        self.logs: list = []

    def capture(self, **kwargs) -> None:
        self.records.append(kwargs)

    def capture_span(self, record) -> None:
        self.spans.append(record)

    def capture_log(self, record) -> None:
        self.logs.append(record)


class Harness:
    """Drive one request through a fresh middleware built with ``options``."""

    def __init__(self, kind: str) -> None:
        self.kind = kind
        self.app_calls = 0

    def request(
        self,
        *,
        client: StubClient | None = None,
        method: str = "GET",
        path: str = "/orders",
        query: str = "",
        headers: dict[str, str] | None = None,
        body: bytes = b"",
        status: int = 200,
        response_body: bytes = b'{"ok":true}',
        response_content_type: str = "application/json",
        client_ip: str = "203.0.113.42",
        **options,
    ) -> tuple[StubClient, bytes]:
        """Returns ``(client, response body the caller received)``."""
        client = client if client is not None else StubClient()
        options.setdefault("capture_spans", False)
        req = SimpleNamespace(
            method=method,
            path=path,
            query=query,
            headers={k.lower(): v for k, v in (headers or {}).items()},
            body=body,
            status=status,
            response_body=response_body,
            content_type=response_content_type,
            client_ip=client_ip,
        )
        run = self._asgi if self.kind == "asgi" else self._wsgi
        return client, run(client, req, options)

    def _asgi(self, client: StubClient, req: SimpleNamespace, options: dict) -> bytes:
        async def app(scope, receive, send):
            self.app_calls += 1
            await receive()
            await send(
                {
                    "type": "http.response.start",
                    "status": req.status,
                    "headers": [(b"content-type", req.content_type.encode())],
                }
            )
            await send({"type": "http.response.body", "body": req.response_body})

        mw = ApiLensASGIMiddleware(app, client, **options)
        scope = {
            "type": "http",
            "method": req.method,
            "path": req.path,
            "query_string": req.query.encode(),
            "headers": [(k.encode(), v.encode()) for k, v in req.headers.items()],
            "client": (req.client_ip, 50000),
        }
        sent: list[bytes] = []

        async def receive():
            return {"type": "http.request", "body": req.body, "more_body": False}

        async def send(message):
            if message["type"] == "http.response.body":
                sent.append(message.get("body", b""))

        asyncio.run(mw(scope, receive, send))
        return b"".join(sent)

    def _wsgi(self, client: StubClient, req: SimpleNamespace, options: dict) -> bytes:
        def app(environ, start_response):
            self.app_calls += 1
            environ["wsgi.input"].read()
            start_response(f"{req.status} {_REASONS.get(req.status, 'Status')}", [("Content-Type", req.content_type)])
            return [req.response_body]

        mw = ApiLensWSGIMiddleware(app, client, **options)
        environ = {
            "REQUEST_METHOD": req.method,
            "PATH_INFO": req.path,
            "QUERY_STRING": req.query,
            "CONTENT_LENGTH": str(len(req.body)),
            "REMOTE_ADDR": req.client_ip,
            "SERVER_NAME": "example.com",
            "SERVER_PORT": "80",
            "HTTP_HOST": "example.com",
            "wsgi.url_scheme": "http",
            "wsgi.input": io.BytesIO(req.body),
        }
        for name, value in req.headers.items():
            if name == "content-type":
                environ["CONTENT_TYPE"] = value
            else:
                environ["HTTP_" + name.upper().replace("-", "_")] = value
        return b"".join(mw(environ, lambda status, headers, exc_info=None: None))


@pytest.fixture(params=["asgi", "wsgi"])
def harness(request) -> Harness:
    return Harness(request.param)


@pytest.fixture
def make_stub_client():
    """``make_stub_client(capture_ip=False, ...)`` -> a fresh :class:`StubClient`."""
    return StubClient


@pytest.fixture
def clean_apilens_env(monkeypatch):
    """Unset every ``APILENS_*`` option variable the config loader reads (the
    session defaults above are not loader options and stay set)."""
    from apilens.client._env import ENV_OPTIONS, env_var

    for option in ENV_OPTIONS:
        monkeypatch.delenv(env_var(option), raising=False)
    monkeypatch.delenv("APILENS_PARAMETRIZE_PATHS", raising=False)
