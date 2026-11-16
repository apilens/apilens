"""Errors are never sampled and do not depend on span capture (issue #904, M5 D1/D2).

A request whose handler raised, or that answered 5xx, is kept with its spans
and exception log whatever ``sample_rate``, ``sample_on_request`` or
``sample_on_response`` decided; ``capture_spans=False`` drops the spans but
never the exception log. A remote ``enabled=false`` policy still sends nothing.
"""

from __future__ import annotations

import asyncio
import io
from types import SimpleNamespace

import pytest

from apilens.client._policy import ALLOW_ALL, Policy
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware
from apilens.client.spans import record_span
from apilens.client.trace import current_span_id, current_trace_id

DETAIL_KEYS = ("request_headers", "response_headers", "request_payload", "response_payload")


class FakeClient:
    def __init__(self, policy: Policy = ALLOW_ALL) -> None:
        self.config = SimpleNamespace(project_slug="", environment="test")
        self.current = policy
        self.records: list[dict] = []
        self.spans: list = []
        self.logs: list = []

    def policy(self, app_id: str = "") -> Policy:
        return self.current

    def capture(self, **kwargs) -> None:
        self.records.append(kwargs)

    def capture_span(self, record) -> None:
        self.spans.append(record)

    def capture_log(self, record) -> None:
        self.logs.append(record)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in ("APILENS_CAPTURE_SPANS", "APILENS_EXCLUDE_PATHS", "APILENS_EXCLUDE_USER_AGENTS", "APILENS_SAMPLE_RATE"):
        monkeypatch.delenv(name, raising=False)


def _child_span() -> None:
    """An outbound child span recorded while the request runs."""
    record_span(
        name="GET https://downstream.example.com/x",
        kind="http",
        trace_id=current_trace_id(),
        span_id="c" * 16,
        parent_span_id=current_span_id(),
        duration_ms=1.0,
    )


# ── ASGI ────────────────────────────────────────────────────────────────────


def _asgi_app(status: int = 200, *, raise_exc: bool = False):
    async def app(scope, receive, send):
        await receive()
        _child_span()
        if raise_exc:
            raise RuntimeError("boom")
        await send(
            {"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json")]}
        )
        await send({"type": "http.response.body", "body": b'{"error":"down"}'})

    return app


def _run_asgi(mw) -> None:
    async def receive():
        return {"type": "http.request", "body": b'{"name":"x"}', "more_body": False}

    async def send(message):
        return None

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/orders",
        "query_string": b"",
        "headers": [(b"host", b"example.com"), (b"content-type", b"application/json"), (b"x-req", b"1")],
        "scheme": "http",
        "client": ("10.0.0.1", 1234),
    }
    asyncio.run(mw(scope, receive, send))


def _asgi(app, client, **kwargs) -> ApiLensASGIMiddleware:
    return ApiLensASGIMiddleware(app, client, app_id="orders-api", **kwargs)


def test_asgi_sample_rate_zero_exception_is_kept_with_log_and_spans():
    client = FakeClient()
    with pytest.raises(RuntimeError):
        _run_asgi(_asgi(_asgi_app(raise_exc=True), client, sample_rate=0.0))
    (rec,) = client.records
    assert rec["sampled"] is True and rec["status_code"] == 500
    assert rec["request_headers"]  # headers kept per posture
    (log,) = client.logs
    assert log.logger_name == "apilens.exception"
    assert log.message == "RuntimeError: boom" and "Traceback" in log.payload
    assert log.trace_id == rec["trace_id"] and log.span_id == rec["span_id"]
    # The held child span and the root span are both sent.
    assert {s.kind for s in client.spans} == {"server", "http"}
    assert all(s.trace_id == rec["trace_id"] for s in client.spans)


def test_asgi_sample_rate_zero_5xx_keeps_headers_and_response_body():
    client = FakeClient()
    _run_asgi(_asgi(_asgi_app(503), client, sample_rate=0.0))
    (rec,) = client.records
    assert rec["sampled"] is True
    assert rec["request_headers"] and rec["response_headers"]
    assert "down" in rec["response_payload"]
    # The request body was never buffered for a sampled-out request.
    assert rec["request_payload"] == ""
    (log,) = client.logs
    assert log.logger_name == "apilens.http" and log.status_code == 503


def test_asgi_sampled_out_healthy_request_still_drops_child_spans():
    client = FakeClient()
    _run_asgi(_asgi(_asgi_app(200), client, sample_rate=0.0))
    (rec,) = client.records
    assert rec["sampled"] is False and all(rec[k] == "" for k in DETAIL_KEYS)
    assert client.spans == [] and client.logs == []


