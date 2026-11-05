"""``sample_rate`` for request detail, with the base record always sent (issue #513)."""

from __future__ import annotations

import asyncio
import io
import json
import random
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from apilens.client import ApiLensClient, ApiLensConfig
from apilens.client._sampling import DetailSampler, validate_sample_rate
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware
from apilens.client.models import RequestRecord
from apilens.client.spans import record_span
from apilens.client.trace import current_span_id, current_trace_id, current_traceparent, detail_sampled

TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
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
    monkeypatch.delenv("APILENS_CAPTURE_SPANS", raising=False)
    monkeypatch.delenv("APILENS_EXCLUDE_PATHS", raising=False)
    monkeypatch.delenv("APILENS_EXCLUDE_USER_AGENTS", raising=False)


# ── Sampler ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("rate", [-0.01, 1.01, float("nan"), float("inf"), "abc", None, True])
def test_invalid_rates_are_rejected(rate):
    with pytest.raises(ValueError):
        validate_sample_rate(rate)
    with pytest.raises(ValueError):
        DetailSampler(rate)


def test_invalid_rate_is_rejected_by_middlewares():
    with pytest.raises(ValueError):
        ApiLensASGIMiddleware(None, FakeClient(), sample_rate=1.5)
    with pytest.raises(ValueError):
        ApiLensWSGIMiddleware(None, FakeClient(), sample_rate=-0.5)


@pytest.mark.parametrize("rate", [0, 0.0, 0.25, 1, 1.0, "0.5"])
def test_valid_rates_are_accepted(rate):
    assert DetailSampler(rate).rate == float(rate)


class _ExplodingRandom(random.Random):
    def random(self):  # pragma: no cover - must never be called
        raise AssertionError("PRNG must not be consulted at rate 0 or 1")


def test_rates_zero_and_one_are_exact_and_skip_the_prng():
    rng = _ExplodingRandom()
    assert all(DetailSampler(1.0, rng=rng).sample() for _ in range(10_000))
    assert not any(DetailSampler(0.0, rng=rng).sample() for _ in range(10_000))


@pytest.mark.parametrize("rate", [0.01, 0.1, 0.5, 0.9])
def test_statistical_rate_within_tolerance_over_10k(rate):
    n = 10_000
    sampler = DetailSampler(rate, rng=random.Random(513))
    hits = sum(sampler.sample() for _ in range(n))
    # 5 standard deviations of a binomial — deterministic with the seed, and
    # still well inside the bound for any seed.
    tolerance = 5 * (n * rate * (1 - rate)) ** 0.5
    assert abs(hits - n * rate) <= tolerance


def test_default_prng_rate_within_tolerance_over_10k():
    n, rate = 10_000, 0.3
    sampler = DetailSampler(rate)
    hits = sum(sampler.sample() for _ in range(n))
    assert abs(hits - n * rate) <= 5 * (n * rate * (1 - rate)) ** 0.5


# ── Wire format ─────────────────────────────────────────────────────────────


def _record(**overrides) -> RequestRecord:
    fields = dict(
        timestamp=datetime(2026, 11, 5, tzinfo=timezone.utc),
        environment="test",
        method="GET",
        path="/orders",
        status_code=200,
        response_time_ms=1.5,
        request_headers='{"a":"b"}',
    )
    fields.update(overrides)
    return RequestRecord(**fields)


def test_sampled_in_record_is_byte_identical_to_before():
    wire = _record().to_wire()
    assert "sampled" not in wire
    assert json.dumps(wire) == json.dumps(_record(sampled=True).to_wire())


def test_sampled_out_record_serialises_flag():
    wire = _record(sampled=False, request_headers="").to_wire()
    assert wire["sampled"] is False
    assert json.loads(json.dumps(wire))["sampled"] is False


def test_client_capture_carries_sampled_flag():
    client = ApiLensClient(ApiLensConfig(api_key="test-key", max_retries=0), start_worker=False)
    captured: list[RequestRecord] = []
    client.capture_record = captured.append  # type: ignore[method-assign]
    client.capture(method="GET", path="/a", status_code=200, response_time_ms=1.0)
    client.capture(method="GET", path="/a", status_code=200, response_time_ms=1.0, sampled=False)
    assert [r.sampled for r in captured] == [True, False]
    assert "sampled" not in captured[0].to_wire()
    assert captured[1].to_wire()["sampled"] is False


