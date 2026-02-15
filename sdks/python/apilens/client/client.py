from __future__ import annotations

import json
import logging
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone

from .models import RequestRecord

logger = logging.getLogger("apilens")


@dataclass(slots=True)
class ApiLensConfig:
    api_key: str
    base_url: str = "https://api.apilens.ai/api/v1"
    environment: str = "production"
    ingest_path: str = "/ingest/requests"

    batch_size: int = 200
    flush_interval: float = 3.0
    timeout: float = 5.0
    verify_tls: bool = True
    ca_bundle_path: str = ""

    max_queue_size: int = 10_000
    max_retries: int = 3
    retry_backoff_base: float = 0.25
    retry_backoff_max: float = 5.0

    enabled: bool = True
    user_agent: str = "apilens-python-sdk/0.1.0"


class ApiLensClient:
    def __init__(self, config: ApiLensConfig, *, start_worker: bool = True) -> None:
        if not config.api_key:
            raise ValueError("api_key is required")

        if config.batch_size <= 0:
            raise ValueError("batch_size must be > 0")
        if config.max_queue_size <= 0:
            raise ValueError("max_queue_size must be > 0")

        self.config = config
        self._queue: deque[RequestRecord] = deque()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._wakeup = threading.Event()
        self._thread: threading.Thread | None = None
        self._dropped = 0

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
        return self._dropped

    def capture(
        self,
        *,
        timestamp: datetime | None = None,
        method: str,
        path: str,
        status_code: int,
        response_time_ms: float,
        request_size: int = 0,
        response_size: int = 0,
        ip_address: str = "",
        user_agent: str = "",
        consumer_id: str = "",
        consumer_name: str = "",
        consumer_group: str = "",
        request_payload: str = "",
        response_payload: str = "",
        environment: str | None = None,
    ) -> None:
        record = RequestRecord(
            timestamp=timestamp or datetime.now(tz=timezone.utc),
            environment=environment or self.config.environment,
            method=method,
            path=path,
            status_code=status_code,
            response_time_ms=response_time_ms,
            request_size=request_size,
            response_size=response_size,
            ip_address=ip_address,
            user_agent=user_agent,
            consumer_id=consumer_id,
            consumer_name=consumer_name,
            consumer_group=consumer_group,
            request_payload=request_payload,
            response_payload=response_payload,
        )
        self.capture_record(record)

    def capture_record(self, record: RequestRecord) -> None:
        if not self.config.enabled:
            return
        with self._lock:
            if len(self._queue) >= self.config.max_queue_size:
                self._queue.popleft()
                self._dropped += 1
            self._queue.append(record)
            queue_size = len(self._queue)

        if queue_size >= self.config.batch_size:
            self._wakeup.set()

    def capture_many(self, records: list[RequestRecord]) -> None:
        for record in records:
            self.capture_record(record)

    def flush_once(self) -> int:
        batch = self._pop_batch(self.config.batch_size)
        if not batch:
            return 0

        sent = self._send_batch_with_retry(batch)
        if not sent:
            logger.warning("API Lens ingest failed; dropping batch of %d records", len(batch))
            return 0
        return len(batch)

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
        with self._lock:
            if not self._queue:
                return []
            batch: list[RequestRecord] = []
            for _ in range(min(size, len(self._queue))):
                batch.append(self._queue.popleft())
            return batch

    def _send_batch_with_retry(self, batch: list[RequestRecord]) -> bool:
        last_error: Exception | None = None
        for attempt in range(self.config.max_retries + 1):
            try:
                self._send_batch(batch)
                return True
            except Exception as exc:  # pragma: no cover
                last_error = exc
                if attempt >= self.config.max_retries:
                    break
                backoff = min(
                    self.config.retry_backoff_base * (2 ** attempt),
                    self.config.retry_backoff_max,
                )
                time.sleep(backoff)

        if last_error is not None:
            logger.warning("API Lens ingest request failed after retries: %s", last_error)
        return False

    def _send_batch(self, batch: list[RequestRecord]) -> None:
        payload = {"requests": [r.to_wire() for r in batch]}
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")

        ingest_url = urllib.parse.urljoin(
            self.config.base_url.rstrip("/") + "/",
            self.config.ingest_path.lstrip("/"),
        )

        req = urllib.request.Request(
            ingest_url,
            method="POST",
            data=body,
            headers={
                "Content-Type": "application/json",
                "X-API-Key": self.config.api_key,
                "User-Agent": self.config.user_agent,
            },
        )

        try:
            ssl_context = None
            if self.config.verify_tls:
                ssl_context = ssl.create_default_context(
                    cafile=self.config.ca_bundle_path or None
                )
            else:
                ssl_context = ssl._create_unverified_context()  # noqa: SLF001

            with urllib.request.urlopen(req, timeout=self.config.timeout, context=ssl_context) as resp:
                status = getattr(resp, "status", 200)
                if status >= 400:
                    raise RuntimeError(f"API Lens ingest returned status={status}")
        except urllib.error.HTTPError as exc:
            if 400 <= exc.code < 500 and exc.code != 429:
                raise RuntimeError(f"Non-retryable ingest error status={exc.code}") from exc
            raise RuntimeError(f"Retryable ingest error status={exc.code}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Ingest network error: {exc}") from exc
