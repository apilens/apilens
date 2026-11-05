from __future__ import annotations

from dataclasses import dataclass

from .client import ApiLensClient
from .client._routes import litestar_route_template
from .client.middleware import ApiLensASGIMiddleware


# eq=False keeps identity hashing — Litestar stores plugins in a frozenset, so
# the plugin must be hashable (the default dataclass __eq__ makes it unhashable).
@dataclass(slots=True, eq=False)
class ApiLensPlugin:
    """Litestar plugin-protocol style integration.

    Usage::

        app = Litestar(
            route_handlers=[...],
            plugins=[ApiLensPlugin(client=client, app_id="orders-api")],
        )

    ``app_id`` selects which app in the project the traffic belongs to and is
    required for ingestion (and for span capture).
    """

    client: ApiLensClient
    app_id: str = ""
    project_slug: str = ""
    environment: str | None = None
    capture_spans: bool = True
    service_name: str = ""
    exclude_paths: list[str] | None = None
    exclude_user_agents: list[str] | None = None
    default_exclusions: bool = True

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
                app_id=self.app_id,
                project_slug=self.project_slug,
                environment=self.environment,
                capture_spans=self.capture_spans,
                service_name=self.service_name,
                exclude_paths=self.exclude_paths,
                exclude_user_agents=self.exclude_user_agents,
                default_exclusions=self.default_exclusions,
                route_resolver=litestar_route_template,
            )
        )
        app_config.middleware = middleware
        return app_config


def instrument_app(
    app,
    client: ApiLensClient,
    *,
    app_id: str = "",
    project_slug: str = "",
    environment: str | None = None,
    capture_spans: bool = True,
    service_name: str = "",
    exclude_paths: list[str] | None = None,
    exclude_user_agents: list[str] | None = None,
    default_exclusions: bool = True,
):
    """Fallback direct installation for Litestar ASGI apps."""
    app.asgi_handler = ApiLensASGIMiddleware(
        app.asgi_handler,
        client=client,
        app_id=app_id,
        project_slug=project_slug,
        environment=environment,
        capture_spans=capture_spans,
        service_name=service_name,
        exclude_paths=exclude_paths,
        exclude_user_agents=exclude_user_agents,
        default_exclusions=default_exclusions,
        route_resolver=litestar_route_template,
    )
    return app
