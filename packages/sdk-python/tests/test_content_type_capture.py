"""Content-type aware body capture.

Bodies are captured only for JSON, ``+json``, ``text/*`` and form-encoded
content. Form-encoded bodies are masked field by field; any other body
(multipart, binary) is never buffered and is stored as an
``[<content-type>, N bytes omitted]`` placeholder. ``capture_content_types``
replaces the default list.
"""

from __future__ import annotations

import asyncio
import io
import json
from types import SimpleNamespace

import pytest

from apilens.client._sanitize import (
    DEFAULT_CAPTURE_CONTENT_TYPES,
    REDACTED,
    ContentTypeFilter,
    Redactor,
    capture_body,
    mask_body,
    omitted_body,
)
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware

FORM = "application/x-www-form-urlencoded"
MULTIPART = "multipart/form-data; boundary=xyz"
MULTIPART_BODY = (
    b"--xyz\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.bin\"\r\n"
    b"Content-Type: application/octet-stream\r\n\r\n" + bytes(range(256)) * 4 + b"\r\n--xyz--\r\n"
)
PNG_BODY = b"\x89PNG\r\n\x1a\n" + b"\x00" * 120


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


class NoBuffer(bytes):
    """A body chunk that fails the test if the middleware slices (buffers) it."""

    def __getitem__(self, key):
        raise AssertionError("body of a non-captured content type was buffered")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("APILENS_EXCLUDE_PATHS", raising=False)
    monkeypatch.delenv("APILENS_CAPTURE_SPANS", raising=False)


# ── ContentTypeFilter / omitted_body: unit ──────────────────────────────────


@pytest.mark.parametrize(
    "content_type",
    [
        "application/json",
        "Application/JSON; charset=utf-8",
        "application/problem+json",
        "application/vnd.api+json",
        "text/plain",
        "text/html; charset=utf-8",
        "text/csv",
        FORM,
        f"{FORM}; charset=utf-8",
    ],
)
def test_default_filter_captures_json_text_and_form(content_type) -> None:
    assert ContentTypeFilter().allows(content_type)


@pytest.mark.parametrize(
    "content_type",
    [
        MULTIPART,
        "image/png",
        "application/octet-stream",
        "application/pdf",
        "application/zip",
        "application/xml",
        "",
        None,
    ],
)
def test_default_filter_omits_multipart_binary_and_unknown(content_type) -> None:
    assert not ContentTypeFilter().allows(content_type)


def test_override_replaces_defaults() -> None:
    f = ContentTypeFilter(["application/xml", "Application/*+XML"])
    assert f.allows("application/xml") and f.allows("application/atom+xml")
    assert not f.allows("application/json") and not f.allows("text/plain")
    assert ContentTypeFilter("application/json, text/csv").patterns == ("application/json", "text/csv")
    assert ContentTypeFilter().patterns == DEFAULT_CAPTURE_CONTENT_TYPES


def test_omitted_placeholder() -> None:
    assert omitted_body(MULTIPART, 1234) == "[multipart/form-data, 1234 bytes omitted]"
    assert omitted_body("IMAGE/PNG", 5) == "[image/png, 5 bytes omitted]"
    assert omitted_body("", 3) == "[application/octet-stream, 3 bytes omitted]"
    assert omitted_body("image/png", 0) == ""


# ── form-encoded masking: unit ──────────────────────────────────────────────


def test_form_password_is_masked() -> None:
    assert Redactor().redact_form("user=ada&password=x") == "user=ada&password=[redacted]"


def test_form_uses_body_and_query_patterns() -> None:
    r = Redactor(body_fields=[r"^iban$"])
    out = r.redact_form("iban=DE00&api_key=k&card_number=4242&n=1")
    assert out == f"iban={REDACTED}&api_key={REDACTED}&card_number={REDACTED}&n=1"


def test_form_without_sensitive_fields_is_byte_for_byte() -> None:
    body = "q=red+shoes&page=2&tag=%C3%A9"
    assert Redactor().redact_form(body) == body


def test_mask_body_picks_masking_by_content_type() -> None:
    r = Redactor()
    assert mask_body(b"password=x&a=1", redactor=r, content_type=FORM) == "password=[redacted]&a=1"
    assert json.loads(mask_body(b'{"password":"x"}', redactor=r, content_type="application/json")) == {
        "password": REDACTED
    }
    assert mask_body(b"password=x", redactor=r, content_type="text/plain") == "password=x"


