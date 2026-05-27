from __future__ import annotations

from dataclasses import dataclass

from .client import ApiLensClient
from .client.middleware import ApiLensASGIMiddleware


@dataclass(slots=True)
class ApiLensPlugin:
    """Litestar plugin-protocol style integration."""

    client: ApiLensClient
    environment: str | None = None

    def on_app_init(self, app_config):
        try:
            from litestar.middleware import DefineMiddleware
        except Exception as exc:  # pragma: no cover
            raise RuntimeError(
                "Litestar integration requires litestar installed in this app environment"
            ) from exc

        middleware = list(getattr(app_config, "middleware", []) or [])
        middleware.append(
            DefineMiddleware(
                ApiLensASGIMiddleware,
                client=self.client,
                environment=self.environment,
            )
        )
        app_config.middleware = middleware
        return app_config


def instrument_app(app, client: ApiLensClient, *, environment: str | None = None):
    """Fallback direct installation for Litestar ASGI apps."""
    app.asgi_handler = ApiLensASGIMiddleware(
        app.asgi_handler,
        client=client,
        environment=environment,
    )
    return app
