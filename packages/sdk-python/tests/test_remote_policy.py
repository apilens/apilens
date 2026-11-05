"""Remote capture policy from the heartbeat response (issue #525).

The client parses ``policy`` into an immutable ``Policy`` per app; the
middlewares read it per request. Remote can only narrow capture: disable it,
lower the sample rate, turn headers/bodies off, lower the body cap. A failed
heartbeat keeps the last known policy; local ``enabled=False`` always wins.
"""

from __future__ import annotations

import asyncio
import dataclasses
import io
import json
import logging
import random
import time
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from apilens.client import ApiLensClient, ApiLensConfig
from apilens.client import client as client_mod
from apilens.client._env import ENV_OPTIONS, env_var
from apilens.client._policy import ALLOW_ALL, DISABLED, Policy, parse_policy, policy_for
from apilens.client._sampling import RequestSampler
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware
from apilens.client.models import LogRecord, SpanRecord
from test_heartbeat import _FakeIngest

API_KEY = "apilens_test_POLICYKEY"
BODY = b'{"email":"a@example.com","note":"' + b"x" * 200 + b'"}'

WIDE_OPEN = {
    "enabled": True,
    "sample_rate": 1.0,
    "capture_headers": True,
    "capture_request_body": True,
    "capture_response_body": True,
    "max_payload_bytes": 1 << 20,
}
OFF = {**WIDE_OPEN, "enabled": False}


def _reply(policy: dict) -> tuple[int, bytes, dict]:
    return 200, json.dumps({"policy": policy}).encode(), {"Content-Type": "application/json"}


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    for option in ENV_OPTIONS:
        monkeypatch.delenv(env_var(option), raising=False)
    monkeypatch.setenv("APILENS_SEND_HEARTBEAT", "true")
    monkeypatch.setattr(client_mod, "HEARTBEAT_MIN_INTERVAL_SECONDS", 0.0)


@pytest.fixture
def ingest():
    servers: list[_FakeIngest] = []

    def make(*replies: tuple[int, bytes, dict]) -> _FakeIngest:
        server = _FakeIngest(list(replies))
        servers.append(server)
        return server

    yield make
    for server in servers:
        server.close()


def _client(server: _FakeIngest | None = None, **overrides) -> ApiLensClient:
    cfg = dict(
        api_key=API_KEY,
        base_url=server.base_url if server else "http://127.0.0.1:9/v1",
        app_id="storefront",
        environment="staging",
        timeout=2.0,
    )
    cfg.update(overrides)
    return ApiLensClient(ApiLensConfig(**cfg), start_worker=False)


def _queued(client: ApiLensClient) -> int:
    return len(client._queue) + len(client._span_queue) + len(client._log_queue)


def _capture_all(client: ApiLensClient, app_id: str = "storefront") -> None:
    client.capture(method="GET", path="/orders", status_code=200, response_time_ms=1.0, app_id=app_id)
    now = datetime.now(tz=timezone.utc)
    client.capture_span(
        SpanRecord(now, "staging", trace_id="a" * 32, span_id="b" * 16, name="GET /orders", app_id=app_id)
    )
    client.capture_log(LogRecord(now, "staging", "ERROR", "boom", trace_id="a" * 32, app_id=app_id))


# ── parsing ─────────────────────────────────────────────────────────────────


def test_parse_full_policy():
    policy = parse_policy(
        {
            "enabled": True,
            "sample_rate": 0.25,
            "capture_headers": False,
            "capture_request_body": True,
            "capture_response_body": False,
            "max_payload_bytes": 1024,
        }
    )
    assert policy == Policy(True, 0.25, False, True, False, 1024)


def test_parse_missing_or_unusable_fields_impose_no_restriction():
    assert parse_policy({}) == ALLOW_ALL
    assert parse_policy({"max_payload_bytes": None}) == ALLOW_ALL
    garbage = {
        "enabled": "no",
        "sample_rate": "half",
        "capture_headers": 0,
        "max_payload_bytes": True,
    }
    assert parse_policy(garbage) == ALLOW_ALL
    assert parse_policy({"sample_rate": 7}).sample_rate == 1.0
    assert parse_policy({"sample_rate": -1}).sample_rate == 0.0
    assert parse_policy({"max_payload_bytes": float("inf")}).max_payload_bytes is None


@pytest.mark.parametrize("value", [None, [], "policy", 1])
def test_parse_non_object_is_none(value):
    assert parse_policy(value) is None


def test_policy_is_immutable():
    with pytest.raises(dataclasses.FrozenInstanceError):
        ALLOW_ALL.enabled = False  # type: ignore[misc]


