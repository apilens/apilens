"""Validation errors (FastAPI/Ninja 422, Litestar 400) -> ``validation_errors``.

The middlewares parse a framework validation response into
``[{loc, msg, type}]`` (at most 20, ``loc`` dotted) on the request record,
even when the response body is not captured or the detail was sampled out.
``loc`` segments beneath a masked body field become ``[redacted]``; the
rejected ``input`` never leaves the app. Parsing failures are silent.
"""

# No ``from __future__ import annotations``: the live framework tests define
# their models inside the test, and FastAPI, Litestar and Ninja resolve
# handler annotations from module globals.
import asyncio
import datetime
import json
import types
from types import SimpleNamespace

import pytest

from apilens.client._sanitize import REDACTED, Redactor
from apilens.client._validation import parse_validation_errors
from apilens.client.middleware import ApiLensASGIMiddleware
from apilens.client.models import RequestRecord

# Real bodies, captured from FastAPI 0.12x / pydantic 2, django-ninja 1.x and
# Litestar 2.x for the same invalid request
# (POST ?limit=x {"age": "nope", "tags": {"a": "b"}}).
FASTAPI_422 = (
    b'{"detail":[{"type":"int_parsing","loc":["query","limit"],"msg":"Input should be a valid integer, '
    b'unable to parse string as an integer","input":"x"},{"type":"missing","loc":["body","email"],'
    b'"msg":"Field required","input":{"age":"nope","tags":{"a":"b"}}},{"type":"int_parsing",'
    b'"loc":["body","age"],"msg":"Input should be a valid integer, unable to parse string as an integer",'
    b'"input":"nope"},{"type":"int_parsing","loc":["body","tags","a"],"msg":"Input should be a valid '
    b'integer, unable to parse string as an integer","input":"b"}]}'
)
NINJA_422 = (
    b'{"detail": [{"type": "missing", "loc": ["body", "payload", "email"], "msg": "Field required"}, '
    b'{"type": "int_parsing", "loc": ["body", "payload", "age"], "msg": "Input should be a valid integer, '
    b'unable to parse string as an integer"}, {"type": "int_parsing", "loc": ["query", "limit"], '
    b'"msg": "Input should be a valid integer, unable to parse string as an integer"}]}'
)
LITESTAR_400 = (
    b'{"status_code":400,"detail":"Validation failed for POST /d?limit=x","extra":[{"message":'
    b'"Expected `int`, got `str`","key":"age","source":"body"},{"message":"Expected `int`, got `str`",'
    b'"key":"limit","source":"query"}]}'
)
INT_MSG = "Input should be a valid integer, unable to parse string as an integer"


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


# ── parser: unit ────────────────────────────────────────────────────────────


def test_fastapi_body_parsed_without_input() -> None:
    out = parse_validation_errors(422, FASTAPI_422, "application/json")
    assert out == [
        {"loc": "query.limit", "msg": INT_MSG, "type": "int_parsing"},
        {"loc": "body.email", "msg": "Field required", "type": "missing"},
        {"loc": "body.age", "msg": INT_MSG, "type": "int_parsing"},
        {"loc": "body.tags.a", "msg": INT_MSG, "type": "int_parsing"},
    ]
    assert "nope" not in json.dumps(out)  # the rejected input is never kept


def test_ninja_body_parsed() -> None:
    out = parse_validation_errors(422, NINJA_422, "application/json; charset=utf-8")
    assert [e["loc"] for e in out] == ["body.payload.email", "body.payload.age", "query.limit"]
    assert out[0] == {"loc": "body.payload.email", "msg": "Field required", "type": "missing"}


def test_litestar_body_parsed() -> None:
    out = parse_validation_errors(400, LITESTAR_400, "application/json")
    assert out == [
        {"loc": "body.age", "msg": "Expected `int`, got `str`", "type": ""},
        {"loc": "query.limit", "msg": "Expected `int`, got `str`", "type": ""},
    ]


def test_loc_string_and_numeric_segments() -> None:
    body = json.dumps(
        {"detail": [{"loc": ["body", "items", 0, "name"], "msg": "bad", "type": "t"}, {"loc": "a.b", "msg": "m"}]}
    )
    out = parse_validation_errors(422, body, "application/json")
    assert out == [{"loc": "body.items.0.name", "msg": "bad", "type": "t"}, {"loc": "a.b", "msg": "m", "type": ""}]


def test_capped_at_20() -> None:
    body = json.dumps({"detail": [{"loc": ["body", f"f{i}"], "msg": "m", "type": "t"} for i in range(50)]})
    out = parse_validation_errors(422, body, "application/json")
    assert len(out) == 20 and out[-1]["loc"] == "body.f19"


