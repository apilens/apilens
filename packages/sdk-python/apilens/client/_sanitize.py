"""PII redaction and UTF-8-safe payload decoding.

Shared by the ASGI and WSGI middlewares so request/response capture behaves
identically across frameworks.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Union
from urllib.parse import parse_qsl, quote, urlencode

REDACTED = "[redacted]"
# Stored in place of a whole body that a mask callback dropped (returned
# ``None``) or failed on (raised / returned a non-bytes value).
MASKED = "[masked]"

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

# Built-in name patterns that are ALWAYS masked (Apitally parity). User-supplied
# patterns extend these, never replace them. Each is matched case-insensitively
# with ``re.search`` against the parameter / header / JSON field *name*.
DEFAULT_MASK_QUERY_PARAMS: tuple[str, ...] = (
    r"auth",
    r"api.?key",
    r"secret",
    r"token",
    r"password",
    r"pwd",
)
DEFAULT_MASK_HEADER_PATTERNS: tuple[str, ...] = (
    r"auth",
    r"api.?key",
    r"secret",
    r"token",
    r"cookie",
)
DEFAULT_MASK_BODY_FIELDS: tuple[str, ...] = (
    r"password",
    r"pwd",
    r"token",
    r"secret",
    r"auth",
    r"card.?number",
    r"ccv",
    r"cvv",
    r"cvc",
    r"ssn",
)
# Names whose ``key=value`` / ``key: value`` VALUES are masked inside log text
# (auto error-trace logs): every built-in query, header and body pattern,
# de-duplicated. Always on; a ``mask_log_record`` callback runs first and can
# never switch these off.
DEFAULT_MASK_LOG_NAMES: tuple[str, ...] = tuple(
    dict.fromkeys(
        (*DEFAULT_MASK_QUERY_PARAMS, *DEFAULT_MASK_HEADER_PATTERNS, *DEFAULT_MASK_BODY_FIELDS)
    )
)

# Cap on the serialized header JSON so a pathological request can't bloat a row.
_MAX_HEADER_BYTES = 8192

# How deep redact_body() walks nested JSON before giving up (guards against
# adversarially deep documents; typical API bodies are < 10 levels).
_MAX_BODY_DEPTH = 32


def _compile(defaults: Sequence[str], extra: Sequence[str] | None) -> re.Pattern[str]:
    """Combine built-in and user patterns into ONE case-insensitive regex.

    Each source pattern is wrapped in its own non-capturing group so alternation
    can't change its meaning; ``search`` on the union is equivalent to "any
    pattern matches" but costs a single regex call per name.
    """
    patterns = [*defaults, *(extra or ())]
    # Validate each pattern on its own so a bad user regex fails loudly at
    # middleware construction with a precise error, not a confusing union one.
    for p in patterns:
        re.compile(p)
    return re.compile("|".join(f"(?:{p})" for p in patterns), re.IGNORECASE)


_DEFAULT_HEADER_RE = _compile(DEFAULT_MASK_HEADER_PATTERNS, ())
_DEFAULT_LOG_NAME_RE = _compile(DEFAULT_MASK_LOG_NAMES, ())

# A ``name=value`` / ``name: value`` pair in free text whose name contains one
# of the default sensitive names. The name may be quoted (``'password': 'x'``
# as in a dict repr); the value is a quoted string or a bare token, optionally
# behind an auth scheme (``Authorization: Bearer abc``) so the credential is
# masked rather than just the scheme word. Names ending in Error / Exception /
# Warning are exception types (``InvalidTokenError: expired``), not pairs.
_LOG_NAME_CHARS = r"[A-Za-z0-9_.\-]"
_LOG_PAIR_RE = re.compile(
    r"(?P<name>(?<![A-Za-z0-9_.\-])[\"']?"
    + _LOG_NAME_CHARS
    + r"*?(?:"
    + "|".join(f"(?:{p})" for p in DEFAULT_MASK_LOG_NAMES)
    + r")"
    + _LOG_NAME_CHARS
    + r"*(?<!error)(?<!exception)(?<!warning)[\"']?)"
    + r"(?P<sep>\s*[=:]\s*)"
    + r"(?:(?:bearer|basic|digest|token)\s+)?"
    + r"(?P<value>\"[^\"]*\"|'[^']*'|[^\s&,;\"'()\[\]{}<>]+)",
    re.IGNORECASE,
)


def _mask_log_pair(match: re.Match[str]) -> str:
    value = match.group("value")
    q = value[0] if value[:1] in ("'", '"') else ""
    return f"{match.group('name')}{match.group('sep')}{q}{REDACTED}{q}"


def mask_log_text(text: str) -> str:
    """Mask sensitive ``key=value`` / ``key: value`` values in log text.

    Applied to every outgoing log record's message and payload (stack trace):
    ``token=abc`` becomes ``token=[redacted]``, ``{'password': 'x'}`` becomes
    ``{'password': '[redacted]'}`` and ``Authorization: Bearer abc`` becomes
    ``Authorization: [redacted]``. Names are matched case-insensitively with
    the built-in :data:`DEFAULT_MASK_LOG_NAMES`; text with no match is
    returned unchanged.
    """
    if not text:
        return text
    return _LOG_PAIR_RE.sub(_mask_log_pair, text)


def mask_log_attributes(attributes: dict[str, str] | None) -> dict[str, str] | None:
    """Mask log attribute values whose key is a default sensitive name, and
    sensitive ``key=value`` pairs inside the remaining string values."""
    if not attributes:
        return attributes
    out: dict[str, str] = {}
    for key, value in attributes.items():
        if _DEFAULT_LOG_NAME_RE.search(str(key)):
            out[key] = REDACTED
        elif isinstance(value, str):
            out[key] = mask_log_text(value)
        else:
            out[key] = value
    return out


class Redactor:
    """Compiled PII redaction rules for captured request data.

    Built once per middleware: the built-in ``DEFAULT_MASK_*`` patterns always
    apply and the user-supplied regex lists extend them. Every pattern is
    matched case-insensitively with ``re.search`` against the *name* of the
    thing being redacted (query parameter, header, or JSON body field). Use
    anchors for exact matches (``r"^card_number$"``).

    Values are replaced with ``[redacted]``; names stay visible so the request
    log still shows *what* was sent, never the sensitive value itself.
    """

    __slots__ = ("query_params", "headers", "body_fields")

    def __init__(
        self,
        query_params: Sequence[str] = (),
        headers: Sequence[str] = (),
        body_fields: Sequence[str] = (),
    ) -> None:
        # Compiled exactly once here; nothing is compiled per request.
        self.query_params = _compile(DEFAULT_MASK_QUERY_PARAMS, query_params)
        self.headers = (
            _DEFAULT_HEADER_RE if not headers else _compile(DEFAULT_MASK_HEADER_PATTERNS, headers)
        )
        self.body_fields = _compile(DEFAULT_MASK_BODY_FIELDS, body_fields)

    def header_matches(self, name: str) -> bool:
        return self.headers.search(name) is not None

    def redact_query(self, query: str) -> str:
        """Redact matching parameter values within a raw query string.

        Unparseable input is passed through untouched — capture must never
        break a request over a weird query string.
        """
        if not query:
            return query
        try:
            pairs = parse_qsl(query, keep_blank_values=True)
            if not pairs:
                return query
            pattern = self.query_params
            if not any(pattern.search(k) for k, _ in pairs):
                # Nothing sensitive: keep the original encoding byte-for-byte.
                return query
            redacted = [(k, REDACTED if pattern.search(k) else v) for k, v in pairs]
            return urlencode(
                redacted,
                # Keep "[redacted]" readable in the request log instead of %5Bredacted%5D.
                quote_via=lambda s, safe, enc, err: quote(s, safe=str(safe) + "[]", encoding=enc, errors=err),
            )
        except Exception:
            return query

    def redact_body(self, payload: str) -> str:
        """Redact matching field values in a JSON body (recursively).

        A matching field's value is masked when it is a string or a number
        (stricter than string-only masking: numeric card numbers / PINs are
        caught too) and also when it is a nested object or array, which is
        masked whole. Booleans and ``null`` carry no secret and stay visible.
        Bodies with no matching field are returned byte-for-byte. Non-JSON
        payloads are returned unchanged — field-level redaction only makes
        sense for structured bodies.
        """
        if not payload:
            return payload
        try:
            data = json.loads(payload)
        except Exception:
            return payload
        if not isinstance(data, (dict, list)):
            return payload
        pattern = self.body_fields
        changed = False

        def walk(node, depth: int):
            nonlocal changed
            if depth > _MAX_BODY_DEPTH:
                return node
            if isinstance(node, dict):
                out = {}
                for k, v in node.items():
                    if v is not None and not isinstance(v, bool) and pattern.search(str(k)):
                        out[k] = REDACTED
                        changed = True
                    else:
                        out[k] = walk(v, depth + 1)
                return out
            if isinstance(node, list):
                return [walk(v, depth + 1) for v in node]
            return node

        try:
            result = walk(data, 0)
            if not changed:
                return payload
            return json.dumps(result, separators=(",", ":"), ensure_ascii=False)
        except Exception:
            return payload


@dataclass(frozen=True, slots=True)
class RequestInfo:
    """What a ``mask_request_body`` callback is told about the request.

    ``path`` is the request path without query string; ``raw_path`` is the
    exact URL with any sensitive query values already redacted. ``headers``
    are the request headers with lower-cased names, unredacted (the callback
    runs in-process, nothing has left the app yet). ``attributes`` holds the
    custom attributes the handler set with ``set_request_attribute``.
    """

    method: str
    path: str
    raw_path: str = ""
    headers: Mapping[str, str] = field(default_factory=dict)
    attributes: Mapping[str, Any] = field(default_factory=dict)

    @property
    def content_type(self) -> str:
        return str(self.headers.get("content-type") or "")


@dataclass(frozen=True, slots=True)
class ResponseInfo:
    """What a ``mask_response_body`` callback is told about the response.

    ``attributes`` are the request's custom attributes (``set_request_attribute``).
    """

    request: RequestInfo
    status_code: int
    headers: Mapping[str, str] = field(default_factory=dict)
    attributes: Mapping[str, Any] = field(default_factory=dict)

    @property
    def content_type(self) -> str:
        return str(self.headers.get("content-type") or "")


# ``(info, body) -> bytes | None``: return the (possibly rewritten) body bytes,
# or ``None`` to drop the whole body (stored as ``[masked]``).
BodyMasker = Callable[[Any, bytes], Union[bytes, None]]


def lower_headers(headers: Mapping[str, Any] | None) -> dict[str, str]:
    """Header map with lower-cased names, for :class:`RequestInfo`/:class:`ResponseInfo`."""
    if not headers:
        return {}
    return {str(k).lower(): str(v) for k, v in headers.items()}


def mask_body(
    body: bytes,
    *,
    redactor: Redactor,
    masker: BodyMasker | None = None,
    info: RequestInfo | ResponseInfo | None = None,
) -> str:
    """Turn captured body bytes into the payload string that is sent.

    Order is fixed: the user ``masker`` callback runs first on the (already
    truncated) raw bytes, then the result is decoded and the regex field
    masking — user patterns plus the built-in defaults — is applied by
    ``redactor``. The callback can rewrite or drop the body but can never
    switch the built-ins off.

    Fail closed: if the callback returns ``None``, raises, or returns
    something that is not bytes/str, the whole body becomes ``[masked]`` —
    the raw body is never sent in that case.
    """
    if not body:
        return ""
    if masker is not None:
        try:
            result = masker(info, bytes(body))
        except Exception:
            return MASKED
        if result is None:
            return MASKED
        if isinstance(result, str):
            result = result.encode("utf-8")
        elif isinstance(result, (bytearray, memoryview)):
            result = bytes(result)
        elif not isinstance(result, bytes):
            return MASKED
        body = result
    return redactor.redact_body(decode_utf8_safe(body))


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


def serialize_headers(
    headers: dict[str, str],
    *,
    max_bytes: int = _MAX_HEADER_BYTES,
    redactor: Redactor | None = None,
) -> str:
    """Serialize a header map to a compact JSON string, redacting secrets.

    Returns ``""`` when there are no headers. Sensitive values are replaced with
    ``[redacted]`` — the exact-name :data:`SENSITIVE_HEADERS` and the
    :data:`DEFAULT_MASK_HEADER_PATTERNS` always apply, and a ``redactor`` adds
    the app's own header patterns on top. The whole blob is
    capped so it can't dominate a row.
    """
    if not headers:
        return ""
    safe: dict[str, str] = {}
    for key, value in headers.items():
        name = (key or "").lower()
        if not name:
            continue
        if name in SENSITIVE_HEADERS:
            sensitive = True
        elif redactor is not None:
            sensitive = redactor.header_matches(name)
        else:
            sensitive = _DEFAULT_HEADER_RE.search(name) is not None
        safe[name] = REDACTED if sensitive else str(value)
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
