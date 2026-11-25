from __future__ import annotations

import gzip
import json
import logging
import os
import platform
import random
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Literal

from .._version import __version__
from ._env import apply_env_defaults, parse_mode
from ._policy import ALLOW_ALL, DISABLED, Policy, ResourcesPolicy, parse_policy
from ._routes import cap_routes
from ._sanitize import mask_log_attributes, mask_log_text
from ._stats import ClientStats
from .models import LogRecord, RequestRecord, SpanRecord

logger = logging.getLogger("apilens")

# Drop reasons reported by ``ApiLensClient.drop_counts()``.
DROP_QUEUE_FULL = "queue_full"  # record-count cap (max_queue_size) hit
DROP_QUEUE_BYTES = "queue_bytes"  # memory cap (max_queue_bytes) hit
DROP_NON_RETRYABLE = "non_retryable"  # ingest rejected the batch with a 4xx
DROP_RETRIES_EXHAUSTED = "retries_exhausted"  # still failing after max_retry_seconds
DROP_INVALID = "invalid"  # ingest accepted the batch but refused these records
DROP_SHUTDOWN = "shutdown"  # still queued when the client shut down
DROP_SPAN_CAP = "span_cap"  # child span over the per-request cap (MAX_SPANS_PER_REQUEST)
DROP_REASONS = (
    DROP_QUEUE_FULL,
    DROP_QUEUE_BYTES,
    DROP_NON_RETRYABLE,
    DROP_RETRIES_EXHAUSTED,
    DROP_INVALID,
    DROP_SHUTDOWN,
    DROP_SPAN_CAP,
)
# Not a drop: a single record over ``max_batch_bytes`` was cut down (payloads
# first) and still delivered. Reported by ``drop_counts()`` but not counted in
# ``dropped_count``.
DROP_TRUNCATED = "truncated"
# Reasons not reported in the heartbeat's ``dropped``: truncated records were
# delivered, and ingest already counts the records it refused as invalid.
_UNREPORTED_REASONS = frozenset({DROP_TRUNCATED, DROP_INVALID})
# Signal name of each queue in the heartbeat's ``dropped`` field.
SIGNAL_REQUESTS = "requests"
SIGNAL_SPANS = "spans"
SIGNAL_LOGS = "logs"

# Floor for ``max_batch_bytes``: room for one record with its variable-length
# fields truncated (ids, scalars and field names stay intact).
MIN_BATCH_BYTES = 16 * 1024
# Put in the middle of a string field cut down to fit ``max_batch_bytes``
# (D4): the head and the tail survive, so an exception keeps both the raised
# error and its root cause. ``{n}`` is the number of characters removed.
TRUNCATION_MARKER = "\n…[{n} chars truncated]…\n"
# Wire fields shrunk first when one record exceeds ``max_batch_bytes``, in
# order; then attribute maps, then any other string field (largest first).
_TRUNCATE_FIRST = (
    "request_payload",
    "response_payload",
    "payload",
    "request_headers",
    "response_headers",
    "message",
)

# Env fallback for ``ApiLensConfig.proxy_url``.
ENV_PROXY = "APILENS_PROXY"

# Delivery mode (``ApiLensConfig.mode``). ``thread``: a daemon thread flushes
# every ``flush_interval``. ``inline``: no thread; records are delivered by a
# synchronous ``ApiLensClient.flush()`` (the middlewares call it after each
# response is sent). For serverless runtimes that freeze the process between
# invocations, where a background thread may never run.
MODE_THREAD = "thread"
MODE_INLINE = "inline"
MODES = (MODE_THREAD, MODE_INLINE)
ClientMode = Literal["thread", "inline"]
# Env fallback for ``ApiLensConfig.mode`` when it is left empty.
ENV_MODE = "APILENS_MODE"


def _resolve_mode(value: str) -> str:
    """Explicit ``mode``, else env ``APILENS_MODE``, else ``thread``. An
    unknown explicit mode is kept (the client rejects it); an unknown env
    value raises ``ValueError`` naming the variable, like every ``APILENS_*``
    option."""
    explicit = (value or "").strip().lower()
    if explicit:
        return explicit
    raw = os.getenv(ENV_MODE) or ""
    if not raw.strip():
        return MODE_THREAD
    return parse_mode(raw, name=ENV_MODE)

# Fixed per-record overhead added to the variable-length string fields when
# estimating a queued record's size (object headers, scalars, short fields).
RECORD_OVERHEAD_BYTES = 512

# gzip level for ingest bodies: a good size/CPU trade-off for JSON batches.
GZIP_LEVEL = 5


# Retry policy (see ``ApiLensClient._flush_queue``).
# 408 / 429 / 5xx and network errors are retried; any other 4xx drops the batch.
RETRYABLE_4XX = frozenset({408, 429})
# A failed record is retried for this long after its first failed attempt
# (``ApiLensConfig.max_retry_seconds``) before it is dropped.
DEFAULT_MAX_RETRY_SECONDS = 300.0
# A server-sent Retry-After is honoured up to this many seconds.
RETRY_AFTER_MAX_SECONDS = 60.0
# A non-retryable status logs its response body at most once per window.
NON_RETRYABLE_LOG_INTERVAL_SECONDS = 300.0
# Response bodies quoted in logs are truncated to this many bytes.
MAX_LOGGED_BODY_BYTES = 1024
TROUBLESHOOTING_URL = "https://apilens.ai/docs/support/troubleshooting"
# New drops are logged at INFO at most once per window (the DEBUG summary
# runs every flush interval regardless).
DROP_LOG_INTERVAL_SECONDS = 60.0
# ``last_error`` strings are truncated to this many characters.
MAX_LAST_ERROR_CHARS = 512

# App metadata (``POST /v1/metadata``, see ``ApiLensClient.report_metadata``).
# Sent from a daemon thread this long after the middleware is built, so the
# framework has registered its routes; retried up to METADATA_MAX_RETRIES times.
METADATA_DELAY_SECONDS = 1.0
METADATA_MAX_RETRIES = 3
# Env kill switch: APILENS_SEND_METADATA=false never sends the report.
ENV_SEND_METADATA = "APILENS_SEND_METADATA"
# (pid, base_url, app_id, environment) already reported by this process.
_metadata_reported: set[tuple[int, str, str, str]] = set()
_metadata_lock = threading.Lock()


# Heartbeat (``POST /v1/heartbeat``, see ``ApiLensClient.send_heartbeat``).
# Sent from the flush thread on start, every ``heartbeat_interval`` seconds and
# once more with ``final=true`` on shutdown. Ingest answers 429 to heartbeats
# of one instance less than 10 s apart, so shorter intervals are refused.
HEARTBEAT_MIN_INTERVAL_SECONDS = 10.0
# Env kill switch: APILENS_SEND_HEARTBEAT=false never sends a heartbeat.
ENV_SEND_HEARTBEAT = "APILENS_SEND_HEARTBEAT"
SDK_NAME = "apilenss"

# Runtime resources (M7, ``apilens.client.resources``): sampled on a daemon
# thread every ``resources_interval`` seconds, drained into each heartbeat.
RESOURCES_MIN_INTERVAL_SECONDS = 15.0


def _django_autoreload_parent() -> bool:
    """``manage.py runserver``'s watcher parent: it only restarts the child
    (which runs with ``RUN_MAIN=true``) and serves nothing, so it never
    samples resources."""
    import sys

    argv = sys.argv
    return (
        len(argv) > 1
        and argv[1] == "runserver"
        and "--noreload" not in argv
        and os.environ.get("RUN_MAIN") != "true"
    )


def env_send_heartbeat_enabled() -> bool:
    raw = os.getenv(ENV_SEND_HEARTBEAT)
    if raw is None:
        return True
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def _runtime() -> str:
    return f"python {platform.python_version()}"


def env_send_metadata_enabled() -> bool:
    raw = os.getenv(ENV_SEND_METADATA)
    if raw is None:
        return True
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def _is_api_key_name(name: str) -> bool:
    """Mirror of the ingest edge's check: ``api_key`` / ``apiKey`` / ``api-key``."""
    normalised = name.lower()
    for ch in "_-. ":
        normalised = normalised.replace(ch, "")
    return normalised == "apikey"


