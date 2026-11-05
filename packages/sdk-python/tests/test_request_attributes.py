"""``set_request_attribute(key, value)``: custom attributes on the current request (issue #518).

Attributes land on the request record (``attributes`` on ``/v1/requests``), on
the server span, and on the ``RequestInfo`` / ``ResponseInfo`` handed to the
body-mask callbacks. Capped at 32 keys / 256-char values with a one-time
warning.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import threading
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

import apilens
from apilens.client._attributes import (
    MAX_ATTRIBUTES,
    MAX_VALUE_CHARS,
    _reset_warnings,
    begin_request_attributes,
    current_request_attributes,
    end_request_attributes,
    set_request_attribute,
    span_attributes,
)
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware
from apilens.client.models import RequestRecord


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
def _clean(monkeypatch):
    monkeypatch.delenv("APILENS_CAPTURE_SPANS", raising=False)
    monkeypatch.delenv("APILENS_EXCLUDE_PATHS", raising=False)
    monkeypatch.delenv("APILENS_EXCLUDE_USER_AGENTS", raising=False)
    _reset_warnings()
    yield
    _reset_warnings()


@pytest.fixture
def request_scope():
    token = begin_request_attributes()
    yield
    end_request_attributes(token)


# ── set_request_attribute: unit ─────────────────────────────────────────────


def test_exported_from_package() -> None:
    assert apilens.set_request_attribute is set_request_attribute
    assert "set_request_attribute" in apilens.__all__


def test_outside_a_request_is_a_noop() -> None:
    set_request_attribute("tenant.id", "acme")
    assert current_request_attributes() == {}


def test_values_keep_their_type_and_overwrite(request_scope) -> None:
    set_request_attribute("tenant.id", "acme")
    set_request_attribute("seats", 12)
    set_request_attribute("ratio", 0.5)
    set_request_attribute("beta", True)
    set_request_attribute("tenant.id", "globex")
    assert current_request_attributes() == {"tenant.id": "globex", "seats": 12, "ratio": 0.5, "beta": True}


def test_snapshot_is_a_copy(request_scope) -> None:
    set_request_attribute("a", 1)
    snap = current_request_attributes()
    snap["b"] = 2
    assert current_request_attributes() == {"a": 1}


def test_key_cap_drops_extra_keys_and_warns_once(request_scope, caplog) -> None:
    with caplog.at_level(logging.WARNING, logger="apilens"):
        for i in range(MAX_ATTRIBUTES + 5):
            set_request_attribute(f"k{i}", i)
        # Overwriting an existing key is still allowed at the cap.
        set_request_attribute("k0", "updated")
    attrs = current_request_attributes()
    assert len(attrs) == MAX_ATTRIBUTES
    assert attrs["k0"] == "updated" and f"k{MAX_ATTRIBUTES}" not in attrs
    warnings = [r for r in caplog.records if "at most" in r.getMessage()]
    assert len(warnings) == 1


def test_value_cap_truncates_and_warns_once(request_scope, caplog) -> None:
    with caplog.at_level(logging.WARNING, logger="apilens"):
        set_request_attribute("a", "x" * 1000)
        set_request_attribute("b", "y" * 300)
    attrs = current_request_attributes()
    assert attrs["a"] == "x" * MAX_VALUE_CHARS and attrs["b"] == "y" * MAX_VALUE_CHARS
    assert len([r for r in caplog.records if "capped" in r.getMessage()]) == 1


@pytest.mark.parametrize(
    "key,value",
    [
        ("", "v"),
        ("   ", "v"),
        (None, "v"),
        (3, "v"),
        ("k" * 200, "v"),
        ("obj", {"a": 1}),
        ("lst", [1]),
        ("none", None),
        ("nan", float("nan")),
        ("inf", float("inf")),
    ],
)
def test_invalid_input_is_dropped_never_raised(request_scope, caplog, key, value) -> None:
    with caplog.at_level(logging.WARNING, logger="apilens"):
        set_request_attribute(key, value)  # type: ignore[arg-type]
    assert current_request_attributes() == {}
    assert len(caplog.records) == 1


def test_requests_are_isolated() -> None:
    token = begin_request_attributes()
    set_request_attribute("a", 1)
    end_request_attributes(token)
    token = begin_request_attributes()
    assert current_request_attributes() == {}
    end_request_attributes(token)


def test_span_attributes_stringify() -> None:
    assert span_attributes({"b": True, "f": False, "n": 3, "x": 1.5, "s": "v"}) == {
        "b": "true",
        "f": "false",
        "n": "3",
        "x": "1.5",
        "s": "v",
    }


# ── RequestRecord wire format ───────────────────────────────────────────────


def _record(**kw) -> RequestRecord:
    return RequestRecord(
        timestamp=datetime(2026, 1, 1, tzinfo=timezone.utc),
        environment="test",
        method="GET",
        path="/orders",
        status_code=200,
        response_time_ms=1.0,
        **kw,
    )


def test_wire_carries_attributes_as_json_object() -> None:
    wire = _record(attributes={"tenant.id": "acme", "seats": 3, "beta": True, "r": 0.5}).to_wire()
    body = json.loads(json.dumps(wire))
    assert body["attributes"] == {"tenant.id": "acme", "seats": 3, "beta": True, "r": 0.5}


@pytest.mark.parametrize("attrs", [None, {}])
def test_wire_omits_empty_attributes(attrs) -> None:
    assert "attributes" not in _record(attributes=attrs).to_wire()


def test_client_capture_builds_record_with_attributes() -> None:
    client = apilens.ApiLensClient(apilens.ApiLensConfig(api_key="apilens_test", enabled=False))
    captured: list = []
    client.capture_record = captured.append  # type: ignore[method-assign]
    client.capture(method="GET", path="/", status_code=200, response_time_ms=1.0, attributes={"a": 1})
    client.capture(method="GET", path="/", status_code=200, response_time_ms=1.0)
    assert captured[0].attributes == {"a": 1} and captured[1].attributes is None


# ── ASGI ────────────────────────────────────────────────────────────────────


def _asgi_app(status: int = 200, attrs: dict | None = None, raise_exc: bool = False):
    async def app(scope, receive, send):
        await receive()
        for k, v in (attrs or {}).items():
            set_request_attribute(k, v)
        if raise_exc:
            raise RuntimeError("boom")
        await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": b'{"ok":true}'})

    return app


def _run_asgi(mw) -> None:
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/orders",
        "query_string": b"",
        "headers": [(b"content-type", b"application/json"), (b"host", b"example.com")],
        "client": ("127.0.0.1", 1234),
        "scheme": "http",
    }

    async def receive():
        return {"type": "http.request", "body": b'{"n":1}', "more_body": False}

    async def send(_message):
        return None

    async def run():
        try:
            await mw(scope, receive, send)
        except RuntimeError:
            pass

    asyncio.run(run())


ATTRS = {"tenant.id": "acme", "seats": 3, "beta": True}


def test_asgi_attributes_on_record_span_and_callbacks() -> None:
    seen: dict = {}

    def mask_req(info, body):
        seen["req"] = dict(info.attributes)
        return body

    def mask_res(info, body):
        seen["res"] = dict(info.attributes)
        seen["res_req"] = dict(info.request.attributes)
        return body

    client = FakeClient()
    mw = ApiLensASGIMiddleware(
        _asgi_app(attrs=ATTRS), client, app_id="orders-api", mask_request_body=mask_req, mask_response_body=mask_res
    )
    _run_asgi(mw)
    (rec,) = client.records
    assert rec["attributes"] == ATTRS
    assert seen == {"req": ATTRS, "res": ATTRS, "res_req": ATTRS}
    (span,) = [s for s in client.spans if s.kind == "server"]
    assert span.attributes == {"tenant.id": "acme", "seats": "3", "beta": "true"}
    assert span.to_wire()["attributes"]["tenant.id"] == "acme"
    # Store is reset once the request ends.
    assert current_request_attributes() == {}


def test_asgi_without_attributes_sends_none() -> None:
    client = FakeClient()
    _run_asgi(ApiLensASGIMiddleware(_asgi_app(), client, capture_spans=False))
    assert client.records[0]["attributes"] is None


def test_asgi_attributes_survive_handler_exception() -> None:
    client = FakeClient()
    _run_asgi(ApiLensASGIMiddleware(_asgi_app(attrs={"a": 1}, raise_exc=True), client, capture_spans=False))
    assert client.records[0]["attributes"] == {"a": 1}


def test_asgi_sampled_out_record_still_carries_attributes() -> None:
    client = FakeClient()
    _run_asgi(ApiLensASGIMiddleware(_asgi_app(attrs={"a": 1}), client, app_id="orders-api", sample_rate=0.0))
    (rec,) = client.records
    assert rec["sampled"] is False and rec["attributes"] == {"a": 1}
    assert client.spans == []


def test_asgi_attributes_from_child_task_are_seen() -> None:
    async def _set_in_task():
        set_request_attribute("from.task", "yes")

    async def app(scope, receive, send):
        await asyncio.create_task(_set_in_task())
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    client = FakeClient()
    _run_asgi(ApiLensASGIMiddleware(app, client, capture_spans=False))
    assert client.records[0]["attributes"] == {"from.task": "yes"}


# ── WSGI ────────────────────────────────────────────────────────────────────


def _run_wsgi(mw, attrs: dict) -> bytes:
    def app(environ, start_response):
        assert environ["wsgi.input"].read() == b'{"n":1}'
        for k, v in attrs.items():
            set_request_attribute(k, v)
        start_response("200 OK", [("Content-Type", "application/json")])
        return [b'{"ok":true}']

    mw.app = app
    environ = {
        "REQUEST_METHOD": "POST",
        "PATH_INFO": "/orders",
        "QUERY_STRING": "",
        "CONTENT_TYPE": "application/json",
        "CONTENT_LENGTH": "7",
        "HTTP_HOST": "example.com",
        "wsgi.url_scheme": "http",
        "wsgi.input": io.BytesIO(b'{"n":1}'),
    }
    return b"".join(mw(environ, lambda status, headers, exc_info=None: None))


def test_wsgi_attributes_on_record_span_and_callbacks() -> None:
    seen: dict = {}

    def mask_req(info, body):
        seen["req"] = dict(info.attributes)
        return body

    def mask_res(info, body):
        seen["res"] = dict(info.attributes)
        seen["same_request"] = info.request.attributes == info.attributes
        return body

    client = FakeClient()
    mw = ApiLensWSGIMiddleware(None, client, app_id="orders-api", mask_request_body=mask_req, mask_response_body=mask_res)
    assert _run_wsgi(mw, ATTRS) == b'{"ok":true}'
    (rec,) = client.records
    assert rec["attributes"] == ATTRS
    # The request body is still captured (masked after the handler ran).
    assert json.loads(rec["request_payload"]) == {"n": 1}
    assert seen == {"req": ATTRS, "res": ATTRS, "same_request": True}
    (span,) = [s for s in client.spans if s.kind == "server"]
    assert span.attributes == {"tenant.id": "acme", "seats": "3", "beta": "true"}
    assert current_request_attributes() == {}


def test_wsgi_requests_do_not_leak_attributes() -> None:
    client = FakeClient()
    mw = ApiLensWSGIMiddleware(None, client, capture_spans=False)
    _run_wsgi(mw, {"a": 1})
    _run_wsgi(mw, {})
    assert client.records[0]["attributes"] == {"a": 1}
    assert client.records[1]["attributes"] is None


def test_wsgi_concurrent_threads_are_isolated() -> None:
    client = FakeClient()
    barrier = threading.Barrier(4)

    def worker(i: int) -> None:
        def app(environ, start_response):
            set_request_attribute("worker", i)
            barrier.wait(timeout=5)
            start_response("200 OK", [])
            return [b""]

        mw = ApiLensWSGIMiddleware(app, client, capture_spans=False)
        environ = {"REQUEST_METHOD": "GET", "PATH_INFO": f"/w/{i}", "wsgi.input": io.BytesIO(b"")}
        b"".join(mw(environ, lambda *a: None))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(r["attributes"]["worker"] for r in client.records) == [0, 1, 2, 3]


# ── Django ──────────────────────────────────────────────────────────────────


@pytest.fixture
def django_client(monkeypatch):
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
    monkeypatch.setattr(settings, "APILENS_CAPTURE_SPANS", False, raising=False)
    return settings, client


urlpatterns: list = []


def test_django_attributes_on_record_and_callbacks(django_client, monkeypatch) -> None:
    settings, client = django_client
    seen: dict = {}

    def mask_req(info, body):
        seen["req"] = dict(info.attributes)
        return body

    def mask_res(info, body):
        seen["res"] = dict(info.attributes)
        return body

    monkeypatch.setattr(settings, "APILENS_MASK_REQUEST_BODY", mask_req, raising=False)
    monkeypatch.setattr(settings, "APILENS_MASK_RESPONSE_BODY", mask_res, raising=False)
    from django.http import HttpResponse
    from django.test import RequestFactory

    from apilens.django import ApiLensDjangoMiddleware
    from apilens.django import set_request_attribute as django_set

    def view(request):
        django_set("tenant.id", "acme")
        django_set("seats", 3)
        return HttpResponse("ok")

    mw = ApiLensDjangoMiddleware(view)
    mw(RequestFactory().post("/orders", data='{"n":1}', content_type="application/json"))
    rec = client.records[0]
    assert rec["attributes"] == {"tenant.id": "acme", "seats": 3}
    assert json.loads(rec["request_payload"]) == {"n": 1}
    assert seen == {"req": {"tenant.id": "acme", "seats": 3}, "res": {"tenant.id": "acme", "seats": 3}}
    assert current_request_attributes() == {}


def test_django_attributes_kept_when_view_raises(django_client) -> None:
    _settings, client = django_client
    from django.test import RequestFactory

    from apilens.django import ApiLensDjangoMiddleware

    def view(request):
        set_request_attribute("a", 1)
        raise RuntimeError("boom")

    mw = ApiLensDjangoMiddleware(view)
    with pytest.raises(RuntimeError):
        mw(RequestFactory().get("/orders"))
    assert client.records[0]["attributes"] == {"a": 1}
