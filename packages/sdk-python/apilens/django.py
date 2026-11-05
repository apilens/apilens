from __future__ import annotations

import time
from dataclasses import replace
from typing import Any

from .client._attributes import (
    begin_request_attributes,
    current_request_attributes,
    end_request_attributes,
    set_request_attribute,
    span_attributes,
)
from .client._env import load_env_config
from .client._capture import CaptureContext, _normalize_path, _to_int, capture_response
from .client._exclusions import RequestExcluder
from .client._metadata import start_django_metadata
from .client._routes import django_route_template, resolve_endpoint_path
from .client._sampling import DetailSampler
from .client._sanitize import (
    ContentTypeFilter,
    Redactor,
    RequestInfo,
    ResponseInfo,
    capture_body,
    lower_headers,
    serialize_headers,
)
from .client import ApiLensClient, ApiLensConfig
from .client.middleware import (
    _apply_consumer,
    _consumer_ctx,
    _maybe_record_error,
    _read_consumer,
    normalize_consumer,
    set_consumer,
    track_consumer,
)
from .client._shutdown import DEFAULT_SHUTDOWN_TIMEOUT, env_flush_on_shutdown, register_atexit
from .client._validation import MAX_VALIDATION_BODY_BYTES, parse_validation_errors
from .client.spans import configure_spans, env_spans_enabled, record_span
from .client.trace import (
    begin_request_trace,
    end_request_trace,
    reset_detail_sampled,
    set_detail_sampled,
)

_client_singleton: ApiLensClient | None = None

_MISSING = object()


def _setting(settings: Any, name: str, default: Any = None, env: dict[str, Any] | None = None) -> Any:
    """``APILENS_<NAME>``: the Django setting when defined, else the env var of
    the same name (parsed by ``load_env_config``), else ``default``."""
    value = getattr(settings, f"APILENS_{name}", _MISSING)
    if value is not _MISSING:
        return value
    env = load_env_config() if env is None else env
    return env.get(name.lower(), default)


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


def _resolve_body_masker(settings: Any, name: str):
    """Read a body-mask setting; accept a callable or its dotted import path.

    Unlike the consumer resolver this fails loudly: silently ignoring a
    privacy callback that can't be imported would ship unmasked bodies.
    """
    target = getattr(settings, name, None)
    if target is None or target == "":
        return None
    if callable(target):
        return target
    if isinstance(target, str):
        from django.utils.module_loading import import_string

        try:
            fn = import_string(target)
        except ImportError as exc:
            raise RuntimeError(f"{name}: cannot import {target!r}") from exc
        if not callable(fn):
            raise RuntimeError(f"{name}: {target!r} is not callable")
        return fn
    raise RuntimeError(f"{name} must be a callable or a dotted import path")


