from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Iterable

from .client import ApiLensClient


@dataclass(slots=True)
class CaptureContext:
    method: str
    path: str
    request_size: int = 0
    ip_address: str = ""
    user_agent: str = ""
    consumer_id: str = ""
    consumer_name: str = ""
    consumer_group: str = ""
    request_payload: str = ""



def _headers_to_dict(headers: Iterable[tuple[bytes, bytes]]) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw_k, raw_v in headers:
        key = raw_k.decode("latin-1").lower()
        value = raw_v.decode("latin-1")
        out[key] = value
    return out



def _normalize_path(path: str) -> str:
    value = (path or "/").strip()
    if not value:
        return "/"
    q_index = value.find("?")
    if q_index != -1:
        value = value[:q_index]
    if not value.startswith("/"):
        value = f"/{value}"
    return value



def _to_int(raw: str | None, default: int = 0) -> int:
    if not raw:
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default



def _extract_ip(headers: dict[str, str], fallback: str = "") -> str:
    xff = headers.get("x-forwarded-for", "").strip()
    if xff:
        return xff.split(",", 1)[0].strip()
    return headers.get("x-real-ip", "").strip() or fallback



def _extract_user_agent(headers: dict[str, str]) -> str:
    return headers.get("user-agent", "").strip()



def capture_response(
    client: ApiLensClient,
    ctx: CaptureContext,
    *,
    status_code: int,
    response_size: int,
    started_at: float,
    environment: str | None = None,
    response_payload: str = "",
) -> None:
    elapsed_ms = max((time.perf_counter() - started_at) * 1000.0, 0.0)
    client.capture(
        method=ctx.method,
        path=ctx.path,
        status_code=status_code,
        response_time_ms=elapsed_ms,
        request_size=ctx.request_size,
        response_size=max(response_size, 0),
        ip_address=ctx.ip_address,
        user_agent=ctx.user_agent,
        consumer_id=ctx.consumer_id,
        consumer_name=ctx.consumer_name,
        consumer_group=ctx.consumer_group,
        request_payload=ctx.request_payload,
        response_payload=response_payload,
        environment=environment,
    )