def test_capture_body_omits_without_calling_masker() -> None:
    def masker(info, body):
        raise AssertionError("masker must not run for an omitted body")

    out = capture_body(
        b"",
        size=99,
        content_type="application/pdf",
        content_types=ContentTypeFilter(),
        redactor=Redactor(),
        masker=masker,
    )
    assert out == "[application/pdf, 99 bytes omitted]"


# ── ASGI: request and response sides ────────────────────────────────────────


def _run_asgi(
    mw,
    *,
    request_type: str,
    request_chunks: list[bytes],
    response_type: str = "application/json",
    response_chunks: list[bytes] | None = None,
    content_length: int | None = None,
) -> dict:
    response_chunks = response_chunks if response_chunks is not None else [b'{"ok":true}']

    async def app(scope, receive, send):
        while True:
            message = await receive()
            if not message.get("more_body"):
                break
        await send(
            {"type": "http.response.start", "status": 200, "headers": [(b"content-type", response_type.encode())]}
        )
        for i, chunk in enumerate(response_chunks):
            more = i < len(response_chunks) - 1
            await send({"type": "http.response.body", "body": chunk, "more_body": more})

    mw.app = app
    headers = [(b"content-type", request_type.encode())] if request_type else []
    if content_length is not None:
        headers.append((b"content-length", str(content_length).encode()))
    scope = {"type": "http", "method": "POST", "path": "/upload", "query_string": b"", "headers": headers}
    messages = [
        {"type": "http.request", "body": c, "more_body": i < len(request_chunks) - 1}
        for i, c in enumerate(request_chunks)
    ]

    async def receive():
        return messages.pop(0)

    async def send(_message):
        return None

    asyncio.run(mw(scope, receive, send))
    return mw.client.records[-1]


def _asgi(**kwargs) -> ApiLensASGIMiddleware:
    return ApiLensASGIMiddleware(None, FakeClient(), capture_spans=False, **kwargs)


def test_asgi_json_request_and_response_captured_and_masked() -> None:
    rec = _run_asgi(
        _asgi(),
        request_type="application/json; charset=utf-8",
        request_chunks=[b'{"password":"x",', b'"n":1}'],
        response_type="application/problem+json",
        response_chunks=[b'{"token":"t","title":"bad"}'],
    )
    assert json.loads(rec["request_payload"]) == {"password": REDACTED, "n": 1}
    assert json.loads(rec["response_payload"]) == {"token": REDACTED, "title": "bad"}


def test_asgi_text_request_and_response_captured() -> None:
    rec = _run_asgi(
        _asgi(),
        request_type="text/plain",
        request_chunks=[b"hello"],
        response_type="text/html; charset=utf-8",
        response_chunks=[b"<p>hi</p>"],
    )
    assert rec["request_payload"] == "hello"
    assert rec["response_payload"] == "<p>hi</p>"


def test_asgi_form_request_and_response_masked() -> None:
    rec = _run_asgi(
        _asgi(),
        request_type=FORM,
        request_chunks=[b"user=ada&password=x"],
        response_type=FORM,
        response_chunks=[b"access_token=abc&expires=3600"],
    )
    assert rec["request_payload"] == "user=ada&password=[redacted]"
    assert rec["response_payload"] == "access_token=[redacted]&expires=3600"


def test_asgi_multipart_request_stores_placeholder_without_buffering() -> None:
    half = len(MULTIPART_BODY) // 2
    chunks = [NoBuffer(MULTIPART_BODY[:half]), NoBuffer(MULTIPART_BODY[half:])]
    rec = _run_asgi(_asgi(), request_type=MULTIPART, request_chunks=chunks)
    assert rec["request_payload"] == f"[multipart/form-data, {len(MULTIPART_BODY)} bytes omitted]"
    assert json.loads(rec["response_payload"]) == {"ok": True}


def test_asgi_binary_response_stores_placeholder_without_buffering() -> None:
    rec = _run_asgi(
        _asgi(),
        request_type="application/json",
        request_chunks=[b"{}"],
        response_type="image/png",
        response_chunks=[NoBuffer(PNG_BODY[:50]), NoBuffer(PNG_BODY[50:])],
    )
    assert rec["response_payload"] == f"[image/png, {len(PNG_BODY)} bytes omitted]"
    assert rec["response_size"] == len(PNG_BODY)


