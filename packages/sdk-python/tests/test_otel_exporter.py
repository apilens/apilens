"""OTel exporter keeps span attributes, status description and the
``exception`` event (full stack trace) of errored spans."""

from __future__ import annotations

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.trace import Status, StatusCode

from apilens.client.otel import ApiLensSpanExporter

from conftest import StubClient


class _Client(StubClient):
    def capture_many(self, records) -> None:
        self.records.extend(records)

    def flush_all(self) -> None:
        pass


@pytest.fixture
def exported():
    client = _Client()
    exporter = ApiLensSpanExporter(client, app_id="orders", environment="test", service_name="orders-svc")
    provider = TracerProvider(shutdown_on_exit=False)
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    yield client, provider.get_tracer("test")
    provider.shutdown()


def _fail_deep(depth: int) -> None:
    if depth == 0:
        raise ValueError("card declined")
    _fail_deep(depth - 1)


def test_attributes_status_and_exception_event(exported):
    client, tracer = exported
    with tracer.start_as_current_span("charge", record_exception=False, set_status_on_exception=False) as span:
        span.set_attribute("payment.provider", "stripe")
        span.set_attribute("payment.amount", 42)
        span.set_attribute("payment.retry", True)
        span.set_attribute("payment.tags", ["a", "b"])
        try:
            _fail_deep(3)
        except ValueError as exc:
            span.record_exception(exc)
            span.set_status(Status(StatusCode.ERROR, "card declined by issuer"))

    [record] = client.spans
    assert record.status == "error"
    assert record.attributes["payment.provider"] == "stripe"
    assert record.attributes["payment.amount"] == "42"
    assert record.attributes["payment.retry"] == "true"
    assert record.attributes["payment.tags"] == '["a", "b"]'
    assert record.status_message == "card declined by issuer"

    [event] = record.events
    assert event.name == "exception"
    assert event.attributes["exception.type"] == "ValueError"
    assert event.attributes["exception.message"] == "card declined"
    assert "_fail_deep" in event.attributes["exception.stacktrace"]

    wire = record.to_wire()
    assert wire["status_message"] == "card declined by issuer"
    assert wire["attributes"]["payment.provider"] == "stripe"
    assert wire["events"][0]["name"] == "exception"
    assert wire["events"][0]["timestamp"].endswith("Z")
    assert "_fail_deep" in wire["events"][0]["attributes"]["exception.stacktrace"]


def test_errored_span_without_exception_event_gets_one(exported):
    client, tracer = exported
    with tracer.start_as_current_span("charge") as span:
        span.set_attribute("error.type", "TimeoutError")
        span.set_status(Status(StatusCode.ERROR, "upstream timed out"))

    [record] = client.spans
    [event] = record.events
    assert event.name == "exception"
    assert event.attributes == {"exception.type": "TimeoutError", "exception.message": "upstream timed out"}


def test_long_stacktrace_keeps_head_and_tail(exported):
    client, tracer = exported
    stack = "HEAD" + "x" * 200_000 + "TAIL"
    with tracer.start_as_current_span("charge") as span:
        span.add_event("exception", {"exception.type": "E", "exception.stacktrace": stack})
        span.set_status(Status(StatusCode.ERROR))

    [record] = client.spans
    kept = record.events[0].attributes["exception.stacktrace"]
    assert len(kept) <= 64 * 1024
    assert kept.startswith("HEAD") and kept.endswith("TAIL")
    assert "chars truncated" in kept


def test_ok_span_has_no_events_or_status_message(exported):
    client, tracer = exported
    with tracer.start_as_current_span("list") as span:
        span.set_attribute("db.system", "postgresql")

    [record] = client.spans
    assert record.status == "ok"
    assert record.events == []
    assert record.status_message == ""
    wire = record.to_wire()
    assert "events" not in wire and "status_message" not in wire
    assert wire["attributes"] == {"db.system": "postgresql"}
