"""``mask_request_body`` / ``mask_response_body``: user callbacks on raw bytes.

Order is callback -> regex field masking (user patterns + built-ins). A
callback that returns ``None`` or fails masks the whole body (fail closed).
"""

from __future__ import annotations

import asyncio
import io
import json
import sys
import types
from types import SimpleNamespace

import pytest

from apilens import RequestInfo, ResponseInfo
from apilens.client._sanitize import MASKED, REDACTED, Redactor, mask_body
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware

RAW_SECRET = "hunter2-raw-secret"


class FakeClient:
    def __init__(self) -> None:
        self.config = SimpleNamespace(project_slug="", environment="test")
        self.records: list[dict] = []

    def capture(self, **kwargs) -> None:
        self.records.append(kwargs)

    def capture_span(self, record) -> None:
        pass

    def capture_log(self, record) -> None:
        pass


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("APILENS_EXCLUDE_PATHS", raising=False)
    monkeypatch.delenv("APILENS_CAPTURE_SPANS", raising=False)


def _boom(info, body):
    raise ValueError("callback bug")


def _drop(info, body):
    return None


# ── mask_body: unit ─────────────────────────────────────────────────────────


def test_no_callback_is_regex_masking_only() -> None:
    assert json.loads(mask_body(b'{"password":"p","n":1}', redactor=Redactor())) == {"password": REDACTED, "n": 1}


def test_callback_runs_on_raw_bytes_before_decode() -> None:
    seen = {}

    def cb(info, body):
        seen["info"], seen["body"] = info, body
        return body.replace(b"secret=abc", b"secret=***")

    info = RequestInfo(method="POST", path="/login", headers={"content-type": "application/x-www-form-urlencoded"})
    out = mask_body(b"user=ada&secret=abc", redactor=Redactor(), masker=cb, info=info)
    assert out == "user=ada&secret=***"
    assert isinstance(seen["body"], bytes) and seen["body"] == b"user=ada&secret=abc"
    assert seen["info"] is info and info.content_type == "application/x-www-form-urlencoded"


def test_builtins_still_apply_to_callback_output() -> None:
    # The callback re-introduces sensitive fields; the built-in "password" and
    # "token" defaults still mask them, and a user pattern applies after too.
    def cb(info, body):
        return b'{"password":"from-callback","token":"t","iban":"DE00","n":1}'

    out = mask_body(b"<xml/>", redactor=Redactor(body_fields=[r"^iban$"]), masker=cb)
    assert json.loads(out) == {"password": REDACTED, "token": REDACTED, "iban": REDACTED, "n": 1}


def test_callback_none_masks_whole_body() -> None:
    assert mask_body(RAW_SECRET.encode(), redactor=Redactor(), masker=_drop) == MASKED


@pytest.mark.parametrize("bad", [_boom, lambda i, b: 123, lambda i, b: {"x": 1}])
def test_callback_failure_fails_closed(bad) -> None:
    out = mask_body(RAW_SECRET.encode(), redactor=Redactor(), masker=bad)
    assert out == MASKED
    assert RAW_SECRET not in out


def test_callback_may_return_str_or_bytearray() -> None:
    assert mask_body(b"x", redactor=Redactor(), masker=lambda i, b: "héllo") == "héllo"
    assert mask_body(b"x", redactor=Redactor(), masker=lambda i, b: bytearray(b"ok")) == "ok"


def test_empty_body_skips_callback() -> None:
    assert mask_body(b"", redactor=Redactor(), masker=_boom) == ""


# ── ASGI ────────────────────────────────────────────────────────────────────


def _run_asgi(mw, *, body: bytes, response: bytes, status: int = 200) -> None:
    async def app(scope, receive, send):
        await receive()
        await send({"type": "http.response.start", "status": status, "headers": [(b"Content-Type", b"text/plain")]})
        await send({"type": "http.response.body", "body": response})

    mw.app = app
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/login",
        "query_string": b"token=abc&q=1",
        "headers": [(b"Content-Type", b"application/x-www-form-urlencoded")],
    }

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(_message):
        return None

    asyncio.run(mw(scope, receive, send))


