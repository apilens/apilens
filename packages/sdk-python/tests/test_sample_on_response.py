"""``sample_on_response`` callback evaluated after the response (issue #515)."""

from __future__ import annotations

import asyncio
import importlib
import inspect
import io
import logging
import random
import threading
from types import SimpleNamespace

import pytest

from apilens import RequestInfo, ResponseInfo, set_request_attribute, track_consumer
from apilens.client._sampling import ResponseSampler
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware
from apilens.client.spans import record_span
from apilens.client.trace import current_span_id, current_trace_id, detail_sampled

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


def _info(status: int = 200, *, sampled: bool = True) -> ResponseInfo:
    return ResponseInfo(request=RequestInfo(method="GET", path="/orders"), status_code=status, sampled=sampled)


# ── The two documented examples ─────────────────────────────────────────────


def keep_only_errors(info):
    """README example 1: keep the detail of failed requests only."""
    return info.status_code >= 400


def sample_by_consumer(info):
    """README example 2: drop internal consumers, sample the free tier."""
    if info.consumer_group == "internal":
        return False
    if info.attributes.get("tenant.tier") == "free":
        return 0.1
    return None


# ── Sampler ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("prior", [True, False])
def test_none_keeps_the_prior_decision(prior):
    sampler = ResponseSampler(lambda info: None, rng=_ExplodingRandom())
    assert sampler.decide(prior, _info) is prior


def test_bool_decides_a_kept_request():
    rng = _ExplodingRandom()
    assert ResponseSampler(lambda info: True, rng=rng).decide(True, _info) is True
    assert ResponseSampler(lambda info: False, rng=rng).decide(True, _info) is False


@pytest.mark.parametrize("verdict", [True, 1.0, 0.7, None])
def test_cannot_undrop_a_request_sampled_out_at_request_stage(verdict):
    seen: list = []

    def sample(info):
        seen.append(info.sampled)
        return verdict

    assert ResponseSampler(sample, rng=_ExplodingRandom()).decide(False, lambda: _info(sampled=False)) is False
    # The callback still runs and is told about the prior decision.
    assert seen == [False]


@pytest.mark.parametrize("probability", [0.25, 0.5])
def test_float_is_a_keep_probability(probability):
    sampler = ResponseSampler(lambda info: probability, rng=random.Random(7))
    kept = sum(sampler.decide(True, _info) for _ in range(10_000))
    assert abs(kept / 10_000 - probability) < 0.03


@pytest.mark.parametrize(("value", "expected"), [(0, False), (0.0, False), (-1, False), (1, True), (5.0, True)])
def test_float_bounds_are_exact_and_clamped(value, expected):
    assert ResponseSampler(lambda info: value, rng=_ExplodingRandom()).decide(True, _info) is expected


def test_info_is_not_built_without_a_callback():
    def info():  # pragma: no cover - must never be called
        raise AssertionError("ResponseInfo built without a callback")

    sampler = ResponseSampler()
    assert sampler.decide(True, info) is True and sampler.decide(False, info) is False
    assert not sampler.defers(True)
    assert ResponseSampler(lambda info: None).defers(True)
    assert not ResponseSampler(lambda info: None).defers(False)


def test_non_callable_callback_is_rejected():
    with pytest.raises(TypeError):
        ResponseSampler("nope")  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        ApiLensASGIMiddleware(None, FakeClient(), sample_on_response=0.5)  # type: ignore[arg-type]


def test_exception_is_treated_as_none_and_logged_once(caplog):
    caplog.set_level(logging.WARNING, logger="apilens")

    def boom(info):
        raise ValueError("nope")

    sampler = ResponseSampler(boom)
    assert [sampler.decide(True, _info) for _ in range(3)] == [True, True, True]
    assert sampler.decide(False, _info) is False
    assert len([r for r in caplog.records if "sample_on_response raised" in r.getMessage()]) == 1


@pytest.mark.parametrize("value", ["yes", float("nan"), [1]])
def test_unusable_return_value_is_treated_as_none_and_logged_once(value, caplog):
    caplog.set_level(logging.WARNING, logger="apilens")
    sampler = ResponseSampler(lambda info: value)
    assert sampler.decide(True, _info) is True
    assert sampler.decide(True, _info) is True
    assert len([r for r in caplog.records if "sample_on_response returned" in r.getMessage()]) == 1


