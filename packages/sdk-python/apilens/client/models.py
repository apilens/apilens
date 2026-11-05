from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass(slots=True)
class RequestRecord:
    timestamp: datetime
    environment: str
    method: str
    path: str
    status_code: int
    response_time_ms: float
    # Exact request path for the log; ``path`` is the grouping template.
    raw_path: str = ""
    project_slug: str = ""
    app_id: str = ""  # Required by backend API
    request_size: int = 0
    response_size: int = 0
    ip_address: str = ""
    user_agent: str = ""
    consumer_id: str = ""
    consumer_name: str = ""
    consumer_group: str = ""
    request_payload: str = ""
    response_payload: str = ""
    request_headers: str = ""
    response_headers: str = ""
    base_url: str = ""
    trace_id: str = ""
    span_id: str = ""
    # Deploy correlation; empty fields inherit the client config at capture time.
    release: str = ""
    commit: str = ""
    # False when ``sample_rate`` dropped this request's detail (headers,
    # bodies, spans, logs). The base record is always sent so metrics stay
    # exact; only the request-log detail is sampled.
    sampled: bool = True
    # Custom metadata from ``set_request_attribute`` (str/int/float/bool
    # values). Sent as a JSON object; omitted when empty.
    attributes: dict[str, str | int | float | bool] | None = None
    # Field errors parsed from a framework validation response (FastAPI /
    # Django Ninja 422, Litestar 400): ``[{loc, msg, type}]``, at most 20,
    # ``loc`` dotted. Sent only when non-empty.
    validation_errors: list[dict[str, str]] | None = None

    def to_wire(self) -> dict[str, object]:
        ts = self.timestamp
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        else:
            ts = ts.astimezone(timezone.utc)

        iso = ts.isoformat().replace("+00:00", "Z")
        path = self.path or "/"
        if not path.startswith("/"):
            path = f"/{path}"
        raw_path = self.raw_path or path
        if not raw_path.startswith("/"):
            raw_path = f"/{raw_path}"

        wire: dict[str, object] = {
            "project_slug": self.project_slug or "",
            "app_id": self.app_id or "",
            "timestamp": iso,
            "environment": self.environment,
            "method": (self.method or "GET").upper(),
            "path": path,
            "raw_path": raw_path,
            "status_code": int(self.status_code),
            "response_time_ms": float(self.response_time_ms),
            "request_size": int(self.request_size or 0),
            "response_size": int(self.response_size or 0),
            "ip_address": self.ip_address or "",
            "user_agent": self.user_agent or "",
            "consumer_id": self.consumer_id or "",
            "consumer_name": self.consumer_name or "",
            "consumer_group": self.consumer_group or "",
            "request_payload": self.request_payload or "",
            "response_payload": self.response_payload or "",
            "request_headers": self.request_headers or "",
            "response_headers": self.response_headers or "",
            "base_url": self.base_url or "",
            "trace_id": self.trace_id or "",
            "span_id": self.span_id or "",
            "release": self.release or "",
            "commit": self.commit or "",
        }
        # Only sent when False: ingest reads an absent flag as sampled in, so
        # sampled-in records stay byte-identical to SDKs without sampling.
        if not self.sampled:
            wire["sampled"] = False
        if self.attributes:
            wire["attributes"] = dict(self.attributes)
        if self.validation_errors:
            wire["validation_errors"] = [
                {"loc": str(e.get("loc") or ""), "msg": str(e.get("msg") or ""), "type": str(e.get("type") or "")}
                for e in self.validation_errors[:20]
            ]
        return wire


def _iso_utc(ts: datetime) -> str:
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    else:
        ts = ts.astimezone(timezone.utc)
    return ts.isoformat().replace("+00:00", "Z")


@dataclass(slots=True)
class SpanRecord:
    """One span of a distributed trace (the unit sent to /v1/traces)."""

    timestamp: datetime  # span start, UTC
    environment: str
    trace_id: str
    span_id: str
    name: str
    parent_span_id: str = ""
    kind: str = "internal"  # server | client | http | db | internal | ...
    service_name: str = ""
    duration_ms: float = 0.0
    status: str = "ok"  # ok | error
    status_code: int = 0
    project_slug: str = ""
    app_id: str = ""
    attributes: dict[str, str] | None = None
    release: str = ""
    commit: str = ""

    def to_wire(self) -> dict[str, object]:
        return {
            "project_slug": self.project_slug or "",
            "app_id": self.app_id or "",
            "timestamp": _iso_utc(self.timestamp),
            "environment": self.environment,
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "parent_span_id": self.parent_span_id or "",
            "name": self.name or "",
            "kind": (self.kind or "internal").lower(),
            "service_name": self.service_name or "",
            "duration_ms": float(self.duration_ms or 0.0),
            "status": (self.status or "ok").lower(),
            "status_code": int(self.status_code or 0),
            "attributes": {str(k): str(v) for k, v in (self.attributes or {}).items()},
            "release": self.release or "",
            "commit": self.commit or "",
        }


@dataclass(slots=True)
class LogRecord:
    """One log line correlated to a trace (the unit sent to /v1/logs).

    APILens emits these automatically for errors — an unhandled exception or a
    5xx response — so the failing request's trace carries its message. It is
    not a general application-logging API.
    """

    timestamp: datetime
    environment: str
    level: str
    message: str
    trace_id: str
    span_id: str = ""
    logger_name: str = ""
    endpoint_method: str = ""
    endpoint_path: str = ""
    status_code: int = 0
    consumer_id: str = ""
    consumer_name: str = ""
    consumer_group: str = ""
    project_slug: str = ""
    app_id: str = ""
    payload: str = ""
    attributes: dict[str, str] | None = None
    release: str = ""
    commit: str = ""

    def to_wire(self) -> dict[str, object]:
        return {
            "project_slug": self.project_slug or "",
            "app_id": self.app_id or "",
            "timestamp": _iso_utc(self.timestamp),
            "environment": self.environment,
            "level": (self.level or "INFO").upper(),
            "message": self.message or "",
            "logger_name": self.logger_name or "",
            "endpoint_method": (self.endpoint_method or "").upper(),
            "endpoint_path": self.endpoint_path or "",
            "status_code": int(self.status_code or 0),
            "consumer_id": self.consumer_id or "",
            "consumer_name": self.consumer_name or "",
            "consumer_group": self.consumer_group or "",
            "trace_id": self.trace_id or "",
            "span_id": self.span_id or "",
            "payload": self.payload or "",
            "attributes": {str(k): str(v) for k, v in (self.attributes or {}).items()},
            "release": self.release or "",
            "commit": self.commit or "",
        }
