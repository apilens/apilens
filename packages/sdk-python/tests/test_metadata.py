"""App metadata report: POST /v1/metadata once per process start (issue #536).

Framework, versions, discovered route templates (capped at 2000) and the
effective privacy config; sent once per process from a background thread,
retried up to 3 times, never carrying the API key or callback source.
"""

from __future__ import annotations

import gzip
import json
import sys
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from apilens._version import __version__
from apilens.client import ApiLensClient, ApiLensConfig
from apilens.client import _metadata as metadata_mod
from apilens.client import client as client_mod
from apilens.client._metadata import build_payload, effective_config
from apilens.client._routes import (
    ANY_METHOD,
    MAX_METADATA_ROUTES,
    cap_routes,
    list_starlette_routes,
)
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware

SECRET_KEY = "apilens_live_S3CRETKEYVALUE"
PROXY = "http://proxyuser:hunter2pass@proxy.internal:3128"
CA_PATH = "/etc/private/corp-ca-bundle.pem"


class _FakeIngest:
    """Records each POST (path, headers, decoded JSON) and answers with the
    next scripted status (the last one repeats)."""

    def __init__(self, statuses: list[int]) -> None:
        self.statuses = list(statuses)
        self.requests: list[tuple[str, dict, dict]] = []
        self.got = threading.Event()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                if self.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                outer.requests.append((self.path, dict(self.headers), json.loads(raw)))
                status = outer.statuses[min(len(outer.requests) - 1, len(outer.statuses) - 1)]
                self.send_response(status)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")
                outer.got.set()

            def log_message(self, *_a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def ingest():
    servers: list[_FakeIngest] = []

    def make(*statuses: int) -> _FakeIngest:
        server = _FakeIngest(list(statuses) or [200])
        servers.append(server)
        return server

    yield make
    for server in servers:
        server.close()


@pytest.fixture(autouse=True)
def metadata_enabled(monkeypatch):
    """Re-enable reports (conftest turns them off), report immediately, and
    forget what earlier tests reported."""
    monkeypatch.setenv("APILENS_SEND_METADATA", "true")
    monkeypatch.setattr(client_mod, "METADATA_DELAY_SECONDS", 0.0)
    monkeypatch.setattr(client_mod, "_metadata_reported", set())
    monkeypatch.setattr(metadata_mod, "_hints", {})
    monkeypatch.setattr(metadata_mod, "APP_WAIT_SECONDS", 2.0)


def _client(base_url: str = "http://127.0.0.1:9/v1", **overrides) -> ApiLensClient:
    cfg = dict(
        api_key=SECRET_KEY,
        base_url=base_url,
        retry_backoff_base=0.001,
        retry_backoff_max=0.002,
        timeout=2.0,
    )
    cfg.update(overrides)
    return ApiLensClient(ApiLensConfig(**cfg), start_worker=False)


def _join(client: ApiLensClient, timeout: float = 5.0) -> None:
    thread = client._metadata_thread
    assert thread is not None
    thread.join(timeout)
    assert not thread.is_alive()


async def _noop_app(scope, receive, send):  # pragma: no cover - never routed
    return None


def _api_key_keys(value) -> list[str]:
    """Object keys naming an API key at any depth (the ingest edge's check)."""
    found: list[str] = []
    if isinstance(value, dict):
        for k, v in value.items():
            if k.lower().replace("_", "").replace("-", "").replace(".", "") == "apikey":
                found.append(k)
            found += _api_key_keys(v)
    elif isinstance(value, list):
        for v in value:
            found += _api_key_keys(v)
    return found


# ── Payload and secrets ─────────────────────────────────────────────────────


def _secret_masker_function_name(info, body):  # pragma: no cover - never called
    return body


def test_payload_shape_and_effective_config():
    mw = ApiLensASGIMiddleware(
        _noop_app,
        _client(),
        app_id="orders-api",
        environment="staging",
        capture_spans=False,
        log_response_body=False,
        max_payload_bytes=1024,
        redact_query_params=[r"^card_number$"],
        redact_body_fields=[r"^ssn$"],
        exclude_paths=[r"^/internal/"],
        sample_rate=0.25,
        mask_request_body=_secret_masker_function_name,
    )
    config = effective_config(mw)
    payload = build_payload(
        mw, framework="fastapi", routes=[{"method": "get", "path": "/orders/{id}"}], config=config
    )

    assert payload["app_id"] == "orders-api"
    assert payload["environment"] == "staging"
    assert payload["framework"] == "fastapi"
    assert payload["sdk_version"] == __version__
    assert payload["python_version"].count(".") == 2
    assert payload["routes"] == [{"method": "GET", "path": "/orders/{id}"}]
    assert "project_slug" not in payload  # only sent when configured

    assert config["capture_request_body"] is True
    assert config["capture_response_body"] is False
    assert config["max_payload_bytes"] == 1024
    assert config["capture_spans"] is False
    assert config["sample_rate"] == 0.25
    assert config["redact_query_params"][-1] == r"^card_number$"
    assert "password" in "".join(config["redact_body_fields"])  # built-ins listed too
    assert config["redact_body_fields"][-1] == r"^ssn$"
    assert config["exclude_paths"][-1] == r"^/internal/"
    assert config["default_exclusions"] is True
    assert config["callbacks"] == {
        "mask_request_body": True,
        "mask_response_body": False,
        "mask_log_record": False,
        "get_consumer": False,
        "on_stats": False,
    }


def test_env_overrides_are_reflected(monkeypatch):
    monkeypatch.setenv("APILENS_CAPTURE_IP", "false")
    monkeypatch.setenv("APILENS_ANONYMIZE_IP", "true")
    monkeypatch.setenv("APILENS_PARAMETRIZE_PATHS", "false")
    mw = ApiLensASGIMiddleware(_noop_app, _client(), app_id="a", capture_spans=False)
    config = effective_config(mw)
    assert config["capture_ip"] is False
    assert config["anonymize_ip"] is True
    assert config["parametrize_paths"] is False


def test_secrets_are_absent_from_the_report(ingest):
    server = ingest(200)
    client = _client(
        server.base_url,
        proxy_url=PROXY,
        ca_bundle_path=CA_PATH,
        mask_log_record=lambda record: record,
        on_stats=lambda stats: None,
        send_metadata=False,  # this test posts the report itself, below
    )
    mw = ApiLensWSGIMiddleware(
        lambda environ, start_response: [b""],
        client,
        app_id="orders-api",
        capture_spans=False,
        mask_request_body=_secret_masker_function_name,
        mask_response_body=lambda info, body: body,
        get_consumer=lambda environ: "user-1",
    )
    config = effective_config(mw)
    # Post directly to the fake ingest (the proxy host does not exist).
    client.config.proxy_url = ""
    client.config.ca_bundle_path = ""
    assert client.send_metadata(build_payload(mw, framework="flask", routes=[], config=config))

    (path, headers, body) = server.requests[0]
    assert path == "/v1/metadata"
    assert {k.lower(): v for k, v in headers.items()}["x-api-key"] == SECRET_KEY  # auth only
    text = json.dumps(body)
    for secret in (SECRET_KEY, "hunter2pass", "proxyuser", PROXY, CA_PATH):
        assert secret not in text
    for source in ("_secret_masker_function_name", "lambda", "def ", "return body"):
        assert source not in text
    assert _api_key_keys(body) == []
    assert body["config"]["proxy"] is True
    assert body["config"]["custom_ca"] is True
    assert set(body["config"]["callbacks"].values()) == {True}


def test_api_key_fields_are_stripped_at_any_depth(ingest):
    server = ingest(200)
    client = _client(server.base_url)
    assert client.send_metadata(
        {
            "app_id": "a",
            "api_key": SECRET_KEY,
            "routes": [],
            "config": {"apiKey": SECRET_KEY, "nested": [{"Api-Key": SECRET_KEY, "keep": 1}]},
        }
    )
    body = server.requests[0][2]
    assert _api_key_keys(body) == []
    assert SECRET_KEY not in json.dumps(body)
    assert body["config"]["nested"] == [{"keep": 1}]


# ── Routes cap ──────────────────────────────────────────────────────────────


def test_routes_capped_at_2000(ingest):
    server = ingest(200)
    client = _client(server.base_url)
    routes = [{"method": "GET", "path": f"/r/{i}"} for i in range(2500)]
    assert client.send_metadata({"app_id": "a", "routes": routes, "config": {}})
    sent = server.requests[0][2]["routes"]
    assert len(sent) == MAX_METADATA_ROUTES == 2000
    assert sent[0] == {"method": "GET", "path": "/r/0"}
    assert sent[-1] == {"method": "GET", "path": "/r/1999"}


def test_cap_routes_normalises_and_dedupes():
    routes = [
        {"method": "get", "path": " /a "},
        {"method": "GET", "path": "/a"},
        {"method": "", "path": "/b"},
        {"method": "POST", "path": ""},
        "not-a-route",
        {"method": "post", "path": "/a"},
    ]
    assert cap_routes(routes) == [
        {"method": "GET", "path": "/a"},
        {"method": "POST", "path": "/a"},
    ]
    assert len(cap_routes([{"method": "GET", "path": f"/{i}"} for i in range(10)], limit=3)) == 3


# ── Once per process, non-blocking, retries ─────────────────────────────────


def test_sent_once_per_process_per_app_and_environment(ingest):
    server = ingest(200)
    client = _client(server.base_url)
    build = lambda: {"app_id": "a", "routes": [], "config": {}}
    assert client.report_metadata(build, app_id="a", environment="production") is True
    _join(client)
    # Another middleware instance or another client in the same process.
    assert client.report_metadata(build, app_id="a", environment="production") is False
    assert _client(server.base_url).report_metadata(build, app_id="a", environment="production") is False
    assert len(server.requests) == 1
    # A different environment is a different report.
    assert client.report_metadata(build, app_id="a", environment="staging") is True
    _join(client)
    assert len(server.requests) == 2


def test_report_is_non_blocking(monkeypatch, ingest):
    server = ingest(200)
    monkeypatch.setattr(client_mod, "METADATA_DELAY_SECONDS", 0.3)
    client = _client(server.base_url)
    built = threading.Event()

    def build():
        time.sleep(0.3)
        built.set()
        return {"app_id": "a", "routes": [], "config": {}}

    started = time.perf_counter()
    assert client.report_metadata(build, app_id="a") is True
    assert time.perf_counter() - started < 0.1
    assert not built.is_set()
    _join(client)
    assert built.is_set() and len(server.requests) == 1


def test_disabled_reports_nothing(monkeypatch):
    build = lambda: {"app_id": "a"}
    assert _client(send_metadata=False).report_metadata(build, app_id="a") is False
    assert _client(enabled=False).report_metadata(build, app_id="b") is False
    monkeypatch.setenv("APILENS_SEND_METADATA", "false")
    assert _client().report_metadata(build, app_id="c") is False


def test_build_failure_is_swallowed():
    client = _client()

    def build():
        raise RuntimeError("boom")

    assert client.report_metadata(build, app_id="a") is True
    _join(client)


@pytest.mark.parametrize(
    "statuses, ok, hits",
    [
        ([503, 503, 200], True, 3),
        ([503], False, 4),  # first try + 3 retries
        ([422], False, 1),  # non-retryable
        ([429, 200], True, 2),
    ],
)
def test_retry_up_to_three_times(ingest, statuses, ok, hits):
    server = ingest(*statuses)
    client = _client(server.base_url)
    assert client.send_metadata({"app_id": "a", "routes": [], "config": {}}) is ok
    assert len(server.requests) == hits


def test_shutdown_before_the_delay_cancels_the_report(monkeypatch, ingest):
    server = ingest(200)
    monkeypatch.setattr(client_mod, "METADATA_DELAY_SECONDS", 5.0)
    client = _client(server.base_url)
    assert client.report_metadata(lambda: {"app_id": "a"}, app_id="a")
    client.shutdown(flush=False, timeout=0.1)
    _join(client)
    assert server.requests == []


# ── Middleware wiring ───────────────────────────────────────────────────────


class _Route:
    def __init__(self, path, methods):
        self.path = path
        self.methods = set(methods)


class _Mount:
    def __init__(self, path, routes):
        self.path = path
        self.routes = routes


class _RoutedApp:
    """A Starlette-shaped app (``routes`` list) with no framework module."""

    def __init__(self, routes):
        self.routes = routes

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})


