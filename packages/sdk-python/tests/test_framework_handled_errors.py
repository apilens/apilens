"""Framework-handled 500s keep the full stack (issue #910, M5 D3).

Flask's ``handle_exception``, Starlette/FastAPI exception handlers and Django's
``handler500`` turn an exception into a 500 before it reaches the APILens
middleware, which used to log a bare ``HTTP 500``. Each framework's hook now
notes the original exception, and the request logs it exactly once, also when
both the hook fires and the exception raises past the middleware.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from apilens.client._policy import ALLOW_ALL, Policy


class FakeClient:
    def __init__(self, policy: Policy = ALLOW_ALL) -> None:
        self.config = SimpleNamespace(project_slug="", environment="test")
        self.current = policy
        self.records: list[dict] = []
        self.spans: list = []
        self.logs: list = []

    def policy(self, app_id: str = "") -> Policy:
        return self.current

    def capture(self, **kwargs) -> None:
        self.records.append(kwargs)

    def capture_span(self, record) -> None:
        self.spans.append(record)

    def capture_log(self, record) -> None:
        self.logs.append(record)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in ("APILENS_CAPTURE_SPANS", "APILENS_EXCLUDE_PATHS", "APILENS_EXCLUDE_USER_AGENTS", "APILENS_SAMPLE_RATE"):
        monkeypatch.delenv(name, raising=False)


class PaymentDeclined(Exception):
    pass


def charge_card() -> None:
    try:
        raise ConnectionError("gateway timeout")
    except ConnectionError as exc:
        raise PaymentDeclined("card declined") from exc


def _assert_full_stack(client: FakeClient, status: int = 500) -> None:
    """One request record and exactly one exception log carrying the stack."""
    (rec,) = client.records
    assert rec["status_code"] == status
    (log,) = client.logs
    assert log.logger_name == "apilens.exception"
    assert log.message.endswith("PaymentDeclined: card declined")
    assert "Traceback" in log.payload and "charge_card" in log.payload
    # The chained cause survives too.
    assert "ConnectionError: gateway timeout" in log.payload
    assert log.trace_id == rec["trace_id"]


# ── Flask ───────────────────────────────────────────────────────────────────


def _flask_app(client: FakeClient, **config):
    flask = pytest.importorskip("flask")
    from apilens.flask import instrument_flask

    app = flask.Flask(__name__)
    app.config.update(config)

    @app.post("/checkout")
    def checkout():
        charge_card()
        return "ok"

    instrument_flask(app, client, app_id="shop", flush_on_shutdown=False)
    return app


def _flask_post(app):
    resp = app.test_client().post("/checkout")
    resp.get_data()  # drain the WSGI iterable so the middleware finishes
    resp.close()
    return resp


def test_flask_unhandled_exception_500_keeps_full_stack():
    client = FakeClient()
    app = _flask_app(client)
    resp = _flask_post(app)
    assert resp.status_code == 500
    _assert_full_stack(client)


def test_flask_errorhandler_500_keeps_full_stack():
    client = FakeClient()
    app = _flask_app(client)

    @app.errorhandler(500)
    def server_error(err):
        return {"error": "internal"}, 500

    resp = _flask_post(app)
    assert resp.status_code == 500 and resp.get_json() == {"error": "internal"}
    _assert_full_stack(client)


def test_flask_propagated_exception_is_logged_once():
    # Both paths fire: the signal notes it, then it raises past the middleware.
    client = FakeClient()
    app = _flask_app(client, PROPAGATE_EXCEPTIONS=True)
    with pytest.raises(PaymentDeclined):
        app.test_client().post("/checkout")
    _assert_full_stack(client)


def test_flask_handled_4xx_logs_nothing():
    client = FakeClient()
    app = _flask_app(client)

    @app.errorhandler(PaymentDeclined)
    def declined(err):
        return {"error": "declined"}, 402

    resp = _flask_post(app)
    assert resp.status_code == 402
    assert len(client.records) == 1 and client.logs == []


def test_flask_signal_outside_a_captured_request_is_ignored():
    pytest.importorskip("flask")
    from apilens.client.middleware import note_handled_exception

    note_handled_exception(RuntimeError("no request"))  # must not raise


# ── Starlette / FastAPI ─────────────────────────────────────────────────────


def _fastapi_app(client: FakeClient):
    fastapi = pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from apilens.fastapi import instrument_fastapi

    app = fastapi.FastAPI()

    @app.post("/checkout")
    def checkout():
        charge_card()
        return {"ok": True}

    instrument_fastapi(app, client, app_id="shop", flush_on_shutdown=False)
    return app


def _post(app, path: str = "/checkout"):
    from starlette.testclient import TestClient

    with TestClient(app, raise_server_exceptions=False) as tc:
        return tc.post(path)


def test_fastapi_exception_handler_500_keeps_full_stack():
    from fastapi.responses import JSONResponse

    client = FakeClient()
    app = _fastapi_app(client)

    @app.exception_handler(PaymentDeclined)
    async def declined(request, exc):
        return JSONResponse({"error": "payment service down"}, status_code=500)

    resp = _post(app)
    assert resp.status_code == 500 and resp.json() == {"error": "payment service down"}
    _assert_full_stack(client)


def test_fastapi_sync_exception_handler_500_keeps_full_stack():
    from fastapi.responses import JSONResponse

    client = FakeClient()
    app = _fastapi_app(client)

    @app.exception_handler(PaymentDeclined)
    def declined(request, exc):  # sync handler: Starlette runs it in a thread
        return JSONResponse({"error": "down"}, status_code=503)

    resp = _post(app)
    assert resp.status_code == 503
    _assert_full_stack(client, status=503)


def test_fastapi_catch_all_exception_handler_is_logged_once():
    # ``Exception`` handlers live in ServerErrorMiddleware, above APILens: the
    # exception raises past the middleware and is logged once.
    from fastapi.responses import JSONResponse

    client = FakeClient()
    app = _fastapi_app(client)

    @app.exception_handler(Exception)
    async def catch_all(request, exc):
        return JSONResponse({"error": "internal"}, status_code=500)

    resp = _post(app)
    assert resp.status_code == 500
    _assert_full_stack(client)


def test_fastapi_handled_4xx_and_http_exception_log_nothing():
    from fastapi import HTTPException
    from fastapi.responses import JSONResponse

    client = FakeClient()
    app = _fastapi_app(client)

    @app.exception_handler(PaymentDeclined)
    async def declined(request, exc):
        return JSONResponse({"error": "declined"}, status_code=402)

    @app.get("/missing")
    def missing():
        raise HTTPException(status_code=404)

    from starlette.testclient import TestClient

    with TestClient(app, raise_server_exceptions=False) as tc:
        assert tc.post("/checkout").status_code == 402
        assert tc.get("/missing").status_code == 404
    assert len(client.records) == 2 and client.logs == []


def test_starlette_exception_handler_500_keeps_full_stack():
    pytest.importorskip("starlette")
    pytest.importorskip("httpx")
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    from apilens.starlette import instrument_app

    async def checkout(request):
        charge_card()

    async def declined(request, exc):
        return JSONResponse({"error": "down"}, status_code=500)

    app = Starlette(
        routes=[Route("/checkout", checkout, methods=["POST"])],
        exception_handlers={PaymentDeclined: declined},
    )
    client = FakeClient()
    instrument_app(app, client, app_id="shop", flush_on_shutdown=False)
    resp = _post(app)
    assert resp.status_code == 500
    _assert_full_stack(client)


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
            APILENS_APP_ID="shop",
        )
        django.setup()

    import apilens.django as apilens_django

    client = FakeClient()
    monkeypatch.setattr(apilens_django, "_client_singleton", client)
    return client


def _django_checkout(request):
    charge_card()


def _django_ok(request):
    from django.http import HttpResponse

    return HttpResponse("ok")


class RaisingMiddleware:
    """A middleware below APILens that raises in ``__call__``: Django turns it
    into a 500 without ever calling ``process_exception``."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path == "/mw-boom":
            charge_card()
        return self.get_response(request)


