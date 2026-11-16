"""Optional ``app_id``: code > APILENS_APP_ID > OTEL_SERVICE_NAME > omitted."""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

from apilens.client import _app
from apilens.client._app import describe_app_choice, resolve_app_id
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware


class FakeClient:
    def __init__(self) -> None:
        self.config = SimpleNamespace(project_slug="", environment="test")

    def capture(self, **kwargs) -> None:  # pragma: no cover
        pass

    def capture_span(self, record) -> None:  # pragma: no cover
        pass

    def capture_log(self, record) -> None:  # pragma: no cover
        pass


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.delenv("APILENS_APP_ID", raising=False)
    monkeypatch.delenv("OTEL_SERVICE_NAME", raising=False)
    _app._reset_for_tests()
    yield
    _app._reset_for_tests()


@pytest.mark.parametrize(
    ("explicit", "environ", "expected"),
    [
        ("code-app", {"APILENS_APP_ID": "env-app", "OTEL_SERVICE_NAME": "otel"}, ("code-app", "app_id")),
        ("", {"APILENS_APP_ID": "env-app", "OTEL_SERVICE_NAME": "otel"}, ("env-app", "APILENS_APP_ID")),
        ("env-app", {"APILENS_APP_ID": "env-app"}, ("env-app", "APILENS_APP_ID")),
        ("", {"APILENS_APP_ID": "  ", "OTEL_SERVICE_NAME": "Orders API"}, ("Orders API", "OTEL_SERVICE_NAME")),
        ("", {"OTEL_SERVICE_NAME": "otel"}, ("otel", "OTEL_SERVICE_NAME")),
        ("", {}, ("", "")),
        (None, {"OTEL_SERVICE_NAME": "  "}, ("", "")),
    ],
)
def test_resolution_order(explicit, environ, expected):
    assert resolve_app_id(explicit, environ) == expected


def test_free_form_names_are_not_validated():
    assert resolve_app_id("Orders API", {}) == ("Orders API", "app_id")


def test_log_lines():
    assert describe_app_choice("orders-api", "APILENS_APP_ID") == 'APILens: app "orders-api" (from APILENS_APP_ID)'
    assert describe_app_choice("", "") == (
        "APILens: no app name configured; data goes to the project's default app "
        "(set app_id, APILENS_APP_ID or OTEL_SERVICE_NAME)"
    )


@pytest.mark.parametrize("cls", [ApiLensASGIMiddleware, ApiLensWSGIMiddleware])
def test_middleware_explicit_wins(monkeypatch, cls):
    monkeypatch.setenv("APILENS_APP_ID", "env-app")
    monkeypatch.setenv("OTEL_SERVICE_NAME", "otel")
    assert cls(None, FakeClient(), app_id="Orders API", capture_spans=False).app_id == "Orders API"


@pytest.mark.parametrize("cls", [ApiLensASGIMiddleware, ApiLensWSGIMiddleware])
def test_middleware_env_then_otel(monkeypatch, cls):
    monkeypatch.setenv("OTEL_SERVICE_NAME", "otel-svc")
    assert cls(None, FakeClient(), capture_spans=False).app_id == "otel-svc"
    monkeypatch.setenv("APILENS_APP_ID", "env-app")
    assert cls(None, FakeClient(), capture_spans=False).app_id == "env-app"


@pytest.mark.parametrize("cls", [ApiLensASGIMiddleware, ApiLensWSGIMiddleware])
def test_middleware_omitted_logs_once(caplog, cls):
    caplog.set_level(logging.INFO, logger="apilens")
    mw = cls(None, FakeClient(), capture_spans=False)
    cls(None, FakeClient(), capture_spans=False)
    assert mw.app_id == ""
    lines = [r.getMessage() for r in caplog.records if "app" in r.getMessage() and r.name == "apilens"]
    assert lines == [describe_app_choice("", "")]


def test_middleware_logs_source(caplog, monkeypatch):
    caplog.set_level(logging.INFO, logger="apilens")
    monkeypatch.setenv("APILENS_APP_ID", "orders-api")
    ApiLensASGIMiddleware(None, FakeClient(), capture_spans=False)
    assert 'APILens: app "orders-api" (from APILENS_APP_ID)' in caplog.messages


def test_omitted_request_sends_empty_app_id():
    """Without any app name the record carries ``app_id=""`` (the default app)."""
    import asyncio

    captured: list[dict] = []

    class Client(FakeClient):
        def capture(self, **kwargs) -> None:
            captured.append(kwargs)

    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    mw = ApiLensASGIMiddleware(app, Client(), capture_spans=False)

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        pass

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/orders",
        "raw_path": b"/orders",
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 1),
        "server": ("test", 80),
        "scheme": "http",
    }
    asyncio.run(mw(scope, receive, send))
    assert len(captured) == 1
    assert captured[0]["app_id"] == ""