def test_sample_by_consumer_example():
    sampler = ResponseSampler(sample_by_consumer, rng=random.Random(3))
    request = RequestInfo(method="GET", path="/orders")
    internal = ResponseInfo(request=request, status_code=200, consumer_group="internal")
    free = ResponseInfo(request=request, status_code=200, attributes={"tenant.tier": "free"})
    paid = ResponseInfo(request=request, status_code=200, attributes={"tenant.tier": "paid"})
    assert sampler.decide(True, lambda: internal) is False
    assert sampler.decide(True, lambda: paid) is True
    kept = sum(sampler.decide(True, lambda: free) for _ in range(5_000))
    assert abs(kept / 5_000 - 0.1) < 0.02


# ── ASGI ────────────────────────────────────────────────────────────────────


def _asgi_app(status: int = 200, *, consumer: str = "", group: str = "", raise_exc: bool = False):
    async def app(scope, receive, send):
        await receive()
        if consumer:
            track_consumer(identifier=consumer, name=consumer.title(), group=group or None)
        set_request_attribute("tenant.id", "t-42")
        # An outbound child span recorded during the request.
        record_span(
            name="GET https://downstream.example.com/x",
            kind="http",
            trace_id=current_trace_id(),
            span_id="c" * 16,
            parent_span_id=current_span_id(),
            duration_ms=1.0,
        )
        if raise_exc:
            raise RuntimeError("boom")
        await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": b'{"ok":true}'})

    return app


def _run_asgi(mw, *, path: str = "/orders/7") -> None:
    async def receive():
        return {"type": "http.request", "body": b'{"name":"x"}', "more_body": False}

    async def send(message):
        return None

    scope = {
        "type": "http",
        "method": "POST",
        "path": path,
        "query_string": b"q=1",
        "headers": [
            (b"host", b"example.com"),
            (b"user-agent", b"curl/8.0"),
            (b"content-type", b"application/json"),
            (b"content-length", b"12"),
        ],
        "scheme": "http",
        "client": ("10.0.0.1", 1234),
    }
    asyncio.run(mw(scope, receive, send))


def test_asgi_keep_only_errors_example():
    client = FakeClient()
    ok = ApiLensASGIMiddleware(_asgi_app(200), client, app_id="orders-api", sample_on_response=keep_only_errors)
    failing = ApiLensASGIMiddleware(_asgi_app(503), client, app_id="orders-api", sample_on_response=keep_only_errors)
    _run_asgi(ok)
    # The 200 still sends its base record, with no detail and no spans.
    (rec,) = client.records
    assert rec["sampled"] is False and rec["status_code"] == 200
    assert all(rec[k] == "" for k in DETAIL_KEYS)
    assert rec["raw_path"] == "/orders/7?q=1" and rec["response_size"] == len(b'{"ok":true}')
    assert client.spans == [] and client.logs == []

    _run_asgi(failing)
    rec = client.records[-1]
    assert rec["sampled"] is True and rec["status_code"] == 503
    assert all(rec[k] for k in DETAIL_KEYS)
    assert {s.kind for s in client.spans} == {"server", "http"}
    assert len(client.logs) == 1
    assert detail_sampled() is True


def test_asgi_callback_gets_the_response_info():
    client = FakeClient()
    calls: list = []

    def sample(info):
        calls.append(info)
        return None

    mw = ApiLensASGIMiddleware(
        _asgi_app(201, consumer="acme", group="partners"),
        client,
        sample_on_response=sample,
        route_resolver=lambda scope: "/orders/{id}",
    )
    _run_asgi(mw)
    (info,) = calls
    (rec,) = client.records
    assert isinstance(info, ResponseInfo)
    assert info.route == "/orders/{id}" == rec["path"]
    assert info.raw_path == "/orders/7?q=1" and info.path == "/orders/7" and info.method == "POST"
    assert info.status_code == 201
    assert info.response_time_ms > 0 and info.response_time_ms == rec["response_time_ms"]
    assert (info.consumer_id, info.consumer_name, info.consumer_group) == ("acme", "Acme", "partners")
    assert info.attributes == {"tenant.id": "t-42"}
    assert info.request.attributes == {"tenant.id": "t-42"}
    assert info.headers["content-type"] == "application/json"
    assert info.sampled is True
    assert rec["sampled"] is True and rec["request_payload"]


def test_asgi_drop_by_consumer_group():
    client = FakeClient()
    internal = ApiLensASGIMiddleware(
        _asgi_app(200, consumer="ops", group="internal"), client, sample_on_response=sample_by_consumer
    )
    external = ApiLensASGIMiddleware(
        _asgi_app(200, consumer="acme", group="partners"), client, sample_on_response=sample_by_consumer
    )
    _run_asgi(internal)
    _run_asgi(external)
    dropped, kept = client.records
    assert dropped["sampled"] is False and dropped["consumer_id"] == "ops"
    assert all(dropped[k] == "" for k in DETAIL_KEYS)
    assert kept["sampled"] is True and kept["response_payload"]


