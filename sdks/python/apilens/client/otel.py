from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.trace import SpanKind

from .client import ApiLensClient
from .models import RequestRecord

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
        capture_client_ip: bool = False,
        capture_user_agent: bool = True,
    ) -> None:
        self.client = client
        self.app_id = app_id
        self.environment = environment
        self.capture_client_ip = capture_client_ip
        self.capture_user_agent = capture_user_agent

    def export(self, spans: list[ReadableSpan]) -> SpanExportResult:
        records: list[RequestRecord] = []

        for span in spans:
            if span.kind not in (SpanKind.SERVER, SpanKind.CONSUMER):
                continue

            attrs = dict(span.attributes or {})
            method = str(_pick_attr(attrs, _HTTP_METHOD_KEYS, "GET")).upper()
            path = _normalize_path(_pick_attr(attrs, _HTTP_PATH_KEYS, "/"))
            status_code = _coerce_int(_pick_attr(attrs, _HTTP_STATUS_KEYS, 0), 0)

            if path.endswith("/ingest/requests"):
                # Avoid ingest loop if transport is instrumented.
                continue

            duration_ms = max((span.end_time - span.start_time) / 1_000_000.0, 0.0)
            timestamp = datetime.fromtimestamp(span.start_time / 1_000_000_000, tz=timezone.utc)

            ip_address = ""
            if self.capture_client_ip:
                ip_address = str(_pick_attr(attrs, _HTTP_IP_KEYS, "") or "")

            user_agent = ""
            if self.capture_user_agent:
                user_agent = str(_pick_attr(attrs, _HTTP_USER_AGENT_KEYS, "") or "")

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
        capture_client_ip=capture_client_ip,
        capture_user_agent=capture_user_agent,
    )
    provider.add_span_processor(BatchSpanProcessor(exporter))
    setattr(provider, "_apilens_exporter_installed", True)
    return provider
