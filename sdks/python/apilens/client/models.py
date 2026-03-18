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
    request_size: int = 0
    response_size: int = 0
    ip_address: str = ""
    user_agent: str = ""
    consumer_id: str = ""
    consumer_name: str = ""
    consumer_group: str = ""
    request_payload: str = ""
    response_payload: str = ""

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
        }
