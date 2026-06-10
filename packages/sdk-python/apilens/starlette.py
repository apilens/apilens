from __future__ import annotations

from typing import Any, Callable

from .client import ApiLensClient
from .client.middleware import ApiLensASGIMiddleware, set_consumer, track_consumer


def instrument_app(
    app,
    client: ApiLensClient,
    *,
    project_slug: str = "",
    app_id: str = "",
    environment: str | None = None,
    get_consumer: Callable[..., Any] | None = None,
):
    """Starlette integration via ASGI middleware."""
    app.add_middleware(
        ApiLensASGIMiddleware,
        client=client,
        project_slug=project_slug,
        app_id=app_id,
        environment=environment,
        get_consumer=get_consumer,
    )
    return app


__all__ = ["instrument_app", "track_consumer", "set_consumer"]