def test_list_starlette_routes_recurses_mounts_and_drops_implicit_methods():
    routes = [
        _Route("/orders/{id}", {"GET", "HEAD"}),
        _Route("/orders", {"POST"}),
        _Route("/ws", ()),  # websocket: no methods
        _Mount("/admin", [_Route("/users/{uid}", {"DELETE", "OPTIONS"})]),
        _Route("/head-only", {"HEAD"}),
    ]
    assert list_starlette_routes(routes) == [
        {"method": "GET", "path": "/orders/{id}"},
        {"method": "POST", "path": "/orders"},
        {"method": "DELETE", "path": "/admin/users/{uid}"},
        {"method": "HEAD", "path": "/head-only"},
    ]


def test_asgi_middleware_reports_routes_found_down_the_chain(ingest):
    server = ingest(200)
    inner = _RoutedApp([_Route("/orders/{id}", {"GET"})])
    ApiLensASGIMiddleware(inner, _client(server.base_url), app_id="orders-api", capture_spans=False)
    assert server.got.wait(5)
    body = server.requests[0][2]
    assert body["app_id"] == "orders-api"
    assert body["routes"] == [{"method": "GET", "path": "/orders/{id}"}]


def test_asgi_middleware_learns_the_app_from_the_first_scope(ingest):
    """Litestar applies app middleware per route: the middleware's inner app
    has no routes, so the report waits for the first request's scope["app"]."""
    import asyncio

    server = ingest(200)
    client = _client(server.base_url)
    first = ApiLensASGIMiddleware(_noop_app, client, app_id="orders-api", capture_spans=False)
    # A second instance of the same app shares the hint (and sends nothing).
    second = ApiLensASGIMiddleware(_RoutedApp([]), client, app_id="orders-api", capture_spans=False)
    assert second._metadata_hint is first._metadata_hint
    assert not server.got.wait(0.2)  # still waiting for an app

    app = _RoutedApp([_Route("/items/{item_id}", {"GET", "PUT"})])
    scope = {"type": "http", "method": "GET", "path": "/items/1", "headers": [], "app": app}

    async def receive():
        return {"type": "http.request", "body": b""}

    async def send(message):
        pass

    asyncio.run(second(scope, receive, send))
    assert server.got.wait(5)
    assert server.requests[0][2]["routes"] == [
        {"method": "GET", "path": "/items/{item_id}"},
        {"method": "PUT", "path": "/items/{item_id}"},
    ]
    assert first._metadata_hint.waiting is False
    assert len(server.requests) == 1


