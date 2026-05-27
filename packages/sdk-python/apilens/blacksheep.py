from __future__ import annotations

from .client import ApiLensClient
from .client.middleware import ApiLensASGIMiddleware


def instrument_app(app, client: ApiLensClient, *, environment: str | None = None):
    """BlackSheep integration via ASGI middleware."""
    wrapped = None
    if hasattr(app, "asgi"):
        wrapped = ApiLensASGIMiddleware(app.asgi, client=client, environment=environment)
        app.asgi = wrapped
    elif hasattr(app, "_asgi_app"):
        wrapped = ApiLensASGIMiddleware(app._asgi_app, client=client, environment=environment)  # noqa: SLF001
        app._asgi_app = wrapped  # noqa: SLF001
    else:
        raise RuntimeError("Unsupported BlackSheep app shape for middleware installation")
    return app
