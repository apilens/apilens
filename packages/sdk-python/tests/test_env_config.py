"""Single ``APILENS_*`` env-var config loader (issue #520)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from apilens.client import ApiLensConfig
from apilens.client._env import ENV_OPTIONS, env_defaults, env_var, fill_from_env, load_env_config
from apilens.client._sanitize import (
    DEFAULT_MASK_BODY_FIELDS,
    DEFAULT_MASK_HEADER_PATTERNS,
    DEFAULT_MASK_QUERY_PARAMS,
)
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware

ALL_VARS = [env_var(option) for option in ENV_OPTIONS]


_BUILT_IN = {
    "query_params": len(DEFAULT_MASK_QUERY_PARAMS),
    "headers": len(DEFAULT_MASK_HEADER_PATTERNS),
    "body_fields": len(DEFAULT_MASK_BODY_FIELDS),
}


def _user_patterns(mw, kind: str) -> tuple[str, ...]:
    """Redaction patterns configured on ``mw`` beyond the built-ins."""
    return mw.redactor.patterns[kind][_BUILT_IN[kind] :]


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
    """Records what ``app.add_middleware`` was given (no middleware is built)."""

    def __init__(self) -> None:
        self.middleware: list[tuple[type, dict]] = []

    def add_middleware(self, cls, **kwargs) -> None:
        self.middleware.append((cls, kwargs))


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in ALL_VARS:
        monkeypatch.delenv(name, raising=False)


# ── Parsing ─────────────────────────────────────────────────────────────────


def test_every_documented_option_has_an_env_var():
    assert sorted(ALL_VARS) == sorted(
        "APILENS_" + n
        for n in (
            "API_KEY APP_ID ENVIRONMENT BASE_URL ENABLED CAPTURE_HEADERS CAPTURE_PAYLOADS "
            "LOG_REQUEST_BODY LOG_RESPONSE_BODY MAX_PAYLOAD_BYTES CAPTURE_CONTENT_TYPES REDACT_QUERY_PARAMS "
            "REDACT_HEADERS REDACT_BODY_FIELDS EXCLUDE_PATHS EXCLUDE_USER_AGENTS "
            "DEFAULT_EXCLUSIONS SAMPLE_RATE CAPTURE_IP ANONYMIZE_IP CAPTURE_SPANS "
            "BATCH_SIZE FLUSH_INTERVAL MODE"
        ).split()
    )


def test_unset_and_empty_vars_are_absent():
    assert load_env_config({}) == {}
    assert load_env_config({"APILENS_SAMPLE_RATE": "  ", "APILENS_APP_ID": ""}) == {}


def test_parses_every_type():
    cfg = load_env_config(
        {
            "APILENS_API_KEY": " apilens_xxx ",
            "APILENS_APP_ID": "orders-api",
            "APILENS_ENVIRONMENT": "staging",
            "APILENS_BASE_URL": "http://localhost:8080/v1",
            "APILENS_ENABLED": "0",
            "APILENS_CAPTURE_HEADERS": "false",
            "APILENS_CAPTURE_PAYLOADS": "TRUE",
            "APILENS_LOG_REQUEST_BODY": "1",
            "APILENS_LOG_RESPONSE_BODY": "False",
            "APILENS_MAX_PAYLOAD_BYTES": "1024",
            "APILENS_CAPTURE_CONTENT_TYPES": "application/json, text/*",
            "APILENS_REDACT_QUERY_PARAMS": "^token$, card ,,",
            "APILENS_REDACT_HEADERS": "^x-secret$",
            "APILENS_REDACT_BODY_FIELDS": "password,ssn",
            "APILENS_EXCLUDE_PATHS": "^/internal/",
            "APILENS_EXCLUDE_USER_AGENTS": "uptimerobot,pingdom",
            "APILENS_DEFAULT_EXCLUSIONS": "off",
            "APILENS_SAMPLE_RATE": "0.25",
            "APILENS_CAPTURE_IP": "no",
            "APILENS_ANONYMIZE_IP": "yes",
            "APILENS_CAPTURE_SPANS": "false",
            "APILENS_BATCH_SIZE": "50",
            "APILENS_FLUSH_INTERVAL": "0.5",
            "APILENS_UNRELATED": "ignored",
        }
    )
    assert cfg == {
        "api_key": "apilens_xxx",
        "app_id": "orders-api",
        "environment": "staging",
        "base_url": "http://localhost:8080/v1",
        "enabled": False,
        "capture_headers": False,
        "capture_payloads": True,
        "log_request_body": True,
        "log_response_body": False,
        "max_payload_bytes": 1024,
        "capture_content_types": ["application/json", "text/*"],
        "redact_query_params": ["^token$", "card"],
        "redact_headers": ["^x-secret$"],
        "redact_body_fields": ["password", "ssn"],
        "exclude_paths": ["^/internal/"],
        "exclude_user_agents": ["uptimerobot", "pingdom"],
        "default_exclusions": False,
        "sample_rate": 0.25,
        "capture_ip": False,
        "anonymize_ip": True,
        "capture_spans": False,
        "batch_size": 50,
        "flush_interval": 0.5,
    }


def test_reads_os_environ_by_default(monkeypatch):
    monkeypatch.setenv("APILENS_SAMPLE_RATE", "0.1")
    assert load_env_config() == {"sample_rate": 0.1}


@pytest.mark.parametrize(
    "name,value",
    [
        ("APILENS_ENABLED", "maybe"),
        ("APILENS_CAPTURE_HEADERS", "2"),
        ("APILENS_MAX_PAYLOAD_BYTES", "64k"),
        ("APILENS_BATCH_SIZE", "1.5"),
        ("APILENS_SAMPLE_RATE", "half"),
        ("APILENS_FLUSH_INTERVAL", "nan"),
    ],
)
def test_invalid_values_raise_naming_the_variable(name, value):
    with pytest.raises(ValueError, match=name):
        load_env_config({name: value})


# ── Precedence: explicit kwarg > env > default ──────────────────────────────


def test_fill_from_env_respects_positional_keyword_and_alias():
    def f(app, app_id: str = "", *, env: str = "production", client_id: str | None = None, api_key=None):
        return None

    env = {"app_id": "from-env", "environment": "staging", "api_key": "k"}
    assert fill_from_env(f, (None,), {}, env) == {
        "app_id": "from-env",
        "env": "staging",
        "client_id": "k",
        "api_key": "k",
    }
    assert fill_from_env(f, (None, "explicit"), {}, env)["env"] == "staging"
    assert "app_id" not in fill_from_env(f, (None, "explicit"), {}, env)
    filled = fill_from_env(f, (None,), {"env": "dev", "client_id": "mine"}, env)
    assert filled["env"] == "dev"
    assert filled["client_id"] == "mine"
    assert "api_key" not in filled


def test_env_defaults_decorator(monkeypatch):
    @env_defaults
    def helper(*, sample_rate: float = 1.0, exclude_paths=None, service_name: str = ""):
        return sample_rate, exclude_paths, service_name

    assert helper() == (1.0, None, "")
    monkeypatch.setenv("APILENS_SAMPLE_RATE", "0.5")
    # Exclusion patterns are additive and merged by the excluder, not filled in.
    monkeypatch.setenv("APILENS_EXCLUDE_PATHS", "^/x$")
    assert helper() == (0.5, None, "")
    assert helper(sample_rate=0.0) == (0.0, None, "")


def test_api_lens_config_reads_env(monkeypatch):
    assert ApiLensConfig(api_key="k").batch_size == 200
    monkeypatch.setenv("APILENS_API_KEY", "env-key")
    monkeypatch.setenv("APILENS_BASE_URL", "http://localhost:9/v1")
    monkeypatch.setenv("APILENS_ENVIRONMENT", "staging")
    monkeypatch.setenv("APILENS_ENABLED", "false")
    monkeypatch.setenv("APILENS_BATCH_SIZE", "7")
    monkeypatch.setenv("APILENS_FLUSH_INTERVAL", "0.25")
    monkeypatch.setenv("APILENS_CAPTURE_IP", "false")
    monkeypatch.setenv("APILENS_ANONYMIZE_IP", "true")
    cfg = ApiLensConfig()
    assert (cfg.api_key, cfg.base_url, cfg.environment, cfg.enabled) == (
        "env-key",
        "http://localhost:9/v1",
        "staging",
        False,
    )
    assert (cfg.batch_size, cfg.flush_interval, cfg.capture_ip, cfg.anonymize_ip) == (7, 0.25, False, True)
    explicit = ApiLensConfig("code-key", base_url="https://ingest.example.com/v1", batch_size=9, enabled=True)
    assert (explicit.api_key, explicit.base_url, explicit.batch_size, explicit.enabled) == (
        "code-key",
        "https://ingest.example.com/v1",
        9,
        True,
    )
    assert explicit.environment == "staging"


def _set_capture_env(monkeypatch):
    monkeypatch.setenv("APILENS_APP_ID", "env-app")
    monkeypatch.setenv("APILENS_ENVIRONMENT", "staging")
    monkeypatch.setenv("APILENS_CAPTURE_HEADERS", "false")
    monkeypatch.setenv("APILENS_CAPTURE_PAYLOADS", "true")
    monkeypatch.setenv("APILENS_LOG_REQUEST_BODY", "false")
    monkeypatch.setenv("APILENS_LOG_RESPONSE_BODY", "true")
    monkeypatch.setenv("APILENS_MAX_PAYLOAD_BYTES", "128")
    monkeypatch.setenv("APILENS_CAPTURE_CONTENT_TYPES", "application/json")
    monkeypatch.setenv("APILENS_REDACT_QUERY_PARAMS", "^token$")
    monkeypatch.setenv("APILENS_REDACT_HEADERS", "^x-secret$")
    monkeypatch.setenv("APILENS_REDACT_BODY_FIELDS", "^password$,^ssn$")
    monkeypatch.setenv("APILENS_EXCLUDE_PATHS", "^/internal/")
    monkeypatch.setenv("APILENS_EXCLUDE_USER_AGENTS", "uptimerobot")
    monkeypatch.setenv("APILENS_DEFAULT_EXCLUSIONS", "false")
    monkeypatch.setenv("APILENS_SAMPLE_RATE", "0.5")
    monkeypatch.setenv("APILENS_CAPTURE_SPANS", "false")


@pytest.mark.parametrize("cls", [ApiLensASGIMiddleware, ApiLensWSGIMiddleware])
def test_middlewares_read_env(monkeypatch, cls):
    _set_capture_env(monkeypatch)
    mw = cls(None, FakeClient())
    assert mw.app_id == "env-app"
    assert mw.environment == "staging"
    assert mw.capture_headers is False
    assert mw.capture_payloads is True
    assert mw.log_request_body is False
    assert mw.log_response_body is True
    assert mw.max_payload_bytes == 128
    assert mw.content_types.patterns == ("application/json",)
    assert _user_patterns(mw, "query_params") == ("^token$",)
    assert _user_patterns(mw, "headers") == ("^x-secret$",)
    assert _user_patterns(mw, "body_fields") == ("^password$", "^ssn$")
    assert [p.pattern for p in mw.excluder.paths.patterns] == ["^/internal/"]
    assert mw.excluder.default_exclusions is False
    assert [p.pattern for p in mw.excluder.user_agents] == ["uptimerobot"]
    assert mw.sampler.rate == 0.5
    assert mw.capture_spans is False


@pytest.mark.parametrize("cls", [ApiLensASGIMiddleware, ApiLensWSGIMiddleware])
def test_middleware_kwargs_beat_env(monkeypatch, cls):
    _set_capture_env(monkeypatch)
    mw = cls(
        None,
        FakeClient(),
        app_id="code-app",
        capture_headers=True,
        log_request_body=True,
        max_payload_bytes=0,
        redact_body_fields=["^card$"],
        exclude_paths=["^/code$"],
        default_exclusions=True,
        sample_rate=1.0,
    )
    assert mw.app_id == "code-app"
    assert mw.capture_headers is True
    assert mw.log_request_body is True
    assert mw.max_payload_bytes == 0
    assert _user_patterns(mw, "body_fields") == ("^card$",)
    # Exclusion env vars add to the patterns passed in code.
    assert [p.pattern for p in mw.excluder.paths.patterns] == ["^/code$", "^/internal/"]
    assert mw.excluder.default_exclusions is True
    assert mw.sampler.rate == 1.0
    # Not passed: still from env.
    assert mw.environment == "staging"


def test_middleware_defaults_without_env():
    mw = ApiLensASGIMiddleware(None, FakeClient())
    assert (mw.app_id, mw.capture_headers, mw.max_payload_bytes, mw.sampler.rate) == ("", True, 65536, 1.0)
    assert mw.excluder.default_exclusions is True


def test_kill_switch_env_still_wins_over_code(monkeypatch):
    monkeypatch.setenv("APILENS_CAPTURE_SPANS", "false")
    mw = ApiLensASGIMiddleware(None, FakeClient(), app_id="a", capture_spans=True)
    assert mw.capture_spans is False


def test_instrument_helpers_forward_env(monkeypatch):
    from apilens.frameworks.fastapi import instrument_fastapi
    from apilens.starlette import instrument_app as instrument_starlette

    monkeypatch.setenv("APILENS_APP_ID", "env-app")
    monkeypatch.setenv("APILENS_SAMPLE_RATE", "0.2")
    monkeypatch.setenv("APILENS_REDACT_HEADERS", "^x-a$,^x-b$")
    for helper in (instrument_fastapi, instrument_starlette):
        app = FakeApp()
        helper(app, FakeClient(), sample_rate=0.9)
        (_cls, kwargs), = app.middleware
        assert kwargs["app_id"] == "env-app"
        assert kwargs["sample_rate"] == 0.9
        assert kwargs["redact_headers"] == ["^x-a$", "^x-b$"]


def test_instrument_flask_reads_env_for_options_it_does_not_take(monkeypatch):
    from apilens.frameworks.flask import instrument_flask

    monkeypatch.setenv("APILENS_APP_ID", "env-app")
    monkeypatch.setenv("APILENS_LOG_RESPONSE_BODY", "false")
    app = SimpleNamespace(wsgi_app=lambda environ, start_response: [b""])
    instrument_flask(app, FakeClient())
    assert app.wsgi_app.app_id == "env-app"
    assert app.wsgi_app.log_response_body is False


def test_gateway_middleware_builds_client_from_env(monkeypatch):
    from apilens.fastapi import ApiLensGatewayMiddleware

    monkeypatch.setenv("APILENS_API_KEY", "env-key")
    monkeypatch.setenv("APILENS_APP_ID", "env-app")
    monkeypatch.setenv("APILENS_BASE_URL", "http://127.0.0.1:9/v1")
    monkeypatch.setenv("APILENS_ENVIRONMENT", "staging")
    monkeypatch.setenv("APILENS_ENABLED", "false")
    mw = ApiLensGatewayMiddleware(None)
    cfg = mw.client.config
    assert (cfg.api_key, cfg.base_url, cfg.environment, cfg.enabled) == (
        "env-key",
        "http://127.0.0.1:9/v1",
        "staging",
        False,
    )
    assert mw.app_id == "env-app"
    assert mw.environment == "staging"

    explicit = ApiLensGatewayMiddleware(None, client_id="code-key", env="dev")
    assert explicit.client.config.api_key == "code-key"
    assert explicit.client.config.environment == "dev"
    assert explicit.environment == "dev"


def test_gateway_without_any_api_key_still_raises():
    from apilens.fastapi import ApiLensGatewayMiddleware

    with pytest.raises(ValueError, match="api_key"):
        ApiLensGatewayMiddleware(None)


def test_litestar_plugin_reads_env(monkeypatch):
    from apilens.litestar import ApiLensPlugin

    monkeypatch.setenv("APILENS_APP_ID", "env-app")
    monkeypatch.setenv("APILENS_DEFAULT_EXCLUSIONS", "false")
    plugin = ApiLensPlugin(client=FakeClient())
    assert plugin.app_id == "env-app"
    assert plugin.default_exclusions is False
    assert ApiLensPlugin(FakeClient(), app_id="code-app").app_id == "code-app"


# ── Django: settings > env > default ────────────────────────────────────────


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


def test_django_reads_env_when_setting_absent(django_settings, monkeypatch):
    settings, apilens_django = django_settings
    from django.http import HttpResponse

    monkeypatch.delattr(settings, "APILENS_APP_ID")
    _set_capture_env(monkeypatch)
    mw = apilens_django.ApiLensDjangoMiddleware(lambda request: HttpResponse("ok"))
    assert mw.app_id == "env-app"
    assert mw.environment == "staging"
    assert mw.capture_headers is False
    assert mw.log_request_body is False
    assert mw.max_payload_bytes == 128
    assert mw.content_types.patterns == ("application/json",)
    assert _user_patterns(mw, "body_fields") == ("^password$", "^ssn$")
    assert mw.excluder.default_exclusions is False
    assert mw.sampler.rate == 0.5
    assert mw.capture_spans is False


def test_django_settings_win_over_env(django_settings, monkeypatch):
    settings, apilens_django = django_settings
    from django.http import HttpResponse

    _set_capture_env(monkeypatch)
    monkeypatch.setattr(settings, "APILENS_CAPTURE_HEADERS", True, raising=False)
    monkeypatch.setattr(settings, "APILENS_LOG_REQUEST_BODY", True, raising=False)
    monkeypatch.setattr(settings, "APILENS_SAMPLE_RATE", 1.0, raising=False)
    monkeypatch.setattr(settings, "APILENS_REDACT_BODY_FIELDS", ["^card$"], raising=False)
    mw = apilens_django.ApiLensDjangoMiddleware(lambda request: HttpResponse("ok"))
    assert mw.app_id == "orders-api"  # the setting, not APILENS_APP_ID=env-app
    assert mw.capture_headers is True
    assert mw.log_request_body is True
    assert mw.sampler.rate == 1.0
    assert _user_patterns(mw, "body_fields") == ("^card$",)
    assert mw.max_payload_bytes == 128  # no setting: env


def test_django_client_config_from_env(django_settings, monkeypatch):
    settings, apilens_django = django_settings

    monkeypatch.setattr(apilens_django, "_client_singleton", None)
    monkeypatch.delattr(settings, "APILENS_API_KEY")
    monkeypatch.setenv("APILENS_API_KEY", "env-key")
    monkeypatch.setenv("APILENS_BASE_URL", "http://127.0.0.1:9/v1")
    monkeypatch.setenv("APILENS_ENABLED", "false")
    monkeypatch.setenv("APILENS_BATCH_SIZE", "11")
    monkeypatch.setattr(settings, "APILENS_BATCH_SIZE", 22, raising=False)
    client = apilens_django._get_client_from_settings()
    try:
        cfg = client.config
        assert (cfg.api_key, cfg.base_url, cfg.enabled, cfg.batch_size) == (
            "env-key",
            "http://127.0.0.1:9/v1",
            False,
            22,
        )
    finally:
        client.shutdown(flush=False)


def test_django_body_toggles_gate_capture(django_settings, monkeypatch):
    settings, apilens_django = django_settings
    from django.http import HttpResponse
    from django.test import RequestFactory

    client = FakeClient()
    monkeypatch.setattr(apilens_django, "_client_singleton", client)
    monkeypatch.setenv("APILENS_LOG_REQUEST_BODY", "false")
    mw = apilens_django.ApiLensDjangoMiddleware(lambda request: HttpResponse('{"ok":true}'))
    mw(RequestFactory().post("/orders", data='{"a":1}', content_type="application/json"))
    (record,) = client.records
    assert record["request_payload"] == ""
    assert record["response_payload"] == '{"ok":true}'
