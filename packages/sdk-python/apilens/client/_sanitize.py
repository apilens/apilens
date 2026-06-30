"""Header redaction and UTF-8-safe payload decoding.

Shared by the ASGI and WSGI middlewares so request/response capture behaves
identically across frameworks.
"""

from __future__ import annotations

import json

REDACTED = "[redacted]"

# Header names whose VALUES must never leave the app (case-insensitive).
SENSITIVE_HEADERS = frozenset(
    {
        "authorization",
        "proxy-authorization",
        "cookie",
        "set-cookie",
        "x-api-key",
        "api-key",
        "x-auth-token",
        "x-amz-security-token",
        "x-csrf-token",
    }
)

# Cap on the serialized header JSON so a pathological request can't bloat a row.
_MAX_HEADER_BYTES = 8192


def decode_utf8_safe(data: bytes) -> str:
    """Decode UTF-8, dropping an incomplete multibyte sequence at the tail.

    Payloads are captured by byte budget, so the cut can land in the middle of a
    multibyte character (common for non-ASCII / non-English text). Trimming the
    dangling continuation bytes before decoding avoids the trailing ``�`` that
    ``errors="replace"`` would otherwise produce.
    """
    if not data:
        return ""
    # Walk back over trailing UTF-8 continuation bytes (0b10xxxxxx). At most 3
    # can precede the lead byte of a 4-byte sequence.
    cut = len(data)
    for _ in range(4):
        try:
            return data[:cut].decode("utf-8")
        except UnicodeDecodeError as exc:
            # Re-raise if the error isn't at the very end (genuinely malformed).
            if exc.start < cut - 4:
                break
            cut = exc.start
    return data.decode("utf-8", errors="replace")


def serialize_headers(headers: dict[str, str], *, max_bytes: int = _MAX_HEADER_BYTES) -> str:
    """Serialize a header map to a compact JSON string, redacting secrets.

    Returns ``""`` when there are no headers. Sensitive values are replaced with
    ``[redacted]``; the whole blob is capped so it can't dominate a row.
    """
    if not headers:
        return ""
    safe: dict[str, str] = {}
    for key, value in headers.items():
        name = (key or "").lower()
        if not name:
            continue
        safe[name] = REDACTED if name in SENSITIVE_HEADERS else str(value)
    if not safe:
        return ""
    blob = json.dumps(safe, separators=(",", ":"), ensure_ascii=False)
    if len(blob.encode("utf-8")) > max_bytes:
        # Drop keys (longest values first) until it fits.
        for name, _ in sorted(safe.items(), key=lambda kv: len(kv[1]), reverse=True):
            del safe[name]
            blob = json.dumps(safe, separators=(",", ":"), ensure_ascii=False)
            if len(blob.encode("utf-8")) <= max_bytes:
                break
    return blob
