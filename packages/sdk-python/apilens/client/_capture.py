from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Iterable

from .client import ApiLensClient


@dataclass(slots=True)
class CaptureContext:
    method: str
    path: str
    project_slug: str = ""
    app_id: str = ""
    request_size: int = 0
    ip_address: str = ""
    user_agent: str = ""
    consumer_id: str = ""
    consumer_name: str = ""
    consumer_group: str = ""
    request_payload: str = ""
    base_url: str = ""



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



def _detect_base_url_from_headers(headers: dict[str, str], default_scheme: str = "https") -> str:
    """Build scheme://host from request headers, respecting reverse-proxy headers."""
    scheme = headers.get("x-forwarded-proto", "").split(",")[0].strip() or default_scheme
    host = headers.get("x-forwarded-host", "").split(",")[0].strip() or headers.get("host", "").strip()
    if not host:
        return ""
    return f"{scheme}://{host}"


def _detect_base_url_from_environ(environ: dict) -> str:
    """Build scheme://host from a WSGI environ dict."""
    scheme = environ.get("HTTP_X_FORWARDED_PROTO", "").split(",")[0].strip() or environ.get("wsgi.url_scheme", "http")
    host = (environ.get("HTTP_X_FORWARDED_HOST", "").split(",")[0].strip()
            or environ.get("HTTP_HOST", "").strip())
    if not host:
        server_name = environ.get("SERVER_NAME", "")
        server_port = environ.get("SERVER_PORT", "")
        if server_name:
            host = f"{server_name}:{server_port}" if server_port not in ("80", "443", "") else server_name
    if not host:
        return ""
    return f"{scheme}://{host}"


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
        project_slug=ctx.project_slug,
        status_code=status_code,
        response_time_ms=elapsed_ms,
        app_id=ctx.app_id,
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
        base_url=ctx.base_url,
    )
