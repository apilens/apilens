from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.trace import SpanKind, StatusCode

from ._capture import apply_ip_policy
from ._exception import MAX_EXCEPTION_MESSAGE, MAX_EXCEPTION_PAYLOAD, truncate_head_tail
from .client import ApiLensClient
from .models import RequestRecord, SpanEvent, SpanRecord
from .spans import env_spans_enabled

_HTTP_METHOD_KEYS = ("http.request.method", "http.method")
_HTTP_PATH_KEYS = ("http.route", "url.path", "http.target")
_HTTP_STATUS_KEYS = ("http.response.status_code", "http.status_code")
_HTTP_REQUEST_SIZE_KEYS = (
    "http.request.body.size",
    "http.request_content_length",
    "http.request_content_length_uncompressed",
)
_HTTP_RESPONSE_SIZE_KEYS = (
    "http.response.body.size",
    "http.response_content_length",
    "http.response_content_length_uncompressed",
)
_HTTP_IP_KEYS = ("client.address", "http.client_ip", "net.peer.ip")
_HTTP_USER_AGENT_KEYS = ("user_agent.original", "http.user_agent")

# Span attribute and event caps, the same as ingest's (/v1/traces): longer
# values and extra keys would be cut there anyway.
_MAX_SPAN_ATTRIBUTES = 64
_MAX_ATTRIBUTE_VALUE_CHARS = 512
_MAX_SPAN_EVENTS = 128
_EXCEPTION_EVENT = "exception"
# Event attributes allowed past the default cap (head and tail kept, D4).
_LONG_EVENT_ATTRIBUTES = {
    "exception.stacktrace": MAX_EXCEPTION_PAYLOAD,
    "exception.message": MAX_EXCEPTION_MESSAGE,
}


def _pick_attr(attrs: dict[str, Any], keys: tuple[str, ...], default: Any = None) -> Any:
    for key in keys:
        value = attrs.get(key)
        if value is not None:
            return value
    return default


def _normalize_path(raw_path: str | None) -> str:
    path = (raw_path or "/").strip()
    if not path:
        return "/"
    if path.startswith("http://") or path.startswith("https://"):
        # urlparse would pull path but this keeps deps minimal and stable.
        slash_idx = path.find("/", path.find("//") + 2)
        path = path[slash_idx:] if slash_idx != -1 else "/"
    q_idx = path.find("?")
    if q_idx != -1:
        path = path[:q_idx]
    if not path.startswith("/"):
        path = f"/{path}"
    return path


def _coerce_int(value: Any, default: int = 0) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _attribute_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, tuple)):
        # OTel array attribute: keep every element, as JSON.
        return json.dumps(list(value), default=str, ensure_ascii=False)
    return "" if value is None else str(value)


def _otel_attributes(
    attrs: Mapping[str, Any] | None, long_values: Mapping[str, int] | None = None
) -> dict[str, str]:
    """OTel span/event attributes as the string map of the JSON span schema."""
    output: dict[str, str] = {}
    for key, value in (attrs or {}).items():
        if len(output) >= _MAX_SPAN_ATTRIBUTES:
            break
        clean_key = str(key or "").strip()
        if not clean_key:
            continue
        limit = (long_values or {}).get(clean_key)
        text = _attribute_text(value)
        output[clean_key] = truncate_head_tail(text, limit) if limit else text[:_MAX_ATTRIBUTE_VALUE_CHARS]
    return output


def _ns_to_datetime(ns: int) -> datetime:
    return datetime.fromtimestamp(ns / 1_000_000_000, tz=timezone.utc)


def _span_events(span: ReadableSpan, is_error: bool, status_message: str) -> list[SpanEvent]:
    """The span's events (``exception`` events keep their full stack trace);
    an errored span without one gets an ``exception`` event built from its
    status, so the failure always carries its reason."""
    events = [
        SpanEvent(
            timestamp=_ns_to_datetime(event.timestamp or span.start_time),
            name=str(event.name or ""),
            attributes=_otel_attributes(event.attributes, _LONG_EVENT_ATTRIBUTES),
        )
        for event in list(span.events or ())[:_MAX_SPAN_EVENTS]
    ]
    if is_error and not any(event.name == _EXCEPTION_EVENT for event in events):
        attrs = span.attributes or {}
        exc_type = _attribute_text(attrs.get("exception.type") or attrs.get("error.type") or "")
        exc_attrs = {"exception.type": exc_type, "exception.message": status_message}
        event = SpanEvent(
            timestamp=_ns_to_datetime(span.end_time or span.start_time),
            name=_EXCEPTION_EVENT,
            attributes={k: v for k, v in exc_attrs.items() if v},
        )
        if len(events) >= _MAX_SPAN_EVENTS:
            events[-1] = event
        else:
            events.append(event)
    return events


def _coerce_float(value: Any, default: float = 0.0) -> float:
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


