from __future__ import annotations

import ipaddress
import os
import time
from dataclasses import dataclass
from typing import Iterable

from .client import ApiLensClient


@dataclass(slots=True)
class CaptureContext:
    method: str
    path: str
    # The exact request path as received (``/product/123``). ``path`` holds the
    # grouping template (``/product/{id}``); this preserves the real URL for the
    # request log. Defaults to ``path`` when a caller doesn't set it.
    raw_path: str = ""
    project_slug: str = ""
    app_id: str = ""
    request_size: int = 0
    ip_address: str = ""
    user_agent: str = ""
    consumer_id: str = ""
    consumer_name: str = ""
    consumer_group: str = ""
    request_payload: str = ""
    request_headers: str = ""
    base_url: str = ""
    trace_id: str = ""
    span_id: str = ""
    # False when sample_rate dropped this request's detail.
    sampled: bool = True



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



_TRUTHY = {"1", "true", "yes", "on", "enabled"}
_FALSEY = {"0", "false", "no", "off", "disabled"}


def env_capture_ip_enabled() -> bool:
    """``APILENS_CAPTURE_IP=false`` is a deploy-time kill-switch for client IPs.

    Returns ``True`` unless the variable is set to a falsey value. Like the
    other privacy env vars it can only tighten capture: an env ``false`` wins
    over ``capture_ip=True`` in code, never the other way round.
    """
    raw = os.getenv("APILENS_CAPTURE_IP")
    if raw is None:
        return True
    return raw.strip().lower() not in _FALSEY


def env_anonymize_ip_enabled() -> bool:
    """``APILENS_ANONYMIZE_IP=true`` forces IP anonymisation for the process."""
    raw = os.getenv("APILENS_ANONYMIZE_IP")
    if raw is None:
        return False
    return raw.strip().lower() in _TRUTHY


def _parse_ip(raw: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """Parse one client address, tolerating the shapes proxies send.

    Accepts a bare v4/v6 address, the first entry of an ``X-Forwarded-For``
    list, ``1.2.3.4:5678``, ``[2001:db8::1]:443`` and zone ids
    (``fe80::1%eth0``). Returns ``None`` for anything else.
    """
    value = (raw or "").split(",", 1)[0].strip()
    if not value:
        return None
    if value.startswith("["):
        end = value.find("]")
        if end == -1:
            return None
        value = value[1:end]
    elif value.count(":") == 1:
        # IPv4 with a port; a bare IPv6 address always has 2+ colons.
        value = value.split(":", 1)[0]
    value = value.split("%", 1)[0]
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        return None


def anonymize_ip(raw: str) -> str:
    """Truncate a client IP: IPv4 keeps its /24 (last octet zeroed), IPv6 its /48.

    IPv4-mapped IPv6 (``::ffff:1.2.3.4``) is treated as IPv4. A value that is
    not a parseable IP returns ``""`` — it cannot be anonymised safely, so it
    is dropped rather than sent as-is.
    """
    addr = _parse_ip(raw)
    if addr is None:
        return ""
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    prefix = 24 if addr.version == 4 else 48
    return str(ipaddress.ip_network(f"{addr}/{prefix}", strict=False).network_address)


def apply_ip_policy(ip_address: str, *, capture_ip: bool = True, anonymize: bool = False) -> str:
    """Return the client IP to record under the capture/anonymise options."""
    if not capture_ip or not env_capture_ip_enabled():
        return ""
    if anonymize or env_anonymize_ip_enabled():
        return anonymize_ip(ip_address)
    return ip_address


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
    response_headers: str = "",
) -> None:
    elapsed_ms = max((time.perf_counter() - started_at) * 1000.0, 0.0)
    # IP privacy is applied here, once, so every integration (ASGI, WSGI,
    # Django) honours ``capture_ip`` / ``anonymize_ip`` before the record exists.
    ip_address = apply_ip_policy(
        ctx.ip_address,
        capture_ip=getattr(client.config, "capture_ip", True),
        anonymize=getattr(client.config, "anonymize_ip", False),
    )
    client.capture(
        method=ctx.method,
        path=ctx.path,
        raw_path=ctx.raw_path or ctx.path,
        project_slug=ctx.project_slug,
        status_code=status_code,
        response_time_ms=elapsed_ms,
        app_id=ctx.app_id,
        request_size=ctx.request_size,
        response_size=max(response_size, 0),
        ip_address=ip_address,
        user_agent=ctx.user_agent,
        consumer_id=ctx.consumer_id,
        consumer_name=ctx.consumer_name,
        consumer_group=ctx.consumer_group,
        request_payload=ctx.request_payload,
        response_payload=response_payload,
        request_headers=ctx.request_headers,
        response_headers=response_headers,
        environment=environment,
        base_url=ctx.base_url,
        trace_id=ctx.trace_id,
        span_id=ctx.span_id,
        sampled=ctx.sampled,
    )