def test_asgi_missing_content_type_is_omitted() -> None:
    rec = _run_asgi(_asgi(), request_type="", request_chunks=[b"\x00\x01\x02"])
    assert rec["request_payload"] == "[application/octet-stream, 3 bytes omitted]"


def test_asgi_unread_body_uses_content_length() -> None:
    mw = _asgi()

    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 413, "headers": [(b"content-type", b"text/plain")]})
        await send({"type": "http.response.body", "body": b"too big"})

    mw.app = app
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/upload",
        "query_string": b"",
        "headers": [(b"content-type", b"application/zip"), (b"content-length", b"5000000")],
    }

    async def receive():
        raise AssertionError("not read")

    async def send(_message):
        return None

    asyncio.run(mw(scope, receive, send))
    rec = mw.client.records[-1]
    assert rec["request_payload"] == "[application/zip, 5000000 bytes omitted]"
    assert rec["response_payload"] == "too big"


def test_asgi_empty_omitted_body_stays_empty() -> None:
    rec = _run_asgi(_asgi(), request_type="", request_chunks=[b""], response_type="image/png", response_chunks=[b""])
    assert rec["request_payload"] == "" and rec["response_payload"] == ""


def test_asgi_capture_content_types_override() -> None:
    mw = _asgi(capture_content_types=["application/xml"])
    rec = _run_asgi(
        mw,
        request_type="application/xml",
        request_chunks=[b"<a/>"],
        response_type="application/json",
        response_chunks=[b'{"ok":true}'],
    )
    assert rec["request_payload"] == "<a/>"
    assert rec["response_payload"] == "[application/json, 11 bytes omitted]"


def test_asgi_no_placeholder_when_body_capture_is_off() -> None:
    rec = _run_asgi(
        _asgi(log_request_body=False, log_response_body=False),
        request_type=MULTIPART,
        request_chunks=[MULTIPART_BODY],
        response_type="image/png",
        response_chunks=[PNG_BODY],
    )
    assert rec["request_payload"] == "" and rec["response_payload"] == ""


def test_asgi_no_placeholder_when_sampled_out() -> None:
    rec = _run_asgi(
        _asgi(sample_rate=0.0),
        request_type=MULTIPART,
        request_chunks=[MULTIPART_BODY],
        response_type="image/png",
        response_chunks=[PNG_BODY],
    )
    assert rec["request_payload"] == "" and rec["response_payload"] == ""


# ── WSGI: request and response sides ────────────────────────────────────────


class TrackedStream(io.BytesIO):
    """Records whether anything other than the app read the request stream."""

    def __init__(self, data: bytes) -> None:
        super().__init__(data)
        self.read_by_app = False
        self.reads_before_app = 0

    def read(self, *args):
        if not self.read_by_app:
            self.reads_before_app += 1
        return super().read(*args)


def _run_wsgi(mw, *, request_type: str, body: bytes, response_type: str, response: list[bytes]):
    seen: dict = {}
    stream = TrackedStream(body)

    def app(environ, start_response):
        inp = environ["wsgi.input"]
        if isinstance(inp, TrackedStream):
            inp.read_by_app = True
        seen["input"] = inp.read()
        start_response("200 OK", [("Content-Type", response_type)])
        return response

    mw.app = app
    environ = {
        "REQUEST_METHOD": "POST",
        "PATH_INFO": "/upload",
        "QUERY_STRING": "",
        "CONTENT_LENGTH": str(len(body)),
        "HTTP_HOST": "example.com",
        "wsgi.url_scheme": "http",
        "wsgi.input": stream,
    }
    if request_type:
        environ["CONTENT_TYPE"] = request_type
    out = b"".join(mw(environ, lambda status, headers, exc_info=None: None))
    return mw.client.records[-1], seen["input"], stream, out


def _wsgi(**kwargs) -> ApiLensWSGIMiddleware:
    return ApiLensWSGIMiddleware(None, FakeClient(), capture_spans=False, **kwargs)


def test_wsgi_json_request_and_response_captured_and_masked() -> None:
    rec, _, _, _ = _run_wsgi(
        _wsgi(),
        request_type="application/json",
        body=b'{"password":"x","n":1}',
        response_type="application/vnd.api+json",
        response=[b'{"secret":"s"}'],
    )
    assert json.loads(rec["request_payload"]) == {"password": REDACTED, "n": 1}
    assert json.loads(rec["response_payload"]) == {"secret": REDACTED}