def test_asgi_callbacks_get_info_and_truncated_bytes() -> None:
    seen: dict = {}

    def mask_req(info, body):
        seen["req"] = (info, body)
        return body.replace(b"pw=hunt", b"pw=***")

    def mask_res(info, body):
        seen["res"] = (info, body)
        return b'{"password":"leak","ok":true}'

    client = FakeClient()
    mw = ApiLensASGIMiddleware(
        None,
        client,
        capture_spans=False,
        max_payload_bytes=16,
        mask_request_body=mask_req,
        mask_response_body=mask_res,
    )
    _run_asgi(mw, body=b"user=ada&pw=hunter2&tail", response=b"plain text response")

    req_info, req_body = seen["req"]
    assert isinstance(req_info, RequestInfo)
    assert req_body == b"user=ada&pw=hunt"  # truncated to max_payload_bytes
    assert req_info.method == "POST" and req_info.path == "/login"
    assert req_info.raw_path == "/login?token=[redacted]&q=1"
    assert req_info.content_type == "application/x-www-form-urlencoded"

    res_info, res_body = seen["res"]
    assert isinstance(res_info, ResponseInfo)
    assert res_body == b"plain text respo"
    assert res_info.status_code == 200 and res_info.content_type == "text/plain"
    assert res_info.request is req_info

    rec = client.records[0]
    assert rec["request_payload"] == "user=ada&pw=***"
    # Built-ins apply after the callback.
    assert json.loads(rec["response_payload"]) == {"password": REDACTED, "ok": True}


def test_asgi_callback_exception_masks_body() -> None:
    client = FakeClient()
    mw = ApiLensASGIMiddleware(None, client, capture_spans=False, mask_request_body=_boom, mask_response_body=_drop)
    _run_asgi(mw, body=RAW_SECRET.encode(), response=RAW_SECRET.encode())
    rec = client.records[0]
    assert rec["request_payload"] == MASKED
    assert rec["response_payload"] == MASKED


# ── WSGI ────────────────────────────────────────────────────────────────────


def _run_wsgi(mw, body: bytes, response: bytes) -> tuple[bytes, bytes]:
    seen = {}

    def app(environ, start_response):
        seen["input"] = environ["wsgi.input"].read()
        start_response("201 Created", [("Content-Type", "application/xml")])
        return [response]

    mw.app = app
    environ = {
        "REQUEST_METHOD": "POST",
        "PATH_INFO": "/orders",
        "QUERY_STRING": "",
        "CONTENT_TYPE": "application/xml",
        "CONTENT_LENGTH": str(len(body)),
        "HTTP_HOST": "example.com",
        "wsgi.url_scheme": "http",
        "wsgi.input": io.BytesIO(body),
    }
    out = b"".join(mw(environ, lambda status, headers, exc_info=None: None))
    return seen["input"], out


def test_wsgi_callbacks_mask_and_app_still_sees_raw_body() -> None:
    seen: dict = {}

    def mask_req(info, body):
        seen["req"] = info
        return body.replace(b"<ssn>123</ssn>", b"<ssn>***</ssn>")

    def mask_res(info, body):
        seen["res"] = info
        return b'{"cvv":"999","id":7}'

    client = FakeClient()
    mw = ApiLensWSGIMiddleware(None, client, capture_spans=False, mask_request_body=mask_req, mask_response_body=mask_res)
    body = b"<order><ssn>123</ssn></order>"
    app_input, out = _run_wsgi(mw, body, b"<ok/>")
    # Masking only touches the captured copy; the app reads the raw body.
    assert app_input == body and out == b"<ok/>"

    rec = client.records[0]
    assert rec["request_payload"] == "<order><ssn>***</ssn></order>"
    assert json.loads(rec["response_payload"]) == {"cvv": REDACTED, "id": 7}
    assert seen["req"].content_type == "application/xml" and seen["req"].path == "/orders"
    assert seen["res"].status_code == 201 and seen["res"].content_type == "application/xml"
    assert seen["res"].request is seen["req"]


