"""Error-issue fingerprinting — stable grouping keys for error logs.

The naive exact GROUP BY on (method, path, status, message) fragments issues:
any dynamic value in a message ("timeout for order 12345") becomes a new
"issue". A fingerprint groups occurrences of the same underlying defect:

* With a traceback: exception type + the code path (file basename + function
  of the innermost frames). Line numbers are excluded — code moves between
  releases — and so is the message, which often embeds dynamic values.
* Without a traceback (plain HTTP 5xx): exception type + endpoint + status +
  the message with dynamic values (ids, hex, numbers, quoted strings)
  normalised to placeholders.

The fingerprint is stored on every api_logs row and keys the Postgres
error_issues entity (lifecycle: open/regressed/resolved/ignored).
"""

from __future__ import annotations

import hashlib
import posixpath
import re

_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE
)
_HEX_RE = re.compile(r"\b0x[0-9a-f]+\b|\b[0-9a-f]{16,}\b", re.IGNORECASE)
_QUOTED_RE = re.compile(r"'[^']*'|\"[^\"]*\"")
# Unanchored on purpose: "after 30s" and "order#123" carry dynamic numbers too.
_NUM_RE = re.compile(r"\d+")
_WS_RE = re.compile(r"\s+")

# CPython traceback frame: File "<path>", line N, in <func>
_FRAME_RE = re.compile(r'File "([^"]+)", line \d+, in (\S+)')

# Leading "SomeError: ..." (dotted paths allowed: sqlalchemy.exc.OperationalError).
_EXC_TYPE_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_.]*)\s*:")
_HTTP_MSG_RE = re.compile(r"^HTTP (\d{3})\b")

# Innermost frames to include — enough to distinguish call sites without
# letting deep framework stacks dominate the signature.
_MAX_FRAMES = 8


def normalize_message(message: str) -> str:
    """Collapse dynamic values so message variants of one defect compare equal."""
    text = str(message or "")
    text = _UUID_RE.sub("<id>", text)
    text = _HEX_RE.sub("<hex>", text)
    text = _QUOTED_RE.sub("<str>", text)
    text = _NUM_RE.sub("<n>", text)
    return _WS_RE.sub(" ", text).strip()[:300]


def exception_type(message: str) -> str:
    """`ValueError: boom` -> `ValueError`; `HTTP 502 on GET /x` -> `HTTP 502`."""
    text = str(message or "").strip()
    http = _HTTP_MSG_RE.match(text)
    if http:
        return f"HTTP {http.group(1)}"
    typed = _EXC_TYPE_RE.match(text)
    if typed:
        return typed.group(1)
    return ""


def frame_signature(payload: str) -> str:
    """Innermost traceback frames as `file:function` pairs (line numbers excluded)."""
    frames = _FRAME_RE.findall(payload or "")
    if not frames:
        return ""
    tail = frames[-_MAX_FRAMES:]
    return ";".join(f"{posixpath.basename(p.replace(chr(92), '/'))}:{fn}" for p, fn in tail)


def compute_fingerprint(
    message: str,
    payload: str = "",
    method: str = "",
    path: str = "",
    status_code: int = 0,
) -> str:
    """40-hex grouping key for one error occurrence."""
    etype = exception_type(message)
    frames = frame_signature(payload)
    if frames:
        basis = f"{etype}|{frames}"
    else:
        basis = f"{etype}|{(method or '').upper()} {path or ''}|{int(status_code or 0)}|{normalize_message(message)}"
    return hashlib.sha1(basis.encode("utf-8", "replace")).hexdigest()
