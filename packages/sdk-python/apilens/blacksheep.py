from __future__ import annotations

from .client import ApiLensClient
from .client.middleware import ApiLensASGIMiddleware


def instrument_app(
    app,
    client: ApiLensClient,
    *,
    app_id: str = "",
    project_slug: str = "",
    environment: str | None = None,
    capture_spans: bool = True,
    service_name: str = "",
):
    """BlackSheep integration via ASGI middleware.

    ``app_id`` selects which app in the project the traffic belongs to and is
    required for ingestion (and for span capture). Pass ``capture_spans=False``
    to record requests without emitting trace spans.
    """
    kwargs = dict(
        client=client,
        app_id=app_id,
        project_slug=project_slug,
        environment=environment,
        capture_spans=capture_spans,
        service_name=service_name,
    )
    if hasattr(app, "asgi"):
        app.asgi = ApiLensASGIMiddleware(app.asgi, **kwargs)
    elif hasattr(app, "_asgi_app"):
        app._asgi_app = ApiLensASGIMiddleware(app._asgi_app, **kwargs)  # noqa: SLF001
    else:
        raise RuntimeError("Unsupported BlackSheep app shape for middleware installation")
    return app