def test_asgi_cannot_undrop_a_request_sampled_out_at_request_stage():
    client = FakeClient()
    seen: list = []

    def keep_everything(info):
        seen.append(info.sampled)
        return True

    mw = ApiLensASGIMiddleware(
        _asgi_app(500), client, app_id="orders-api", sample_rate=0.0, sample_on_response=keep_everything
    )
    _run_asgi(mw)
    (rec,) = client.records
    assert seen == [False]
    assert rec["sampled"] is False
    assert all(rec[k] == "" for k in DETAIL_KEYS)
    assert client.spans == [] and client.logs == []

    # Same with sample_on_request dropping it.
    client2 = FakeClient()
    mw2 = ApiLensASGIMiddleware(
        _asgi_app(200),
        client2,
        app_id="orders-api",
        sample_on_request=lambda info: False,
        sample_on_response=lambda info: 1.0,
    )
    _run_asgi(mw2)
    assert client2.records[0]["sampled"] is False and client2.spans == []


def test_asgi_callback_exception_is_treated_as_none():
    client = FakeClient()

    def boom(info):
        raise RuntimeError("nope")

    mw = ApiLensASGIMiddleware(_asgi_app(200), client, app_id="orders-api", sample_on_response=boom)
    _run_asgi(mw)
    (rec,) = client.records
    assert rec["sampled"] is True and rec["response_payload"]
    assert {s.kind for s in client.spans} == {"server", "http"}


def test_asgi_dropped_request_skips_the_response_body_masker():
    client = FakeClient()
    masked: list = []

    def mask(info, body):
        masked.append(info)
        return body

    mw = ApiLensASGIMiddleware(
        _asgi_app(200), client, sample_on_response=lambda info: False, mask_response_body=mask
    )
    _run_asgi(mw)
    assert masked == []
    assert client.records[0]["response_payload"] == ""


def test_child_span_finishing_after_the_decision_follows_it():
    client = FakeClient()
    late = threading.Event()
    done = threading.Event()

    def background(trace_id, span_id):
        late.wait(5)
        record_span(name="late", kind="internal", trace_id=trace_id, span_id="d" * 16, parent_span_id=span_id, duration_ms=1.0)
        done.set()

    async def app(scope, receive, send):
        import contextvars

        ctx = contextvars.copy_context()
        threading.Thread(target=ctx.run, args=(background, current_trace_id(), current_span_id())).start()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    mw = ApiLensASGIMiddleware(app, client, app_id="orders-api", sample_on_response=lambda info: False)
    _run_asgi(mw)
    late.set()
    assert done.wait(5)
    assert client.spans == []


# ── WSGI ────────────────────────────────────────────────────────────────────


def _wsgi_app(status: str = "200 OK", consumer: str = ""):
    def app(environ, start_response):
        environ["wsgi.input"].read()
        if consumer:
            track_consumer(identifier=consumer)
        set_request_attribute("tenant.id", "t-42")
        record_span(
            name="GET https://downstream.example.com/x",
            kind="http",
            trace_id=current_trace_id(),
            span_id="c" * 16,
            parent_span_id=current_span_id(),
            duration_ms=1.0,
        )
        start_response(status, [("Content-Type", "application/json")])
        return [b'{"ok":true}']

    return app


def _run_wsgi(mw) -> bytes:
    environ = {
        "REQUEST_METHOD": "POST",
        "PATH_INFO": "/orders/7",
        "QUERY_STRING": "q=1",
        "HTTP_HOST": "example.com",
        "CONTENT_TYPE": "application/json",
        "CONTENT_LENGTH": "12",
        "wsgi.url_scheme": "http",
        "wsgi.input": io.BytesIO(b'{"name":"x"}'),
    }
    return b"".join(mw(environ, lambda status, headers, exc_info=None: None))


def test_wsgi_keep_only_errors_example():
    client = FakeClient()
    ok = ApiLensWSGIMiddleware(_wsgi_app("200 OK"), client, app_id="orders-api", sample_on_response=keep_only_errors)
    failing = ApiLensWSGIMiddleware(
        _wsgi_app("500 Internal Server Error"), client, app_id="orders-api", sample_on_response=keep_only_errors
    )
    assert _run_wsgi(ok) == b'{"ok":true}'
    (rec,) = client.records
    assert rec["sampled"] is False and all(rec[k] == "" for k in DETAIL_KEYS)
    assert client.spans == []

    _run_wsgi(failing)
    rec = client.records[-1]
    assert rec["sampled"] is True and all(rec[k] for k in DETAIL_KEYS)
    assert {s.kind for s in client.spans} == {"server", "http"}