def test_wsgi_text_request_and_response_captured() -> None:
    rec, _, _, _ = _run_wsgi(
        _wsgi(), request_type="text/csv", body=b"a,b\n1,2", response_type="text/plain", response=[b"ok"]
    )
    assert rec["request_payload"] == "a,b\n1,2" and rec["response_payload"] == "ok"


def test_wsgi_form_request_and_response_masked() -> None:
    rec, app_input, _, _ = _run_wsgi(
        _wsgi(),
        request_type=FORM,
        body=b"user=ada&password=x",
        response_type=FORM,
        response=[b"token=abc&ok=1"],
    )
    assert app_input == b"user=ada&password=x"  # the app still gets the raw body
    assert rec["request_payload"] == "user=ada&password=[redacted]"
    assert rec["response_payload"] == "token=[redacted]&ok=1"


def test_wsgi_multipart_request_is_not_read_by_middleware() -> None:
    rec, app_input, stream, _ = _run_wsgi(
        _wsgi(), request_type=MULTIPART, body=MULTIPART_BODY, response_type="application/json", response=[b"{}"]
    )
    assert stream.reads_before_app == 0
    assert app_input == MULTIPART_BODY
    assert rec["request_payload"] == f"[multipart/form-data, {len(MULTIPART_BODY)} bytes omitted]"


def test_wsgi_binary_response_stores_placeholder_without_buffering() -> None:
    rec, _, _, out = _run_wsgi(
        _wsgi(),
        request_type="application/json",
        body=b"{}",
        response_type="application/octet-stream",
        response=[NoBuffer(PNG_BODY[:40]), NoBuffer(PNG_BODY[40:])],
    )
    assert out == PNG_BODY
    assert rec["response_payload"] == f"[application/octet-stream, {len(PNG_BODY)} bytes omitted]"


def test_wsgi_capture_content_types_override() -> None:
    rec, _, _, _ = _run_wsgi(
        _wsgi(capture_content_types=["multipart/*"]),
        request_type=MULTIPART,
        body=b"--xyz--",
        response_type="text/plain",
        response=[b"ok"],
    )
    assert rec["request_payload"] == "--xyz--"
    assert rec["response_payload"] == "[text/plain, 2 bytes omitted]"


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
    monkeypatch.setattr(settings, "APILENS_CAPTURE_SPANS", False, raising=False)
    return settings, client


urlpatterns: list = []


def test_django_form_masked_and_binary_response_omitted(django_settings) -> None:
    _, client = django_settings
    from django.http import HttpResponse
    from django.test import RequestFactory

    from apilens.django import ApiLensDjangoMiddleware

    mw = ApiLensDjangoMiddleware(lambda request: HttpResponse(PNG_BODY, content_type="image/png"))
    mw(RequestFactory().post("/login", data="user=ada&password=x", content_type=FORM))
    rec = client.records[-1]
    assert rec["request_payload"] == "user=ada&password=[redacted]"
    assert rec["response_payload"] == f"[image/png, {len(PNG_BODY)} bytes omitted]"


def test_django_multipart_request_omitted_and_setting_override(django_settings, monkeypatch) -> None:
    settings, client = django_settings
    from django.http import HttpResponse
    from django.test import RequestFactory

    from apilens.django import ApiLensDjangoMiddleware

    mw = ApiLensDjangoMiddleware(lambda request: HttpResponse('{"ok":true}', content_type="application/json"))
    mw(RequestFactory().post("/upload", data=MULTIPART_BODY, content_type=MULTIPART))
    rec = client.records[-1]
    assert rec["request_payload"] == f"[multipart/form-data, {len(MULTIPART_BODY)} bytes omitted]"
    assert rec["response_payload"] == '{"ok":true}'

    monkeypatch.setattr(settings, "APILENS_CAPTURE_CONTENT_TYPES", "text/*", raising=False)
    mw = ApiLensDjangoMiddleware(lambda request: HttpResponse('{"ok":true}', content_type="application/json"))
    mw(RequestFactory().post("/upload", data="hi", content_type="text/plain"))
    rec = client.records[-1]
    assert rec["request_payload"] == "hi"
    assert rec["response_payload"] == "[application/json, 11 bytes omitted]"