def test_asgi_sample_on_request_false_is_overridden_for_errors():
    client = FakeClient()
    _run_asgi(_asgi(_asgi_app(500), client, sample_on_request=lambda info: False))
    (rec,) = client.records
    assert rec["sampled"] is True
    assert len(client.logs) == 1 and {s.kind for s in client.spans} == {"server", "http"}


def test_asgi_capture_spans_off_still_sends_exception_log():
    client = FakeClient()
    with pytest.raises(RuntimeError):
        _run_asgi(_asgi(_asgi_app(raise_exc=True), client, capture_spans=False))
    (rec,) = client.records
    (log,) = client.logs
    assert client.spans == []
    assert log.logger_name == "apilens.exception" and "RuntimeError: boom" in log.message
    assert log.trace_id == rec["trace_id"] and log.span_id == ""
    assert log.app_id == "orders-api" and log.environment == "test"


def test_asgi_env_kill_switch_still_sends_exception_log(monkeypatch):
    monkeypatch.setenv("APILENS_CAPTURE_SPANS", "false")
    client = FakeClient()
    _run_asgi(_asgi(_asgi_app(502), client, sample_rate=0.0))
    assert client.spans == []
    (log,) = client.logs
    assert log.status_code == 502 and log.span_id == ""


@pytest.mark.parametrize("verdict", [False, 0.0, 0])
def test_asgi_sample_on_response_drop_is_overridden_for_errors(verdict):
    client = FakeClient()
    seen: list = []

    def drop(info):
        seen.append(info)
        return verdict

    with pytest.raises(RuntimeError):
        _run_asgi(_asgi(_asgi_app(raise_exc=True), client, sample_on_response=drop))
    _run_asgi(_asgi(_asgi_app(500), client, sample_on_response=drop))
    _run_asgi(_asgi(_asgi_app(200), client, sample_on_response=drop))
    failed, failed_5xx, ok = client.records
    assert failed["sampled"] is True and failed["request_payload"] and failed["request_headers"]
    assert failed_5xx["sampled"] is True and failed_5xx["response_payload"]
    assert ok["sampled"] is False and all(ok[k] == "" for k in DETAIL_KEYS)
    assert len(client.logs) == 2
    # Root + child span for each failed request only.
    assert sorted(s.kind for s in client.spans) == ["http", "http", "server", "server"]


def test_asgi_remote_disable_still_sends_nothing_for_errors():
    client = FakeClient(Policy(enabled=False))
    with pytest.raises(RuntimeError):
        _run_asgi(_asgi(_asgi_app(raise_exc=True), client, sample_rate=0.0))
    _run_asgi(_asgi(_asgi_app(500), client))
    assert client.records == [] and client.spans == [] and client.logs == []


# ── WSGI ────────────────────────────────────────────────────────────────────


def _wsgi_app(status: str = "200 OK", *, raise_exc: bool = False):
    def app(environ, start_response):
        environ["wsgi.input"].read()
        _child_span()
        if raise_exc:
            raise RuntimeError("boom")
        start_response(status, [("Content-Type", "application/json")])
        return [b'{"error":"down"}']

    return app


def _run_wsgi(mw) -> bytes:
    environ = {
        "REQUEST_METHOD": "POST",
        "PATH_INFO": "/orders",
        "QUERY_STRING": "",
        "HTTP_HOST": "example.com",
        "HTTP_X_REQ": "1",
        "CONTENT_TYPE": "application/json",
        "CONTENT_LENGTH": "12",
        "wsgi.url_scheme": "http",
        "wsgi.input": io.BytesIO(b'{"name":"x"}'),
    }
    return b"".join(mw(environ, lambda status, headers, exc_info=None: None))


def _wsgi(app, client, **kwargs) -> ApiLensWSGIMiddleware:
    return ApiLensWSGIMiddleware(app, client, app_id="orders-api", **kwargs)


def test_wsgi_sample_rate_zero_exception_is_kept_with_log_and_spans():
    client = FakeClient()
    with pytest.raises(RuntimeError):
        _run_wsgi(_wsgi(_wsgi_app(raise_exc=True), client, sample_rate=0.0))
    (rec,) = client.records
    assert rec["sampled"] is True and rec["request_headers"]
    (log,) = client.logs
    assert log.logger_name == "apilens.exception" and log.span_id == rec["span_id"]
    assert {s.kind for s in client.spans} == {"server", "http"}


