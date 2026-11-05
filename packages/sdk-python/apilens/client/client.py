from __future__ import annotations

import gzip
import json
import logging
import os
import random
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from .._version import __version__
from ._sanitize import mask_log_attributes, mask_log_text
from .models import LogRecord, RequestRecord, SpanRecord

logger = logging.getLogger("apilens")

# Drop reasons reported by ``ApiLensClient.drop_counts()``.
DROP_QUEUE_FULL = "queue_full"  # record-count cap (max_queue_size) hit
DROP_QUEUE_BYTES = "queue_bytes"  # memory cap (max_queue_bytes) hit
DROP_NON_RETRYABLE = "non_retryable"  # ingest rejected the batch with a 4xx
DROP_RETRIES_EXHAUSTED = "retries_exhausted"  # batch still failing after max_retries
DROP_REASONS = (DROP_QUEUE_FULL, DROP_QUEUE_BYTES, DROP_NON_RETRYABLE, DROP_RETRIES_EXHAUSTED)

# Env fallback for ``ApiLensConfig.proxy_url``.
ENV_PROXY = "APILENS_PROXY"

# Fixed per-record overhead added to the variable-length string fields when
# estimating a queued record's size (object headers, scalars, short fields).
RECORD_OVERHEAD_BYTES = 512

# gzip level for ingest bodies: a good size/CPU trade-off for JSON batches.
GZIP_LEVEL = 5


# Retry policy (see ``ApiLensClient._send_batch_with_retry``).
# 408 / 429 / 5xx and network errors are retried; any other 4xx drops the batch.
RETRYABLE_4XX = frozenset({408, 429})
# A server-sent Retry-After is honoured up to this many seconds.
RETRY_AFTER_MAX_SECONDS = 60.0
# A non-retryable status logs its response body at most once per window.
NON_RETRYABLE_LOG_INTERVAL_SECONDS = 300.0
# Response bodies quoted in logs are truncated to this many bytes.
MAX_LOGGED_BODY_BYTES = 1024
TROUBLESHOOTING_URL = "https://apilens.ai/docs/support/troubleshooting"


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


def _detect_release() -> str:
    return (os.getenv("APILENS_RELEASE") or "").strip()


def _detect_commit() -> str:
    for var in ("APILENS_COMMIT", "GIT_COMMIT", "SOURCE_VERSION", "RENDER_GIT_COMMIT"):
        value = (os.getenv(var) or "").strip()
        if value:
            return value
    return ""


