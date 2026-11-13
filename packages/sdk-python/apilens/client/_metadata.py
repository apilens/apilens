"""App metadata report: ``POST /v1/metadata`` once per process start.

Every middleware (ASGI, WSGI, Django) starts one report when it is built. A
daemon thread waits ``METADATA_DELAY_SECONDS`` (so routes registered after
the middleware are in), lists the app's routes from the framework, and posts:

.. code-block:: json

    {
      "app_id": "orders-api",
      "project_slug": "shop",             // only when configured
      "environment": "production",
      "framework": "fastapi",              // fastapi, starlette, flask, django, litestar, blacksheep
      "framework_version": "0.115.0",
      "python_version": "3.13.1",
      "sdk_version": "0.5.0",
      "routes": [{"method": "GET", "path": "/orders/{order_id}"}],  // at most 2000
      "config": {
        "capture_headers": true,
        "capture_request_body": true,
        "capture_response_body": true,
        "max_payload_bytes": 65536,
        "capture_spans": true,
        "capture_ip": true,
        "anonymize_ip": false,
        "redact_query_params": ["...built-ins", "^card_number$"],
        "redact_headers": ["...built-ins"],
        "redact_body_fields": ["...built-ins", "^ssn$"],
        "default_exclusions": true,
        "exclude_paths": ["...built-ins", "^/internal/"],
        "exclude_user_agents": ["...built-ins"],
        "sample_rate": 1.0,
        "parametrize_paths": true,
        "batch_size": 200,
        "flush_interval": 3.0,
        "max_queue_size": 10000,
        "max_queue_bytes": 67108864,
        "max_batch_bytes": 4194304,
        "max_retries": 3,
        "compress": true,
        "proxy": false,
        "custom_ca": false,
        "verify_tls": true,
        "callbacks": {
          "mask_request_body": false,
          "mask_response_body": false,
          "mask_log_record": false,
          "get_consumer": false,
          "on_stats": false
        }
      }
    }

``config`` is the effective configuration: built-in redaction patterns and
exclusions are listed with the user's, and env overrides
(``APILENS_CAPTURE_IP``, ``APILENS_PARAMETRIZE_PATHS``...) are applied.

Never sent: the API key, the proxy URL (it may hold credentials; only
``proxy: true/false``), the CA bundle path, and anything about callbacks
beyond whether one is set. ``ApiLensClient.send_metadata`` also drops any key
naming an API key, at any depth, before posting.
"""

from __future__ import annotations

import platform
import threading
from collections.abc import Callable
from importlib import metadata as importlib_metadata
from typing import Any

from .._version import __version__
from ._capture import env_anonymize_ip_enabled, env_capture_ip_enabled
from ._routes import (
    cap_routes,
    find_app,
    framework_of,
    list_app_routes,
    list_django_routes,
    parametrize_enabled,
)

# ASGI apps whose routes cannot be found by walking the middleware chain
# (Litestar applies app middleware per route) are learnt from the first
# request's ``scope["app"]``; the report waits at most this long for one.
APP_WAIT_SECONDS = 30.0

# Distribution names whose version is reported, by framework.
_DISTRIBUTIONS = {"django": "Django", "flask": "Flask"}


def framework_version(framework: str) -> str:
    """Installed version of ``framework`` ("" when unknown)."""
    if not framework:
        return ""
    try:
        return importlib_metadata.version(_DISTRIBUTIONS.get(framework, framework))
    except Exception:
        return ""


def _patterns(compiled: Any) -> list[str]:
    return [p.pattern for p in compiled or ()]


def effective_config(mw: Any) -> dict[str, Any]:
    """The capture config ``mw`` (an ASGI, WSGI or Django middleware) runs
    with. Booleans only for callbacks; no secrets."""
    cfg = mw.client.config
    capture_bodies = bool(getattr(mw, "capture_payloads", True))
    redactor = getattr(mw, "redactor", None)
    redact = getattr(redactor, "patterns", None) or {}
    excluder = getattr(mw, "excluder", None)
    sampler = getattr(mw, "sampler", None)
    return {
        "capture_headers": bool(getattr(mw, "capture_headers", True)),
        "capture_request_body": capture_bodies and bool(getattr(mw, "log_request_body", True)),
        "capture_response_body": capture_bodies and bool(getattr(mw, "log_response_body", True)),
        "max_payload_bytes": int(getattr(mw, "max_payload_bytes", 0)),
        "capture_spans": bool(getattr(mw, "capture_spans", False)),
        "capture_ip": bool(getattr(cfg, "capture_ip", True)) and env_capture_ip_enabled(),
        "anonymize_ip": bool(getattr(cfg, "anonymize_ip", False)) or env_anonymize_ip_enabled(),
        "redact_query_params": list(redact.get("query_params", ())),
        "redact_headers": list(redact.get("headers", ())),
        "redact_body_fields": list(redact.get("body_fields", ())),
        "default_exclusions": bool(getattr(excluder, "default_exclusions", False)),
        "exclude_paths": _patterns(getattr(excluder, "default_paths", ()))
        + _patterns(getattr(getattr(excluder, "paths", None), "patterns", ())),
        "exclude_user_agents": _patterns(getattr(excluder, "user_agents", ())),
        "sample_rate": float(getattr(sampler, "rate", 1.0)),
        "parametrize_paths": bool(getattr(mw, "parametrize_paths", True)) and parametrize_enabled(),
        "batch_size": cfg.batch_size,
        "flush_interval": cfg.flush_interval,
        "max_queue_size": cfg.max_queue_size,
        "max_queue_bytes": cfg.max_queue_bytes,
        "max_batch_bytes": cfg.max_batch_bytes,
        "max_retries": cfg.max_retries,
        "compress": bool(cfg.compress),
        "proxy": bool(cfg.proxy_url),
        "custom_ca": bool(cfg.ca_bundle_path),
        "verify_tls": bool(cfg.verify_tls),
        "callbacks": {
            "mask_request_body": getattr(mw, "mask_request_body", None) is not None,
            "mask_response_body": getattr(mw, "mask_response_body", None) is not None,
            "mask_log_record": getattr(cfg, "mask_log_record", None) is not None,
            "get_consumer": getattr(mw, "get_consumer", None) is not None,
            "on_stats": getattr(cfg, "on_stats", None) is not None,
        },
    }


