"""Built-in default masking patterns (Apitally parity) — always on, user patterns extend."""

from __future__ import annotations

import asyncio
import json
import re
from types import SimpleNamespace

import pytest

from apilens.client import _sanitize
from apilens.client._sanitize import (
    DEFAULT_MASK_BODY_FIELDS,
    DEFAULT_MASK_HEADER_PATTERNS,
    DEFAULT_MASK_QUERY_PARAMS,
    REDACTED,
    SENSITIVE_HEADERS,
    Redactor,
    serialize_headers,
)
from apilens.client.middleware import ApiLensASGIMiddleware


def test_default_pattern_lists_are_verbatim() -> None:
    assert DEFAULT_MASK_QUERY_PARAMS == (r"auth", r"api.?key", r"secret", r"token", r"password", r"pwd")
    assert DEFAULT_MASK_HEADER_PATTERNS == (r"auth", r"api.?key", r"secret", r"token", r"cookie")
    assert DEFAULT_MASK_BODY_FIELDS == (
        r"password",
        r"pwd",
        r"token",
        r"secret",
        r"auth",
        r"card.?number",
        r"ccv",
        r"cvv",
        r"cvc",
        r"ssn",
    )
    # The exact-name set is kept alongside the patterns.
    assert "x-amz-security-token" in SENSITIVE_HEADERS
    assert "proxy-authorization" in SENSITIVE_HEADERS


# ── Query params ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "name",
    ["auth", "api_key", "apikey", "api-key", "client_secret", "token", "access_token", "password", "pwd", "AUTH_CODE"],
)
def test_default_query_param_patterns(name: str) -> None:
    out = Redactor().redact_query(f"{name}=s3cr3t&page=2")
    assert out == f"{name}={REDACTED}&page=2"


def test_token_query_redacted_with_no_user_config() -> None:
    assert Redactor().redact_query("token=abc") == "token=[redacted]"


def test_query_without_sensitive_params_is_untouched_byte_for_byte() -> None:
    query = "q=hello%20world&page=2&tags=a+b"
    assert Redactor().redact_query(query) is query


def test_user_query_patterns_extend_defaults() -> None:
    out = Redactor(query_params=[r"^card_number$"]).redact_query("card_number=4242&token=t&page=1")
    assert out == f"card_number={REDACTED}&token={REDACTED}&page=1"


# ── Headers ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "name",
    ["x-auth-user", "x-apikey", "x-api_key", "x-client-secret", "x-refresh-token", "x-session-cookie"],
)
def test_default_header_patterns(name: str) -> None:
    for redactor in (None, Redactor()):
        blob = json.loads(serialize_headers({name: "v", "accept": "json"}, redactor=redactor))
        assert blob == {name: REDACTED, "accept": "json"}


def test_exact_sensitive_headers_still_apply() -> None:
    blob = json.loads(serialize_headers({"x-amz-security-token": "v", "set-cookie": "c"}))
    assert blob == {"x-amz-security-token": REDACTED, "set-cookie": REDACTED}


def test_user_header_patterns_extend_defaults() -> None:
    blob = json.loads(
        serialize_headers(
            {"x-internal": "v", "x-auth": "a", "accept": "json"},
            redactor=Redactor(headers=[r"^x-internal$"]),
        )
    )
    assert blob == {"x-internal": REDACTED, "x-auth": REDACTED, "accept": "json"}


# ── Body fields ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "field",
    ["password", "pwd", "token", "client_secret", "auth", "card_number", "cardnumber", "ccv", "cvv", "cvc", "ssn"],
)
def test_default_body_field_patterns(field: str) -> None:
    out = json.loads(Redactor().redact_body(json.dumps({field: "x", "name": "Ada"})))
    assert out == {field: REDACTED, "name": "Ada"}


def test_body_masks_numbers_as_well_as_strings() -> None:
    body = json.dumps({"card_number": 4242424242424242, "cvv": 123, "ssn": 1.5, "amount": 10})
    out = json.loads(Redactor().redact_body(body))
    assert out == {"card_number": REDACTED, "cvv": REDACTED, "ssn": REDACTED, "amount": 10}


def test_body_keeps_booleans_and_null() -> None:
    body = json.dumps({"token": None, "password_set": True, "user": {"auth": False}})
    assert Redactor().redact_body(body) == body


def test_body_nested_defaults() -> None:
    body = json.dumps({"user": {"name": "Ada", "password": "p"}, "items": [{"cvc": "1"}]})
    out = json.loads(Redactor().redact_body(body))
    assert out == {"user": {"name": "Ada", "password": REDACTED}, "items": [{"cvc": REDACTED}]}


def test_body_without_sensitive_fields_is_untouched_byte_for_byte() -> None:
    body = '{ "name": "Ada",\n  "amount": 10 }'
    assert Redactor().redact_body(body) is body


def test_user_body_patterns_extend_defaults() -> None:
    out = json.loads(Redactor(body_fields=[r"^iban$"]).redact_body('{"iban":"DE00","password":"p","n":1}'))
    assert out == {"iban": REDACTED, "password": REDACTED, "n": 1}


# ── Performance: compiled once per middleware ───────────────────────────────


def test_patterns_compiled_once_not_per_request(monkeypatch: pytest.MonkeyPatch) -> None:
    redactor = Redactor(query_params=[r"^x$"], headers=[r"^y$"], body_fields=[r"^z$"])
    for attr in ("query_params", "headers", "body_fields"):
        assert isinstance(getattr(redactor, attr), re.Pattern)

    def boom(*_a, **_k):
        raise AssertionError("regex compiled per request")

    monkeypatch.setattr(_sanitize.re, "compile", boom)
    assert redactor.redact_query("token=a&x=1") == f"token={REDACTED}&x={REDACTED}"
    assert json.loads(redactor.redact_body('{"password":"p","z":1}')) == {"password": REDACTED, "z": REDACTED}
    assert json.loads(serialize_headers({"x-auth": "a", "y": "b"}, redactor=redactor)) == {
        "x-auth": REDACTED,
        "y": REDACTED,
    }
    assert json.loads(serialize_headers({"x-auth": "a"})) == {"x-auth": REDACTED}


def test_invalid_user_pattern_fails_at_construction() -> None:
    with pytest.raises(re.error):
        Redactor(query_params=["("])


# ── End to end: ASGI middleware with no redaction config ────────────────────


class _FakeClient:
    def __init__(self) -> None:
        self.config = SimpleNamespace(project_slug="", environment="production")
        self.captured: list[dict] = []

    def capture(self, **kwargs) -> None:
        self.captured.append(kwargs)


def test_asgi_middleware_masks_token_query_without_config() -> None:
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": b'{"token":"t-123","ok":true}'})

    client = _FakeClient()
    mw = ApiLensASGIMiddleware(app, client, app_id="", capture_spans=False)

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/search",
        "query_string": b"token=abc&q=shoes",
        "headers": [(b"x-api-key", b"k"), (b"accept", b"*/*")],
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(_message):
        return None

    asyncio.run(mw(scope, receive, send))

    assert len(client.captured) == 1
    rec = client.captured[0]
    assert rec["raw_path"] == "/search?token=[redacted]&q=shoes"
    assert json.loads(rec["response_payload"]) == {"token": REDACTED, "ok": True}
