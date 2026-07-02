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

        return {
            "project_slug": self.project_slug or "",
            "app_id": self.app_id or "",
            "timestamp": iso,
            "environment": self.environment,
            "method": (self.method or "GET").upper(),
            "path": path,
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
        }


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
        }
