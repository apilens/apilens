from __future__ import annotations

from typing import Any, Callable

from .client import ApiLensClient
from .client.middleware import set_consumer, track_consumer
from .frameworks.flask import instrument_flask


def instrument_app(
    app,
    client: ApiLensClient,
    *,
    project_slug: str = "",
    app_id: str = "",
    environment: str | None = None,
    capture_spans: bool = True,
    service_name: str = "",
    redact_query_params: list[str] | None = None,
    redact_headers: list[str] | None = None,
    redact_body_fields: list[str] | None = None,
    mask_request_body: Callable[[Any, bytes], bytes | None] | None = None,
    mask_response_body: Callable[[Any, bytes], bytes | None] | None = None,
    exclude_paths: list[str] | None = None,
    exclude_user_agents: list[str] | None = None,
    default_exclusions: bool = True,
    get_consumer: Callable[..., Any] | None = None,
    flush_on_shutdown: bool = True,
    shutdown_timeout: float = 5.0,
):
    """Compatibility wrapper: prefer apilens.frameworks.flask.instrument_flask."""
    return instrument_flask(
        app,
        client,
        project_slug=project_slug,
        app_id=app_id,
        environment=environment,
        capture_spans=capture_spans,
        service_name=service_name,
        redact_query_params=redact_query_params,
        redact_headers=redact_headers,
        redact_body_fields=redact_body_fields,
        mask_request_body=mask_request_body,
        mask_response_body=mask_response_body,
        exclude_paths=exclude_paths,
        exclude_user_agents=exclude_user_agents,
        default_exclusions=default_exclusions,
        get_consumer=get_consumer,
        flush_on_shutdown=flush_on_shutdown,
        shutdown_timeout=shutdown_timeout,
    )


__all__ = ["instrument_app", "track_consumer", "set_consumer"]