def _strip_api_key_fields(value):
    """Copy of ``value`` without object keys naming an API key, at any depth
    (the ingest edge rejects a metadata body that has one)."""
    if isinstance(value, dict):
        return {
            k: _strip_api_key_fields(v) for k, v in value.items() if not _is_api_key_name(str(k))
        }
    if isinstance(value, (list, tuple)):
        return [_strip_api_key_fields(v) for v in value]
    return value


class _IngestError(RuntimeError):
    """A failed ingest POST. ``status`` is ``None`` for network errors/timeouts."""

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        retry_after: float | None = None,
        body: str = "",
    ) -> None:
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after
        self.body = body


class _RetryableIngestError(_IngestError):
    """408, 429, 5xx or a network failure: worth retrying after a backoff."""


class _NonRetryableIngestError(_IngestError):
    """Any other 4xx: retrying the same batch cannot succeed."""


def is_retryable_status(status: int) -> bool:
    return status >= 500 or status in RETRYABLE_4XX


def parse_retry_after(value: str | None, *, now: datetime | None = None) -> float | None:
    """Seconds to wait from a ``Retry-After`` header (delta-seconds or an
    HTTP-date), clamped to ``[0, RETRY_AFTER_MAX_SECONDS]``. ``None`` when the
    header is missing or unparseable."""
    if not value:
        return None
    value = value.strip()
    try:
        seconds = float(value)
    except ValueError:
        try:
            when = parsedate_to_datetime(value)
        except (TypeError, ValueError, IndexError):
            return None
        if when is None:
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        seconds = (when - (now or datetime.now(tz=timezone.utc))).total_seconds()
    if seconds != seconds:  # NaN
        return None
    return max(0.0, min(seconds, RETRY_AFTER_MAX_SECONDS))


def backoff_delay(attempt: int, base: float, cap: float) -> float:
    """Full-jitter exponential backoff: uniform in ``[0, min(cap, base * 2**attempt)]``
    so workers that failed together do not retry in lockstep."""
    ceiling = min(cap, base * (2 ** attempt))
    return random.uniform(0.0, max(ceiling, 0.0))


def _read_error_body(exc: urllib.error.HTTPError) -> str:
    try:
        raw = exc.read(MAX_LOGGED_BODY_BYTES + 1) or b""
    except Exception:
        return ""
    text = raw[:MAX_LOGGED_BODY_BYTES].decode("utf-8", errors="replace").strip()
    if len(raw) > MAX_LOGGED_BODY_BYTES:
        text += "..."
    return text


def _attrs_size(attributes: dict[str, str] | None) -> int:
    if not attributes:
        return 0
    return sum(len(str(k)) + len(str(v)) for k, v in attributes.items())


def estimate_record_bytes(record: RequestRecord | SpanRecord | LogRecord) -> int:
    """Serialised-size estimate of a queued record: its variable-length string
    fields plus a fixed ``RECORD_OVERHEAD_BYTES``. Cheap (no JSON encoding)."""
    if isinstance(record, RequestRecord):
        variable = (
            len(record.request_payload)
            + len(record.response_payload)
            + len(record.request_headers)
            + len(record.response_headers)
            + len(record.raw_path)
            + len(record.path)
            + len(record.user_agent)
        )
    elif isinstance(record, SpanRecord):
        variable = len(record.name) + _attrs_size(record.attributes)
    elif isinstance(record, LogRecord):
        variable = len(record.message) + len(record.payload) + _attrs_size(record.attributes)
    else:  # pragma: no cover - defensive
        variable = 0
    return RECORD_OVERHEAD_BYTES + variable


def _describe_error(exc: BaseException) -> str:
    """``last_error`` text: the message, plus the response body ingest sent."""
    text = str(exc) or type(exc).__name__
    body = getattr(exc, "body", "")
    if body:
        text = f"{text}: {body}"
    return text[:MAX_LAST_ERROR_CHARS]


def _dumps(obj) -> bytes:
    return json.dumps(obj, separators=(",", ":")).encode("utf-8")


def _envelope(key: str, records: list) -> bytes:
    """``{"<key>":[...]}`` from records or already-encoded records (bytes)."""
    items = [r if isinstance(r, bytes) else _dumps(r.to_wire()) for r in records]
    return b'{"' + key.encode("ascii") + b'":[' + b",".join(items) + b"]}"


def _marker_bytes(marker: str) -> int:
    return len(_dumps(marker)) - 2  # without the quotes


def _shrink(value: str, excess: int) -> str:
    """Cut the middle of ``value`` so its JSON encoding loses at least
    ``excess`` bytes, keeping the head and the tail around a
    ``TRUNCATION_MARKER``. Every character encodes to >= 1 byte, so removing
    ``excess`` characters plus the marker's encoded size is always enough."""
    removed = excess
    while True:
        marker = TRUNCATION_MARKER.format(n=removed)
        needed = excess + _marker_bytes(marker)
        if removed >= needed:
            break
        removed = needed
    keep = len(value) - removed
    if keep <= 0:
        return ""
    head = (keep + 1) // 2
    tail = keep - head
    return value[:head] + marker + (value[len(value) - tail :] if tail else "")


def _truncate_wire(wire: dict, budget: int) -> bytes:
    """Encode ``wire`` in at most ``budget`` bytes, shrinking payloads first,
    then headers and message, then attribute maps, then any other string
    field (largest first)."""
    encoded = _dumps(wire)
    strings = [k for k in _TRUNCATE_FIRST if isinstance(wire.get(k), str)]
    rest = sorted(
        (k for k, v in wire.items() if isinstance(v, str) and k not in _TRUNCATE_FIRST),
        key=lambda k: len(wire[k]),
        reverse=True,
    )
    maps = [k for k, v in wire.items() if isinstance(v, dict)]

    def shrink(field: str) -> None:
        nonlocal encoded
        if len(encoded) <= budget or not wire[field]:
            return
        if isinstance(wire[field], dict):
            wire[field] = {}
        else:
            wire[field] = _shrink(wire[field], len(encoded) - budget)
        encoded = _dumps(wire)

    for field in (*strings, *maps, *rest):
        shrink(field)
    return encoded


def _detect_release() -> str:
    return (os.getenv("APILENS_RELEASE") or "").strip()


def _detect_commit() -> str:
    for var in ("APILENS_COMMIT", "GIT_COMMIT", "SOURCE_VERSION", "RENDER_GIT_COMMIT"):
        value = (os.getenv(var) or "").strip()
        if value:
            return value
    return ""