def test_caps_only_narrow():
    policy = Policy(sample_rate=0.5, max_payload_bytes=100)
    assert policy.cap_sample_rate(1.0) == 0.5
    assert policy.cap_sample_rate(0.1) == 0.1
    assert policy.cap_payload_bytes(65536) == 100
    assert policy.cap_payload_bytes(10) == 10
    assert ALLOW_ALL.cap_payload_bytes(10) == 10


def test_policy_for_tolerates_clients_without_policy():
    assert policy_for(SimpleNamespace(), "a") is ALLOW_ALL

    def boom(_app_id):
        raise RuntimeError

    assert policy_for(SimpleNamespace(policy=boom), "a") is ALLOW_ALL
    assert policy_for(SimpleNamespace(policy=lambda _a: "nope"), "a") is ALLOW_ALL


# ── client: heartbeat → Policy ──────────────────────────────────────────────


def test_policy_before_first_heartbeat_is_unrestricted():
    assert _client().policy() is ALLOW_ALL


def test_heartbeat_publishes_the_policy_per_app(ingest):
    server = ingest(_reply({**WIDE_OPEN, "sample_rate": 0.5, "capture_headers": False}))
    client = _client(server)
    assert client.send_heartbeat() is True
    policy = client.policy("storefront")
    assert isinstance(policy, Policy)
    assert (policy.sample_rate, policy.capture_headers) == (0.5, False)
    assert client.policy() == policy  # default: the config's app_id
    assert client.policy("other-app") is ALLOW_ALL


def test_remote_disable_stops_capture_on_the_next_heartbeat(ingest):
    server = ingest(_reply(WIDE_OPEN), _reply(OFF), _reply(WIDE_OPEN))
    client = _client(server)
    client.send_heartbeat()
    _capture_all(client)
    assert _queued(client) == 3

    client._queue.clear(), client._span_queue.clear(), client._log_queue.clear()
    client.send_heartbeat()
    assert client.policy().enabled is False
    _capture_all(client)
    assert _queued(client) == 0
    _capture_all(client, app_id="other-app")  # only the disabled app stops
    assert _queued(client) == 3

    client._queue.clear(), client._span_queue.clear(), client._log_queue.clear()
    client.send_heartbeat()  # re-enabled remotely
    _capture_all(client)
    assert _queued(client) == 3


def test_flush_thread_applies_the_kill_switch_within_one_interval(ingest):
    server = ingest(_reply(OFF))
    cfg = ApiLensConfig(
        api_key=API_KEY,
        base_url=server.base_url,
        app_id="storefront",
        heartbeat_interval=0.05,
        flush_interval=0.02,
        timeout=2.0,
    )
    client = ApiLensClient(cfg)
    try:
        end = time.monotonic() + 3.0
        while client.policy().enabled and time.monotonic() < end:
            time.sleep(0.01)
        assert client.policy().enabled is False
    finally:
        client.shutdown(flush=False, timeout=1.0)


def test_local_disable_cannot_be_overridden_remotely():
    client = _client(enabled=False)
    client._apply_heartbeat_response(json.dumps({"policy": WIDE_OPEN}).encode(), "storefront")
    assert client.policy() is DISABLED
    _capture_all(client)
    assert _queued(client) == 0


@pytest.mark.parametrize(
    "failure",
    [
        (503, b'{"error":"unavailable"}', {"Retry-After": "1"}),
        (500, b"oops", {}),
        (401, b'{"error":"unauthorized"}', {}),
        (200, b"not json", {}),
        (200, b'{"nope":1}', {}),
        (200, b'{"policy":null}', {}),
    ],
)
def test_heartbeat_failure_keeps_the_last_known_policy(ingest, failure):
    server = ingest(_reply(OFF), failure)
    client = _client(server)
    client.send_heartbeat()
    client.send_heartbeat()
    assert client.policy().enabled is False
    _capture_all(client)
    assert _queued(client) == 0


def test_network_failure_keeps_the_last_known_policy():
    client = _client()  # nothing listens on the base_url
    client._apply_heartbeat_response(json.dumps({"policy": OFF}).encode(), "storefront")
    assert client.send_heartbeat() is False
    assert client.policy().enabled is False


def test_policy_change_is_logged_once(ingest, caplog):
    server = ingest(_reply(OFF), _reply(OFF), _reply(WIDE_OPEN), _reply(WIDE_OPEN))
    client = _client(server)
    with caplog.at_level(logging.INFO, logger="apilens"):
        for _ in range(4):
            client.send_heartbeat()
    changes = [r for r in caplog.records if "capture policy" in r.getMessage()]
    assert len(changes) == 2
    assert "'enabled': False" in changes[0].getMessage()
    assert "'enabled': True" in changes[1].getMessage()