def _django_urls():
    from django.urls import path

    return [path("checkout", _django_checkout), path("mw-boom", _django_ok)]


urlpatterns: list = []


def _django_post(path: str, middleware: list[str]):
    from django.test import Client, override_settings

    global urlpatterns
    urlpatterns = _django_urls()
    with override_settings(
        ROOT_URLCONF=__name__,
        ALLOWED_HOSTS=["*"],
        DEBUG=False,
        DEBUG_PROPAGATE_EXCEPTIONS=False,
        MIDDLEWARE=middleware,
        APILENS_FLUSH_ON_SHUTDOWN=False,
    ):
        return Client(raise_request_exception=False).post(path)


def test_django_view_exception_500_is_logged_once(django_client):
    # process_exception and got_request_exception both fire for a view error.
    resp = _django_post("/checkout", ["apilens.django.ApiLensDjangoMiddleware"])
    assert resp.status_code == 500
    _assert_full_stack(django_client)


def test_django_exception_below_middleware_keeps_full_stack(django_client):
    # process_exception never runs; only got_request_exception sees it.
    resp = _django_post(
        "/mw-boom",
        ["apilens.django.ApiLensDjangoMiddleware", f"{__name__}.RaisingMiddleware"],
    )
    assert resp.status_code == 500
    _assert_full_stack(django_client)
