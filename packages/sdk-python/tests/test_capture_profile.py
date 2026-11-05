"""``capture_profile`` presets (issue #524).

``metadata`` drops headers, bodies and validation errors; ``redacted`` keeps
them with a 16 KB body cap and the built-in masking; ``full`` is the default.
Explicit flags (kwarg, their own env var, Django setting) win over the preset.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from apilens.client._env import ENV_OPTIONS, env_var, load_env_config
from apilens.client._profile import CAPTURE_PROFILES, normalize_profile, profile_defaults
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware

FASTAPI_422 = b'{"detail":[{"type":"missing","loc":["body","email"],"msg":"Field required"}]}'


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


class FakeApp:
    def __init__(self) -> None:
        self.middleware: list[tuple[type, dict]] = []

    def add_middleware(self, cls, **kwargs) -> None:
        self.middleware.append((cls, kwargs))


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for option in ENV_OPTIONS:
        monkeypatch.delenv(env_var(option), raising=False)


def _asgi(**kwargs) -> ApiLensASGIMiddleware:
    return ApiLensASGIMiddleware(None, FakeClient(), capture_spans=False, **kwargs)


def _flags(mw) -> dict:
    return {
        "capture_headers": mw.capture_headers,
        "log_request_body": mw.log_request_body,
        "log_response_body": mw.log_response_body,
        "capture_validation_errors": mw.capture_validation_errors,
        "max_payload_bytes": mw.max_payload_bytes,
    }


# ── presets ─────────────────────────────────────────────────────────────────


def test_preset_table() -> None:
    assert set(CAPTURE_PROFILES) == {"metadata", "redacted", "full"}
    assert _flags(_asgi(capture_profile="metadata")) == {
        "capture_headers": False,
        "log_request_body": False,
        "log_response_body": False,
        "capture_validation_errors": False,
        "max_payload_bytes": 65536,
    }
    assert _flags(_asgi(capture_profile="redacted")) == {
        "capture_headers": True,
        "log_request_body": True,
        "log_response_body": True,
        "capture_validation_errors": True,
        "max_payload_bytes": 16384,
    }
    assert _flags(_asgi(capture_profile="full")) == _flags(_asgi())


def test_default_posture_is_full_and_unchanged() -> None:
    mw = _asgi()
    assert mw.capture_profile is None
    assert _flags(mw) == {
        "capture_headers": True,
        "log_request_body": True,
        "log_response_body": True,
        "capture_validation_errors": True,
        "max_payload_bytes": 65536,
    }


def test_profile_name_is_normalised_and_validated() -> None:
    assert normalize_profile(" Metadata ") == "metadata"
    assert normalize_profile("") is None
    assert profile_defaults(None) == {}
    with pytest.raises(ValueError, match="capture_profile"):
        _asgi(capture_profile="everything")


# ── explicit flags win ──────────────────────────────────────────────────────


def test_explicit_flags_win_over_the_preset() -> None:
    mw = _asgi(capture_profile="metadata", capture_headers=True, log_response_body=True)
    assert mw.capture_headers is True
    assert mw.log_response_body is True
    assert mw.log_request_body is False  # not passed: the preset applies
    assert mw.capture_validation_errors is False

    mw = _asgi(capture_profile="redacted", max_payload_bytes=1024, capture_headers=False)
    assert mw.max_payload_bytes == 1024
    assert mw.capture_headers is False
    assert mw.log_request_body is True


def test_flag_env_var_wins_over_the_preset(monkeypatch) -> None:
    monkeypatch.setenv("APILENS_CAPTURE_HEADERS", "true")
    mw = _asgi(capture_profile="metadata")
    assert mw.capture_headers is True
    assert mw.log_request_body is False


def test_env_profile(monkeypatch) -> None:
    monkeypatch.setenv("APILENS_CAPTURE_PROFILE", "REDACTED")
    assert load_env_config()["capture_profile"] == "redacted"
    mw = _asgi()
    assert mw.capture_profile == "redacted"
    assert mw.max_payload_bytes == 16384
    # A kwarg profile wins over the env one; a kwarg flag over both.
    assert _asgi(capture_profile="metadata").capture_headers is False
    assert _asgi(capture_profile="metadata", capture_headers=True).capture_headers is True


def test_invalid_env_profile_names_the_variable(monkeypatch) -> None:
    monkeypatch.setenv("APILENS_CAPTURE_PROFILE", "all")
    with pytest.raises(ValueError, match="APILENS_CAPTURE_PROFILE"):
        load_env_config()


def test_wsgi_middleware_honours_the_preset() -> None:
    mw = ApiLensWSGIMiddleware(lambda e, s: [], FakeClient(), capture_spans=False, capture_profile="metadata")
    assert mw.capture_profile == "metadata"
    assert (mw.capture_headers, mw.log_request_body, mw.log_response_body) == (False, False, False)


# ── framework wrappers forward the profile ──────────────────────────────────


def _built(app: FakeApp) -> ApiLensASGIMiddleware:
    cls, kwargs = app.middleware[-1]
    return cls(None, **kwargs)


def test_instrument_fastapi_forwards_profile_and_explicit_flags() -> None:
    from apilens.frameworks.fastapi import instrument_fastapi

    app = FakeApp()
    instrument_fastapi(app, FakeClient(), capture_spans=False, capture_profile="metadata", log_request_body=True)
    mw = _built(app)
    assert mw.capture_profile == "metadata"
    assert mw.capture_headers is False
    assert mw.log_request_body is True  # explicit on the wrapper
    assert mw.log_response_body is False
    assert mw.capture_validation_errors is False


def test_instrument_fastapi_env_profile(monkeypatch) -> None:
    from apilens.frameworks.fastapi import instrument_fastapi

    monkeypatch.setenv("APILENS_CAPTURE_PROFILE", "metadata")
    app = FakeApp()
    instrument_fastapi(app, FakeClient(), capture_spans=False)
    assert _flags(_built(app))["log_request_body"] is False


def test_starlette_wrapper_forwards_profile() -> None:
    from apilens.starlette import instrument_app

    app = FakeApp()
    instrument_app(app, FakeClient(), capture_spans=False, capture_profile="redacted")
    assert _built(app).max_payload_bytes == 16384


def test_litestar_plugin_forwards_profile() -> None:
    from apilens.litestar import ApiLensPlugin

    plugin = ApiLensPlugin(client=FakeClient(), capture_profile="metadata")
    assert plugin.capture_profile == "metadata"


# ── what actually leaves the app ────────────────────────────────────────────


def _run_asgi(mw, *, status: int, body: bytes) -> dict:
    async def app(scope, receive, send):
        await receive()
        await send(
            {"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json")]}
        )
        await send({"type": "http.response.body", "body": body, "more_body": False})

    mw.app = app
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/items",
        "query_string": b"",
        "headers": [(b"content-type", b"application/json"), (b"x-trace", b"t")],
    }

    async def receive():
        return {"type": "http.request", "body": b'{"email":"a@example.com"}', "more_body": False}

    async def send(_message):
        return None

    asyncio.run(mw(scope, receive, send))
    return mw.client.records[-1]


def test_metadata_sends_no_headers_bodies_or_validation_errors() -> None:
    rec = _run_asgi(_asgi(capture_profile="metadata"), status=422, body=FASTAPI_422)
    assert rec["status_code"] == 422 and rec["path"] == "/items"
    assert rec["request_headers"] == "" and rec["response_headers"] == ""
    assert rec["request_payload"] == "" and rec["response_payload"] == ""
    assert rec["validation_errors"] is None


def test_redacted_caps_bodies_at_16kb() -> None:
    big = b'{"data":"' + b"x" * 40000 + b'"}'
    rec = _run_asgi(_asgi(capture_profile="redacted"), status=200, body=big)
    assert rec["request_headers"] and rec["response_headers"]
    assert rec["request_payload"]
    assert 0 < len(rec["response_payload"]) <= 16384 + 64  # cap plus the truncation marker


def test_full_keeps_validation_errors() -> None:
    rec = _run_asgi(_asgi(capture_profile="full"), status=422, body=FASTAPI_422)
    assert rec["validation_errors"] == [{"loc": "body.email", "msg": "Field required", "type": "missing"}]


# ── Django: setting > env > preset > default ────────────────────────────────


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

    monkeypatch.setattr(apilens_django, "_client_singleton", FakeClient())
    return settings, apilens_django


urlpatterns: list = []


def test_django_profile_setting_and_overrides(django_settings, monkeypatch) -> None:
    settings, apilens_django = django_settings
    from django.http import HttpResponse

    monkeypatch.setattr(settings, "APILENS_CAPTURE_PROFILE", "metadata", raising=False)
    monkeypatch.setattr(settings, "APILENS_LOG_RESPONSE_BODY", True, raising=False)
    monkeypatch.setenv("APILENS_CAPTURE_HEADERS", "1")
    mw = apilens_django.ApiLensDjangoMiddleware(lambda request: HttpResponse("ok"))
    assert mw.capture_profile == "metadata"
    assert mw.capture_headers is True  # env var beats the preset
    assert mw.log_response_body is True  # setting beats the preset
    assert mw.log_request_body is False
    assert mw.capture_validation_errors is False


def test_django_env_profile(django_settings, monkeypatch) -> None:
    _, apilens_django = django_settings
    from django.http import HttpResponse

    monkeypatch.setenv("APILENS_CAPTURE_PROFILE", "redacted")
    mw = apilens_django.ApiLensDjangoMiddleware(lambda request: HttpResponse("ok"))
    assert mw.max_payload_bytes == 16384
    assert mw.capture_headers is True


def test_django_invalid_profile_setting(django_settings, monkeypatch) -> None:
    settings, apilens_django = django_settings
    from django.http import HttpResponse

    monkeypatch.setattr(settings, "APILENS_CAPTURE_PROFILE", "loud", raising=False)
    with pytest.raises(ValueError, match="APILENS_CAPTURE_PROFILE"):
        apilens_django.ApiLensDjangoMiddleware(lambda request: HttpResponse("ok"))