def test_unrestricted_first_policy_is_not_logged(ingest, caplog):
    server = ingest(_reply({}))
    client = _client(server)
    with caplog.at_level(logging.INFO, logger="apilens"):
        client.send_heartbeat()
    assert not [r for r in caplog.records if "capture policy" in r.getMessage()]


# ── sampler cap ─────────────────────────────────────────────────────────────


class _ExplodingRandom(random.Random):
    def random(self):  # pragma: no cover - must never be called
        raise AssertionError("PRNG must not be consulted")


def test_sampler_cap_only_lowers_the_rate():
    info = lambda: None  # noqa: E731
    rng = _ExplodingRandom()
    assert RequestSampler(1.0, rng=rng).decide(info, 0.0) is False
    assert RequestSampler(0.0, rng=rng).decide(info, 1.0) is False  # never widened
    assert RequestSampler(1.0, rng=rng).decide(info) is True
    n = 10_000
    sampler = RequestSampler(1.0, rng=random.Random(525))
    hits = sum(sampler.decide(info, 0.25) for _ in range(n))
    assert abs(hits - n * 0.25) <= 5 * (n * 0.25 * 0.75) ** 0.5


def test_sampler_cap_narrows_callback_verdicts():
    info = lambda: None  # noqa: E731
    asked: list[int] = []

    def keep(_info):
        asked.append(1)
        return True

    assert RequestSampler(1.0, keep).decide(info, 0.0) is False
    assert asked == []  # cap 0: the callback is not consulted
    assert RequestSampler(1.0, lambda _i: False).decide(info, 1.0) is False
    n = 10_000
    sampler = RequestSampler(1.0, keep, rng=random.Random(525))
    hits = sum(sampler.decide(info, 0.5) for _ in range(n))
    assert abs(hits - n * 0.5) <= 5 * (n * 0.25) ** 0.5


# ── middlewares read the policy per request ────────────────────────────────


class FakeClient:
    def __init__(self, policy: Policy = ALLOW_ALL) -> None:
        self.config = SimpleNamespace(project_slug="", environment="test")
        self.records: list[dict] = []
        self.current = policy
        self.asked: list[str] = []

    def policy(self, app_id: str = "") -> Policy:
        self.asked.append(app_id)
        return self.current

    def capture(self, **kwargs) -> None:
        self.records.append(kwargs)

    def capture_span(self, record) -> None:
        pass

    def capture_log(self, record) -> None:
        pass


def _run_asgi(mw) -> dict | None:
    async def app(scope, receive, send):
        await receive()
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": BODY, "more_body": False})

    mw.app = app
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/orders",
        "query_string": b"",
        "headers": [(b"content-type", b"application/json"), (b"x-trace", b"t")],
    }

    async def receive():
        return {"type": "http.request", "body": BODY, "more_body": False}

    async def send(_message):
        return None

    before = len(mw.client.records)
    asyncio.run(mw(scope, receive, send))
    return mw.client.records[-1] if len(mw.client.records) > before else None


def _run_wsgi(mw) -> dict | None:
    def app(environ, start_response):
        environ["wsgi.input"].read()
        start_response("200 OK", [("Content-Type", "application/json")])
        return [BODY]

    mw.app = app
    environ = {
        "REQUEST_METHOD": "POST",
        "PATH_INFO": "/orders",
        "CONTENT_TYPE": "application/json",
        "CONTENT_LENGTH": str(len(BODY)),
        "HTTP_X_TRACE": "t",
        "wsgi.input": io.BytesIO(BODY),
    }
    before = len(mw.client.records)
    result = mw(environ, lambda status, headers, exc_info=None: None)
    for _ in result:
        pass
    if hasattr(result, "close"):
        result.close()
    return mw.client.records[-1] if len(mw.client.records) > before else None


def _asgi(policy: Policy = ALLOW_ALL, **kwargs) -> ApiLensASGIMiddleware:
    return ApiLensASGIMiddleware(None, FakeClient(policy), app_id="storefront", capture_spans=False, **kwargs)


def _wsgi(policy: Policy = ALLOW_ALL, **kwargs) -> ApiLensWSGIMiddleware:
    return ApiLensWSGIMiddleware(None, FakeClient(policy), app_id="storefront", capture_spans=False, **kwargs)


RUNNERS = [pytest.param(_asgi, _run_asgi, id="asgi"), pytest.param(_wsgi, _run_wsgi, id="wsgi")]