def test_wsgi_callback_exception_masks_body() -> None:
    client = FakeClient()
    mw = ApiLensWSGIMiddleware(None, client, capture_spans=False, mask_request_body=_boom, mask_response_body=_boom)
    _run_wsgi(mw, RAW_SECRET.encode(), RAW_SECRET.encode())
    rec = client.records[0]
    assert rec["request_payload"] == MASKED and rec["response_payload"] == MASKED


# ── Django settings (callable or dotted path) ───────────────────────────────


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
    monkeypatch.setattr(settings, "APILENS_CAPTURE_SPANS", False, raising=False)
    return settings, client


urlpatterns: list = []


@pytest.fixture
def masker_module(monkeypatch):
    mod = types.ModuleType("apilens_test_maskers")

    def mask_request(info, body):
        return body.replace(b"card=4242", b"card=****")

    def mask_response(info, body):
        return b'{"secret":"s","status":' + str(info.status_code).encode() + b"}"

    mod.mask_request = mask_request
    mod.mask_response = mask_response
    mod.not_callable = 42
    monkeypatch.setitem(sys.modules, mod.__name__, mod)
    return mod


def test_django_dotted_path_settings(django_settings, masker_module, monkeypatch) -> None:
    settings, client = django_settings
    monkeypatch.setattr(settings, "APILENS_MASK_REQUEST_BODY", "apilens_test_maskers.mask_request", raising=False)
    monkeypatch.setattr(settings, "APILENS_MASK_RESPONSE_BODY", "apilens_test_maskers.mask_response", raising=False)
    from django.http import HttpResponse
    from django.test import RequestFactory

    from apilens.django import ApiLensDjangoMiddleware

    mw = ApiLensDjangoMiddleware(lambda request: HttpResponse("raw response", status=202))
    req = RequestFactory().post("/pay", data="card=4242&amount=1", content_type="application/x-www-form-urlencoded")
    assert mw(req).status_code == 202
    rec = client.records[0]
    assert rec["request_payload"] == "card=****&amount=1"
    assert json.loads(rec["response_payload"]) == {"secret": REDACTED, "status": 202}


def test_django_callable_setting_and_fail_closed(django_settings, monkeypatch) -> None:
    settings, client = django_settings
    monkeypatch.setattr(settings, "APILENS_MASK_REQUEST_BODY", _boom, raising=False)
    monkeypatch.setattr(settings, "APILENS_MASK_RESPONSE_BODY", _drop, raising=False)
    from django.http import HttpResponse
    from django.test import RequestFactory

    from apilens.django import ApiLensDjangoMiddleware

    mw = ApiLensDjangoMiddleware(lambda request: HttpResponse(RAW_SECRET))
    mw(RequestFactory().post("/pay", data=RAW_SECRET, content_type="text/plain"))
    rec = client.records[0]
    assert rec["request_payload"] == MASKED and rec["response_payload"] == MASKED


@pytest.mark.parametrize("target", ["apilens_test_maskers.missing", "apilens_test_maskers.not_callable", 42])
def test_django_bad_setting_raises_at_construction(django_settings, masker_module, monkeypatch, target) -> None:
    settings, _ = django_settings
    monkeypatch.setattr(settings, "APILENS_MASK_REQUEST_BODY", target, raising=False)
    from django.http import HttpResponse

    from apilens.django import ApiLensDjangoMiddleware

    with pytest.raises(RuntimeError):
        ApiLensDjangoMiddleware(lambda request: HttpResponse("ok"))