def test_middleware_without_app_id_reports_for_the_default_app(ingest):
    """No app name configured: the report still goes out, with ``app_id=""``
    (the server files it under the project's default app)."""
    server = ingest(200)
    client = _client(server.base_url)
    mw = ApiLensASGIMiddleware(_noop_app, client, capture_spans=False)
    assert mw.app_id == ""
    assert mw._metadata_hint is not None
    mw._metadata_hint.note(None)
    _join(client)
    assert len(server.requests) == 1
    assert server.requests[0][2]["app_id"] == ""


# ── Real frameworks (skipped when not installed) ────────────────────────────


def test_fastapi_routes_and_framework(ingest):
    pytest.importorskip("fastapi")
    from fastapi import APIRouter, FastAPI

    from apilens.client._metadata import _discovered
    from apilens.client._routes import find_app

    app = FastAPI()
    router = APIRouter(prefix="/api")

    @app.get("/product/{id}")
    async def _get(id: int):  # pragma: no cover
        return {}

    @router.post("/orders")
    async def _post():  # pragma: no cover
        return {}

    app.include_router(router)
    framework, routes = _discovered(app)
    assert framework == "fastapi"
    assert {"method": "GET", "path": "/product/{id}"} in routes
    assert {"method": "POST", "path": "/api/orders"} in routes
    # Through the middleware chain the Router is found; still reported as FastAPI.
    framework, _ = _discovered(find_app(app.router))
    assert framework == "fastapi"


