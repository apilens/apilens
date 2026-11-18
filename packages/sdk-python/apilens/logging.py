"""Logging integration: ``apilens.logging.ApiLensHandler``.

The middlewares install the handler on the root logger at level ERROR
(``capture_logs="errors"``, the default; ``"off"`` disables it), so
``logger.exception(...)`` inside a request ships the full exception on the
request's trace. See :mod:`apilens.client.log_handler`.
"""

from __future__ import annotations

from .client.log_handler import (
    ApiLensHandler,
    install_log_handler,
    uninstall_log_handler,
)

__all__ = ["ApiLensHandler", "install_log_handler", "uninstall_log_handler"]
