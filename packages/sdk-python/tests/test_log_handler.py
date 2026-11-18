"""Logging integration ships logged exceptions to the trace (issue #914).

``logger.exception`` inside a request becomes an ``apilens.exception`` log
with the full stack and the request's trace id; outside a request it is still
shipped without one; ``capture_logs="off"`` disables the handler; the SDK's own
loggers never recurse into it.
"""

from __future__ import annotations

import asyncio
import io
import logging

import pytest
from conftest import StubClient

from apilens.client.log_handler import normalize_capture_logs
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware
from apilens.client.trace import current_trace_id
from apilens.logging import ApiLensHandler, install_log_handler, uninstall_log_handler

app_logger = logging.getLogger("tests.orders")


class PaymentError(Exception):
    pass


@pytest.fixture(autouse=True)
def _clean_handler():
    uninstall_log_handler()
    yield
    uninstall_log_handler()


def _root_apilens_handlers() -> list[logging.Handler]:
    return [h for h in logging.getLogger().handlers if isinstance(h, ApiLensHandler)]


def _charge_and_log() -> None:
    try:
        try:
            raise ValueError("card declined")
        except ValueError as e:
            raise PaymentError("charge failed") from e
    except PaymentError:
        app_logger.exception("could not charge order %s", 42)


def _run_asgi(mw, path: str = "/orders") -> None:
    scope = {
        "type": "http",
        "method": "POST",
        "path": path,
        "query_string": b"",
        "headers": [],
        "client": ("203.0.113.42", 50000),
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        return None

    asyncio.run(mw(scope, receive, send))


def _asgi_app(handler):
    async def app(scope, receive, send):
        handler()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    return app


def _wsgi_environ() -> dict:
    return {
        "REQUEST_METHOD": "POST",
        "PATH_INFO": "/orders",
        "QUERY_STRING": "",
        "CONTENT_LENGTH": "0",
        "REMOTE_ADDR": "203.0.113.42",
        "SERVER_NAME": "example.com",
        "SERVER_PORT": "80",
        "HTTP_HOST": "example.com",
        "wsgi.url_scheme": "http",
        "wsgi.input": io.BytesIO(b""),
    }


def test_logger_exception_inside_asgi_request_ships_stack_on_same_trace() -> None:
    seen: list[str] = []

    def handler() -> None:
        seen.append(current_trace_id())
        _charge_and_log()

    client = StubClient()
    mw = ApiLensASGIMiddleware(_asgi_app(handler), client, app_id="orders", capture_logs="errors")
    _run_asgi(mw)

    assert len(client.records) == 1
    logs = [log for log in client.logs if log.logger_name == "apilens.exception"]
    assert len(logs) == 1
    log = logs[0]
    assert log.level == "ERROR"
    assert len(log.trace_id) == 32 and log.trace_id == seen[0]
    assert client.records[0]["trace_id"] == log.trace_id
    assert "PaymentError: charge failed" in log.message
    assert "Traceback" in log.payload
    assert "ValueError: card declined" in log.payload  # chained cause kept
    assert log.attributes["exception.type"].endswith("PaymentError")
    assert log.attributes["exception.chain_depth"] == "2"
    assert log.attributes["log.logger"] == "tests.orders"
    assert log.attributes["log.message"] == "could not charge order 42"
    assert log.app_id == "orders"


def test_log_trace_id_matches_request_trace_wsgi() -> None:
    seen: list[str] = []

    def app(environ, start_response):
        seen.append(current_trace_id())
        _charge_and_log()
        start_response("200 OK", [("Content-Type", "text/plain")])
        return [b"ok"]

    client = StubClient()
    mw = ApiLensWSGIMiddleware(app, client, app_id="orders", capture_logs="errors", capture_spans=True)
    b"".join(mw(_wsgi_environ(), lambda status, headers, exc_info=None: None))

    logs = [log for log in client.logs if log.logger_name == "apilens.exception"]
    assert len(logs) == 1
    assert seen and logs[0].trace_id == seen[0]
    assert logs[0].span_id  # spans captured: the log links the server span
    assert "PaymentError" in logs[0].payload


def test_log_outside_a_request_is_shipped_without_trace_id() -> None:
    client = StubClient()
    install_log_handler(client, app_id="worker")
    _charge_and_log()
    app_logger.error("queue backlog at %d", 900)

    assert len(client.logs) == 2
    exc_log, plain = client.logs
    assert exc_log.logger_name == "apilens.exception"
    assert exc_log.trace_id == "" and exc_log.span_id == ""
    assert "PaymentError" in exc_log.payload
    assert plain.logger_name == "tests.orders"
    assert plain.level == "ERROR"
    assert plain.message == "queue backlog at 900"
    assert plain.payload == "" and plain.trace_id == ""


def test_records_below_error_are_ignored() -> None:
    client = StubClient()
    install_log_handler(client)
    app_logger.warning("slow query")
    app_logger.info("hello")
    assert client.logs == []


def test_capture_logs_off_disables() -> None:
    client = StubClient()
    mw = ApiLensASGIMiddleware(_asgi_app(_charge_and_log), client, app_id="orders", capture_logs="off")
    _run_asgi(mw)
    assert _root_apilens_handlers() == []
    assert client.logs == []


def test_capture_logs_env_var_off(monkeypatch) -> None:
    monkeypatch.setenv("APILENS_CAPTURE_LOGS", "off")
    client = StubClient()
    ApiLensWSGIMiddleware(lambda e, s: [b""], client, app_id="orders")
    assert _root_apilens_handlers() == []
    monkeypatch.setenv("APILENS_CAPTURE_LOGS", "errors")
    ApiLensWSGIMiddleware(lambda e, s: [b""], client, app_id="orders")
    assert len(_root_apilens_handlers()) == 1


def test_installed_once_on_root_at_error_level() -> None:
    a, b = StubClient(), StubClient()
    ApiLensASGIMiddleware(_asgi_app(lambda: None), a, capture_logs="errors")
    ApiLensWSGIMiddleware(lambda e, s: [b""], b, capture_logs="errors")
    handlers = _root_apilens_handlers()
    assert len(handlers) == 1
    assert handlers[0].level == logging.ERROR
    app_logger.error("boom")
    assert len(b.logs) == 1 and a.logs == []


def test_sdk_own_logger_never_recurses() -> None:
    class LoggingClient(StubClient):
        def capture_log(self, record) -> None:
            # The SDK logging an error while shipping, and an app logger the
            # mask callback might call: neither may re-enter the handler.
            logging.getLogger("apilens").error("delivery failed")
            logging.getLogger("apilens.client").error("queue full")
            app_logger.error("logged from inside capture")
            super().capture_log(record)

    client = LoggingClient()
    install_log_handler(client)
    logging.getLogger("apilens").error("sdk error")
    assert client.logs == []
    app_logger.error("app error")
    assert [log.message for log in client.logs] == ["app error"]


def test_exception_reported_by_middleware_is_not_shipped_twice() -> None:
    def boom():
        raise PaymentError("unhandled")

    client = StubClient()
    mw = ApiLensASGIMiddleware(_asgi_app(boom), client, app_id="orders", capture_logs="errors")
    with pytest.raises(PaymentError) as info:
        _run_asgi(mw)
    # The server logs the escaped exception afterwards (uvicorn does).
    logging.getLogger("uvicorn.error").error("Exception in ASGI application", exc_info=info.value)
    exc_logs = [log for log in client.logs if log.logger_name == "apilens.exception"]
    assert len(exc_logs) == 1
    assert exc_logs[0].status_code == 500  # the middleware's richer record


def test_handler_never_raises_into_logging_call() -> None:
    class BrokenClient(StubClient):
        def capture_log(self, record) -> None:
            raise RuntimeError("queue exploded")

    install_log_handler(BrokenClient())
    app_logger.error("still fine")  # must not raise


@pytest.mark.parametrize(
    "value,expected",
    [("errors", "errors"), ("OFF", "off"), (True, "errors"), (False, "off"), ("false", "off"), ("1", "errors")],
)
def test_normalize_capture_logs(value, expected) -> None:
    assert normalize_capture_logs(value) == expected


def test_normalize_capture_logs_rejects_unknown() -> None:
    with pytest.raises(ValueError, match="capture_logs"):
        normalize_capture_logs("all")


# ── Django ──────────────────────────────────────────────────────────────────


urlpatterns: list = []


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

    monkeypatch.setattr(settings, "APILENS_CAPTURE_LOGS", "errors", raising=False)
    client = StubClient()
    monkeypatch.setattr(apilens_django, "_client_singleton", client)
    return client


def _django_request():
    from django.test import RequestFactory

    return RequestFactory().get("/orders")


def test_django_logged_exception_ships_on_request_trace(django_client) -> None:
    from django.http import HttpResponse

    from apilens.django import ApiLensDjangoMiddleware

    def view(request):
        _charge_and_log()
        return HttpResponse("ok")

    ApiLensDjangoMiddleware(view)(_django_request())
    (rec,) = django_client.records
    (log,) = django_client.logs
    assert log.logger_name == "apilens.exception"
    assert log.trace_id == rec["trace_id"]
    assert "PaymentError" in log.payload


def test_django_unhandled_exception_logged_by_django_request_is_not_duplicated(django_client) -> None:
    from django.http import HttpResponse

    from apilens.django import ApiLensDjangoMiddleware

    def view(request):
        try:
            raise PaymentError("unhandled")
        except PaymentError as exc:
            mw.process_exception(request, exc)
            # Django's handler then logs it on ``django.request``.
            logging.getLogger("django.request").error("Internal Server Error: /orders", exc_info=True)
        return HttpResponse("down", status=500)

    mw = ApiLensDjangoMiddleware(view)
    mw(_django_request())
    exc_logs = [log for log in django_client.logs if log.logger_name == "apilens.exception"]
    assert len(exc_logs) == 1 and exc_logs[0].status_code == 500
