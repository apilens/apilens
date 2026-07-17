from __future__ import annotations

from typing import Any, Callable

from .client import ApiLensClient, ApiLensConfig
from .client._routes import starlette_route_template
from .client.middleware import ApiLensASGIMiddleware
from .frameworks.fastapi import instrument_fastapi, set_consumer, track_consumer


class ApiLensGatewayMiddleware(ApiLensASGIMiddleware):
    """
    FastAPI middleware with a simple constructor.

    Usage:
        app.add_middleware(
            ApiLensGatewayMiddleware,
            api_key="your_app_api_key",
            project_slug="your-project-slug",
            app_id="your_app_id",
            base_url="https://ingest.apilens.ai/v1",
            env="production",
        )

    PII redaction — regexes matched case-insensitively against NAMES (anchor
    for exact matches); matched values are stored as ``[redacted]``::

        app.add_middleware(
            ApiLensGatewayMiddleware,
            api_key="...", app_id="...",
            redact_query_params=[r"^card_number$", r"token"],
            redact_headers=[r"^x-internal-secret$"],   # on top of built-ins
            redact_body_fields=[r"^password$", r"^ssn$", r"card"],
        )
    """

    def __init__(
        self,
        app,
        *,
        api_key: str | None = None,
        client_id: str | None = None,
        project_slug: str = "",
        app_id: str = "",
        base_url: str = "https://ingest.apilens.ai/v1",
        env: str = "production",
        release: str = "",
        commit: str = "",
        verify_tls: bool = True,
        ca_bundle_path: str = "",
        client: ApiLensClient | None = None,
        enable_request_logging: bool = True,
        log_request_body: bool = True,
        log_response_body: bool = True,
        capture_spans: bool = True,
        service_name: str = "",
        max_payload_bytes: int = 65536,
        redact_query_params: list[str] | None = None,
        redact_headers: list[str] | None = None,
        redact_body_fields: list[str] | None = None,
        get_consumer: Callable[..., Any] | None = None,
    ) -> None:
        resolved_key = (api_key or client_id or "").strip()
        resolved_project_slug = project_slug.strip()
        if client is None:
            if not resolved_key:
                raise ValueError("api_key (or client_id) is required")
            # project_slug is optional: the project-level key identifies it.
            client = ApiLensClient(
                ApiLensConfig(
                    api_key=resolved_key,
                    project_slug=resolved_project_slug,
                    base_url=base_url,
                    environment=env,
                    release=release,
                    commit=commit,
                    verify_tls=verify_tls,
                    ca_bundle_path=ca_bundle_path,
                )
            )

        # Keep strong reference for the app lifecycle.
        self.apilens_client = client
        super().__init__(
            app,
            client=client,
            project_slug=resolved_project_slug or client.config.project_slug,
            app_id=app_id,
            environment=env,
            enable_request_logging=enable_request_logging,
            log_request_body=log_request_body,
            log_response_body=log_response_body,
            capture_spans=capture_spans,
            service_name=service_name,
            max_payload_bytes=max_payload_bytes,
            redact_query_params=redact_query_params,
            redact_headers=redact_headers,
            redact_body_fields=redact_body_fields,
            get_consumer=get_consumer,
            route_resolver=starlette_route_template,
        )


class ApiLensMiddleware(ApiLensGatewayMiddleware):
    """Backward-compatible alias for ApiLensGatewayMiddleware."""


def instrument_app(
    app,
    client: ApiLensClient,
    *,
    project_slug: str = "",
    app_id: str = "",
    environment: str | None = None,
    enable_request_logging: bool = True,
    log_request_body: bool = True,
    log_response_body: bool = True,
    capture_spans: bool = True,
    service_name: str = "",
    max_payload_bytes: int = 65536,
):
    """Compatibility wrapper: prefer apilens.frameworks.fastapi.instrument_fastapi."""
    return instrument_fastapi(
        app,
        client,
        project_slug=project_slug,
        app_id=app_id,
        environment=environment,
        enable_request_logging=enable_request_logging,
        log_request_body=log_request_body,
        log_response_body=log_response_body,
        capture_spans=capture_spans,
        service_name=service_name,
        max_payload_bytes=max_payload_bytes,
    )


__all__ = [
    "ApiLensGatewayMiddleware",
    "ApiLensMiddleware",
    "instrument_app",
    "track_consumer",
    "set_consumer",
]
