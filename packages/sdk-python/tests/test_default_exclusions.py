"""Built-in default exclusions (health/probe paths and user agents) with opt-out."""

from __future__ import annotations

import asyncio
import io
import re
from types import SimpleNamespace

import pytest

from apilens.client._exclude import ENV_EXCLUDE_PATHS
from apilens.client._exclusions import (
    DEFAULT_EXCLUDED_PATHS,
    DEFAULT_EXCLUDED_USER_AGENTS,
    ENV_EXCLUDE_USER_AGENTS,
    RequestExcluder,
)
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware


class FakeClient:
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
    monkeypatch.delenv(ENV_EXCLUDE_USER_AGENTS, raising=False)
    monkeypatch.delenv("APILENS_CAPTURE_SPANS", raising=False)


# Every default path pattern, with at least one path it must exclude.
DEFAULT_PATH_CASES = {
    r"/_?healthz?$": ["/health", "/healthz", "/_health", "/_healthz", "/api/HEALTH"],
    r"/_?health[\-_]?checks?$": ["/health_checks", "/health-check", "/healthcheck", "/_HealthChecks"],
    r"/_?heart[\-_]?beats?$": ["/heartbeat", "/heart-beat", "/heart_beats", "/_HEARTBEAT"],
    r"/ping$": ["/ping", "/v1/PING"],
    r"/ready$": ["/ready", "/Ready"],
    r"/live$": ["/live", "/LIVE"],
    r"/favicon(?:-[\w-]+)?\.(?:ico|png|svg)$": ["/favicon.ico", "/favicon-32x32.png", "/FAVICON.SVG"],
    r"/apple-touch-icon(?:-[\w-]+)?\.png$": ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"],
    r"/robots\.txt$": ["/robots.txt", "/ROBOTS.TXT"],
    r"/sitemap\.xml$": ["/sitemap.xml"],
    r"/manifest\.json$": ["/manifest.json"],
    r"/site\.webmanifest$": ["/site.webmanifest"],
    r"/service-worker\.js$": ["/service-worker.js"],
    r"/sw\.js$": ["/sw.js"],
    r"/\.well-known/": ["/.well-known/openid-configuration", "/.WELL-KNOWN/acme-challenge/x"],
}

DEFAULT_UA_CASES = {
    r"health[\-_ ]?check": ["ELB-HealthChecker/2.0", "Health Check", "health-check/1.0", "HEALTH_CHECK"],
    r"microsoft-azure-application-lb": ["Microsoft-Azure-Application-LB/AGI"],
    r"googlehc": ["GoogleHC/1.0"],
    r"kube-probe": ["kube-probe/1.29", "Kube-Probe/1.30"],
}


def test_default_lists_are_the_documented_set():
    assert list(DEFAULT_PATH_CASES) == list(DEFAULT_EXCLUDED_PATHS)
    assert list(DEFAULT_UA_CASES) == list(DEFAULT_EXCLUDED_USER_AGENTS)


@pytest.mark.parametrize(
    "pattern, path",
    [(pattern, path) for pattern, paths in DEFAULT_PATH_CASES.items() for path in paths],
)
def test_every_default_path_pattern_excludes(pattern, path):
    assert re.search(pattern, path, re.IGNORECASE)
    assert RequestExcluder(include_env=False).matches(path)
    assert RequestExcluder(include_env=False).matches(f"{path}?probe=1")


@pytest.mark.parametrize(
    "pattern, user_agent",
    [(pattern, ua) for pattern, uas in DEFAULT_UA_CASES.items() for ua in uas],
)
def test_every_default_user_agent_pattern_excludes(pattern, user_agent):
    assert re.search(pattern, user_agent, re.IGNORECASE)
    assert RequestExcluder(include_env=False).matches("/orders", user_agent)


@pytest.mark.parametrize(
    "path",
    ["/orders", "/healthy", "/health/db", "/pinger", "/readiness", "/lively", "/favicon.gif", "/robots.txt.bak"],
)
def test_defaults_do_not_exclude_real_traffic(path):
    assert not RequestExcluder(include_env=False).matches(path, "Mozilla/5.0")


def test_query_string_is_not_matched_by_defaults():
    assert not RequestExcluder(include_env=False).matches("/orders?next=/health")


@pytest.mark.parametrize("path", ["/health", "/healthz", "/ready", "/favicon.ico", "/.well-known/x"])
def test_opt_out_disables_default_paths(path):
    excluder = RequestExcluder(default_exclusions=False, include_env=False)
    assert not excluder
    assert not excluder.checks_user_agent
    assert not excluder.matches(path, "kube-probe/1.29")


def test_opt_out_keeps_user_patterns():
    excluder = RequestExcluder([r"^/internal/"], [r"^my-monitor/"], default_exclusions=False, include_env=False)
    assert excluder.matches("/internal/stats")
    assert excluder.matches("/orders", "My-Monitor/2.1")
    assert not excluder.matches("/health", "kube-probe/1.29")


def test_custom_user_agents_add_to_defaults():
    excluder = RequestExcluder(exclude_user_agents=[r"^uptimerobot"], include_env=False)
    assert excluder.matches("/orders", "UptimeRobot/2.0")
    assert excluder.matches("/orders", "kube-probe/1.29")
    assert not excluder.matches("/orders", "curl/8.0")
    assert not excluder.matches("/orders", None)


