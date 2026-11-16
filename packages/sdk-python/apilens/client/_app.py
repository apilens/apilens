"""Which app the captured data belongs to.

``app_id`` is optional. The middlewares resolve it in this order:

1. the ``app_id`` passed in code (or the Django ``APILENS_APP_ID`` setting);
2. env ``APILENS_APP_ID``;
3. env ``OTEL_SERVICE_NAME``;
4. nothing: records carry an empty ``app_id`` and the server files them under
   the project's default app.

Any free-form name works ("Orders API", "orders-api"): the server normalizes it
to a slug and creates apps it has not seen, so nothing is validated here.
The choice is logged once per process at INFO on the ``apilens`` logger.
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Mapping

logger = logging.getLogger("apilens")

APP_ID_ENV = "APILENS_APP_ID"
OTEL_SERVICE_NAME_ENV = "OTEL_SERVICE_NAME"
#: Source label for a value passed in code.
SOURCE_CONFIG = "app_id"

_logged: set[tuple[str, str]] = set()
_logged_lock = threading.Lock()


def resolve_app_id(
    app_id: str | None = "", environ: Mapping[str, str] | None = None
) -> tuple[str, str]:
    """``(name, source)`` for the app; ``("", "")`` when none is configured.

    ``app_id`` is the value the constructor ended up with; ``env_defaults``
    may already have filled it from ``APILENS_APP_ID``, in which case the
    source is reported as that variable.
    """
    source_env = os.environ if environ is None else environ
    name = (app_id or "").strip()
    env_value = (source_env.get(APP_ID_ENV) or "").strip()
    if name:
        return name, (APP_ID_ENV if name == env_value else SOURCE_CONFIG)
    if env_value:
        return env_value, APP_ID_ENV
    otel = (source_env.get(OTEL_SERVICE_NAME_ENV) or "").strip()
    if otel:
        return otel, OTEL_SERVICE_NAME_ENV
    return "", ""


def describe_app_choice(name: str, source: str) -> str:
    """The startup log line for a resolved app."""
    if not name:
        return (
            "APILens: no app name configured; data goes to the project's default app "
            "(set app_id, APILENS_APP_ID or OTEL_SERVICE_NAME)"
        )
    return f'APILens: app "{name}" (from {source})'


def log_app_choice(name: str, source: str) -> None:
    """Log :func:`describe_app_choice` once per process per (name, source)."""
    key = (name, source)
    with _logged_lock:
        if key in _logged:
            return
        _logged.add(key)
    logger.info(describe_app_choice(name, source))


def resolve_and_log_app_id(app_id: str | None = "", *, source: str | None = None) -> str:
    """Resolve the app (see :func:`resolve_app_id`), log the choice once and
    return the name ("" when omitted). ``source`` overrides the label of a
    value passed in (e.g. a Django setting)."""
    name, resolved_source = resolve_app_id(app_id)
    if source and name and (app_id or "").strip() == name:
        resolved_source = source
    log_app_choice(name, resolved_source)
    return name


def _reset_for_tests() -> None:
    with _logged_lock:
        _logged.clear()


__all__ = [
    "APP_ID_ENV",
    "OTEL_SERVICE_NAME_ENV",
    "describe_app_choice",
    "log_app_choice",
    "resolve_and_log_app_id",
    "resolve_app_id",
]