class ApiLensSpanExporter(SpanExporter):
    def __init__(
        self,
        client: ApiLensClient,
        *,
        app_id: str,
        environment: str,
        service_name: str = "",
        capture_client_ip: bool = False,
        capture_user_agent: bool = True,
        export_spans: bool = True,
    ) -> None:
        self.client = client
        self.app_id = app_id
        self.environment = environment
        self.service_name = service_name
        self.capture_client_ip = capture_client_ip
        self.capture_user_agent = capture_user_agent
        # Ship the full span tree to /v1/traces (waterfall view), in addition
        # to collapsing SERVER/CONSUMER spans into request records.
        self.export_spans = export_spans

    def _to_span_record(self, span: ReadableSpan, attrs: dict[str, Any]) -> SpanRecord:
        span_context = span.get_span_context()
        duration_ms = max((span.end_time - span.start_time) / 1_000_000.0, 0.0)
        is_error = span.status is not None and span.status.status_code is StatusCode.ERROR
        description = span.status.description if span.status is not None else ""
        status_message = truncate_head_tail(str(description or "").strip(), MAX_EXCEPTION_MESSAGE)
        return SpanRecord(
            timestamp=datetime.fromtimestamp(span.start_time / 1_000_000_000, tz=timezone.utc),
            environment=self.environment,
            trace_id=format(span_context.trace_id, "032x") if span_context.trace_id else "",
            span_id=format(span_context.span_id, "016x") if span_context.span_id else "",
            parent_span_id=format(span.parent.span_id, "016x") if span.parent else "",
            name=span.name or "",
            kind=span.kind.name.lower() if span.kind else "internal",
            service_name=self.service_name,
            duration_ms=duration_ms,
            status="error" if is_error else "ok",
            status_code=_coerce_int(_pick_attr(attrs, _HTTP_STATUS_KEYS, 0), 0),
            project_slug=self.client.config.project_slug,
            app_id=self.app_id,
            attributes=_otel_attributes(attrs),
            status_message=status_message,
            events=_span_events(span, is_error, status_message),
        )

    def export(self, spans: list[ReadableSpan]) -> SpanExportResult:
        records: list[RequestRecord] = []

        for span in spans:
            attrs = dict(span.attributes or {})
            path = _normalize_path(_pick_attr(attrs, _HTTP_PATH_KEYS, "/"))

            if path.endswith("/v1/requests") or path.endswith("/v1/traces") or path.endswith("/v1/logs"):
                # Avoid ingest loop if transport is instrumented.
                continue

            if self.export_spans and env_spans_enabled():
                span_record = self._to_span_record(span, attrs)
                if span_record.trace_id and span_record.span_id:
                    self.client.capture_span(span_record)

            if span.kind not in (SpanKind.SERVER, SpanKind.CONSUMER):
                continue

            method = str(_pick_attr(attrs, _HTTP_METHOD_KEYS, "GET")).upper()
            status_code = _coerce_int(_pick_attr(attrs, _HTTP_STATUS_KEYS, 0), 0)

            duration_ms = max((span.end_time - span.start_time) / 1_000_000.0, 0.0)
            timestamp = datetime.fromtimestamp(span.start_time / 1_000_000_000, tz=timezone.utc)

            ip_address = ""
            if self.capture_client_ip:
                ip_address = apply_ip_policy(
                    str(_pick_attr(attrs, _HTTP_IP_KEYS, "") or ""),
                    capture_ip=getattr(self.client.config, "capture_ip", True),
                    anonymize=getattr(self.client.config, "anonymize_ip", False),
                )

            user_agent = ""
            if self.capture_user_agent:
                user_agent = str(_pick_attr(attrs, _HTTP_USER_AGENT_KEYS, "") or "")

            span_context = span.get_span_context()
            trace_id = format(span_context.trace_id, "032x") if span_context.trace_id else ""
            span_id = format(span_context.span_id, "016x") if span_context.span_id else ""

            record = RequestRecord(
                timestamp=timestamp,
                environment=self.environment,
                project_slug=self.client.config.project_slug,
                app_id=self.app_id,
                method=method,
                path=path,
                status_code=status_code,
                response_time_ms=duration_ms,
                request_size=_coerce_int(_pick_attr(attrs, _HTTP_REQUEST_SIZE_KEYS, 0), 0),
                response_size=_coerce_int(_pick_attr(attrs, _HTTP_RESPONSE_SIZE_KEYS, 0), 0),
                ip_address=ip_address,
                user_agent=user_agent,
                trace_id=trace_id,
                span_id=span_id,
            )
            records.append(record)

        if records:
            self.client.capture_many(records)

        return SpanExportResult.SUCCESS

    def shutdown(self) -> None:
        self.client.flush_all()


def install_apilens_exporter(
    client: ApiLensClient,
    *,
    app_id: str,
    service_name: str,
    environment: str,
    tracer_provider: TracerProvider | None = None,
    capture_client_ip: bool = False,
    capture_user_agent: bool = True,
) -> TracerProvider:
    provider = tracer_provider

    if provider is None:
        current = trace.get_tracer_provider()
        if isinstance(current, TracerProvider):
            provider = current
        else:
            resource = Resource.create(
                {
                    "service.name": service_name,
                    "deployment.environment": environment,
                }
            )
            provider = TracerProvider(resource=resource)
            trace.set_tracer_provider(provider)

    if getattr(provider, "_apilens_exporter_installed", False):
        return provider

    exporter = ApiLensSpanExporter(
        client,
        app_id=app_id,
        environment=environment,
        service_name=service_name,
        capture_client_ip=capture_client_ip,
        capture_user_agent=capture_user_agent,
    )
    provider.add_span_processor(BatchSpanProcessor(exporter))
    setattr(provider, "_apilens_exporter_installed", True)
    return provider