def test_wsgi_callback_gets_the_response_info_and_cannot_undrop():
    client = FakeClient()
    calls: list = []

    def sample(info):
        calls.append(info)
        return True

    mw = ApiLensWSGIMiddleware(
        _wsgi_app("404 Not Found", consumer="acme"),
        client,
        sample_rate=0.0,
        sample_on_response=sample,
        route_resolver=lambda environ: "/orders/{id}",
    )
    _run_wsgi(mw)
    (info,) = calls
    (rec,) = client.records
    assert info.route == "/orders/{id}" and info.raw_path == "/orders/7?q=1"
    assert info.status_code == 404 and info.consumer_id == "acme"
    assert info.attributes == {"tenant.id": "t-42"}
    assert info.response_time_ms == rec["response_time_ms"]
    assert info.sampled is False
    assert rec["sampled"] is False and all(rec[k] == "" for k in DETAIL_KEYS)


def test_wsgi_callback_exception_is_treated_as_none():
    client = FakeClient()

    def boom(info):
        raise RuntimeError("nope")

    mw = ApiLensWSGIMiddleware(_wsgi_app(), client, sample_on_response=boom)
    assert _run_wsgi(mw) == b'{"ok":true}'
    (rec,) = client.records
    assert rec["sampled"] is True and rec["response_payload"]


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


def django_keep_only_errors(info):
    _DJANGO_CALLS.append(info)
    return info.status_code >= 400


def _django_view(status: int):
    from django.http import HttpResponse

    def view(request):
        request.body  # noqa: B018 - the view reads its body
        set_request_attribute("tenant.id", "t-42")
        return HttpResponse('{"ok":true}', status=status, content_type="application/json")

    return view


def test_django_sample_on_response_setting(django_settings, monkeypatch):
    settings, client = django_settings
    monkeypatch.setattr(settings, "APILENS_SAMPLE_ON_RESPONSE", f"{__name__}.django_keep_only_errors", raising=False)
    _DJANGO_CALLS.clear()
    from django.test import RequestFactory

    from apilens.django import ApiLensDjangoMiddleware

    for status in (200, 422):
        mw = ApiLensDjangoMiddleware(_django_view(status))
        request = RequestFactory().post("/orders/7?q=1", data=b'{"name":"x"}', content_type="application/json")
        assert mw(request).status_code == status
    ok, failed = client.records
    assert ok["sampled"] is False and all(ok[k] == "" for k in DETAIL_KEYS)
    assert failed["sampled"] is True and all(failed[k] for k in DETAIL_KEYS)
    info = _DJANGO_CALLS[0]
    assert info.raw_path == "/orders/7?q=1" and info.status_code == 200
    assert info.attributes == {"tenant.id": "t-42"} and info.sampled is True
    assert info.response_time_ms == ok["response_time_ms"]


def test_django_sample_on_response_exception_is_contained(django_settings, monkeypatch):
    settings, client = django_settings

    def boom(info):
        raise RuntimeError("nope")

    monkeypatch.setattr(settings, "APILENS_SAMPLE_ON_RESPONSE", boom, raising=False)
    from django.test import RequestFactory

    from apilens.django import ApiLensDjangoMiddleware

    mw = ApiLensDjangoMiddleware(_django_view(200))
    assert mw(RequestFactory().post("/orders", data=b"{}", content_type="application/json")).status_code == 200
    (rec,) = client.records
    assert rec["sampled"] is True and rec["response_payload"]


def test_django_cannot_undrop(django_settings, monkeypatch):
    settings, client = django_settings
    monkeypatch.setattr(settings, "APILENS_SAMPLE_RATE", 0.0, raising=False)
    monkeypatch.setattr(settings, "APILENS_SAMPLE_ON_RESPONSE", lambda info: True, raising=False)
    from django.test import RequestFactory

    from apilens.django import ApiLensDjangoMiddleware

    mw = ApiLensDjangoMiddleware(_django_view(500))
    mw(RequestFactory().post("/orders", data=b"{}", content_type="application/json"))
    (rec,) = client.records
    assert rec["sampled"] is False and all(rec[k] == "" for k in DETAIL_KEYS)


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
        ("apilens.client.middleware", "ApiLensASGIMiddleware"),
        ("apilens.client.middleware", "ApiLensWSGIMiddleware"),
    ],
)
def test_framework_helpers_accept_sample_on_response(module, attr):
    target = getattr(importlib.import_module(module), attr)
    assert "sample_on_response" in inspect.signature(target).parameters
