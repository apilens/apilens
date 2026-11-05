from __future__ import annotations

from .client._sampling import SampleOnRequest, SampleOnResponse
from .client import ApiLensClient
from .client._env import env_defaults
from .client._profile import CaptureProfile
from .client._routes import blacksheep_route_template, blacksheep_set_route_pattern
from .client.middleware import ApiLensASGIMiddleware


def _instrument_router(app) -> None:
    """Wrap ``app.router.get_match`` to record the matched route pattern.

    BlackSheep only exposes the template here; we stash it in a contextvar the
    ASGI middleware reads back. Idempotent — installing twice is a no-op.
    """
    router = getattr(app, "router", None)
    if router is None or getattr(router, "_apilens_wrapped", False):
        return
    original_get_match = router.get_match

    def _wrapped_get_match(request):
        match = original_get_match(request)
        try:
            pattern = match.pattern.decode() if match is not None else None
        except Exception:
            pattern = None
        blacksheep_set_route_pattern(pattern)
        return match

    router.get_match = _wrapped_get_match  # type: ignore[assignment]
    router._apilens_wrapped = True  # type: ignore[attr-defined]


@env_defaults
def instrument_app(
    app,
    client: ApiLensClient,
    *,
    app_id: str = "",
    project_slug: str = "",
    environment: str | None = None,
    capture_profile: CaptureProfile | None = None,
    capture_spans: bool = True,
    service_name: str = "",
    exclude_paths: list[str] | None = None,
    exclude_user_agents: list[str] | None = None,
    default_exclusions: bool = True,
    sample_rate: float = 1.0,
    sample_on_request: SampleOnRequest | None = None,
    sample_on_response: SampleOnResponse | None = None,
):
    """BlackSheep integration via ASGI middleware.

    ``app_id`` selects which app in the project the traffic belongs to and is
    required for ingestion (and for span capture). Pass ``capture_spans=False``
    to record requests without emitting trace spans.
    """
    _instrument_router(app)
    kwargs = dict(
        client=client,
        app_id=app_id,
        project_slug=project_slug,
        environment=environment,
        capture_profile=capture_profile,
        capture_spans=capture_spans,
        service_name=service_name,
        exclude_paths=exclude_paths,
        exclude_user_agents=exclude_user_agents,
        default_exclusions=default_exclusions,
        sample_rate=sample_rate,
        sample_on_request=sample_on_request,
        sample_on_response=sample_on_response,
        route_resolver=blacksheep_route_template,
    )
    if hasattr(app, "asgi"):
        app.asgi = ApiLensASGIMiddleware(app.asgi, **kwargs)
    elif hasattr(app, "_asgi_app"):
        app._asgi_app = ApiLensASGIMiddleware(app._asgi_app, **kwargs)  # noqa: SLF001
    else:
        raise RuntimeError("Unsupported BlackSheep app shape for middleware installation")
    return app
