from __future__ import annotations

import time
from typing import Any

from .client._capture import CaptureContext, _normalize_path, _to_int, capture_response
from .client._sanitize import decode_utf8_safe, serialize_headers
from .client import ApiLensClient, ApiLensConfig
from .client.middleware import (
    _apply_consumer,
    _consumer_ctx,
    _read_consumer,
    normalize_consumer,
    set_consumer,
    track_consumer,
)

_client_singleton: ApiLensClient | None = None


def _resolve_get_consumer(settings: Any):
    """Read APILENS_GET_CONSUMER from settings; accept a callable or dotted path."""
    target = getattr(settings, "APILENS_GET_CONSUMER", None)
    if target is None:
        return None
    if callable(target):
        return target
    if isinstance(target, str):
        try:
            from django.utils.module_loading import import_string

            return import_string(target)
        except Exception:
            return None
    return None



def _get_client_from_settings() -> ApiLensClient:
    global _client_singleton
    if _client_singleton is not None:
        return _client_singleton

    try:
        from django.conf import settings
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("Django settings are not available") from exc

    api_key = getattr(settings, "APILENS_API_KEY", "")
    if not api_key:
        raise RuntimeError("APILENS_API_KEY is required in Django settings")
    # Optional: the project-level API key identifies the project server-side.
    project_slug = getattr(settings, "APILENS_PROJECT_SLUG", "")

    cfg = ApiLensConfig(
        api_key=api_key,
        project_slug=project_slug,
        base_url=getattr(settings, "APILENS_BASE_URL", "https://ingest.apilens.ai/v1"),
        environment=getattr(settings, "APILENS_ENVIRONMENT", "production"),
        batch_size=int(getattr(settings, "APILENS_BATCH_SIZE", 200)),
        flush_interval=float(getattr(settings, "APILENS_FLUSH_INTERVAL", 3.0)),
    )
    _client_singleton = ApiLensClient(cfg)
    return _client_singleton


class ApiLensDjangoMiddleware:
    """Django middleware for DRF + Django Ninja.

    **Setup** — add to ``MIDDLEWARE`` and two required settings::

        # settings.py
        MIDDLEWARE = [
            # ... other middleware ...
            "apilens.django.ApiLensDjangoMiddleware",
        ]
        APILENS_API_KEY = "apilens_xxx"   # project-level key from the dashboard
        APILENS_APP_ID  = "my-django-app" # slug of the app being instrumented

    **Identifying consumers** — two options:

    Option A — ``APILENS_GET_CONSUMER`` setting (runs centrally on every
    request; accepts a callable or its dotted import path)::

        # settings.py
        def get_consumer(request):
            if request.user.is_authenticated:
                return {
                    "identifier": request.user.email,       # required: stable id
                    "name": request.user.get_full_name(),    # optional
                    "group": getattr(request.user, "role", ""),  # optional
                }
            return None

        APILENS_GET_CONSUMER = get_consumer
        # or use the dotted path:
        # APILENS_GET_CONSUMER = "myapp.consumers.get_consumer"

    Option B — call :func:`set_consumer` directly from a view or DRF
    serializer (an explicit call always wins over the setting)::

        from apilens.django import set_consumer

        def my_view(request):
            if request.user.is_authenticated:
                set_consumer(
                    request,
                    identifier=request.user.email,
                    name=request.user.get_full_name(),
                )
            ...
    """

    def __init__(self, get_response):
        from django.conf import settings

        self.get_response = get_response
        self.client = _get_client_from_settings()
        self.project_slug = getattr(settings, "APILENS_PROJECT_SLUG", "")
        self.app_id = getattr(settings, "APILENS_APP_ID", "")
        if not self.app_id:
            raise RuntimeError("APILENS_APP_ID is required in Django settings")
        self.max_payload_bytes = int(getattr(settings, "APILENS_MAX_PAYLOAD_BYTES", 65536))
        self.capture_headers = bool(getattr(settings, "APILENS_CAPTURE_HEADERS", True))
        # Optional resolver, e.g. APILENS_GET_CONSUMER = lambda request: request.user.username
        # Nothing is inferred automatically; it only runs the resolver you provide.
        self.get_consumer = _resolve_get_consumer(settings)

    def __call__(self, request):
        started_at = time.perf_counter()
        response = None
        status_code = 500
        response_size = 0
        consumer_token = _consumer_ctx.set(None)

        xff = (request.META.get("HTTP_X_FORWARDED_FOR") or "").strip()
        if xff:
            ip_address = xff.split(",", 1)[0].strip()
        else:
            ip_address = (request.META.get("HTTP_X_REAL_IP") or "").strip() or (request.META.get("REMOTE_ADDR") or "")

        try:
            base_url = f"{request.scheme}://{request.get_host()}"
        except Exception:
            base_url = ""

        ctx = CaptureContext(
            method=(request.method or "GET").upper(),
            path=_normalize_path(getattr(request, "path", "/") or "/"),
            project_slug=self.project_slug or self.client.config.project_slug,
            app_id=self.app_id,
            request_size=_to_int(request.META.get("CONTENT_LENGTH"), 0),
            ip_address=ip_address,
            user_agent=(request.META.get("HTTP_USER_AGENT") or "").strip(),
            base_url=base_url,
        )
        if self.capture_headers:
            try:
                ctx.request_headers = serialize_headers(dict(request.headers.items()))
            except Exception:
                ctx.request_headers = ""
        try:
            body = request.body[: self.max_payload_bytes]
            ctx.request_payload = decode_utf8_safe(body)
        except Exception:
            ctx.request_payload = ""

        response_headers = ""
        try:
            response = self.get_response(request)
            status_code = int(getattr(response, "status_code", 500) or 500)
            content = getattr(response, "content", b"") or b""
            response_size = len(content)
            response_payload = decode_utf8_safe(content[: self.max_payload_bytes])
            if self.capture_headers:
                try:
                    response_headers = serialize_headers(dict(response.items()))
                except Exception:
                    response_headers = ""
            return response
        finally:
            consumer = dict(_read_consumer(request))
            if self.get_consumer is not None and not consumer.get("consumer_id"):
                try:
                    resolved = self.get_consumer(request)
                except Exception:
                    resolved = None
                if resolved is not None:
                    consumer = normalize_consumer(resolved)
            _apply_consumer(ctx, consumer)
            _consumer_ctx.reset(consumer_token)
            capture_response(
                self.client,
                ctx,
                status_code=status_code,
                response_size=response_size,
                started_at=started_at,
                response_payload=locals().get("response_payload", ""),
                response_headers=response_headers,
            )


def instrument_app(app: Any, client: ApiLensClient | None = None, *, environment: str | None = None) -> Any:
    """Optional helper to install Django middleware programmatically.

    Usually prefer adding `apilens.django.ApiLensDjangoMiddleware` to MIDDLEWARE.
    """
    # Programmatic install is intentionally lightweight; framework users should
    # configure middleware in settings for deterministic ordering.
    return app


__all__ = [
    "ApiLensDjangoMiddleware",
    "instrument_app",
    "track_consumer",
    "set_consumer",
]