@pytest.mark.parametrize("build,run", RUNNERS)
def test_unrestricted_policy_captures_everything(build, run):
    rec = run(build())
    assert rec["request_headers"] and rec["response_headers"]
    assert rec["request_payload"] and rec["response_payload"]
    assert rec["sampled"] is True


@pytest.mark.parametrize("build,run", RUNNERS)
def test_remote_disable_sends_no_record(build, run):
    mw = build(Policy(enabled=False))
    assert run(mw) is None
    assert mw.client.asked == ["storefront"]
    mw.client.current = ALLOW_ALL  # read per request: the next one is captured
    assert run(mw) is not None


@pytest.mark.parametrize("build,run", RUNNERS)
def test_remote_policy_narrows_capture(build, run):
    rec = run(build(Policy(capture_headers=False, capture_request_body=False)))
    assert rec["request_headers"] == "" and rec["response_headers"] == ""
    assert rec["request_payload"] == ""
    assert rec["response_payload"]

    rec = run(build(Policy(capture_response_body=False, max_payload_bytes=16)))
    assert rec["response_payload"] == ""
    assert rec["request_payload"].startswith('{"email":"a@exa')
    assert len(rec["request_payload"]) < len(BODY)

    rec = run(build(Policy(sample_rate=0.0)))
    assert rec["sampled"] is False
    assert rec["request_headers"] == "" and rec["request_payload"] == "" and rec["response_payload"] == ""


@pytest.mark.parametrize("build,run", RUNNERS)
def test_remote_policy_never_widens_local_config(build, run):
    wide = Policy(sample_rate=1.0, max_payload_bytes=1 << 20)
    rec = run(build(wide, capture_headers=False, log_request_body=False, log_response_body=False))
    assert rec["request_headers"] == "" and rec["response_headers"] == ""
    assert rec["request_payload"] == "" and rec["response_payload"] == ""

    rec = run(build(wide, sample_rate=0.0))
    assert rec["sampled"] is False

    rec = run(build(wide, max_payload_bytes=16))
    assert len(rec["request_payload"]) < len(BODY)
    assert len(rec["response_payload"]) < len(BODY)


def test_end_to_end_heartbeat_disables_the_middleware(ingest):
    server = ingest(_reply(OFF))
    client = _client(server)
    mw = ApiLensASGIMiddleware(None, client, app_id="storefront", capture_spans=False)
    mw.client = client

    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok", "more_body": False})

    mw.app = app
    scope = {"type": "http", "method": "GET", "path": "/orders", "query_string": b"", "headers": []}

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(_message):
        return None

    asyncio.run(mw(scope, receive, send))
    assert len(client._queue) == 1
    client._queue.clear()
    client.send_heartbeat()
    asyncio.run(mw(scope, receive, send))
    assert _queued(client) == 0


# ── Django ──────────────────────────────────────────────────────────────────


urlpatterns: list = []


@pytest.fixture
def django_mw(monkeypatch):
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
    from django.http import HttpResponse

    fake = FakeClient()
    monkeypatch.setattr(apilens_django, "_client_singleton", fake)
    monkeypatch.setattr(settings, "APILENS_CAPTURE_SPANS", False, raising=False)
    mw = apilens_django.ApiLensDjangoMiddleware(
        lambda request: HttpResponse(BODY, content_type="application/json")
    )
    return mw, fake


def _django_request():
    from django.test import RequestFactory

    return RequestFactory().post("/orders", data=BODY, content_type="application/json", HTTP_X_TRACE="t")


def test_django_remote_disable_sends_no_record(django_mw):
    mw, fake = django_mw
    fake.current = Policy(enabled=False)
    mw(_django_request())
    assert fake.records == []
    assert fake.asked == ["orders-api"]


def test_django_remote_policy_narrows_capture(django_mw):
    mw, fake = django_mw
    fake.current = Policy(capture_headers=False, capture_response_body=False, max_payload_bytes=16)
    mw(_django_request())
    rec = fake.records[-1]
    assert rec["request_headers"] == "" and rec["response_headers"] == ""
    assert rec["response_payload"] == ""
    assert rec["request_payload"] and len(rec["request_payload"]) < len(BODY)


def test_django_remote_policy_never_widens(django_mw, monkeypatch):
    mw, fake = django_mw
    fake.current = Policy(max_payload_bytes=1 << 20)
    monkeypatch.setattr(mw, "capture_headers", False)
    monkeypatch.setattr(mw, "log_request_body", False)
    mw(_django_request())
    rec = fake.records[-1]
    assert rec["request_headers"] == "" and rec["request_payload"] == ""