def test_user_agent_env_var_adds_patterns(monkeypatch):
    monkeypatch.setenv(ENV_EXCLUDE_USER_AGENTS, r"^pingdom, ^statuscake")
    excluder = RequestExcluder(default_exclusions=False)
    assert excluder.matches("/orders", "Pingdom.com_bot")
    assert excluder.matches("/orders", "StatusCake")
    assert not excluder.matches("/orders", "curl/8.0")


def test_invalid_user_agent_regex_raises_at_construction():
    with pytest.raises(re.error):
        RequestExcluder(exclude_user_agents=["(bad"])


# ── ASGI ────────────────────────────────────────────────────────────────────


async def _ok_app(scope, receive, send):
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})


def _run_asgi(mw, path: str, user_agent: bytes | None = None) -> list[dict]:
    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    sent: list[dict] = []

    async def send(message):
        sent.append(message)

    headers = [(b"host", b"example.com")]
    if user_agent is not None:
        headers.append((b"User-Agent", user_agent))
    scope = {
        "type": "http",
        "method": "GET",
        "path": path,
        "query_string": b"",
        "headers": headers,
        "scheme": "http",
        "client": ("127.0.0.1", 1234),
    }
    asyncio.run(mw(scope, receive, send))
    return sent


def test_asgi_defaults_exclude_paths_and_probe_user_agents():
    client = FakeClient()
    mw = ApiLensASGIMiddleware(_ok_app, client, app_id="orders-api")
    assert [m["type"] for m in _run_asgi(mw, "/healthz")] == ["http.response.start", "http.response.body"]
    _run_asgi(mw, "/orders", b"kube-probe/1.29")
    assert client.records == [] and client.spans == [] and client.logs == []
    _run_asgi(mw, "/orders", b"Mozilla/5.0")
    assert len(client.records) == 1


def test_asgi_opt_out_captures_health_and_probes():
    client = FakeClient()
    mw = ApiLensASGIMiddleware(_ok_app, client, app_id="orders-api", default_exclusions=False)
    _run_asgi(mw, "/healthz")
    _run_asgi(mw, "/orders", b"kube-probe/1.29")
    assert [r["raw_path"] for r in client.records] == ["/healthz", "/orders"]


def test_asgi_custom_user_agent_excluded():
    client = FakeClient()
    mw = ApiLensASGIMiddleware(_ok_app, client, app_id="orders-api", exclude_user_agents=[r"uptimerobot"])
    _run_asgi(mw, "/orders", b"Mozilla/5.0 (compatible; UptimeRobot/2.0)")
    assert client.records == []


# ── WSGI ────────────────────────────────────────────────────────────────────


def _wsgi_app(environ, start_response):
    start_response("200 OK", [("Content-Type", "text/plain")])
    return [b"ok"]


def _run_wsgi(mw, path: str, user_agent: str | None = None) -> bytes:
    environ = {
        "REQUEST_METHOD": "GET",
        "PATH_INFO": path,
        "QUERY_STRING": "",
        "HTTP_HOST": "example.com",
        "wsgi.url_scheme": "http",
        "wsgi.input": io.BytesIO(b""),
    }
    if user_agent is not None:
        environ["HTTP_USER_AGENT"] = user_agent
    return b"".join(mw(environ, lambda status, headers, exc_info=None: None))


def test_wsgi_defaults_exclude_paths_and_probe_user_agents():
    client = FakeClient()
    mw = ApiLensWSGIMiddleware(_wsgi_app, client, app_id="orders-api")
    assert _run_wsgi(mw, "/robots.txt") == b"ok"
    _run_wsgi(mw, "/orders", "GoogleHC/1.0")
    assert client.records == [] and client.spans == []
    _run_wsgi(mw, "/orders", "curl/8.0")
    assert len(client.records) == 1


def test_wsgi_opt_out_captures_health_and_probes():
    client = FakeClient()
    mw = ApiLensWSGIMiddleware(_wsgi_app, client, app_id="orders-api", default_exclusions=False)
    _run_wsgi(mw, "/ping")
    _run_wsgi(mw, "/orders", "ELB-HealthChecker/2.0")
    assert [r["raw_path"] for r in client.records] == ["/ping", "/orders"]


# ── Django settings ─────────────────────────────────────────────────────────


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


def test_django_defaults_and_custom_user_agents(django_settings, monkeypatch):
    settings, client = django_settings
    monkeypatch.setattr(settings, "APILENS_EXCLUDE_USER_AGENTS", [r"^pingdom"], raising=False)
    from django.http import HttpResponse
    from django.test import RequestFactory

    from apilens.django import ApiLensDjangoMiddleware

    mw = ApiLensDjangoMiddleware(lambda request: HttpResponse("ok"))
    factory = RequestFactory()
    mw(factory.get("/healthz"))
    mw(factory.get("/orders", HTTP_USER_AGENT="kube-probe/1.29"))
    mw(factory.get("/orders", HTTP_USER_AGENT="Pingdom.com_bot"))
    assert client.records == []
    mw(factory.get("/orders", HTTP_USER_AGENT="curl/8.0"))
    assert len(client.records) == 1


def test_django_opt_out_setting(django_settings, monkeypatch):
    settings, client = django_settings
    monkeypatch.setattr(settings, "APILENS_DEFAULT_EXCLUSIONS", False, raising=False)
    from django.http import HttpResponse
    from django.test import RequestFactory

    from apilens.django import ApiLensDjangoMiddleware

    mw = ApiLensDjangoMiddleware(lambda request: HttpResponse("ok"))
    mw(RequestFactory().get("/healthz", HTTP_USER_AGENT="kube-probe/1.29"))
    assert [r["raw_path"] for r in client.records] == ["/healthz"]