# Any field the caller does not pass is read from its ``APILENS_*`` env var
# when set (api_key, base_url, environment, enabled, batch_size,
# flush_interval, capture_ip, anonymize_ip): explicit kwarg > env > default.
@apply_env_defaults
@dataclass(slots=True)
class ApiLensConfig:
    # Required: pass it or set APILENS_API_KEY (the client raises without one).
    api_key: str = ""
    project_slug: str = ""
    base_url: str = "https://ingest.apilens.ai/v1"
    environment: str = "production"
    ingest_path: str = "/requests"
    spans_path: str = "/traces"
    logs_path: str = "/logs"
    metadata_path: str = "/metadata"
    # Report framework, versions, route templates and the effective capture
    # config once per process start (``POST /v1/metadata``). Env
    # APILENS_SEND_METADATA=false turns it off.
    send_metadata: bool = True
    # Heartbeat (``POST /v1/heartbeat``): SDK/runtime versions, pid, uptime and
    # ``stats()`` on start, every ``heartbeat_interval`` seconds and on
    # shutdown; the response carries the app's remote capture policy
    # (``ApiLensClient.remote_policy``). Sent for ``app_id`` and for every app
    # a framework middleware registers. Env APILENS_SEND_HEARTBEAT=false
    # turns it off.
    send_heartbeat: bool = True
    heartbeat_path: str = "/heartbeat"
    heartbeat_interval: float = 60.0
    # App UUID or slug to send heartbeats for. Optional: the framework
    # middlewares register their own ``app_id`` with the client.
    app_id: str = ""

    # Deploy correlation: stamped on every request/span/log record so the
    # dashboard can answer "did this release cause the regression?". When left
    # empty they are auto-detected from the environment (APILENS_RELEASE;
    # APILENS_COMMIT / GIT_COMMIT / SOURCE_VERSION / RENDER_GIT_COMMIT).
    release: str = ""
    commit: str = ""

    batch_size: int = 200
    # Cap on one POST's JSON body (uncompressed, which is also what the ingest
    # edge's ``ingest.max_body_bytes`` limits). A batch is cut at
    # ``batch_size`` records or ``max_batch_bytes``, whichever comes first; a
    # single record over the cap is truncated (payloads first), never dropped.
    max_batch_bytes: int = 4 * 1024 * 1024
    flush_interval: float = 3.0
    # ``"thread"`` (default): background daemon thread flushes every
    # ``flush_interval``. ``"inline"``: no thread is started; ``flush()``
    # sends synchronously and the ASGI/WSGI middlewares call it after each
    # response has been sent (serverless: Lambda, Cloud Run, Cloud Functions).
    # Empty falls back to env ``APILENS_MODE``, then ``"thread"``.
    mode: ClientMode | str = ""
    timeout: float = 5.0
    verify_tls: bool = True
    ca_bundle_path: str = ""
    # Explicit egress proxy for ingest traffic, e.g. ``http://proxy:3128`` or
    # ``http://user:pass@proxy:3128``. Used for both http and https base URLs
    # (https is tunnelled with CONNECT). Empty falls back to env
    # ``APILENS_PROXY``, then to the standard ``HTTPS_PROXY`` / ``HTTP_PROXY`` /
    # ``NO_PROXY`` variables that urllib honours.
    proxy_url: str = ""

    # Queue bounds, applied to the request, span and log queues. The record cap
    # is per queue; the byte cap is shared by all three (estimated size of the
    # queued records). Either limit drops the oldest records first.
    max_queue_size: int = 10_000
    max_queue_bytes: int = 64 * 1024 * 1024
    # A batch that fails with 408/429/5xx or a network error goes back to the
    # front of its queue and is retried with full-jitter backoff (or after
    # the server's Retry-After) until this many seconds have passed since its
    # first failed attempt; then it is dropped as ``retries_exhausted``. New
    # records keep queueing meanwhile, under the queue caps.
    max_retry_seconds: float = DEFAULT_MAX_RETRY_SECONDS
    # Deprecated alias of ``max_retry_seconds``: when set, the window is the
    # longest time this many backoff retries used to wait
    # (``sum(min(retry_backoff_max, retry_backoff_base * 2**i))``, so ``0``
    # never retries) and it wins over ``max_retry_seconds``.
    max_retries: int | None = None
    # gzip each batch body (``Content-Encoding: gzip``) on the flush thread.
    # Falls back to plain JSON if compression fails; ``False`` always sends plain JSON.
    compress: bool = True
    retry_backoff_base: float = 0.25
    retry_backoff_max: float = 5.0

    enabled: bool = True
    # Client IP privacy. ``capture_ip=False`` sends no IP at all;
    # ``anonymize_ip=True`` truncates IPv4 to /24 and IPv6 to /48 in-process.
    # Env APILENS_CAPTURE_IP=false / APILENS_ANONYMIZE_IP=true can only tighten these.
    capture_ip: bool = True
    anonymize_ip: bool = False
    # ``(record) -> record | None`` applied to every LogRecord before it is
    # queued (auto error-trace logs today, application logs later). Edit the
    # message / payload / attributes and return the record, or return
    # ``None`` to drop it. Built-in ``key=value`` masking runs afterwards.
    mask_log_record: Callable[[LogRecord], LogRecord | None] | None = None
    # ``(stats) -> None`` called on the flush thread with a ``ClientStats``
    # snapshot every ``flush_interval`` (e.g. to export to Prometheus/StatsD).
    # Exceptions it raises are logged at DEBUG and ignored.
    on_stats: Callable[[ClientStats], None] | None = None
    # Runtime resources (M7): CPU, memory, container limits, GC, DB pools and
    # the container's top processes, sampled every ``resources_interval``
    # seconds (minimum 15) on a daemon thread and sent in each heartbeat's
    # ``resources`` block. Env APILENS_CAPTURE_RESOURCES /
    # APILENS_RESOURCES_INTERVAL / APILENS_CAPTURE_PROCESS_LIST. The remote
    # policy can only narrow these (turn sampling or collectors off, lengthen
    # the interval).
    capture_resources: bool = True
    resources_interval: float = 15.0
    # The process list (top 20 by RSS in the SDK's own container: pid, ppid,
    # comm, CPU, RSS; never command lines or environments).
    capture_process_list: bool = True
    user_agent: str = f"apilenss/{__version__}"

    def __post_init__(self) -> None:
        if not self.release:
            self.release = _detect_release()
        if not self.commit:
            self.commit = _detect_commit()
        if not self.proxy_url:
            self.proxy_url = (os.getenv(ENV_PROXY) or "").strip()
        self.mode = _resolve_mode(self.mode)


def _ssl_context(config: ApiLensConfig) -> ssl.SSLContext:
    """TLS context for ingest: custom CA bundle, or verification off."""
    if config.verify_tls:
        return ssl.create_default_context(cafile=config.ca_bundle_path or None)
    return ssl._create_unverified_context()  # noqa: SLF001


def _open(req: urllib.request.Request, config: ApiLensConfig):
    """Send ``req``. With ``proxy_url`` set, an explicit ``ProxyHandler`` routes
    both http and https (CONNECT) through it; otherwise ``urlopen`` installs
    urllib's default ``ProxyHandler``, which honours ``HTTPS_PROXY`` /
    ``HTTP_PROXY`` / ``NO_PROXY`` from the environment."""
    ssl_context = _ssl_context(config)
    if not config.proxy_url:
        return urllib.request.urlopen(req, timeout=config.timeout, context=ssl_context)
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": config.proxy_url, "https": config.proxy_url}),
        urllib.request.HTTPSHandler(context=ssl_context),
    )
    return opener.open(req, timeout=config.timeout)