# ── ASGI ────────────────────────────────────────────────────────────────────


def _asgi_app(status: int = 200, raise_exc: bool = False, seen: list | None = None):
    async def app(scope, receive, send):
        await receive()
        if seen is not None:
            seen.append((current_trace_id(), current_traceparent(), detail_sampled()))
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
        await send({"type": "http.response.start", "status": status, "headers": [(b"x-out", b"1")]})
        await send({"type": "http.response.body", "body": b'{"ok":true}'})

    return app


def _run_asgi(mw, *, traceparent: str | None = None) -> None:
    async def receive():
        return {"type": "http.request", "body": b'{"name":"x"}', "more_body": False}

    async def send(message):
        return None

    headers = [(b"host", b"example.com"), (b"user-agent", b"curl/8.0"), (b"content-length", b"12")]
    if traceparent:
        headers.append((b"traceparent", traceparent.encode()))
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/orders",
        "query_string": b"q=1",
        "headers": headers,
        "scheme": "http",
        "client": ("10.0.0.1", 1234),
    }
    asyncio.run(mw(scope, receive, send))


def test_asgi_rate_zero_sends_every_base_record_without_detail():
    client = FakeClient()
    seen: list = []
    mw = ApiLensASGIMiddleware(_asgi_app(seen=seen), client, app_id="orders-api", sample_rate=0.0)
    for _ in range(20):
        _run_asgi(mw, traceparent=TRACEPARENT)
    assert len(client.records) == 20
    for rec in client.records:
        assert rec["sampled"] is False
        assert all(rec[k] == "" for k in DETAIL_KEYS)
        # Base record (metrics) is intact.
        assert rec["method"] == "POST" and rec["status_code"] == 200
        assert rec["raw_path"] == "/orders?q=1" and rec["request_size"] == 12
        assert rec["response_size"] == len(b'{"ok":true}')
        assert rec["user_agent"] == "curl/8.0" and rec["ip_address"] == "10.0.0.1"
        assert rec["trace_id"] == TRACEPARENT.split("-")[1]
    # No root span, no child span.
    assert client.spans == [] and client.logs == []
    # Trace context still propagated downstream while sampled out.
    for trace_id, traceparent, sampled in seen:
        assert trace_id == TRACEPARENT.split("-")[1]
        assert traceparent.startswith(f"00-{trace_id}-")
        assert sampled is False
    assert detail_sampled() is True


def test_asgi_rate_zero_skips_error_log_and_spans_on_failures():
    client = FakeClient()
    mw = ApiLensASGIMiddleware(_asgi_app(status=503), client, app_id="orders-api", sample_rate=0.0)
    _run_asgi(mw)
    mw_raise = ApiLensASGIMiddleware(_asgi_app(raise_exc=True), client, app_id="orders-api", sample_rate=0.0)
    with pytest.raises(RuntimeError):
        _run_asgi(mw_raise)
    assert [r["status_code"] for r in client.records] == [503, 500]
    assert all(r["sampled"] is False for r in client.records)
    assert client.spans == [] and client.logs == []


def test_asgi_rate_one_keeps_full_detail():
    client = FakeClient()
    seen: list = []
    mw = ApiLensASGIMiddleware(_asgi_app(status=500, seen=seen), client, app_id="orders-api", sample_rate=1.0)
    _run_asgi(mw)
    (rec,) = client.records
    assert rec["sampled"] is True
    assert rec["request_payload"] and rec["response_payload"]
    assert rec["request_headers"] and rec["response_headers"]
    assert {s.kind for s in client.spans} == {"server", "http"}
    assert len(client.logs) == 1
    assert seen[0][2] is True


def test_asgi_default_matches_explicit_rate_one():
    a, b = FakeClient(), FakeClient()
    _run_asgi(ApiLensASGIMiddleware(_asgi_app(), a, app_id="orders-api"))
    _run_asgi(ApiLensASGIMiddleware(_asgi_app(), b, app_id="orders-api", sample_rate=1.0))

    def strip(rec):
        return {k: v for k, v in rec.items() if k not in ("trace_id", "span_id", "response_time_ms")}

    assert strip(a.records[0]) == strip(b.records[0])
    assert len(a.spans) == len(b.spans) == 1


