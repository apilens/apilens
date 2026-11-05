from __future__ import annotations

from typing import Any, Callable

from ..client import ApiLensClient
from ..client._routes import flask_route_template
from ..client.middleware import ApiLensWSGIMiddleware, set_consumer, track_consumer


def instrument_flask(
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
    """Flask integration via WSGI wrapper.

    **Minimal setup**::

        from flask import Flask
        from apilens import ApiLensClient, ApiLensConfig
        from apilens.flask import instrument_flask

        app = Flask(__name__)
        client = ApiLensClient(ApiLensConfig(api_key="apilens_xxx"))
        instrument_flask(app, client, app_id="my-flask-app")

    **Identifying consumers** — call :func:`set_consumer` from a
    ``before_request`` hook (no ``request`` argument needed; it uses a
    contextvar that the middleware reads at response time)::

        from flask import Flask, g
        from apilens.flask import instrument_flask, set_consumer

        @app.before_request
        def identify_consumer():
            if g.current_user:                      # however YOUR app sets this
                set_consumer(
                    identifier=g.current_user["email"],   # required: stable id
                    name=g.current_user.get("name"),      # optional: display name
                    group=g.current_user.get("role"),     # optional: team/tier/org
                )

    **Centralized resolver** — resolve from the WSGI environ (alternative)::

        instrument_flask(
            app, client, app_id="my-flask-app",
            get_consumer=lambda environ: environ.get("HTTP_X_USER_ID"),
        )
    """
    # Close over the Flask app so the resolver can match the WSGI environ
    # against its url_map (rule.rule → /product/<int:id> → /product/{id}).
    app.wsgi_app = ApiLensWSGIMiddleware(  # type: ignore[assignment]
        app.wsgi_app,
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
        route_resolver=lambda environ: flask_route_template(app, environ),
    )
    return app


__all__ = ["instrument_flask", "track_consumer", "set_consumer"]
