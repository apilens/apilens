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
    get_consumer: Callable[..., Any] | None = None,
):
    """Compatibility wrapper: prefer apilens.frameworks.flask.instrument_flask."""
    return instrument_flask(
        app,
        client,
        project_slug=project_slug,
        app_id=app_id,
        environment=environment,
        get_consumer=get_consumer,
    )


__all__ = ["instrument_app", "track_consumer", "set_consumer"]
