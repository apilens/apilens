from __future__ import annotations

import time
from typing import Any

from .client._capture import CaptureContext, _normalize_path, _to_int, capture_response
from .client import ApiLensClient, ApiLensConfig

_client_singleton: ApiLensClient | None = None



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
    project_slug = getattr(settings, "APILENS_PROJECT_SLUG", "")
    if not project_slug:
        raise RuntimeError("APILENS_PROJECT_SLUG is required in Django settings")

    cfg = ApiLensConfig(
        api_key=api_key,
        project_slug=project_slug,
        base_url=getattr(settings, "APILENS_BASE_URL", "https://api.apilens.ai/api/v1"),
        environment=getattr(settings, "APILENS_ENVIRONMENT", "production"),
        batch_size=int(getattr(settings, "APILENS_BATCH_SIZE", 200)),
        flush_interval=float(getattr(settings, "APILENS_FLUSH_INTERVAL", 3.0)),
    )
    _client_singleton = ApiLensClient(cfg)
    return _client_singleton


class ApiLensDjangoMiddleware:
    """Django middleware for DRF + Django Ninja."""

    def __init__(self, get_response):
        from django.conf import settings

        self.get_response = get_response
        self.client = _get_client_from_settings()
        self.project_slug = getattr(settings, "APILENS_PROJECT_SLUG", "")
        self.app_id = getattr(settings, "APILENS_APP_ID", "")
        if not self.app_id:
            raise RuntimeError("APILENS_APP_ID is required in Django settings")
        self.max_payload_bytes = 8192

    def __call__(self, request):
        started_at = time.perf_counter()
        response = None
        status_code = 500
        response_size = 0

        xff = (request.META.get("HTTP_X_FORWARDED_FOR") or "").strip()
        if xff:
            ip_address = xff.split(",", 1)[0].strip()
        else:
            ip_address = (request.META.get("HTTP_X_REAL_IP") or "").strip() or (request.META.get("REMOTE_ADDR") or "")

        ctx = CaptureContext(
            method=(request.method or "GET").upper(),
            path=_normalize_path(getattr(request, "path", "/") or "/"),
            project_slug=self.project_slug or self.client.config.project_slug,
            app_id=self.app_id,
            request_size=_to_int(request.META.get("CONTENT_LENGTH"), 0),
            ip_address=ip_address,
            user_agent=(request.META.get("HTTP_USER_AGENT") or "").strip(),
        )
        try:
            body = request.body[: self.max_payload_bytes]
            ctx.request_payload = body.decode("utf-8", errors="replace")
        except Exception:
            ctx.request_payload = ""

        try:
            response = self.get_response(request)
            status_code = int(getattr(response, "status_code", 500) or 500)
            content = getattr(response, "content", b"") or b""
            response_size = len(content)
            response_payload = (content[: self.max_payload_bytes]).decode("utf-8", errors="replace")
            return response
        finally:
            capture_response(
                self.client,
                ctx,
                status_code=status_code,
                response_size=response_size,
                started_at=started_at,
                response_payload=locals().get("response_payload", ""),
            )


def instrument_app(app: Any, client: ApiLensClient | None = None, *, environment: str | None = None) -> Any:
    """Optional helper to install Django middleware programmatically.

    Usually prefer adding `apilens.django.ApiLensDjangoMiddleware` to MIDDLEWARE.
    """
    # Programmatic install is intentionally lightweight; framework users should
    # configure middleware in settings for deterministic ordering.
    return app