@dataclass(slots=True)
class ApiLensConfig:
    api_key: str
    project_slug: str = ""
    base_url: str = "https://ingest.apilens.ai/v1"
    environment: str = "production"
    ingest_path: str = "/requests"
    spans_path: str = "/traces"
    logs_path: str = "/logs"

    # Deploy correlation: stamped on every request/span/log record so the
    # dashboard can answer "did this release cause the regression?". When left
    # empty they are auto-detected from the environment (APILENS_RELEASE;
    # APILENS_COMMIT / GIT_COMMIT / SOURCE_VERSION / RENDER_GIT_COMMIT).
    release: str = ""
    commit: str = ""

    batch_size: int = 200
    flush_interval: float = 3.0
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
    max_retries: int = 3
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
    user_agent: str = f"apilenss/{__version__}"

    def __post_init__(self) -> None:
        if not self.release:
            self.release = _detect_release()
        if not self.commit:
            self.commit = _detect_commit()
        if not self.proxy_url:
            self.proxy_url = (os.getenv(ENV_PROXY) or "").strip()


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
            raise ValueError("api_key is required")
        # project_slug is optional: the API key is project-level, so the server
        # derives the project from the key. You still pass app_id (which app).

        if config.batch_size <= 0:
            raise ValueError("batch_size must be > 0")
        if config.max_queue_size <= 0:
            raise ValueError("max_queue_size must be > 0")
        if config.max_queue_bytes <= 0:
            raise ValueError("max_queue_bytes must be > 0")

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
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._wakeup = threading.Event()
        self._thread: threading.Thread | None = None
        self._drops: dict[str, int] = dict.fromkeys(DROP_REASONS, 0)
        # status -> monotonic time its rejection was last logged.
        self._non_retryable_logged_at: dict[int, float] = {}

        if start_worker and self.config.enabled:
            self.start()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="apilens-flush")
        self._thread.start()

    def shutdown(self, *, flush: bool = True, timeout: float = 10.0) -> None:
        if flush:
            self.flush_all()

        self._stop.set()
        self._wakeup.set()

        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=timeout)

    def __enter__(self) -> "ApiLensClient":
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.shutdown(flush=True)

    @property
    def dropped_count(self) -> int:
        """Total records dropped for any reason (sum of ``drop_counts()``)."""
        with self._lock:
            return sum(self._drops.values())

    def drop_counts(self) -> dict[str, int]:
        """Records dropped so far, by reason: ``queue_full``, ``queue_bytes``,
        ``non_retryable`` and ``retries_exhausted``."""
        with self._lock:
            return dict(self._drops)

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
        )
        self.capture_record(record)

    def _stamp_release(self, record) -> None:
        # Records carry release/commit themselves so a batch can straddle a
        # deploy; empty fields inherit the config (usually env-detected).
        if not record.release:
            record.release = self.config.release
        if not record.commit:
            record.commit = self.config.commit

    def capture_record(self, record: RequestRecord) -> None:
        if not self.config.enabled:
            return
        self._stamp_release(record)
        self._enqueue(self._queue, record)

    def capture_many(self, records: list[RequestRecord]) -> None:
        for record in records:
            self.capture_record(record)

    def capture_span(self, record: SpanRecord) -> None:
        if not self.config.enabled:
            return
        self._stamp_release(record)
        self._enqueue(self._span_queue, record)

    def capture_log(self, record: LogRecord) -> None:
        if not self.config.enabled:
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
                self._drops[DROP_QUEUE_BYTES] += 1
                return
            if len(queue) >= self.config.max_queue_size:
                self._popleft_locked(queue)
                self._drops[DROP_QUEUE_FULL] += 1
            while self._queued_bytes + size > max_bytes:
                # Drop oldest from this queue first; once it is empty, from
                # whichever other queue holds the most bytes.
                victim = queue if queue else self._largest_queue()
                if victim is None:  # pragma: no cover - accounting invariant
                    break
                self._popleft_locked(victim)
                self._drops[DROP_QUEUE_BYTES] += 1
            queue.append(record)
            self._sizes[id(queue)].append(size)
            self._bytes_by_queue[id(queue)] += size
            self._queued_bytes += size
            queue_size = len(queue)

        if queue_size >= self.config.batch_size:
            self._wakeup.set()

    def _popleft_locked(self, queue: deque):
        record = queue.popleft()
        size = self._sizes[id(queue)].popleft()
        self._bytes_by_queue[id(queue)] -= size
        self._queued_bytes -= size
        return record

    def _largest_queue(self) -> deque | None:
        best: deque | None = None
        best_bytes = -1
        for q in (self._queue, self._span_queue, self._log_queue):
            if q and self._bytes_by_queue[id(q)] > best_bytes:
                best, best_bytes = q, self._bytes_by_queue[id(q)]
        return best

    def flush_once(self) -> int:
        total = 0
        batch = self._pop_batch(self.config.batch_size)
        # A failed batch is dropped and logged by _send_batch_with_retry.
        if batch and self._send_batch_with_retry(batch, self._send_batch):
            total += len(batch)

        span_batch = self._pop_span_batch(self.config.batch_size)
        if span_batch and self._send_batch_with_retry(span_batch, self._send_span_batch):
            total += len(span_batch)

        log_batch = self._pop_log_batch(self.config.batch_size)
        if log_batch and self._send_batch_with_retry(log_batch, self._send_log_batch):
            total += len(log_batch)
        return total

    def flush_all(self) -> int:
        total = 0
        while True:
            n = self.flush_once()
            if n == 0:
                break
            total += n
        return total

    def _run_loop(self) -> None:
        while not self._stop.is_set():
            self._wakeup.wait(self.config.flush_interval)
            self._wakeup.clear()
            try:
                self.flush_once()
            except Exception:  # pragma: no cover
                logger.exception("Unexpected error while flushing API Lens queue")

    def _pop_batch(self, size: int) -> list[RequestRecord]:
        return self._pop_from(self._queue, size)

    def _pop_span_batch(self, size: int) -> list[SpanRecord]:
        return self._pop_from(self._span_queue, size)

    def _pop_log_batch(self, size: int) -> list[LogRecord]:
        return self._pop_from(self._log_queue, size)

    def _pop_from(self, queue: deque, size: int) -> list:
        with self._lock:
            if not queue:
                return []
            return [self._popleft_locked(queue) for _ in range(min(size, len(queue)))]

    def _send_batch_with_retry(self, batch, send=None) -> bool:
        """Send ``batch``; ``True`` on 2xx. 408/429/5xx/network errors retry up
        to ``max_retries`` with full-jitter backoff, or after the server's
        ``Retry-After`` (capped at 60 s) when present. Any other 4xx drops the
        batch at once (``non_retryable``)."""
        send = send or self._send_batch
        last_error: Exception | None = None
        for attempt in range(self.config.max_retries + 1):
            try:
                send(batch)
                return True
            except _NonRetryableIngestError as exc:
                with self._lock:
                    self._drops[DROP_NON_RETRYABLE] += len(batch)
                self._log_non_retryable(exc, len(batch))
                return False
            except Exception as exc:
                last_error = exc
                if attempt >= self.config.max_retries:
                    break
                retry_after = getattr(exc, "retry_after", None)
                if retry_after is None:
                    delay = backoff_delay(
                        attempt, self.config.retry_backoff_base, self.config.retry_backoff_max
                    )
                else:
                    delay = retry_after
                logger.debug(
                    "API Lens ingest attempt %d failed (%s); retrying in %.2fs",
                    attempt + 1,
                    exc,
                    delay,
                )
                self._sleep(delay)

        with self._lock:
            self._drops[DROP_RETRIES_EXHAUSTED] += len(batch)
        logger.warning(
            "API Lens ingest failed after %d attempt(s); dropping batch of %d records: %s",
            self.config.max_retries + 1,
            len(batch),
            last_error,
        )
        return False

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

    def _send_batch(self, batch: list[RequestRecord]) -> None:
        self._post_json(self.config.ingest_path, {"requests": [r.to_wire() for r in batch]})

    def _send_span_batch(self, batch: list[SpanRecord]) -> None:
        self._post_json(self.config.spans_path, {"spans": [s.to_wire() for s in batch]})

    def _send_log_batch(self, batch: list[LogRecord]) -> None:
        self._post_json(self.config.logs_path, {"logs": [r.to_wire() for r in batch]})

    def _post_json(self, path: str, payload: dict) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "X-API-Key": self.config.api_key,
            "User-Agent": self.config.user_agent,
        }
        if self.config.compress:
            # Runs on the flush thread (or an explicit flush/shutdown), never
            # on the request path: capture only enqueues.
            try:
                body = gzip.compress(body, compresslevel=GZIP_LEVEL)
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