def test_loc_beneath_masked_field_is_redacted() -> None:
    body = json.dumps(
        {
            "detail": [
                {"loc": ["body", "tokens", "sk_live_abc", "scope"], "msg": "m", "type": "t"},
                {"loc": ["body", "iban"], "msg": "m", "type": "t"},
                {"loc": ["body", "accounts", "DE001234"], "msg": "m", "type": "t"},
                {"loc": ["body", "name"], "msg": "m", "type": "t"},
            ]
        }
    )
    out = parse_validation_errors(422, body, "application/json", Redactor(body_fields=[r"^accounts$"]))
    assert [e["loc"] for e in out] == [
        f"body.tokens.{REDACTED}.{REDACTED}",  # built-in "token" pattern
        "body.iban",  # a masked field's own name stays visible
        f"body.accounts.{REDACTED}",  # user redact_body_fields pattern
        "body.name",
    ]


@pytest.mark.parametrize(
    "status,body,content_type",
    [
        (200, FASTAPI_422, "application/json"),  # not a validation status
        (500, FASTAPI_422, "application/json"),
        (422, FASTAPI_422, "text/html"),  # not JSON
        (422, FASTAPI_422[:-10], "application/json"),  # truncated
        (422, b"not json", "application/json"),
        (422, b"[1,2]", "application/json"),
        (422, b'{"detail":"Unprocessable"}', "application/json"),
        (422, b'{"detail":[{"msg":"no loc"}]}', "application/json"),
        (422, b'{"detail":[{"loc":["body"],"msg":""}]}', "application/json"),
        (400, b'{"detail":"Bad request"}', "application/json"),
        (422, b"", "application/json"),
        (422, None, None),
    ],
)
def test_unrecognised_bodies_are_silently_none(status, body, content_type) -> None:
    assert parse_validation_errors(status, body, content_type) is None


# ── wire format ─────────────────────────────────────────────────────────────


def _record(**kw) -> RequestRecord:
    return RequestRecord(
        timestamp=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
        environment="test",
        method="POST",
        path="/items",
        status_code=422,
        response_time_ms=1.0,
        **kw,
    )


def test_wire_serialises_validation_errors() -> None:
    errors = [{"loc": "body.email", "msg": "Field required", "type": "missing"}]
    assert _record(validation_errors=errors).to_wire()["validation_errors"] == errors


def test_wire_omits_empty_validation_errors() -> None:
    assert "validation_errors" not in _record().to_wire()
    assert "validation_errors" not in _record(validation_errors=[]).to_wire()


# ── ASGI middleware ─────────────────────────────────────────────────────────


def _run_asgi(mw, *, status: int, chunks: list[bytes], content_type: str = "application/json") -> dict:
    async def app(scope, receive, send):
        await receive()
        await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", content_type.encode())]})
        for i, chunk in enumerate(chunks):
            await send({"type": "http.response.body", "body": chunk, "more_body": i < len(chunks) - 1})

    mw.app = app
    scope = {"type": "http", "method": "POST", "path": "/items", "query_string": b"limit=x", "headers": []}

    async def receive():
        return {"type": "http.request", "body": b"{}", "more_body": False}

    async def send(_message):
        return None

    asyncio.run(mw(scope, receive, send))
    return mw.client.records[-1]


def _asgi(**kwargs) -> ApiLensASGIMiddleware:
    return ApiLensASGIMiddleware(None, FakeClient(), capture_spans=False, **kwargs)


def test_asgi_parses_chunked_422() -> None:
    rec = _run_asgi(_asgi(), status=422, chunks=[FASTAPI_422[:40], FASTAPI_422[40:]])
    assert [e["loc"] for e in rec["validation_errors"]] == ["query.limit", "body.email", "body.age", "body.tags.a"]


def test_asgi_parses_with_response_body_logging_off() -> None:
    rec = _run_asgi(_asgi(log_response_body=False), status=422, chunks=[FASTAPI_422])
    assert rec["response_payload"] == ""
    assert len(rec["validation_errors"]) == 4


def test_asgi_parses_when_request_logging_off_or_sampled_out() -> None:
    for mw in (_asgi(enable_request_logging=False), _asgi(sample_rate=0.0)):
        rec = _run_asgi(mw, status=422, chunks=[FASTAPI_422])
        assert rec["response_payload"] == "" and len(rec["validation_errors"]) == 4


def test_asgi_litestar_400() -> None:
    rec = _run_asgi(_asgi(), status=400, chunks=[LITESTAR_400])
    assert [e["loc"] for e in rec["validation_errors"]] == ["body.age", "query.limit"]


def test_asgi_masks_loc_with_redact_body_fields() -> None:
    rec = _run_asgi(_asgi(redact_body_fields=[r"^tags$"]), status=422, chunks=[FASTAPI_422])
    assert rec["validation_errors"][-1]["loc"] == f"body.tags.{REDACTED}"


def test_asgi_non_validation_responses_have_none() -> None:
    assert _run_asgi(_asgi(), status=200, chunks=[b'{"ok":true}'])["validation_errors"] is None
    assert _run_asgi(_asgi(), status=422, chunks=[b"oops"], content_type="text/plain")["validation_errors"] is None


