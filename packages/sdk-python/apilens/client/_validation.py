"""Structured validation errors parsed from framework error responses.

FastAPI/Starlette and Django Ninja answer a request that fails validation
with ``422 {"detail": [{"loc": [...], "msg": "...", "type": "..."}]}``;
Litestar answers ``400 {"detail": "Validation failed ...", "extra":
[{"message": "...", "key": "...", "source": "..."}]}``. The middlewares
parse those bodies into ``RequestRecord.validation_errors`` so the dashboard
can count failures per field, independently of whether the response body
itself is captured (``log_response_body=False``) or the request's detail was
sampled out.

Only ``loc``, ``msg`` and ``type`` are kept: pydantic's ``input`` (the
rejected value) and ``ctx`` never leave the app. ``loc`` segments nested
under a field whose name matches the body field masking patterns
(``redact_body_fields`` plus the built-ins) become ``[redacted]``, exactly as
that field's value would be in a captured body. Parsing never raises.
"""

from __future__ import annotations

import json
from typing import Any

from ._sanitize import REDACTED, Redactor

# At most this many entries per request (matches the ingest cap).
MAX_VALIDATION_ERRORS = 20
# Bytes of a validation response buffered for parsing; larger bodies are
# truncated JSON and parse to nothing.
MAX_VALIDATION_BODY_BYTES = 65536
_MAX_LOC_CHARS = 256
_MAX_MSG_CHARS = 512
_MAX_TYPE_CHARS = 128

# 422 for FastAPI/Starlette and Django Ninja, 400 for Litestar.
_VALIDATION_STATUSES = frozenset({400, 422})

ValidationError = dict[str, str]


def _is_json(content_type: str | None) -> bool:
    media = (content_type or "").split(";", 1)[0].strip().lower()
    return media == "application/json" or media.endswith("+json")


def is_validation_response(status_code: int, content_type: str | None) -> bool:
    """True when a response may carry validation errors (400/422 JSON)."""
    return status_code in _VALIDATION_STATUSES and _is_json(content_type)


def _scalar(value: Any) -> str:
    if value is None or isinstance(value, (dict, list)):
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _loc_segments(loc: Any) -> list[str]:
    if isinstance(loc, (list, tuple)):
        return [seg for seg in (_scalar(part) for part in loc) if seg != ""]
    text = _scalar(loc)
    return [seg for seg in text.split(".") if seg != ""] if text else []


def _mask_loc(segments: list[str], redactor: Redactor | None) -> str:
    """Join loc segments with ``.``, redacting everything beneath a masked field.

    A masked field's own name stays visible (as it does in a captured body);
    the segments below it are dict keys or indexes inside a value that would
    have been stored as ``[redacted]``, so they are redacted too.
    """
    if redactor is not None:
        pattern = redactor.body_fields
        for i, seg in enumerate(segments):
            if pattern.search(seg):
                segments = [*segments[: i + 1], *([REDACTED] * (len(segments) - i - 1))]
                break
    return ".".join(segments)


def _entry(loc: list[str], msg: Any, typ: Any, redactor: Redactor | None) -> ValidationError | None:
    message = _scalar(msg).strip()
    if not message:
        return None
    return {
        "loc": _mask_loc(loc, redactor)[:_MAX_LOC_CHARS],
        "msg": message[:_MAX_MSG_CHARS],
        "type": _scalar(typ).strip()[:_MAX_TYPE_CHARS],
    }


def _pydantic(detail: Any, redactor: Redactor | None) -> list[ValidationError]:
    out: list[ValidationError] = []
    if not isinstance(detail, list):
        return out
    for item in detail:
        if not isinstance(item, dict) or "loc" not in item:
            continue
        entry = _entry(_loc_segments(item.get("loc")), item.get("msg"), item.get("type"), redactor)
        if entry is not None:
            out.append(entry)
            if len(out) >= MAX_VALIDATION_ERRORS:
                break
    return out


def _litestar(extra: Any, redactor: Redactor | None) -> list[ValidationError]:
    out: list[ValidationError] = []
    if not isinstance(extra, list):
        return out
    for item in extra:
        if not isinstance(item, dict) or "message" not in item:
            continue
        loc = _loc_segments(item.get("key"))
        source = _scalar(item.get("source")).strip()
        if source and loc:
            loc = [source, *loc]
        entry = _entry(loc, item.get("message"), "", redactor)
        if entry is not None:
            out.append(entry)
            if len(out) >= MAX_VALIDATION_ERRORS:
                break
    return out


def parse_validation_errors(
    status_code: int,
    body: bytes | str | None,
    content_type: str | None,
    redactor: Redactor | None = None,
) -> list[ValidationError] | None:
    """Parse a framework validation error response into ``[{loc, msg, type}]``.

    Returns ``None`` when the response is not a recognised validation error
    (wrong status, non-JSON, unknown shape, malformed or truncated JSON).
    """
    try:
        if not body or not is_validation_response(status_code, content_type):
            return None
        data = json.loads(body)
        if not isinstance(data, dict):
            return None
        return _pydantic(data.get("detail"), redactor) or _litestar(data.get("extra"), redactor) or None
    except Exception:
        return None
