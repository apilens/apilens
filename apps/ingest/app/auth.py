"""API-key authentication via the identity service's introspection endpoint.

Instead of re-implementing the key lookup, the ingest service calls the
identity service (`POST {INTROSPECT_URL}` with a shared internal secret) and
caches the result briefly. This keeps auth logic in one place (the IAM service)
per the CNCF pattern; the short TTL cache bounds latency and tolerates brief
identity blips for already-seen keys.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
import urllib.error
import urllib.request

from .config import load_introspect

_TTL_SECONDS = 60.0
_cache: dict[str, tuple[float, tuple[str, str] | None]] = {}
_lock = threading.Lock()


def _introspect(api_key: str) -> tuple[str, str] | None:
    cfg = load_introspect()
    body = json.dumps({"api_key": api_key}).encode()
    req = urllib.request.Request(
        cfg.url,
        method="POST",
        data=body,
        headers={"Content-Type": "application/json", "X-Internal-Secret": cfg.secret},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError, ValueError):
        return None
    if not data.get("active"):
        return None
    return str(data["project_id"]), str(data["project_slug"])


def authenticate(api_key: str) -> tuple[str, str] | None:
    """Return (project_id, project_slug) for a valid key, else None (cached)."""
    if not api_key:
        return None
    cache_key = hashlib.sha256(api_key.encode()).hexdigest()
    now = time.monotonic()
    with _lock:
        entry = _cache.get(cache_key)
        if entry and entry[0] > now:
            return entry[1]
    result = _introspect(api_key)
    with _lock:
        _cache[cache_key] = (now + _TTL_SECONDS, result)
    return result