def test_asgi_oversized_body_is_skipped(monkeypatch) -> None:
    import apilens.client.middleware as middleware

    monkeypatch.setattr(middleware, "MAX_VALIDATION_BODY_BYTES", 64)
    rec = _run_asgi(_asgi(), status=422, chunks=[FASTAPI_422[:50], FASTAPI_422[50:]])
    assert rec["validation_errors"] is None


# ── live frameworks (skipped when not installed) ────────────────────────────


def test_fastapi_end_to_end() -> None:
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from fastapi import FastAPI
    from pydantic import BaseModel
    from starlette.testclient import TestClient

    from apilens.frameworks.fastapi import instrument_fastapi

    class Item(BaseModel):
        email: str
        age: int

    client = FakeClient()
    app = FastAPI()

    @app.post("/items")
    def _create(item: Item, limit: int = 10):
        return item

    instrument_fastapi(app, client, app_id="", capture_spans=False, log_response_body=False)
    resp = TestClient(app).post("/items?limit=x", json={"age": "nope"})
    assert resp.status_code == 422
    errors = client.records[-1]["validation_errors"]
    assert {e["loc"] for e in errors} == {"query.limit", "body.email", "body.age"}
    assert {"loc": "body.email", "msg": "Field required", "type": "missing"} in errors


def test_litestar_end_to_end() -> None:
    pytest.importorskip("litestar")
    from dataclasses import dataclass

    from litestar import Litestar, post
    from litestar.testing import TestClient

    from apilens.litestar import ApiLensPlugin

    @dataclass
    class Item:
        email: str
        age: int

    @post("/items")
    async def _create(data: Item) -> Item:
        return data

    client = FakeClient()
    app = Litestar(route_handlers=[_create], plugins=[ApiLensPlugin(client=client, app_id="", capture_spans=False)])
    with TestClient(app=app) as tc:
        resp = tc.post("/items", json={"email": "a@example.com", "age": "nope"})
    assert resp.status_code == 400
    errors = client.records[-1]["validation_errors"]
    assert errors and errors[0]["loc"] == "body.age"


# ── Django / Django Ninja ───────────────────────────────────────────────────


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


def test_django_ninja_422_body(django_client, monkeypatch) -> None:
    settings, client = django_client
    # Body capture off (cap 0): validation errors are still parsed and masked.
    monkeypatch.setattr(settings, "APILENS_MAX_PAYLOAD_BYTES", 0, raising=False)
    monkeypatch.setattr(settings, "APILENS_REDACT_BODY_FIELDS", [r"^payload$"], raising=False)
    from django.http import HttpResponse
    from django.test import RequestFactory

    from apilens.django import ApiLensDjangoMiddleware

    mw = ApiLensDjangoMiddleware(
        lambda request: HttpResponse(NINJA_422, status=422, content_type="application/json; charset=utf-8")
    )
    assert mw(RequestFactory().post("/api/n?limit=x", data="{}", content_type="application/json")).status_code == 422
    rec = client.records[0]
    assert rec["response_payload"] == ""
    assert [e["loc"] for e in rec["validation_errors"]] == [
        f"body.payload.{REDACTED}",
        f"body.payload.{REDACTED}",
        "query.limit",
    ]


def test_django_non_validation_response(django_client) -> None:
    _, client = django_client
    from django.http import HttpResponse
    from django.test import RequestFactory

    from apilens.django import ApiLensDjangoMiddleware

    mw = ApiLensDjangoMiddleware(lambda request: HttpResponse("ok"))
    mw(RequestFactory().get("/ok"))
    assert client.records[0]["validation_errors"] is None


def test_django_ninja_end_to_end(django_client) -> None:
    pytest.importorskip("ninja")
    _, client = django_client
    from django.test import RequestFactory
    from django.urls import path, resolve
    from ninja import NinjaAPI, Schema

    from apilens.django import ApiLensDjangoMiddleware

    class Payload(Schema):
        email: str
        age: int

    api = NinjaAPI(urls_namespace="apilens-validation-test")

    @api.post("/n")
    def _n(request, payload: Payload, limit: int):
        return {}

    urlconf = types.ModuleType("apilens_test_ninja_urls")
    urlconf.urlpatterns = [path("api/", api.urls)]

    def get_response(request):
        match = resolve(request.path_info, urlconf=urlconf)
        return match.func(request, *match.args, **match.kwargs)

    mw = ApiLensDjangoMiddleware(get_response)
    req = RequestFactory().post("/api/n?limit=x", data='{"age":"nope"}', content_type="application/json")
    assert mw(req).status_code == 422
    errors = client.records[0]["validation_errors"]
    assert {e["loc"] for e in errors} == {"body.payload.email", "body.payload.age", "query.limit"}
