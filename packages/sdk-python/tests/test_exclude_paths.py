"""``exclude_paths``: matched requests bypass capture entirely."""

from __future__ import annotations

import asyncio
import io
import re
from types import SimpleNamespace

import pytest

from apilens.client._exclude import ENV_EXCLUDE_PATHS, PathExcluder, split_patterns
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware


class FakeClient:
    """Stands in for ApiLensClient: records what the middleware hands it."""

    def __init__(self) -> None:
        self.config = SimpleNamespace(project_slug="", environment="test")
        self.records: list[dict] = []
        self.spans: list = []
        self.logs: list = []

    def capture(self, **kwargs) -> None:
        self.records.append(kwargs)

    def capture_span(self, record) -> None:
        self.spans.append(record)

    def capture_log(self, record) -> None:
        self.logs.append(record)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv(ENV_EXCLUDE_PATHS, raising=False)
    monkeypatch.delenv("APILENS_CAPTURE_SPANS", raising=False)


# ── matching semantics ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "path, excluded",
    [
        ("/health", True),
        ("/HEALTH", True),  # case-insensitive
        ("/health?verbose=1", True),  # query string ignored
        ("/healthz", False),  # $ anchor
        ("/api/health", False),  # ^ anchor
        ("/metrics", True),
        ("/internal/metrics/cpu", True),  # unanchored pattern searches
        ("/orders", False),
    ],
)
def test_matches(path, excluded):
    excluder = PathExcluder([r"^/health$", r"metrics"])
    assert excluder.matches(path) is excluded


def test_query_string_is_not_matched():
    assert not PathExcluder([r"verbose"]).matches("/orders?verbose=1")


def test_empty_excluder_matches_nothing():
    excluder = PathExcluder(None)
    assert not excluder
    assert not excluder.matches("/health")


def test_invalid_regex_raises_at_construction():
    with pytest.raises(re.error):
        PathExcluder([r"^/health("])


def test_split_patterns_accepts_comma_string_and_list():
    assert split_patterns(" ^/health$ , ,^/ready$ ") == ["^/health$", "^/ready$"]
    assert split_patterns([r"^/a$", "", r"^/b$"]) == ["^/a$", "^/b$"]
    assert split_patterns(None) == []


def test_env_var_adds_patterns(monkeypatch):
    monkeypatch.setenv(ENV_EXCLUDE_PATHS, r"^/ready$,^/live$")
    excluder = PathExcluder([r"^/health$"])
    assert excluder.matches("/health")
    assert excluder.matches("/ready")
    assert excluder.matches("/LIVE")
    assert not excluder.matches("/orders")


def test_invalid_env_regex_raises_at_construction(monkeypatch):
    monkeypatch.setenv(ENV_EXCLUDE_PATHS, "[unclosed")
    with pytest.raises(re.error):
        PathExcluder(None)


# ── ASGI ────────────────────────────────────────────────────────────────────


def _asgi_app(seen: dict):
    async def app(scope, receive, send):
        seen["receive"] = receive
        seen["send"] = send
        await receive()
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]})
        await send({"type": "http.response.body", "body": b"ok"})

    return app


def _run_asgi(mw, path: str, query: bytes = b"") -> tuple:
    async def receive():
        return {"type": "http.request", "body": b'{"x":1}', "more_body": False}

    sent: list[dict] = []

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "method": "GET",
        "path": path,
        "query_string": query,
        "headers": [(b"host", b"example.com")],
        "scheme": "http",
        "client": ("127.0.0.1", 1234),
    }
    asyncio.run(mw(scope, receive, send))
    return receive, send, sent


def _asgi_mw(client, seen, **kwargs):
    return ApiLensASGIMiddleware(_asgi_app(seen), client, app_id="orders-api", **kwargs)


def test_asgi_excluded_path_bypasses_capture():
    client, seen = FakeClient(), {}
    mw = _asgi_mw(client, seen, exclude_paths=[r"^/health$"])
    receive, send, sent = _run_asgi(mw, "/Health", b"probe=1")
    assert [m["type"] for m in sent] == ["http.response.start", "http.response.body"]
    assert client.records == [] and client.spans == [] and client.logs == []
    # The app got the server's own callables: nothing wrapped, nothing buffered.
    assert seen["receive"] is receive
    assert seen["send"] is send


