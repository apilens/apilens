from __future__ import annotations

from typing import Any, Callable

from .client import ApiLensClient
from .client._routes import starlette_route_template
from .client.middleware import ApiLensASGIMiddleware, set_consumer, track_consumer


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
    get_consumer: Callable[..., Any] | None = None,
):
    """Starlette integration via ASGI middleware."""
    app.add_middleware(
        ApiLensASGIMiddleware,
        client=client,
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
        get_consumer=get_consumer,
        route_resolver=starlette_route_template,
    )
    return app


__all__ = ["instrument_app", "track_consumer", "set_consumer"]
