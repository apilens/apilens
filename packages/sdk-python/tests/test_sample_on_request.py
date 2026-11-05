"""``sample_on_request`` callback evaluated before the handler (issue #514)."""

from __future__ import annotations

import asyncio
import importlib
import inspect
import io
import logging
import random
from types import SimpleNamespace

import pytest

from apilens import RequestInfo
from apilens.client._sampling import RequestSampler
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware
from apilens.client.trace import detail_sampled

DETAIL_KEYS = ("request_headers", "response_headers", "request_payload", "response_payload")


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
    for name in ("APILENS_CAPTURE_SPANS", "APILENS_EXCLUDE_PATHS", "APILENS_EXCLUDE_USER_AGENTS", "APILENS_SAMPLE_RATE"):
        monkeypatch.delenv(name, raising=False)


class _ExplodingRandom(random.Random):
    def random(self):  # pragma: no cover - must never be called
        raise AssertionError("PRNG must not be consulted")


def _info() -> RequestInfo:
    return RequestInfo(method="GET", path="/orders")


# ── Sampler: each return type ───────────────────────────────────────────────


@pytest.mark.parametrize("rate", [0.0, 0.5, 1.0])
def test_bool_is_final_regardless_of_rate(rate):
    rng = _ExplodingRandom()
    assert RequestSampler(rate, lambda info: True, rng=rng).decide(_info) is True
    assert RequestSampler(rate, lambda info: False, rng=rng).decide(_info) is False


def test_none_falls_back_to_sample_rate():
    rng = _ExplodingRandom()
    assert RequestSampler(1.0, lambda info: None, rng=rng).decide(_info) is True
    assert RequestSampler(0.0, lambda info: None, rng=rng).decide(_info) is False
    n, rate = 10_000, 0.25
    sampler = RequestSampler(rate, lambda info: None, rng=random.Random(514))
    hits = sum(sampler.decide(_info) for _ in range(n))
    assert abs(hits - n * rate) <= 5 * (n * rate * (1 - rate)) ** 0.5


@pytest.mark.parametrize("probability", [0.1, 0.5, 0.9])
def test_float_is_a_keep_probability(probability):
    n = 10_000
    # sample_rate is ignored once the callback returns a number.
    sampler = RequestSampler(0.0, lambda info: probability, rng=random.Random(514))
    hits = sum(sampler.decide(_info) for _ in range(n))
    assert abs(hits - n * probability) <= 5 * (n * probability * (1 - probability)) ** 0.5


@pytest.mark.parametrize(("value", "expected"), [(0.0, False), (1.0, True), (0, False), (1, True), (-3.0, False), (7.5, True)])
def test_float_bounds_are_exact_and_clamped(value, expected):
    sampler = RequestSampler(0.5, lambda info: value, rng=_ExplodingRandom())
    assert sampler.decide(_info) is expected


def test_callback_receives_the_request_info():
    seen: list = []
    info = RequestInfo(method="POST", path="/a")
    RequestSampler(1.0, lambda i: seen.append(i)).decide(lambda: info)
    assert seen == [info]


def test_info_is_not_built_without_a_callback():
    def factory():  # pragma: no cover - must never be called
        raise AssertionError("RequestInfo built without a callback")

    assert RequestSampler(1.0).decide(factory) is True
    assert RequestSampler(0.0).decide(factory) is False


def test_non_callable_callback_is_rejected():
    with pytest.raises(TypeError):
        RequestSampler(1.0, "not-callable")  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        ApiLensASGIMiddleware(None, FakeClient(), sample_on_request=42)


# ── Sampler: exception path ─────────────────────────────────────────────────


def test_exception_is_treated_as_none_and_logged_once(caplog):
    def boom(info):
        raise RuntimeError("bad callback")

    caplog.set_level(logging.WARNING, logger="apilens")
    kept = RequestSampler(1.0, boom, rng=_ExplodingRandom())
    dropped = RequestSampler(0.0, boom, rng=_ExplodingRandom())
    assert all(kept.decide(_info) for _ in range(5))
    assert not any(dropped.decide(_info) for _ in range(5))
    warnings = [r for r in caplog.records if "sample_on_request raised" in r.getMessage()]
    # Once per sampler, with the traceback attached.
    assert len(warnings) == 2
    assert all(r.exc_info and r.exc_info[0] is RuntimeError for r in warnings)


@pytest.mark.parametrize("value", ["yes", float("nan"), [1], object()])
def test_unusable_return_value_is_treated_as_none_and_logged_once(value, caplog):
    caplog.set_level(logging.WARNING, logger="apilens")
    sampler = RequestSampler(1.0, lambda info: value, rng=_ExplodingRandom())
    assert sampler.decide(_info) is True
    assert sampler.decide(_info) is True
    assert len([r for r in caplog.records if "sample_on_request returned" in r.getMessage()]) == 1