def test_asgi_excluded_5xx_records_no_error_log():
    client = FakeClient()

    async def failing(scope, receive, send):
        await send({"type": "http.response.start", "status": 503, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    mw = ApiLensASGIMiddleware(failing, client, app_id="orders-api", exclude_paths=[r"^/ready$"])
    _run_asgi(mw, "/ready")
    assert client.records == [] and client.spans == [] and client.logs == []


def test_asgi_non_matching_path_is_captured():
    client, seen = FakeClient(), {}
    # Built-in defaults would exclude /healthz; isolate the user pattern.
    mw = _asgi_mw(client, seen, exclude_paths=[r"^/health$"], default_exclusions=False)
    _run_asgi(mw, "/healthz")
    assert len(client.records) == 1
    assert client.records[0]["raw_path"] == "/healthz"
    assert len(client.spans) == 1


def test_asgi_invalid_regex_raises_at_construction():
    with pytest.raises(re.error):
        _asgi_mw(FakeClient(), {}, exclude_paths=["(unclosed"])


# ── WSGI ────────────────────────────────────────────────────────────────────


def _wsgi_app(seen: dict):
    def app(environ, start_response):
        seen["input"] = environ["wsgi.input"]
        seen["start_response"] = start_response
        start_response("200 OK", [("Content-Type", "text/plain")])
        return [b"ok"]

    return app


def _run_wsgi(mw, path: str, query: str = ""):
    stream = io.BytesIO(b'{"x":1}')
    environ = {
        "REQUEST_METHOD": "POST",
        "PATH_INFO": path,
        "QUERY_STRING": query,
        "CONTENT_TYPE": "application/json",
        "CONTENT_LENGTH": "7",
        "HTTP_HOST": "example.com",
        "wsgi.url_scheme": "http",
        "wsgi.input": stream,
    }
    statuses: list[str] = []

    def start_response(status, headers, exc_info=None):
        statuses.append(status)

    body = b"".join(mw(environ, start_response))
    return stream, start_response, statuses, body


def test_wsgi_excluded_path_bypasses_capture():
    client, seen = FakeClient(), {}
    mw = ApiLensWSGIMiddleware(_wsgi_app(seen), client, app_id="orders-api", exclude_paths=[r"^/health$"])
    stream, start_response, statuses, body = _run_wsgi(mw, "/HEALTH", "probe=1")
    assert statuses == ["200 OK"] and body == b"ok"
    assert client.records == [] and client.spans == [] and client.logs == []
    # The request body stream was not read/replaced and start_response not wrapped.
    assert seen["input"] is stream
    assert stream.tell() == 0
    assert seen["start_response"] is start_response


def test_wsgi_non_matching_path_is_captured():
    client, seen = FakeClient(), {}
    mw = ApiLensWSGIMiddleware(
        _wsgi_app(seen), client, app_id="orders-api", exclude_paths=[r"^/health$"], default_exclusions=False
    )
    _, _, statuses, body = _run_wsgi(mw, "/api/health")
    assert statuses == ["200 OK"] and body == b"ok"
    assert len(client.records) == 1
    assert client.records[0]["raw_path"] == "/api/health"
    assert client.records[0]["request_payload"] == '{"x":1}'
    assert len(client.spans) == 1


def test_wsgi_env_var_excludes(monkeypatch):
    monkeypatch.setenv(ENV_EXCLUDE_PATHS, r"^/ready$, ^/live$")
    client = FakeClient()
    mw = ApiLensWSGIMiddleware(_wsgi_app({}), client, app_id="orders-api")
    _run_wsgi(mw, "/live")
    assert client.records == []


def test_wsgi_invalid_regex_raises_at_construction():
    with pytest.raises(re.error):
        ApiLensWSGIMiddleware(_wsgi_app({}), FakeClient(), app_id="orders-api", exclude_paths=["*bad"])


# ── Django setting ──────────────────────────────────────────────────────────


@pytest.fixture
def django_settings(monkeypatch):
    django = pytest.importorskip("django")
    from django.conf import settings

    if not settings.configured:
        settings.configure(
            DEBUG=False,
            ALLOWED_HOSTS=["*"],
            ROOT_URLCONF=__name__,
            APILENS_API_KEY="apilens_test",
            APILENS_APP_ID="orders-api",
        )
        django.setup()

    import apilens.django as apilens_django

    client = FakeClient()
    monkeypatch.setattr(apilens_django, "_client_singleton", client)
    return settings, client


urlpatterns: list = []


@pytest.mark.parametrize("setting", [[r"^/health$", r"^/ready$"], r"^/health$,^/ready$"])
def test_django_setting_excludes(django_settings, monkeypatch, setting):
    settings, client = django_settings
    monkeypatch.setattr(settings, "APILENS_EXCLUDE_PATHS", setting, raising=False)
    from django.http import HttpResponse
    from django.test import RequestFactory

    from apilens.django import ApiLensDjangoMiddleware

    mw = ApiLensDjangoMiddleware(lambda request: HttpResponse("ok"))
    factory = RequestFactory()

    assert mw(factory.get("/Ready", {"probe": "1"})).status_code == 200
    assert client.records == [] and client.spans == []

    mw(factory.get("/orders"))
    assert len(client.records) == 1
    assert client.records[0]["raw_path"] == "/orders"


def test_django_invalid_regex_raises_at_construction(django_settings, monkeypatch):
    settings, _ = django_settings
    monkeypatch.setattr(settings, "APILENS_EXCLUDE_PATHS", ["(bad"], raising=False)
    from django.http import HttpResponse

    from apilens.django import ApiLensDjangoMiddleware

    with pytest.raises(re.error):
        ApiLensDjangoMiddleware(lambda request: HttpResponse("ok"))