def _get_client_from_settings() -> ApiLensClient:
    global _client_singleton
    if _client_singleton is not None:
        return _client_singleton

    try:
        from django.conf import settings
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("Django settings are not available") from exc

    env = load_env_config()
    api_key = _setting(settings, "API_KEY", "", env)
    if not api_key:
        raise RuntimeError("APILENS_API_KEY is required (Django setting or environment variable)")
    # Optional: the project-level API key identifies the project server-side.
    project_slug = getattr(settings, "APILENS_PROJECT_SLUG", "")

    cfg = ApiLensConfig(
        api_key=api_key,
        project_slug=project_slug,
        base_url=_setting(settings, "BASE_URL", "https://ingest.apilens.ai/v1", env),
        environment=_setting(settings, "ENVIRONMENT", "production", env),
        release=str(getattr(settings, "APILENS_RELEASE", "") or ""),
        commit=str(getattr(settings, "APILENS_COMMIT", "") or ""),
        batch_size=int(_setting(settings, "BATCH_SIZE", 200, env)),
        flush_interval=float(_setting(settings, "FLUSH_INTERVAL", 3.0, env)),
        enabled=bool(_setting(settings, "ENABLED", True, env)),
        capture_ip=bool(_setting(settings, "CAPTURE_IP", True, env)),
        anonymize_ip=bool(_setting(settings, "ANONYMIZE_IP", False, env)),
        mask_log_record=_resolve_body_masker(settings, "APILENS_MASK_LOG_RECORD"),
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

        # Every APILENS_* setting falls back to the env var of the same name
        # (settings win over env vars, env vars over the defaults).
        env = load_env_config()
        self.get_response = get_response
        self.client = _get_client_from_settings()
        self.project_slug = getattr(settings, "APILENS_PROJECT_SLUG", "")
        self.app_id = _setting(settings, "APP_ID", "", env)
        if not self.app_id:
            raise RuntimeError("APILENS_APP_ID is required (Django setting or environment variable)")
        self.environment = _setting(settings, "ENVIRONMENT", None, env)
        self.max_payload_bytes = max(0, int(_setting(settings, "MAX_PAYLOAD_BYTES", 65536, env)))
        self.capture_headers = bool(_setting(settings, "CAPTURE_HEADERS", True, env))
        # Body capture toggles: APILENS_CAPTURE_PAYLOADS gates both bodies,
        # APILENS_LOG_REQUEST_BODY / APILENS_LOG_RESPONSE_BODY each one.
        self.capture_payloads = bool(_setting(settings, "CAPTURE_PAYLOADS", True, env))
        self.log_request_body = bool(_setting(settings, "LOG_REQUEST_BODY", True, env))
        self.log_response_body = bool(_setting(settings, "LOG_RESPONSE_BODY", True, env))
        # PII redaction — regexes matched (case-insensitive) against query
        # parameter / header / JSON body field names; matched values are stored
        # as ``[redacted]``. Built-in sensitive headers always apply.
        self.redactor = Redactor(
            query_params=list(_setting(settings, "REDACT_QUERY_PARAMS", [], env) or []),
            headers=list(_setting(settings, "REDACT_HEADERS", [], env) or []),
            body_fields=list(_setting(settings, "REDACT_BODY_FIELDS", [], env) or []),
        )
        # Body mask callbacks ``(RequestInfo | ResponseInfo, bytes) -> bytes |
        # None`` (a callable or its dotted path). They run on the truncated raw
        # body before the regex field masking; ``None`` or an exception stores
        # the whole body as ``[masked]``.
        self.mask_request_body = _resolve_body_masker(settings, "APILENS_MASK_REQUEST_BODY")
        self.mask_response_body = _resolve_body_masker(settings, "APILENS_MASK_RESPONSE_BODY")
        # Bodies are captured only for these media types (a list of globs or
        # a comma-separated string; default JSON, ``+json``, ``text/*`` and
        # form-encoded). Any other body (multipart, binary) is never read and
        # is stored as ``[<content-type>, N bytes omitted]``.
        self.content_types = ContentTypeFilter(_setting(settings, "CAPTURE_CONTENT_TYPES", None, env) or None)
        # Paths whose requests bypass capture entirely (health checks, probes).
        # A list of regexes or a comma-separated string; matched
        # case-insensitively against the path without query string. The
        # APILENS_EXCLUDE_PATHS env var adds to the setting.
        # APILENS_EXCLUDE_USER_AGENTS does the same for the User-Agent header.
        # Built-in health/probe exclusions apply first unless
        # APILENS_DEFAULT_EXCLUSIONS = False.
        self.excluder = RequestExcluder(
            getattr(settings, "APILENS_EXCLUDE_PATHS", None) or None,
            getattr(settings, "APILENS_EXCLUDE_USER_AGENTS", None) or None,
            default_exclusions=bool(_setting(settings, "DEFAULT_EXCLUSIONS", True, env)),
        )
        # APILENS_SAMPLE_RATE (0.0-1.0): fraction of requests whose detail is
        # kept. Sampled-out requests still send the base record (metrics stay
        # exact) with no headers, bodies, spans or error log.
        self.sampler = DetailSampler(_setting(settings, "SAMPLE_RATE", 1.0, env))
        # Heuristic path parametrization when the URL resolver gives no route
        # (env APILENS_PARAMETRIZE_PATHS wins over this setting).
        self.parametrize_paths = bool(getattr(settings, "APILENS_PARAMETRIZE_PATHS", True))
        # Optional resolver, e.g. APILENS_GET_CONSUMER = lambda request: request.user.username
        # Nothing is inferred automatically; it only runs the resolver you provide.
        self.get_consumer = _resolve_get_consumer(settings)
        # APILENS_CAPTURE_SPANS also works as an env kill-switch (env wins over the setting).
        self.capture_spans = bool(_setting(settings, "CAPTURE_SPANS", True, env)) and env_spans_enabled()
        if self.capture_spans:
            configure_spans(
                self.client,
                app_id=self.app_id,
                environment=self.environment,
                service_name=getattr(settings, "APILENS_SERVICE_NAME", "") or self.app_id,
            )
        # Graceful shutdown: Django has no lifespan hook (and request_finished
        # never fires for the last batch), so flush from ``atexit`` — gunicorn
        # / uwsgi / runserver workers exit normally on SIGTERM. Bounded by
        # APILENS_SHUTDOWN_TIMEOUT seconds; APILENS_FLUSH_ON_SHUTDOWN = False
        # (setting or env var) turns it off.
        self.shutdown_timeout = float(getattr(settings, "APILENS_SHUTDOWN_TIMEOUT", DEFAULT_SHUTDOWN_TIMEOUT))
        self.flush_on_shutdown = (
            bool(getattr(settings, "APILENS_FLUSH_ON_SHUTDOWN", True)) and env_flush_on_shutdown()
        )
        if self.flush_on_shutdown:
            register_atexit(self.client, self.shutdown_timeout)
        # App metadata (POST /v1/metadata): framework, versions, URLconf route
        # templates and the effective config, once per process, off-thread.
        start_django_metadata(self)

    def process_exception(self, request, exception):
        """Django calls this when a view raises — stash it so ``__call__``'s
        finally can log the exception (with traceback) against the trace."""
        try:
            setattr(request, "_apilens_exc", exception)
        except Exception:
            pass
        return None

    def __call__(self, request):
        user_agent = request.META.get("HTTP_USER_AGENT") if self.excluder.checks_user_agent else None
        if self.excluder.matches(getattr(request, "path", "/"), user_agent):
            return self.get_response(request)
        started_at = time.perf_counter()
        response = None
        status_code = 500
        response_size = 0
        consumer_token = _consumer_ctx.set(None)
        attributes_token = begin_request_attributes()
        trace_id, span_id, parent_span_id, trace_token = begin_request_trace(request.META.get("HTTP_TRACEPARENT"))
        # Sampled out: base record only. Trace context above still propagates.
        sampled = self.sampler.sample()
        sampled_token = set_detail_sampled(sampled)
        capture_headers = self.capture_headers and sampled

        xff = (request.META.get("HTTP_X_FORWARDED_FOR") or "").strip()
        if xff:
            ip_address = xff.split(",", 1)[0].strip()
        else:
            ip_address = (request.META.get("HTTP_X_REAL_IP") or "").strip() or (request.META.get("REMOTE_ADDR") or "")

        try:
            base_url = f"{request.scheme}://{request.get_host()}"
        except Exception:
            base_url = ""

        clean_path = _normalize_path(getattr(request, "path", "/") or "/")
        # raw_path keeps the exact URL incl. query string (with any matching
        # parameter values redacted); clean_path drives template resolution.
        query = request.META.get("QUERY_STRING") or ""
        raw_path = f"{clean_path}?{self.redactor.redact_query(query)}" if query else clean_path
        ctx = CaptureContext(
            method=(request.method or "GET").upper(),
            path=clean_path,
            raw_path=raw_path,
            project_slug=self.project_slug or self.client.config.project_slug,
            app_id=self.app_id,
            request_size=_to_int(request.META.get("CONTENT_LENGTH"), 0),
            ip_address=ip_address,
            user_agent=(request.META.get("HTTP_USER_AGENT") or "").strip(),
            base_url=base_url,
            trace_id=trace_id,
            span_id=span_id,
            sampled=sampled,
        )
        try:
            request_headers = dict(request.headers.items())
        except Exception:
            request_headers = {}
        if capture_headers:
            try:
                ctx.request_headers = serialize_headers(request_headers, redactor=self.redactor)
            except Exception:
                ctx.request_headers = ""
        # Read now (before the view consumes the stream); masked after the
        # view ran, so the mask callback sees ``set_request_attribute`` values.
        request_body = b""
        request_content_type = request.META.get("CONTENT_TYPE") or ""
        capture_bodies = sampled and self.max_payload_bytes > 0 and self.capture_payloads
        capture_request_body = capture_bodies and self.log_request_body
        capture_response_body = capture_bodies and self.log_response_body
        if capture_request_body and self.content_types.allows(request_content_type):
            try:
                request_body = request.body[: self.max_payload_bytes]
            except Exception:
                request_body = b""
        request_info = RequestInfo(
            method=ctx.method, path=clean_path, raw_path=raw_path, headers=lower_headers(request_headers)
        )

        response_headers = ""
        attributes: dict = {}
        try:
            response = self.get_response(request)
            attributes = current_request_attributes()
            request_info = replace(request_info, attributes=attributes)
            status_code = int(getattr(response, "status_code", 500) or 500)
            content = getattr(response, "content", b"") or b""
            response_size = len(content)
            try:
                response_header_map = dict(response.items())
            except Exception:
                response_header_map = {}
            # Django Ninja's 422 field errors, parsed whether or not the body
            # itself is captured or the request's detail was sampled out.
            ctx.validation_errors = parse_validation_errors(
                status_code,
                content[:MAX_VALIDATION_BODY_BYTES],
                lower_headers(response_header_map).get("content-type"),
                self.redactor,
            )
            response_info = ResponseInfo(
                request=request_info,
                status_code=status_code,
                headers=lower_headers(response_header_map),
                attributes=attributes,
            )
            response_payload = (
                capture_body(
                    content[: self.max_payload_bytes],
                    size=response_size,
                    content_type=response_info.content_type,
                    content_types=self.content_types,
                    redactor=self.redactor,
                    masker=self.mask_response_body,
                    info=response_info,
                )
                if capture_response_body
                else ""
            )
            if capture_headers:
                try:
                    response_headers = serialize_headers(dict(response.items()), redactor=self.redactor)
                except Exception:
                    response_headers = ""
            return response
        finally:
            # resolver_match is populated once the request has been routed, so
            # group under the URLconf route template; raw_path keeps the URL.
            ctx.path = resolve_endpoint_path(
                django_route_template(request), clean_path, self.parametrize_paths
            )
            consumer = dict(_read_consumer(request))
            if self.get_consumer is not None and not consumer.get("consumer_id"):
                try:
                    resolved = self.get_consumer(request)
                except Exception:
                    resolved = None
                if resolved is not None:
                    consumer = normalize_consumer(resolved)
            _apply_consumer(ctx, consumer)
            if response is None:
                # The view raised: collect what it set before failing.
                attributes = current_request_attributes()
                request_info = replace(request_info, attributes=attributes)
            ctx.attributes = attributes
            try:
                ctx.request_payload = (
                    capture_body(
                        request_body,
                        size=max(len(request_body), ctx.request_size),
                        content_type=request_content_type,
                        content_types=self.content_types,
                        redactor=self.redactor,
                        masker=self.mask_request_body,
                        info=request_info,
                    )
                    if capture_request_body
                    else ""
                )
            except Exception:
                ctx.request_payload = ""
            _consumer_ctx.reset(consumer_token)
            end_request_attributes(attributes_token)
            reset_detail_sampled(sampled_token)
            end_request_trace(trace_token)
            captured_exc = getattr(request, "_apilens_exc", None)
            if self.capture_spans and sampled:
                is_error = captured_exc is not None or status_code >= 500
                record_span(
                    name=f"{ctx.method} {ctx.path}",
                    kind="server",
                    trace_id=trace_id,
                    span_id=span_id,
                    parent_span_id=parent_span_id,
                    duration_ms=(time.perf_counter() - started_at) * 1000.0,
                    status="error" if is_error else "ok",
                    status_code=status_code,
                    attributes=span_attributes(attributes),
                )
                _maybe_record_error(
                    exc=captured_exc,
                    status_code=status_code,
                    trace_id=trace_id,
                    span_id=span_id,
                    method=ctx.method,
                    path=ctx.path,
                    consumer=consumer,
                )
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
    "set_request_attribute",
]