# ── ASGI ────────────────────────────────────────────────────────────────────


def _asgi_scope() -> dict:
    return {
        "type": "http",
        "method": "post",
        "path": "/orders",
        "query_string": b"token=s3cret&q=1",
        "headers": [
            (b"host", b"example.com"),
            (b"User-Agent", b"curl/8.0"),
            (b"X-Forwarded-For", b"203.0.113.9, 10.0.0.2"),
            (b"content-type", b"application/json"),
            (b"content-length", b"12"),
        ],
        "scheme": "http",
        "client": ("10.0.0.1", 1234),
    }


def _run_asgi(mw, app_reads_body: bool = True) -> list[str]:
    """Run one request; return the order of events (callback, receive, handler)."""
    events: list[str] = []

    async def receive():
        events.append("receive")
        return {"type": "http.request", "body": b'{"name":"x"}', "more_body": False}

    async def send(message):
        return None

    async def app(scope, receive_, send_):
        events.append("handler")
        if app_reads_body:
            await receive_()
        await send_({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
        await send_({"type": "http.response.body", "body": b'{"ok":true}'})

    mw.app = app
    asyncio.run(mw(_asgi_scope(), receive, send))
    return events


def test_asgi_callback_gets_request_info_before_the_handler():
    client = FakeClient()
    calls: list = []
    events: list[str] = []

    def sample(info):
        calls.append(info)
        events.append("callback")
        return None

    mw = ApiLensASGIMiddleware(None, client, sample_on_request=sample)
    events += _run_asgi(mw)
    assert events[0] == "callback" and events[1:] == ["handler", "receive"]
    (info,) = calls
    assert isinstance(info, RequestInfo)
    assert info.method == "POST"
    assert info.path == "/orders"
    assert info.query == "token=s3cret&q=1"
    assert info.user_agent == "curl/8.0"
    assert info.client_ip == "203.0.113.9"
    assert info.headers["content-type"] == "application/json"
    assert info.attributes == {}
    with pytest.raises(TypeError):
        info.headers["x-new"] = "1"  # type: ignore[index]


def test_asgi_sampled_out_never_buffers_the_body():
    client = FakeClient()
    mw = ApiLensASGIMiddleware(None, client, sample_on_request=lambda info: False)
    # The middleware itself never calls receive; the handler gets the body.
    assert _run_asgi(mw, app_reads_body=False) == ["handler"]
    assert _run_asgi(mw, app_reads_body=True) == ["handler", "receive"]
    assert len(client.records) == 2
    for rec in client.records:
        assert rec["sampled"] is False
        assert all(rec[k] == "" for k in DETAIL_KEYS)
        assert rec["method"] == "POST" and rec["status_code"] == 200


def test_asgi_true_overrides_rate_zero():
    client = FakeClient()
    mw = ApiLensASGIMiddleware(None, client, sample_rate=0.0, sample_on_request=lambda info: info.method == "POST")
    _run_asgi(mw)
    (rec,) = client.records
    assert rec["sampled"] is True
    assert rec["request_payload"] and rec["response_payload"] and rec["request_headers"]


def test_asgi_callback_exception_never_reaches_the_handler(caplog):
    client = FakeClient()
    caplog.set_level(logging.WARNING, logger="apilens")

    def boom(info):
        raise ValueError("nope")

    mw = ApiLensASGIMiddleware(None, client, sample_on_request=boom)
    for _ in range(3):
        assert _run_asgi(mw) == ["handler", "receive"]
    assert len(client.records) == 3
    # Treated as None: sample_rate (default 1.0) applies, detail kept.
    assert all(r["sampled"] is True and r["request_payload"] for r in client.records)
    assert len([r for r in caplog.records if "sample_on_request raised" in r.getMessage()]) == 1
    assert detail_sampled() is True


# ── WSGI ────────────────────────────────────────────────────────────────────


class _TrackingStream(io.BytesIO):
    def __init__(self, data: bytes) -> None:
        super().__init__(data)
        self.reads = 0

    def read(self, *args):
        self.reads += 1
        return super().read(*args)


def _wsgi_environ(stream) -> dict:
    return {
        "REQUEST_METHOD": "PUT",
        "PATH_INFO": "/orders/7",
        "QUERY_STRING": "a=1",
        "HTTP_HOST": "example.com",
        "HTTP_USER_AGENT": "python-requests/2.32",
        "REMOTE_ADDR": "198.51.100.4",
        "CONTENT_TYPE": "application/json",
        "CONTENT_LENGTH": "12",
        "wsgi.url_scheme": "http",
        "wsgi.input": stream,
    }


def _wsgi_app(environ, start_response):
    start_response("200 OK", [("Content-Type", "application/json")])
    return [b'{"ok":true}']


def test_wsgi_sampled_out_never_reads_the_body():
    client = FakeClient()
    calls: list = []

    def sample(info):
        calls.append(info)
        return False

    stream = _TrackingStream(b'{"name":"x"}')
    environ = _wsgi_environ(stream)
    mw = ApiLensWSGIMiddleware(_wsgi_app, client, sample_on_request=sample)
    assert b"".join(mw(environ, lambda status, headers, exc_info=None: None)) == b'{"ok":true}'
    assert stream.reads == 0 and environ["wsgi.input"] is stream
    (rec,) = client.records
    assert rec["sampled"] is False
    assert all(rec[k] == "" for k in DETAIL_KEYS)
    (info,) = calls
    assert (info.method, info.path, info.query) == ("PUT", "/orders/7", "a=1")
    assert info.user_agent == "python-requests/2.32"
    assert info.client_ip == "198.51.100.4"
    assert info.headers["content-type"] == "application/json"


def test_wsgi_callback_exception_never_reaches_the_handler():
    client = FakeClient()

    def boom(info):
        raise RuntimeError("nope")

    stream = _TrackingStream(b'{"name":"x"}')
    mw = ApiLensWSGIMiddleware(_wsgi_app, client, sample_on_request=boom)
    assert b"".join(mw(_wsgi_environ(stream), lambda *a: None)) == b'{"ok":true}'
    (rec,) = client.records
    assert rec["sampled"] is True and rec["request_payload"]


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

_DJANGO_CALLS: list = []


def drop_orders(info):
    _DJANGO_CALLS.append(info)
    return not info.path.startswith("/orders")


def test_django_sample_on_request_setting_skips_body_read(django_settings, monkeypatch):
    settings, client = django_settings
    monkeypatch.setattr(settings, "APILENS_SAMPLE_ON_REQUEST", f"{__name__}.drop_orders", raising=False)
    _DJANGO_CALLS.clear()
    from django.http import HttpResponse
    from django.test import RequestFactory

    from apilens.django import ApiLensDjangoMiddleware

    mw = ApiLensDjangoMiddleware(lambda request: HttpResponse('{"ok":true}'))
    request = RequestFactory().post(
        "/orders?q=1", data=b'{"name":"x"}', content_type="application/json", HTTP_USER_AGENT="ua/1"
    )
    mw(request)
    # The view never read the body and neither did the middleware.
    assert not hasattr(request, "_body")
    (rec,) = client.records
    assert rec["sampled"] is False
    assert all(rec[k] == "" for k in DETAIL_KEYS)
    (info,) = _DJANGO_CALLS
    assert (info.method, info.path, info.query, info.user_agent) == ("POST", "/orders", "q=1", "ua/1")
    assert info.client_ip == "127.0.0.1"


def test_django_sample_on_request_exception_is_contained(django_settings, monkeypatch):
    settings, client = django_settings

    def boom(info):
        raise RuntimeError("nope")

    monkeypatch.setattr(settings, "APILENS_SAMPLE_ON_REQUEST", boom, raising=False)
    from django.http import HttpResponse
    from django.test import RequestFactory

    from apilens.django import ApiLensDjangoMiddleware

    mw = ApiLensDjangoMiddleware(lambda request: HttpResponse("ok"))
    response = mw(RequestFactory().get("/health-ish"))
    assert response.status_code == 200
    (rec,) = client.records
    assert rec["sampled"] is True


# ── Framework helpers expose the option ─────────────────────────────────────


@pytest.mark.parametrize(
    ("module", "attr"),
    [
        ("apilens.starlette", "instrument_app"),
        ("apilens.flask", "instrument_app"),
        ("apilens.blacksheep", "instrument_app"),
        ("apilens.litestar", "instrument_app"),
        ("apilens.litestar", "ApiLensPlugin"),
        ("apilens.fastapi", "instrument_app"),
        ("apilens.fastapi", "ApiLensGatewayMiddleware"),
        ("apilens.frameworks.fastapi", "instrument_fastapi"),
        ("apilens.frameworks.flask", "instrument_flask"),
    ],
)
def test_framework_helpers_accept_sample_on_request(module, attr):
    target = getattr(importlib.import_module(module), attr)
    assert "sample_on_request" in inspect.signature(target).parameters
