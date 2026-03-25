from __future__ import annotations

from .client import ApiLensClient
from .frameworks.flask import instrument_flask


def instrument_app(
    app,
    client: ApiLensClient,
    *,
    project_slug: str = "",
    app_id: str = "",
    environment: str | None = None,
):
    """Compatibility wrapper: prefer apilens.frameworks.flask.instrument_flask."""
    return instrument_flask(
        app,
        client,
        project_slug=project_slug,
        app_id=app_id,
        environment=environment,
    )
