"""Logging integration: ship ERROR log records (and logged exceptions) to APILens.

Handled exceptions an app logs (``logger.exception(...)``) never reach the
middleware, so :class:`ApiLensHandler` picks them up from the ``logging``
module. The middlewares install one on the root logger at level ERROR when
they start (``capture_logs="errors"``, the default; ``"off"`` disables it).

* A record with ``exc_info`` becomes an ``apilens.exception`` log with the
  full exception payload (qualified type, every frame and chained cause,
  head+tail capped, see :mod:`._exception`).
* Any other record becomes a plain ERROR (or CRITICAL) log.
* Inside a request the log carries the request's ``trace_id`` (and its span
  id when spans are captured), read from contextvars; outside one it is
  still shipped, with no trace id.
* Records from the SDK's own ``apilens`` loggers are ignored, and a record
  logged while the handler is already emitting is dropped, so the handler
  never recurses.
* An exception the middleware already reports for a failing request is not
  shipped twice (frameworks and servers log it again after the fact).
"""

from __future__ import annotations

import contextvars
import logging
import threading
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Literal

from ._exception import MAX_EXCEPTION_MESSAGE, describe_exception, truncate_head_tail
from .models import LogRecord
from .spans import exception_reported, mark_exception_reported
from .trace import current_span_id, current_trace_id

if TYPE_CHECKING:
    from .client import ApiLensClient

CaptureLogs = Literal["errors", "off"]

CAPTURE_LOGS_MODES = ("errors", "off")

_SDK_LOGGER = "apilens"

# Set while this context is inside ``emit`` (recursion guard).
_emitting: contextvars.ContextVar[bool] = contextvars.ContextVar("apilens_log_emitting", default=False)


def normalize_capture_logs(value: object, *, name: str = "capture_logs") -> str:
    """``"errors"`` / ``"off"`` (booleans map to ``"errors"`` / ``"off"``)."""
    if value is True:
        return "errors"
    if value is False or value is None:
        return "off"
    raw = str(value).strip().lower()
    if raw in CAPTURE_LOGS_MODES:
        return raw
    if raw in {"1", "true", "yes", "on"}:
        return "errors"
    if raw in {"0", "false", "no", "none", "disabled"}:
        return "off"
    raise ValueError(f"{name}: expected one of {', '.join(CAPTURE_LOGS_MODES)}, got {value!r}")


def _is_sdk_logger(name: str) -> bool:
    return name == _SDK_LOGGER or name.startswith(_SDK_LOGGER + ".")


class ApiLensHandler(logging.Handler):
    """``logging.Handler`` that ships ERROR records to APILens ``/v1/logs``.

    Usually installed for you by the middleware; to attach it by hand::

        logging.getLogger().addHandler(ApiLensHandler(client, app_id="orders"))
    """

    def __init__(
        self,
        client: ApiLensClient,
        *,
        app_id: str = "",
        environment: str | None = None,
        link_spans: bool = True,
        level: int = logging.ERROR,
    ) -> None:
        super().__init__(level=level)
        self.client = client
        self.app_id = app_id
        self.environment = environment
        # The span id is only linked when the request's server span is
        # captured; otherwise the log carries the trace id alone.
        self.link_spans = link_spans

    def emit(self, record: logging.LogRecord) -> None:
        if _is_sdk_logger(record.name) or _emitting.get():
            return
        token = _emitting.set(True)
        try:
            log = self._build(record)
            if log is not None:
                self.client.capture_log(log)
        except Exception:
            # Never raise into the application's logging call.
            pass
        finally:
            _emitting.reset(token)

    def _build(self, record: logging.LogRecord) -> LogRecord | None:
        exc = None
        if record.exc_info and isinstance(record.exc_info, tuple):
            exc = record.exc_info[1]
        if exc is not None and exception_reported(exc):
            return None
        try:
            text = record.getMessage()
        except Exception:
            text = str(record.msg)
        trace_id = current_trace_id()
        span_id = current_span_id() if trace_id and self.link_spans else ""
        client = self.client
        if exc is not None:
            message, payload, attributes = describe_exception(exc)
            attributes = dict(attributes)
            attributes["log.logger"] = record.name
            if text:
                attributes["log.message"] = truncate_head_tail(text, MAX_EXCEPTION_MESSAGE)
            mark_exception_reported(exc)
            logger_name = "apilens.exception"
        else:
            message, payload, attributes = text, "", None
            logger_name = record.name or "root"
        return LogRecord(
            timestamp=datetime.fromtimestamp(record.created, tz=timezone.utc),
            environment=self.environment or client.config.environment,
            level=(record.levelname or "ERROR").upper(),
            message=truncate_head_tail(message or "", MAX_EXCEPTION_MESSAGE),
            logger_name=logger_name,
            trace_id=trace_id,
            span_id=span_id,
            project_slug=client.config.project_slug,
            app_id=self.app_id,
            payload=payload,
            attributes=attributes,
        )


_installed: ApiLensHandler | None = None
_install_lock = threading.Lock()


def install_log_handler(
    client: ApiLensClient,
    *,
    app_id: str = "",
    environment: str | None = None,
    link_spans: bool = True,
) -> ApiLensHandler:
    """Attach the process-wide :class:`ApiLensHandler` to the root logger at
    level ERROR (idempotent: a later call retargets the same handler)."""
    global _installed
    with _install_lock:
        handler = _installed
        if handler is None:
            handler = ApiLensHandler(client, app_id=app_id, environment=environment, link_spans=link_spans)
            _installed = handler
        else:
            handler.client = client
            handler.app_id = app_id
            handler.environment = environment
            handler.link_spans = link_spans
        root = logging.getLogger()
        if handler not in root.handlers:
            root.addHandler(handler)
        return handler


def uninstall_log_handler() -> None:
    """Remove the handler installed by :func:`install_log_handler`."""
    global _installed
    with _install_lock:
        if _installed is not None:
            logging.getLogger().removeHandler(_installed)
            _installed = None


__all__ = [
    "ApiLensHandler",
    "CaptureLogs",
    "install_log_handler",
    "normalize_capture_logs",
    "uninstall_log_handler",
]