def test_starlette_mount_routes():
    pytest.importorskip("starlette")
    from starlette.applications import Starlette
    from starlette.routing import Mount, Route

    from apilens.client._metadata import _discovered

    async def handler(request):  # pragma: no cover
        ...

    app = Starlette(
        routes=[Route("/p/{id}", handler), Mount("/api", routes=[Route("/o/{oid}", handler, methods=["POST"])])]
    )
    framework, routes = _discovered(app)
    assert framework == "starlette"
    assert routes == [{"method": "GET", "path": "/p/{id}"}, {"method": "POST", "path": "/api/o/{oid}"}]


def test_flask_routes_through_wsgi_app(ingest):
    flask = pytest.importorskip("flask")
    from apilens.frameworks.flask import instrument_flask

    server = ingest(200)
    app = flask.Flask(__name__)

    @app.route("/product/<int:id>", methods=["GET", "DELETE"])
    def _p(id):  # pragma: no cover
        return ""

    instrument_flask(app, _client(server.base_url), app_id="shop", capture_spans=False)
    assert server.got.wait(5)
    body = server.requests[0][2]
    assert body["framework"] == "flask"
    assert body["framework_version"]
    assert body["routes"] == [
        {"method": "DELETE", "path": "/product/{id}"},
        {"method": "GET", "path": "/product/{id}"},
    ]


