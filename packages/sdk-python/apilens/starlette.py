from __future__ import annotations

from .client import ApiLensClient
from .client.middleware import ApiLensASGIMiddleware


def instrument_app(
    app,
    client: ApiLensClient,
    *,
    project_slug: str = "",
    app_id: str = "",
    environment: str | None = None,
):
    """Starlette integration via ASGI middleware."""
    app.add_middleware(
        ApiLensASGIMiddleware,
        client=client,
        project_slug=project_slug,
        app_id=app_id,
        environment=environment,
    )
    return app