def test_wsgi_sample_rate_zero_5xx_keeps_response_body():
    client = FakeClient()
    _run_wsgi(_wsgi(_wsgi_app("500 Internal Server Error"), client, sample_rate=0.0))
    (rec,) = client.records
    assert rec["sampled"] is True and rec["response_headers"] and "down" in rec["response_payload"]
    assert len(client.logs) == 1


def test_wsgi_capture_spans_off_still_sends_exception_log():
    client = FakeClient()
    with pytest.raises(RuntimeError):
        _run_wsgi(_wsgi(_wsgi_app(raise_exc=True), client, capture_spans=False, sample_rate=0.0))
    (rec,) = client.records
    (log,) = client.logs
    assert client.spans == []
    assert log.logger_name == "apilens.exception" and log.trace_id == rec["trace_id"] and log.span_id == ""


def test_wsgi_sample_on_response_drop_is_overridden_for_errors():
    client = FakeClient()
    _run_wsgi(_wsgi(_wsgi_app("503 Service Unavailable"), client, sample_on_response=lambda info: False))
    _run_wsgi(_wsgi(_wsgi_app(), client, sample_on_response=lambda info: False))
    failed, ok = client.records
    assert failed["sampled"] is True and failed["request_payload"] and failed["response_payload"]
    assert ok["sampled"] is False
    assert len(client.logs) == 1


def test_wsgi_remote_disable_still_sends_nothing_for_errors():
    client = FakeClient(Policy(enabled=False))
    with pytest.raises(RuntimeError):
        _run_wsgi(_wsgi(_wsgi_app(raise_exc=True), client, sample_rate=0.0))
    assert client.records == [] and client.spans == [] and client.logs == []


# ── Django ──────────────────────────────────────────────────────────────────


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


def _django_mw(status: int = 500, *, raise_exc: bool = False):
    """A middleware whose view behaves like Django's handler: a raised
    exception goes through ``process_exception`` and becomes a 500."""
    from django.http import HttpResponse

    from apilens.django import ApiLensDjangoMiddleware

    def view(request):
        request.body  # noqa: B018 - the view reads its body
        _child_span()
        if raise_exc:
            try:
                raise RuntimeError("boom")
            except RuntimeError as exc:
                mw.process_exception(request, exc)
            return HttpResponse('{"error":"down"}', status=500, content_type="application/json")
        return HttpResponse('{"error":"down"}', status=status, content_type="application/json")

    mw = ApiLensDjangoMiddleware(view)
    return mw


def _django_request():
    from django.test import RequestFactory

    return RequestFactory().post("/orders", data=b'{"name":"x"}', content_type="application/json")


def test_django_sample_rate_zero_exception_is_kept_with_log_and_spans(django_settings, monkeypatch):
    settings, client = django_settings
    monkeypatch.setattr(settings, "APILENS_SAMPLE_RATE", 0.0, raising=False)
    _django_mw(raise_exc=True)(_django_request())
    (rec,) = client.records
    assert rec["sampled"] is True and all(rec[k] for k in DETAIL_KEYS)
    (log,) = client.logs
    assert log.logger_name == "apilens.exception" and log.span_id == rec["span_id"]
    assert {s.kind for s in client.spans} == {"server", "http"}


def test_django_capture_spans_off_still_sends_exception_log(django_settings, monkeypatch):
    settings, client = django_settings
    monkeypatch.setattr(settings, "APILENS_CAPTURE_SPANS", False, raising=False)
    _django_mw(raise_exc=True)(_django_request())
    (rec,) = client.records
    (log,) = client.logs
    assert client.spans == []
    assert log.logger_name == "apilens.exception" and log.trace_id == rec["trace_id"] and log.span_id == ""


def test_django_sample_on_response_drop_is_overridden_for_errors(django_settings, monkeypatch):
    settings, client = django_settings
    monkeypatch.setattr(settings, "APILENS_SAMPLE_ON_RESPONSE", lambda info: False, raising=False)
    _django_mw(503)(_django_request())
    _django_mw(200)(_django_request())
    failed, ok = client.records
    assert failed["sampled"] is True and all(failed[k] for k in DETAIL_KEYS)
    assert ok["sampled"] is False
    assert len(client.logs) == 1


def test_django_remote_disable_still_sends_nothing_for_errors(django_settings, monkeypatch):
    settings, client = django_settings
    client.current = Policy(enabled=False)
    monkeypatch.setattr(settings, "APILENS_SAMPLE_RATE", 0.0, raising=False)
    _django_mw(raise_exc=True)(_django_request())
    assert client.records == [] and client.spans == [] and client.logs == []