class ApiLensClient:
    def __init__(self, config: ApiLensConfig, *, start_worker: bool = True) -> None:
        if not config.api_key:
            raise ValueError("api_key is required (pass it or set APILENS_API_KEY)")
        # project_slug is optional: the API key is project-level, so the server
        # derives the project from the key. You still pass app_id (which app).

        if config.batch_size <= 0:
            raise ValueError("batch_size must be > 0")
        if config.max_batch_bytes < MIN_BATCH_BYTES:
            raise ValueError(f"max_batch_bytes must be >= {MIN_BATCH_BYTES}")
        if config.max_queue_size <= 0:
            raise ValueError("max_queue_size must be > 0")
        if config.max_queue_bytes <= 0:
            raise ValueError("max_queue_bytes must be > 0")
        if config.mode not in MODES:
            raise ValueError(f"mode must be one of {', '.join(MODES)} (got {config.mode!r})")
        if config.heartbeat_interval < HEARTBEAT_MIN_INTERVAL_SECONDS:
            raise ValueError(
                f"heartbeat_interval must be >= {HEARTBEAT_MIN_INTERVAL_SECONDS:g} seconds"
            )
        if config.resources_interval < RESOURCES_MIN_INTERVAL_SECONDS:
            raise ValueError(
                f"resources_interval must be >= {RESOURCES_MIN_INTERVAL_SECONDS:g} seconds"
            )

        self.config = config
        self._queue: deque[RequestRecord] = deque()
        self._span_queue: deque[SpanRecord] = deque()
        self._log_queue: deque[LogRecord] = deque()
        # Estimated size of each queued record, kept in a parallel deque per
        # queue (keyed by id(queue)) so a pop releases exactly what was charged.
        self._sizes: dict[int, deque[int]] = {
            id(q): deque() for q in (self._queue, self._span_queue, self._log_queue)
        }
        self._bytes_by_queue: dict[int, int] = dict.fromkeys(self._sizes, 0)
        self._queued_bytes = 0
        self._signals: dict[int, str] = {
            id(self._queue): SIGNAL_REQUESTS,
            id(self._span_queue): SIGNAL_SPANS,
            id(self._log_queue): SIGNAL_LOGS,
        }
        # Retry state. id(record) -> monotonic time of its first failed
        # attempt, for records put back after a failure; per queue: when it
        # may be sent again and how many attempts in a row have failed.
        self._failed_at: dict[int, float] = {}
        self._retry_at: dict[int, float] = dict.fromkeys(self._sizes, 0.0)
        self._retry_attempt: dict[int, int] = dict.fromkeys(self._sizes, 0)
        # Drops not yet acknowledged by a heartbeat: (app_id, signal, reason) -> records.
        self._unreported_drops: dict[tuple[str, str, str], int] = {}
        self._invalid_logged_at: float | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._wakeup = threading.Event()
        self._thread: threading.Thread | None = None
        self._drops: dict[str, int] = dict.fromkeys((*DROP_REASONS, DROP_TRUNCATED), 0)
        # status -> monotonic time its rejection was last logged.
        self._non_retryable_logged_at: dict[int, float] = {}
        # Delivery counters for ``stats()``; written on the flush path only.
        self._sent_batches = 0
        self._sent_records = 0
        self._failed_batches = 0
        self._last_error = ""
        self._last_success_at: datetime | None = None
        # Stats reporting state (flush thread only).
        self._stats_reported_at: float | None = None
        self._drops_logged_total = 0
        self._drops_logged_at: float | None = None
        # Thread sending the app metadata report, if this client started one.
        self._metadata_thread: threading.Thread | None = None
        # Heartbeat state. (app_id, environment) -> monotonic time the next
        # heartbeat is due (0.0: now). Guarded by ``_heartbeat_lock``.
        self._heartbeat_lock = threading.Lock()
        self._heartbeat_due: dict[tuple[str, str], float] = {}
        self._heartbeat_logged: set[int] = set()
        self._remote_policy: dict | None = None
        # app_id -> last remote capture policy received for it. Replaced (never
        # mutated) under ``_heartbeat_lock``; read lock-free on the request path.
        self._policies: dict[str, Policy] = {}
        # Inline mode: one caller at a time sends the due heartbeats / stats
        # after a flush (concurrent requests would otherwise duplicate them).
        self._inline_upkeep_lock = threading.Lock()
        # Runtime resources: one sampler per client, ``None`` when off.
        self._resources = self._build_resources()
        self._identity: tuple[int, dict] | None = None
        self._new_instance()
        if config.app_id:
            self.register_app(config.app_id)

        if start_worker and self.config.enabled:
            self.start()

    @property
    def inline(self) -> bool:
        """``True`` in ``mode="inline"``: no background thread, ``flush()``
        delivers synchronously."""
        return self.config.mode == MODE_INLINE

    def _build_resources(self):
        cfg = self.config
        if not (cfg.enabled and cfg.capture_resources) or _django_autoreload_parent():
            return None
        try:
            from .resources import ResourceSampler

            return ResourceSampler(
                interval=cfg.resources_interval,
                capture_process_list=cfg.capture_process_list,
                serverless=self.inline,
            )
        except Exception:
            logger.debug("API Lens could not set up resource sampling", exc_info=True)
            return None

    @property
    def resources(self):
        """The :class:`~apilens.client.resources.ResourceSampler`, or ``None``
        when ``capture_resources`` is off."""
        return self._resources

    def start(self) -> None:
        if self._resources is not None:
            # Inline mode starts no thread: ``flush()`` samples when one is due.
            self._resources.start()
        if self.inline:
            # Serverless: never start a thread the runtime may freeze.
            return
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="apilens-flush")
        self._thread.start()

    def shutdown(self, *, flush: bool = True, timeout: float = 10.0) -> None:
        """Deliver what is queued, then send the final heartbeat.

        With ``flush`` the queues are drained, waiting out retry backoffs for
        at most ``timeout`` minus one request ``timeout`` (room for the final
        heartbeat). Whatever is still queued then is counted as dropped
        (``shutdown``) so the final heartbeat reports it."""
        if flush:
            self._drain(max(0.0, timeout - self.config.timeout))
        if self.config.enabled:
            self._drop_leftovers()
            self.send_heartbeat(final=True)

        self._stop.set()
        self._wakeup.set()
        if self._resources is not None:
            self._resources.stop()

        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=timeout)

    def __enter__(self) -> "ApiLensClient":
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.shutdown(flush=True)

    def report_metadata(
        self,
        build: Callable[[], dict | None],
        *,
        app_id: str,
        environment: str = "",
        delay: float | None = None,
    ) -> bool:
        """Send the app metadata report once per process, without blocking.

        ``build`` returns the ``POST /v1/metadata`` body (see
        ``apilens.client._metadata``); it runs on a daemon thread ``delay``
        seconds (default ``METADATA_DELAY_SECONDS``) from now, so routes
        registered after the middleware are included. Only the first call per process for an app and environment
        starts a report; later ones (more middleware instances, more clients)
        return ``False``. Disabled with ``send_metadata=False``,
        ``enabled=False`` or env ``APILENS_SEND_METADATA=false``.
        """
        # Every framework middleware reports metadata on construction, so
        # this is also where its app is enrolled for heartbeats. An empty
        # app_id is the project's default app.
        app_id = (app_id or "").strip()
        self.register_app(app_id, environment)
        if not (self.config.enabled and self.config.send_metadata and env_send_metadata_enabled()):
            return False
        key = (os.getpid(), self.config.base_url, app_id, environment or self.config.environment)
        with _metadata_lock:
            if key in _metadata_reported:
                return False
            _metadata_reported.add(key)
        if delay is None:
            delay = METADATA_DELAY_SECONDS
        thread = threading.Thread(
            target=self._metadata_worker, args=(build, delay), daemon=True, name="apilens-metadata"
        )
        thread.start()
        self._metadata_thread = thread
        return True

    def _metadata_worker(self, build: Callable[[], dict | None], delay: float) -> None:
        if delay > 0 and self._stop.wait(delay):
            return  # shut down before the report was due
        try:
            payload = build()
        except Exception:
            logger.debug("API Lens could not build the app metadata report", exc_info=True)
            return
        if payload:
            self.send_metadata(payload)

    def send_metadata(self, payload: dict) -> bool:
        """POST one app metadata report now; ``True`` on 2xx.

        Keys naming an API key are removed at any depth and the routes list is
        normalised and capped at ``MAX_METADATA_ROUTES``. 408/429/5xx and
        network errors are retried up to ``METADATA_MAX_RETRIES`` times (after
        ``Retry-After`` when the server sends one); any other 4xx is final.
        """
        body = _strip_api_key_fields(dict(payload))
        body["routes"] = cap_routes(body.get("routes"))
        encoded = _dumps(body)
        last_error: Exception | None = None
        for attempt in range(METADATA_MAX_RETRIES + 1):
            try:
                self._post_body(self.config.metadata_path, encoded)
                return True
            except _NonRetryableIngestError as exc:
                logger.warning(
                    "API Lens ingest rejected the app metadata report with status %s: %s",
                    exc.status,
                    exc.body or "<empty body>",
                )
                return False
            except Exception as exc:
                last_error = exc
                if attempt >= METADATA_MAX_RETRIES:
                    break
                retry_after = getattr(exc, "retry_after", None)
                self._sleep(
                    retry_after
                    if retry_after is not None
                    else backoff_delay(
                        attempt, self.config.retry_backoff_base, self.config.retry_backoff_max
                    )
                )
        logger.debug("API Lens app metadata report failed: %s", last_error)
        return False

    def _new_instance(self) -> None:
        # One instance per process start: a forked worker gets its own id.
        self._pid = os.getpid()
        self._instance_id = str(uuid.uuid4())
        self._started_at = time.monotonic()

    def _check_fork(self) -> None:
        if os.getpid() != self._pid:
            self._new_instance()
            self._after_fork()

    def _after_fork(self) -> None:
        """A forked child (gunicorn ``--preload``, Celery prefork): threads do
        not survive ``fork()``, so restart the ones the parent was running."""
        try:
            if self._resources is not None:
                self._resources.ensure_running()
            if (
                self._thread is not None
                and not self.inline
                and self.config.enabled
                and not self._stop.is_set()
            ):
                self._thread = None
                self.start()
        except Exception:  # pragma: no cover - never break the request path
            logger.debug("API Lens could not restart its threads after fork", exc_info=True)

    @property
    def instance_id(self) -> str:
        """Id of this process in heartbeats; new on every process start."""
        self._check_fork()
        return self._instance_id

    @property
    def remote_policy(self) -> dict | None:
        """The capture policy from the last successful heartbeat, or ``None``
        before the first one. A failed heartbeat keeps the previous policy."""
        with self._heartbeat_lock:
            return dict(self._remote_policy) if self._remote_policy is not None else None

    def policy(self, app_id: str = "") -> Policy:
        """The capture policy in force for ``app_id`` (default: the config's).

        Local ``enabled=False`` always wins (:data:`~apilens.client._policy.DISABLED`);
        otherwise the last policy a heartbeat returned for the app, or no
        remote restriction before the first one. Remote can only narrow the
        local config: middlewares combine it with their own settings via
        ``Policy.cap_*`` and the boolean flags. Cheap enough to call per request."""
        if not self.config.enabled:
            return DISABLED
        return self._policies.get(app_id or self.config.app_id, ALLOW_ALL)

    def _heartbeats_enabled(self) -> bool:
        return self.config.send_heartbeat and env_send_heartbeat_enabled()

    def register_app(self, app_id: str, environment: str = "") -> None:
        """Send heartbeats for ``app_id`` in ``environment`` (default: the
        config's) from now on. The first one goes out on the next flush-loop
        pass. Registering the same app again does nothing. ``""`` is the
        project's default app (no app name configured)."""
        key = ((app_id or "").strip(), environment or self.config.environment)
        with self._heartbeat_lock:
            if key in self._heartbeat_due:
                return
            self._heartbeat_due[key] = 0.0
        if self._resources is not None:
            self._resources.register(key)
        if self._heartbeats_enabled():
            self._wakeup.set()

    def heartbeat_payload(self, app_id: str, environment: str = "", *, final: bool = False) -> dict:
        """The ``POST /v1/heartbeat`` body for one app."""
        return self._heartbeat_body(app_id, environment, final=final)[0]

    def _drop_snapshot(self, app_id: str) -> dict[tuple[str, str, str], int]:
        """Unreported drops of ``app_id``; the first registered app also
        carries drops of apps that send no heartbeat of their own."""
        with self._heartbeat_lock:
            registered = [a for a, _env in self._heartbeat_due]
        primary = registered[0] if registered else app_id
        with self._lock:
            return {
                key: n
                for key, n in self._unreported_drops.items()
                if n > 0 and (key[0] == app_id or (app_id == primary and key[0] not in registered))
            }

    def _ack_drops(self, snapshot: dict[tuple[str, str, str], int]) -> None:
        """A heartbeat carrying ``snapshot`` was accepted: forget those drops."""
        with self._lock:
            for key, n in snapshot.items():
                left = self._unreported_drops.get(key, 0) - n
                if left > 0:
                    self._unreported_drops[key] = left
                else:
                    self._unreported_drops.pop(key, None)

    def _heartbeat_body(
        self, app_id: str, environment: str = "", *, final: bool = False
    ) -> tuple[dict, dict[tuple[str, str, str], int]]:
        self._check_fork()
        body: dict = {
            "app_id": app_id,
            "environment": environment or self.config.environment,
            "instance_id": self._instance_id,
            "sdk_name": SDK_NAME,
            "sdk_version": __version__,
            "runtime": _runtime(),
            "pid": self._pid,
            "uptime_s": int(time.monotonic() - self._started_at),
            "stats": self.stats().to_dict(),
        }
        if self.config.project_slug:
            body["project_slug"] = self.config.project_slug
        if self.config.release:
            body["release"] = self.config.release
        if self.config.commit:
            body["commit"] = self.config.commit
        if final:
            body["final"] = True
        identity = self._process_identity()
        if identity:
            body["identity"] = identity
        resources = self._resources_block(app_id, environment or self.config.environment)
        if resources:
            body["resources"] = resources
        snapshot = self._drop_snapshot(app_id)
        if snapshot:
            dropped: dict[str, dict[str, int]] = {}
            for (_app, signal, reason), n in snapshot.items():
                by_reason = dropped.setdefault(signal, {})
                by_reason[reason] = by_reason.get(reason, 0) + n
            body["dropped"] = dropped
        return body, snapshot

    def _process_identity(self) -> dict:
        """The heartbeat ``identity``, resolved once per process (and again
        in a forked child). Runs on the heartbeat path, never per request."""
        pid = os.getpid()
        cached = self._identity
        if cached is not None and cached[0] == pid:
            return cached[1]
        try:
            from .resources import resolve_identity
            from .resources.process import load_psutil

            sampler = self._resources
            reader = sampler.ctx.cgroup if sampler is not None else None
            identity = resolve_identity(cgroup=reader, psutil=load_psutil())
        except Exception:
            logger.debug("API Lens could not resolve the process identity", exc_info=True)
            identity = {}
        self._identity = (pid, identity)
        return identity

    def _resources_block(self, app_id: str, environment: str) -> dict | None:
        sampler = self._resources
        if sampler is None:
            return None
        try:
            block = sampler.drain((app_id, environment))
        except Exception:  # pragma: no cover - drain never raises
            logger.debug("API Lens could not drain resources", exc_info=True)
            return None
        if block is None or not self.policy(app_id).resources.enabled:
            return None
        return block

    def _sync_resources_policy(self) -> None:
        """Hand the sampler the narrowest resources policy of the apps that
        still want resources (one sampler serves every app of the process)."""
        sampler = self._resources
        if sampler is None:
            return
        policies = [p.resources for p in self._policies.values()]
        if not policies:
            return
        active = [p for p in policies if p.enabled]
        if not active:
            sampler.apply_policy(ResourcesPolicy(enabled=False))
            return
        sampler.apply_policy(
            ResourcesPolicy(
                enabled=True,
                min_interval_s=max(p.min_interval_s for p in active),
                disabled_collectors=frozenset().union(*(p.disabled_collectors for p in active)),
            )
        )

    def send_heartbeat(self, *, final: bool = False) -> bool:
        """Send a heartbeat for every registered app now; ``True`` when all
        succeeded. Never raises and never retries: a failure is logged (once
        per status for 401/403/422, else at DEBUG), keeps the previous
        policy and only reschedules the next heartbeat."""
        if not self._heartbeats_enabled():
            return False
        with self._heartbeat_lock:
            keys = list(self._heartbeat_due)
        ok = bool(keys)
        for app_id, environment in keys:
            ok = self._heartbeat_one(app_id, environment, final=final) and ok
        return ok

    def _maybe_heartbeat(self) -> None:
        """Send the heartbeats that are due. Flush thread only (or ``flush()``
        in inline mode)."""
        if not self._heartbeats_enabled():
            return
        now = time.monotonic()
        with self._heartbeat_lock:
            due = [key for key, at in self._heartbeat_due.items() if at <= now]
        for app_id, environment in due:
            self._heartbeat_one(app_id, environment)

    def _schedule_heartbeat(self, key: tuple[str, str], delay: float) -> None:
        with self._heartbeat_lock:
            self._heartbeat_due[key] = time.monotonic() + delay

    def _heartbeat_one(self, app_id: str, environment: str, *, final: bool = False) -> bool:
        key = (app_id, environment)
        interval = self.config.heartbeat_interval
        try:
            body, drops = self._heartbeat_body(app_id, environment, final=final)
            body = _strip_api_key_fields(body)
            raw = self._post_body(self.config.heartbeat_path, _dumps(body), read_response=True)
        except _IngestError as exc:
            retry_after = exc.retry_after
            self._schedule_heartbeat(key, retry_after if retry_after is not None else interval)
            self._log_heartbeat_failure(exc)
            return False
        except Exception as exc:
            self._schedule_heartbeat(key, interval)
            logger.debug("API Lens heartbeat failed: %s", exc, exc_info=True)
            return False
        self._schedule_heartbeat(key, interval)
        self._ack_drops(drops)
        self._apply_heartbeat_response(raw, app_id)
        return True

    def _apply_heartbeat_response(self, raw: bytes, app_id: str = "") -> None:
        try:
            data = json.loads(raw.decode("utf-8")) if raw else None
        except (UnicodeDecodeError, ValueError):
            logger.debug("API Lens heartbeat response is not JSON; keeping the previous policy")
            return
        policy = data.get("policy") if isinstance(data, dict) else None
        parsed = parse_policy(policy)
        if parsed is None:
            logger.debug("API Lens heartbeat response has no policy; keeping the previous policy")
            return
        app_id = app_id or self.config.app_id
        with self._heartbeat_lock:
            self._remote_policy = dict(policy)
            previous = self._policies.get(app_id, ALLOW_ALL)
            if parsed != previous:
                # Copy-on-write so request threads read a consistent dict.
                self._policies = {**self._policies, app_id: parsed}
        if parsed != previous:
            self._sync_resources_policy()
            logger.info("API Lens capture policy for app %r is now %s", app_id, parsed.to_dict())

    def _log_heartbeat_failure(self, exc: _IngestError) -> None:
        status = exc.status
        if status in (401, 403, 422):
            with self._heartbeat_lock:
                if status in self._heartbeat_logged:
                    return
                self._heartbeat_logged.add(status)
            logger.warning(
                "API Lens ingest rejected the heartbeat with status %s: %s",
                status,
                exc.body or "<empty body>",
            )
            return
        logger.debug("API Lens heartbeat failed: %s", exc)

    @property
    def dropped_count(self) -> int:
        """Total records dropped for any reason (sum of ``drop_counts()``,
        excluding ``truncated``: those records were still sent)."""
        with self._lock:
            return sum(self._drops[reason] for reason in DROP_REASONS)

    def drop_counts(self) -> dict[str, int]:
        """Records dropped so far, by reason: ``queue_full``, ``queue_bytes``,
        ``non_retryable``, ``retries_exhausted``, ``invalid`` (refused by a
        partial accept), ``shutdown`` (still queued at shutdown) and
        ``span_cap`` (child spans over the per-request cap); plus
        ``truncated``, the records cut down to fit ``max_batch_bytes`` (sent,
        not dropped). Drops other than ``truncated`` and ``invalid`` are also
        reported to ingest in the next heartbeat's ``dropped`` field."""
        with self._lock:
            return dict(self._drops)

    def stats(self) -> ClientStats:
        """Snapshot of queue depth, delivery counters, drops and the last error.

        Cheap and thread-safe: one short hold of the client lock, which the
        capture path already takes per record."""
        with self._lock:
            return ClientStats(
                queued_records=len(self._queue) + len(self._span_queue) + len(self._log_queue),
                queued_bytes=self._queued_bytes,
                sent_batches=self._sent_batches,
                sent_records=self._sent_records,
                failed_batches=self._failed_batches,
                drop_counts=dict(self._drops),
                last_error=self._last_error,
                last_success_at=self._last_success_at,
            )

    def _report_stats(self, *, force: bool = False) -> None:
        """Log the stats summary (DEBUG every ``flush_interval``, INFO when new
        drops happened, rate-limited) and call ``on_stats``. Flush thread only
        (or ``flush()`` in inline mode)."""
        now = time.monotonic()
        if (
            not force
            and self._stats_reported_at is not None
            and now - self._stats_reported_at < self.config.flush_interval
        ):
            return
        self._stats_reported_at = now
        stats = self.stats()
        dropped = stats.dropped
        if dropped > self._drops_logged_total and (
            force
            or self._drops_logged_at is None
            or now - self._drops_logged_at >= DROP_LOG_INTERVAL_SECONDS
        ):
            logger.info(
                "API Lens dropped %d record(s) since the last report: %s",
                dropped - self._drops_logged_total,
                stats.summary(),
            )
            self._drops_logged_total = dropped
            self._drops_logged_at = now
        elif logger.isEnabledFor(logging.DEBUG):
            logger.debug("API Lens stats: %s", stats.summary())
        callback = self.config.on_stats
        if callback is not None:
            try:
                callback(stats)
            except Exception:
                logger.debug("API Lens on_stats callback raised", exc_info=True)

    @property
    def queued_bytes(self) -> int:
        """Estimated size of everything currently queued (all three queues)."""
        with self._lock:
            return self._queued_bytes

    def capture(
        self,
        *,
        timestamp: datetime | None = None,
        method: str,
        path: str,
        raw_path: str = "",
        status_code: int,
        response_time_ms: float,
        project_slug: str = "",
        app_id: str = "",
        request_size: int = 0,
        response_size: int = 0,
        ip_address: str = "",
        user_agent: str = "",
        consumer_id: str = "",
        consumer_name: str = "",
        consumer_group: str = "",
        request_payload: str = "",
        response_payload: str = "",
        request_headers: str = "",
        response_headers: str = "",
        environment: str | None = None,
        base_url: str = "",
        trace_id: str = "",
        span_id: str = "",
        sampled: bool = True,
        attributes: dict[str, str | int | float | bool] | None = None,
        validation_errors: list[dict[str, str]] | None = None,
    ) -> None:
        record = RequestRecord(
            timestamp=timestamp or datetime.now(tz=timezone.utc),
            environment=environment or self.config.environment,
            method=method,
            path=path,
            raw_path=raw_path or path,
            status_code=status_code,
            response_time_ms=response_time_ms,
            project_slug=project_slug or self.config.project_slug,
            app_id=app_id,
            request_size=request_size,
            response_size=response_size,
            ip_address=ip_address,
            user_agent=user_agent,
            consumer_id=consumer_id,
            consumer_name=consumer_name,
            consumer_group=consumer_group,
            request_payload=request_payload,
            response_payload=response_payload,
            request_headers=request_headers,
            response_headers=response_headers,
            base_url=base_url,
            trace_id=trace_id,
            span_id=span_id,
            sampled=sampled,
            attributes=dict(attributes) if attributes else None,
            validation_errors=list(validation_errors) if validation_errors else None,
        )
        self.capture_record(record)

    def _stamp_release(self, record) -> None:
        # Records carry release/commit themselves so a batch can straddle a
        # deploy; empty fields inherit the config (usually env-detected).
        if not record.release:
            record.release = self.config.release
        if not record.commit:
            record.commit = self.config.commit

    def _capture_allowed(self, record) -> bool:
        # Local kill switch, then the app's remote one (``policy``).
        return self.config.enabled and self.policy(record.app_id).enabled

    def capture_record(self, record: RequestRecord) -> None:
        if not self._capture_allowed(record):
            return
        self._stamp_release(record)
        # Through the property: a forked worker gets (and stamps) its own id.
        record.instance_id = self.instance_id
        self._enqueue(self._queue, record)

    def capture_many(self, records: list[RequestRecord]) -> None:
        for record in records:
            self.capture_record(record)

    def capture_span(self, record: SpanRecord) -> None:
        if not self._capture_allowed(record):
            return
        self._stamp_release(record)
        self._enqueue(self._span_queue, record)

    def capture_log(self, record: LogRecord) -> None:
        if not self._capture_allowed(record):
            return
        masked = self._mask_log(record)
        if masked is None:
            return
        self._stamp_release(masked)
        self._enqueue(self._log_queue, masked)

    def _mask_log(self, record: LogRecord) -> LogRecord | None:
        """Run ``mask_log_record`` then the built-in masking on one log record.

        Order is fixed: the user callback first (it may edit the record or
        return ``None`` to drop it), then the built-in ``key=value`` masking
        on the message, payload and attributes, which the callback can never
        switch off. Fail closed: a callback that raises or returns something
        other than a ``LogRecord`` drops the record.
        """
        callback = self.config.mask_log_record
        if callback is not None:
            try:
                result = callback(record)
            except Exception:
                logger.debug("apilens: mask_log_record raised; log record dropped", exc_info=True)
                return None
            if result is None:
                return None
            if not isinstance(result, LogRecord):
                logger.debug("apilens: mask_log_record returned %r; log record dropped", type(result))
                return None
            record = result
        record.message = mask_log_text(record.message or "")
        record.payload = mask_log_text(record.payload or "")
        record.attributes = mask_log_attributes(record.attributes)
        return record

    def _enqueue(self, queue: deque, record) -> None:
        size = estimate_record_bytes(record)
        max_bytes = self.config.max_queue_bytes
        with self._lock:
            if size > max_bytes:
                # A single record over the whole budget would evict everything
                # and still not fit: shed it instead.
                self._count_drops_locked(DROP_QUEUE_BYTES, queue, [record])
                return
            while len(queue) >= self.config.max_queue_size:
                # ``while``: records put back after a failed send may have
                # pushed the queue past its cap.
                self._count_drops_locked(DROP_QUEUE_FULL, queue, [self._popleft_locked(queue)])
            while self._queued_bytes + size > max_bytes:
                # Drop oldest from this queue first; once it is empty, from
                # whichever other queue holds the most bytes.
                victim = queue if queue else self._largest_queue()
                if victim is None:  # pragma: no cover - accounting invariant
                    break
                self._count_drops_locked(DROP_QUEUE_BYTES, victim, [self._popleft_locked(victim)])
            queue.append(record)
            self._sizes[id(queue)].append(size)
            self._bytes_by_queue[id(queue)] += size
            self._queued_bytes += size
            queue_size = len(queue)

        if queue_size >= self.config.batch_size:
            self._wakeup.set()

    def count_span_cap_drops(self, app_id: str, count: int = 1) -> None:
        """Count ``count`` spans of ``app_id`` recorded past a request's span
        cap as ``span_cap`` (in ``drop_counts()`` and the next heartbeat's
        ``dropped.spans``)."""
        if count <= 0:
            return
        key = ((app_id or "").strip(), SIGNAL_SPANS, DROP_SPAN_CAP)
        with self._lock:
            self._drops[DROP_SPAN_CAP] += count
            self._unreported_drops[key] = self._unreported_drops.get(key, 0) + count

    def _count_drops_locked(self, reason: str, queue: deque, records: list) -> None:
        """Count dropped ``records`` of ``queue``: in ``drop_counts()`` and,
        per app and signal, for the next heartbeat's ``dropped`` field."""
        self._drops[reason] += len(records)
        if reason in _UNREPORTED_REASONS:
            return
        signal = self._signals[id(queue)]
        for record in records:
            key = ((getattr(record, "app_id", "") or "").strip(), signal, reason)
            self._unreported_drops[key] = self._unreported_drops.get(key, 0) + 1

    def _popleft_locked(self, queue: deque):
        record = queue.popleft()
        size = self._sizes[id(queue)].popleft()
        self._bytes_by_queue[id(queue)] -= size
        self._queued_bytes -= size
        self._failed_at.pop(id(record), None)
        return record

    def _queues(self) -> tuple[deque, deque, deque]:
        return (self._queue, self._span_queue, self._log_queue)

    def _largest_queue(self) -> deque | None:
        best: deque | None = None
        best_bytes = -1
        for q in self._queues():
            if q and self._bytes_by_queue[id(q)] > best_bytes:
                best, best_bytes = q, self._bytes_by_queue[id(q)]
        return best

    def retry_window(self) -> float:
        """Seconds a failed record keeps being retried after its first failed
        attempt: ``max_retry_seconds``, or the legacy ``max_retries`` mapped
        to the backoff that many retries used to wait at most."""
        cfg = self.config
        if cfg.max_retries is None:
            return max(0.0, float(cfg.max_retry_seconds))
        return float(
            sum(
                min(cfg.retry_backoff_max, cfg.retry_backoff_base * (2**i))
                for i in range(max(0, int(cfg.max_retries)))
            )
        )

    def flush_once(self) -> int:
        """One pass over the request, span and log queues: send one batch of
        each queue that is not waiting out a retry backoff. Returns the
        number of records delivered."""
        return sum(
            self._flush_queue(queue, key, send)
            for queue, key, send in (
                (self._queue, "requests", self._send_batch),
                (self._span_queue, "spans", self._send_span_batch),
                (self._log_queue, "logs", self._send_log_batch),
            )
        )

    def _flush_queue(self, queue: deque, key: str, send) -> int:
        """Send one batch of ``queue``; return the records delivered.

        A 408/429/5xx/network failure puts the unsent records back at the
        front of the queue and holds the queue for a full-jitter backoff (or
        the server's ``Retry-After``, capped at 60 s); a record still failing
        ``retry_window()`` seconds after its first failure is dropped
        (``retries_exhausted``). Any other 4xx drops the chunk at once
        (``non_retryable``). Records a 2xx names as invalid (partial accept)
        are counted (``invalid``) and never retried."""
        qid = id(queue)
        if time.monotonic() < self._retry_at[qid]:
            return 0
        # The pop is bounded by the size estimate; the exact JSON split below
        # guarantees no body exceeds max_batch_bytes.
        chunks = self._split_by_bytes(self._pop_entries(queue, self.config.batch_size), key)
        delivered = 0
        for i, (encoded, entries) in enumerate(chunks):
            try:
                raw = send(encoded)
            except _NonRetryableIngestError as exc:
                with self._lock:
                    self._count_drops_locked(DROP_NON_RETRYABLE, queue, [e[0] for e in entries])
                    self._failed_batches += 1
                    self._last_error = _describe_error(exc)
                self._log_non_retryable(exc, len(entries))
                continue
            except Exception as exc:
                self._retry_later(queue, [e for _enc, more in chunks[i:] for e in more], exc)
                return delivered
            invalid = self._invalid_count(raw, len(entries))
            with self._lock:
                self._sent_batches += 1
                self._sent_records += len(entries) - invalid
                self._last_success_at = datetime.now(tz=timezone.utc)
                self._retry_attempt[qid] = 0
                self._drops[DROP_INVALID] += invalid
            delivered += len(entries)
        return delivered

    def _retry_later(self, queue: deque, entries: list, exc: Exception) -> None:
        """Put the ``entries`` still inside the retry window back at the front
        of ``queue`` and hold the queue for the backoff; drop the others."""
        qid = id(queue)
        now = time.monotonic()
        window = self.retry_window()
        keep: list = []
        expired: list = []
        for record, size, failed_at in entries:
            first = now if failed_at is None else failed_at
            (expired if now - first >= window else keep).append((record, size, first))
        retry_after = getattr(exc, "retry_after", None)
        with self._lock:
            self._last_error = _describe_error(exc)
            attempt = self._retry_attempt[qid]
            self._retry_attempt[qid] = attempt + 1
            if retry_after is None:
                delay = backoff_delay(
                    attempt, self.config.retry_backoff_base, self.config.retry_backoff_max
                )
            else:
                delay = retry_after
            self._retry_at[qid] = now + delay
            if expired:
                self._count_drops_locked(DROP_RETRIES_EXHAUSTED, queue, [e[0] for e in expired])
                self._failed_batches += 1
            sizes = self._sizes[qid]
            for record, size, first in reversed(keep):
                queue.appendleft(record)
                sizes.appendleft(size)
                self._bytes_by_queue[qid] += size
                self._queued_bytes += size
                self._failed_at[id(record)] = first
        if expired:
            logger.warning(
                "API Lens ingest still failing after max_retry_seconds=%g; dropping %d %s "
                "record(s): %s",
                window,
                len(expired),
                self._signals[qid],
                exc,
            )
        if keep:
            logger.debug(
                "API Lens ingest attempt %d failed (%s); retrying in %.2fs",
                attempt + 1,
                exc,
                delay,
            )

    def _invalid_count(self, raw, sent: int) -> int:
        """Records a 2xx answer refused as invalid (partial accept:
        ``{"invalid": n, "errors": [{"index": i, "reason": "..."}]}``)."""
        if not raw:
            return 0
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            return 0
        invalid = data.get("invalid") if isinstance(data, dict) else None
        if not isinstance(invalid, int) or isinstance(invalid, bool) or invalid <= 0:
            return 0
        invalid = min(invalid, sent)
        now = time.monotonic()
        if (
            self._invalid_logged_at is None
            or now - self._invalid_logged_at >= NON_RETRYABLE_LOG_INTERVAL_SECONDS
        ):
            self._invalid_logged_at = now
            errors = data.get("errors")
            first = errors[0] if isinstance(errors, list) and errors else None
            reason = str(first.get("reason", "")) if isinstance(first, dict) else ""
            logger.warning(
                "API Lens ingest refused %d of %d record(s) as invalid (not retried)%s",
                invalid,
                sent,
                f": {reason[:MAX_LOGGED_BODY_BYTES]}" if reason else "",
            )
        return invalid

    def flush(self) -> int:
        """Deliver everything queued now, synchronously; return the number of
        records delivered.

        Safe from any thread and in either mode. In ``inline`` mode this is
        the only delivery path: the middlewares call it after the response is
        sent, and code without a middleware (a Lambda handler, a script)
        calls it at the end of each invocation. It also sends any heartbeat
        that is due and the periodic stats report, which the flush thread
        handles in ``thread`` mode. Never raises for delivery failures: they
        stay queued for a later flush, and are dropped and counted once
        ``max_retry_seconds`` has passed.
        """
        total = self.flush_all()
        if self.inline and self.config.enabled and self._inline_upkeep_lock.acquire(blocking=False):
            try:
                try:
                    self._report_stats()
                except Exception:  # pragma: no cover
                    logger.debug("API Lens stats reporting failed", exc_info=True)
                if self._resources is not None:
                    # Serverless: sample at the end of the invocation, when
                    # one is due, and send it with the heartbeat below.
                    try:
                        self._resources.maybe_sample()
                    except Exception:  # pragma: no cover
                        logger.debug("API Lens resource sample failed", exc_info=True)
                self._safe_heartbeat()
            finally:
                self._inline_upkeep_lock.release()
        return total

    def flush_all(self) -> int:
        """Send batches until the queues are empty or every non-empty queue
        is waiting out a retry backoff."""
        total = 0
        while True:
            n = self.flush_once()
            if n == 0:
                break
            total += n
        return total

    def _drain(self, budget: float) -> None:
        """``flush_all``, waiting out retry backoffs for at most ``budget`` seconds."""
        deadline = time.monotonic() + budget
        while True:
            self.flush_all()
            with self._lock:
                waiting = [self._retry_at[id(q)] for q in self._queues() if q]
            if not waiting:
                return
            wait = max(0.0, min(waiting) - time.monotonic())
            if time.monotonic() + wait >= deadline:
                return
            self._sleep(wait)

    def _drop_leftovers(self) -> None:
        """Count what is still queued at shutdown as dropped (``shutdown``)."""
        left_total = 0
        with self._lock:
            for queue in self._queues():
                left = [self._popleft_locked(queue) for _ in range(len(queue))]
                if left:
                    self._count_drops_locked(DROP_SHUTDOWN, queue, left)
                    left_total += len(left)
        if left_total:
            logger.warning(
                "API Lens shut down with %d record(s) undelivered; counted as dropped (shutdown)",
                left_total,
            )

    def _run_loop(self) -> None:
        self._safe_heartbeat()
        while not self._stop.is_set():
            self._wakeup.wait(self.config.flush_interval)
            self._wakeup.clear()
            try:
                self.flush_once()
            except Exception:  # pragma: no cover
                logger.exception("Unexpected error while flushing API Lens queue")
            try:
                self._report_stats()
            except Exception:  # pragma: no cover
                logger.debug("API Lens stats reporting failed", exc_info=True)
            if not self._stop.is_set():
                self._safe_heartbeat()

    def _safe_heartbeat(self) -> None:
        try:
            self._maybe_heartbeat()
        except Exception:  # pragma: no cover
            logger.debug("API Lens heartbeat failed", exc_info=True)

    def _pop_batch(self, size: int) -> list[RequestRecord]:
        return self._pop_from(self._queue, size)

    def _pop_span_batch(self, size: int) -> list[SpanRecord]:
        return self._pop_from(self._span_queue, size)

    def _pop_log_batch(self, size: int) -> list[LogRecord]:
        return self._pop_from(self._log_queue, size)

    def _pop_from(self, queue: deque, size: int) -> list:
        return [entry[0] for entry in self._pop_entries(queue, size)]

    def _pop_entries(self, queue: deque, size: int) -> list[tuple]:
        """Pop up to ``size`` records whose estimated sizes fit in
        ``max_batch_bytes`` (always at least one record), as
        ``(record, estimated size, first failed attempt or None)``."""
        max_bytes = self.config.max_batch_bytes
        with self._lock:
            sizes = self._sizes[id(queue)]
            batch: list[tuple] = []
            used = 0
            while queue and len(batch) < size:
                record_size = sizes[0]
                if batch and used + record_size > max_bytes:
                    break
                used += record_size
                failed_at = self._failed_at.get(id(queue[0]))
                batch.append((self._popleft_locked(queue), record_size, failed_at))
            return batch

    def _split_by_bytes(self, entries: list[tuple], key: str) -> list[tuple[list[bytes], list[tuple]]]:
        """Encode the popped ``entries`` and group them into chunks whose JSON
        body (``{"<key>":[...]}``) is at most ``max_batch_bytes``, as
        ``(encoded records, entries)``. A record that cannot fit even alone
        is truncated, head and tail kept (``truncated`` counter)."""
        if not entries:
            return []
        max_bytes = self.config.max_batch_bytes
        envelope = len(_envelope(key, []))
        chunks: list[tuple[list[bytes], list[tuple]]] = []
        current: list[bytes] = []
        current_entries: list[tuple] = []
        used = envelope
        for entry in entries:
            record = entry[0]
            encoded = _dumps(record.to_wire())
            if envelope + len(encoded) > max_bytes:
                encoded = _truncate_wire(record.to_wire(), max_bytes - envelope)
                with self._lock:
                    self._drops[DROP_TRUNCATED] += 1
                logger.debug(
                    "API Lens record exceeded max_batch_bytes=%d; truncated to %d bytes",
                    max_bytes,
                    len(encoded),
                )
            extra = len(encoded) + (1 if current else 0)  # "," separator
            if current and used + extra > max_bytes:
                chunks.append((current, current_entries))
                current, current_entries, used = [], [], envelope
                extra = len(encoded)
            current.append(encoded)
            current_entries.append(entry)
            used += extra
        if current:
            chunks.append((current, current_entries))
        return chunks

    def _sleep(self, seconds: float) -> None:
        if seconds > 0:
            time.sleep(seconds)

    def _log_non_retryable(self, exc: _NonRetryableIngestError, count: int) -> None:
        """Log a rejected batch at most once per status per 5 minutes, so a
        bad key does not flood the application's logs."""
        status = exc.status or 0
        now = time.monotonic()
        with self._lock:
            last = self._non_retryable_logged_at.get(status)
            if last is not None and now - last < NON_RETRYABLE_LOG_INTERVAL_SECONDS:
                return
            self._non_retryable_logged_at[status] = now
        if status == 401:
            logger.error(
                "API Lens ingest rejected the API key (401 Unauthorized), so telemetry is "
                "being dropped. Check that api_key is a valid project API key for %s. "
                "Troubleshooting: %s",
                self.config.base_url,
                TROUBLESHOOTING_URL,
            )
            return
        logger.warning(
            "API Lens ingest rejected a batch of %d records with status %d (not retried): %s",
            count,
            status,
            exc.body or "<empty body>",
        )

    # ``batch`` is a list of records, or of already-encoded records (bytes)
    # as produced by ``_split_by_bytes`` on the flush path. They return the
    # response body (a partial accept names the records refused as invalid).
    def _send_batch(self, batch: list[RequestRecord] | list[bytes]) -> bytes:
        return self._post_body(
            self.config.ingest_path, _envelope("requests", batch), read_response=True
        )

    def _send_span_batch(self, batch: list[SpanRecord] | list[bytes]) -> bytes:
        return self._post_body(self.config.spans_path, _envelope("spans", batch), read_response=True)

    def _send_log_batch(self, batch: list[LogRecord] | list[bytes]) -> bytes:
        return self._post_body(self.config.logs_path, _envelope("logs", batch), read_response=True)

    def _post_body(self, path: str, body: bytes, *, read_response: bool = False) -> bytes:
        """POST ``body`` to ``path``; returns the response body when
        ``read_response`` (else ``b""``)."""
        headers = {
            "Content-Type": "application/json",
            "X-API-Key": self.config.api_key,
            "User-Agent": self.config.user_agent,
        }
        if self.config.compress:
            # Runs on the flush thread (or an explicit flush/shutdown), never
            # on the request path: capture only enqueues.
            try:
                compressed = gzip.compress(body, compresslevel=GZIP_LEVEL)
                # Incompressible data can grow by gzip's framing; never let
                # that push a body past max_batch_bytes.
                if len(compressed) < len(body):
                    body = compressed
                    headers["Content-Encoding"] = "gzip"
            except Exception as exc:  # identity fallback; never lose the batch
                logger.debug("API Lens gzip failed, sending uncompressed: %s", exc)

        ingest_url = urllib.parse.urljoin(
            self.config.base_url.rstrip("/") + "/",
            path.lstrip("/"),
        )

        req = urllib.request.Request(
            ingest_url,
            method="POST",
            data=body,
            headers=headers,
        )

        try:
            with _open(req, self.config) as resp:
                status = getattr(resp, "status", 200)
                if status >= 400:
                    raise _RetryableIngestError(
                        f"API Lens ingest returned status={status}", status=status
                    )
                return resp.read() if read_response else b""
        except urllib.error.HTTPError as exc:
            status = exc.code
            body = _read_error_body(exc)
            if not is_retryable_status(status):
                raise _NonRetryableIngestError(
                    f"Non-retryable ingest error status={status}", status=status, body=body
                ) from exc
            headers = exc.headers
            raise _RetryableIngestError(
                f"Retryable ingest error status={status}",
                status=status,
                retry_after=parse_retry_after(headers.get("Retry-After") if headers else None),
                body=body,
            ) from exc
        except urllib.error.URLError as exc:
            raise _RetryableIngestError(f"Ingest network error: {exc.reason}") from exc
        except OSError as exc:  # timeouts (socket.timeout), resets, refused
            raise _RetryableIngestError(f"Ingest network error: {exc!r}") from exc