def test_asgi_partial_rate_always_sends_base_record(monkeypatch):
    client = FakeClient()
    mw = ApiLensASGIMiddleware(_asgi_app(), client, app_id="orders-api", sample_rate=0.5)
    mw.sampler = DetailSampler(0.5, rng=random.Random(7))
    for _ in range(200):
        _run_asgi(mw)
    assert len(client.records) == 200
    kept = [r for r in client.records if r["sampled"]]
    dropped = [r for r in client.records if not r["sampled"]]
    assert kept and dropped
    assert all(r["request_payload"] for r in kept)
    assert all(r[k] == "" for r in dropped for k in DETAIL_KEYS)
    assert len(client.spans) == len(kept)


# ── WSGI ────────────────────────────────────────────────────────────────────


def _wsgi_app(seen: list | None = None):
    def app(environ, start_response):
        body = environ["wsgi.input"].read()
        if seen is not None:
            seen.append((current_traceparent(), detail_sampled(), body))
        start_response("200 OK", [("Content-Type", "application/json")])
        return [b'{"ok":true}']

    return app


def _run_wsgi(mw) -> bytes:
    environ = {
        "REQUEST_METHOD": "POST",
        "PATH_INFO": "/orders",
        "QUERY_STRING": "",
        "HTTP_HOST": "example.com",
        "HTTP_TRACEPARENT": TRACEPARENT,
        "CONTENT_LENGTH": "12",
        "wsgi.url_scheme": "http",
        "wsgi.input": io.BytesIO(b'{"name":"x"}'),
    }
    return b"".join(mw(environ, lambda status, headers, exc_info=None: None))


def test_wsgi_rate_zero_sends_base_record_without_detail():
    client = FakeClient()
    seen: list = []
    mw = ApiLensWSGIMiddleware(_wsgi_app(seen), client, app_id="orders-api", sample_rate=0.0)
    assert _run_wsgi(mw) == b'{"ok":true}'
    (rec,) = client.records
    assert rec["sampled"] is False
    assert all(rec[k] == "" for k in DETAIL_KEYS)
    assert rec["request_size"] == 12 and rec["response_size"] == 11
    assert client.spans == []
    traceparent, sampled, body = seen[0]
    assert traceparent.startswith("00-" + TRACEPARENT.split("-")[1])
    assert sampled is False
    # The app still reads the full body.
    assert body == b'{"name":"x"}'


def test_wsgi_rate_one_keeps_detail():
    client = FakeClient()
    mw = ApiLensWSGIMiddleware(_wsgi_app(), client, app_id="orders-api", sample_rate=1.0)
    _run_wsgi(mw)
    (rec,) = client.records
    assert rec["sampled"] is True
    assert rec["request_payload"] and rec["response_payload"] and rec["request_headers"]
    assert len(client.spans) == 1


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


def test_django_sample_rate_setting(django_settings, monkeypatch):
    settings, client = django_settings
    monkeypatch.setattr(settings, "APILENS_SAMPLE_RATE", 0.0, raising=False)
    from django.http import HttpResponse
    from django.test import RequestFactory

    from apilens.django import ApiLensDjangoMiddleware

    mw = ApiLensDjangoMiddleware(lambda request: HttpResponse('{"ok":true}', status=500))
    mw(RequestFactory().post("/orders", data=b'{"name":"x"}', content_type="application/json"))
    (rec,) = client.records
    assert rec["sampled"] is False
    assert all(rec[k] == "" for k in DETAIL_KEYS)
    assert rec["status_code"] == 500 and rec["response_size"] == 11
    assert client.spans == [] and client.logs == []


def test_django_invalid_sample_rate_setting(django_settings, monkeypatch):
    settings, _ = django_settings
    monkeypatch.setattr(settings, "APILENS_SAMPLE_RATE", 2, raising=False)
    from django.http import HttpResponse

    from apilens.django import ApiLensDjangoMiddleware

    with pytest.raises(ValueError):
        ApiLensDjangoMiddleware(lambda request: HttpResponse("ok"))