def _environment(mw: Any) -> str:
    return getattr(mw, "environment", None) or mw.client.config.environment


def build_payload(
    mw: Any, *, framework: str, routes: list[dict[str, str]], config: dict[str, Any]
) -> dict[str, Any]:
    """The ``POST /v1/metadata`` body (see the module docstring)."""
    payload: dict[str, Any] = {
        "app_id": mw.app_id,
        "environment": _environment(mw),
        "framework": framework,
        "framework_version": framework_version(framework),
        "python_version": platform.python_version(),
        "sdk_version": __version__,
        "routes": cap_routes(routes),
        "config": config,
    }
    project_slug = getattr(mw, "project_slug", "") or mw.client.config.project_slug
    if project_slug:
        payload["project_slug"] = project_slug
    return payload


def start_metadata(mw: Any, discover: Callable[[], tuple[str, list[dict[str, str]]]]) -> bool:
    """Start the report for ``mw`` unless this process already sent one for
    its app and environment. ``discover`` runs on the report thread and
    returns ``(framework, routes)``. Never raises."""
    client = getattr(mw, "client", None)
    report = getattr(client, "report_metadata", None)
    # An empty app_id is sent as-is: the server files it under the default app.
    app_id = getattr(mw, "app_id", "") or ""
    if not callable(report):
        return False
    try:
        config = effective_config(mw)

        def build() -> dict[str, Any]:
            framework, routes = discover()
            return build_payload(mw, framework=framework, routes=routes, config=config)

        return bool(report(build, app_id=app_id, environment=_environment(mw)))
    except Exception:
        return False


class AppHint:
    """The first ASGI request's ``scope["app"]``, shared by the middleware
    instances of one app (Litestar builds one per route)."""

    __slots__ = ("app", "event")

    def __init__(self) -> None:
        self.app: Any = None
        self.event = threading.Event()

    @property
    def waiting(self) -> bool:
        return not self.event.is_set()

    def note(self, app: Any) -> None:
        if app is not None and self.app is None:
            self.app = app
        self.event.set()


_hints: dict[tuple[str, str, str], AppHint] = {}
_hints_lock = threading.Lock()


def _discovered(app: Any) -> tuple[str, list[dict[str, str]]]:
    if app is None:
        return "", []
    framework = framework_of(app)
    routes_attr = getattr(app, "routes", None)
    # FastAPI's router is a Starlette Router; its FastAPI routes give it away.
    if (
        framework == "starlette"
        and isinstance(routes_attr, (list, tuple))
        and any(type(r).__module__.startswith("fastapi") for r in routes_attr)
    ):
        framework = "fastapi"
    return framework, list_app_routes(app)


def _hint_key(mw: Any) -> tuple[str, str, str]:
    return (mw.client.config.base_url, mw.app_id, _environment(mw))


def start_asgi_metadata(mw: Any) -> AppHint | None:
    """Start the report for an ASGI middleware. Returns the hint its
    ``__call__`` feeds with ``scope["app"]`` while the report may still need
    it, or ``None``. Never raises."""
    try:
        key = _hint_key(mw)
    except Exception:
        return None
    with _hints_lock:
        existing = _hints.get(key)
    if existing is not None:  # another instance of this app started the report
        return existing if existing.waiting else None
    hint = AppHint()

    def discover() -> tuple[str, list[dict[str, str]]]:
        try:
            app = hint.app or find_app(mw.app)
            if app is None:
                hint.event.wait(APP_WAIT_SECONDS)
                app = hint.app
            return _discovered(app)
        finally:
            hint.event.set()

    if not start_metadata(mw, discover):
        return None
    with _hints_lock:
        _hints[key] = hint
    return hint


def start_wsgi_metadata(mw: Any) -> bool:
    """Start the report for a WSGI middleware (Flask is found through its
    bound ``wsgi_app``)."""
    return start_metadata(mw, lambda: _discovered(find_app(mw.app)))


def start_django_metadata(mw: Any) -> bool:
    """Start the report for the Django middleware (routes from the URLconf)."""
    return start_metadata(mw, lambda: ("django", list_django_routes()))