def test_django_urlconf_routes():
    django = pytest.importorskip("django")
    from django.conf import settings

    if not settings.configured:
        settings.configure(DEBUG=False, ALLOWED_HOSTS=["*"], ROOT_URLCONF=__name__)
        django.setup()
    from django.http import HttpResponse
    from django.urls import include, path, re_path
    from django.views import View

    from apilens.client._routes import list_django_routes

    class ItemView(View):
        def get(self, request, pk):  # pragma: no cover
            return HttpResponse()

        def put(self, request, pk):  # pragma: no cover
            return HttpResponse()

    def orders(request):  # pragma: no cover
        return HttpResponse()

    inner = types.ModuleType("apilens_test_meta_inner_urls")
    inner.urlpatterns = [path("items/<int:pk>/", ItemView.as_view())]
    sys.modules[inner.__name__] = inner
    conf = types.ModuleType("apilens_test_meta_urls")
    conf.urlpatterns = [
        path("orders/", orders),
        path("api/", include(inner.__name__)),
        re_path(r"^legacy/(?P<slug>[\w-]+)/$", orders),
    ]
    sys.modules[conf.__name__] = conf
    try:
        routes = list_django_routes(conf.__name__)
    finally:
        sys.modules.pop(conf.__name__, None)
        sys.modules.pop(inner.__name__, None)
    assert routes == [
        {"method": ANY_METHOD, "path": "/orders/"},
        {"method": "GET", "path": "/api/items/{pk}/"},
        {"method": "PUT", "path": "/api/items/{pk}/"},
        {"method": ANY_METHOD, "path": "/legacy/{slug}/"},
    ]


urlpatterns: list = []
