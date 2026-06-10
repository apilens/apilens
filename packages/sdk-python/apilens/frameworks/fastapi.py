from __future__ import annotations

from typing import Any, Callable

from ..client import ApiLensClient
from ..client.middleware import ApiLensASGIMiddleware, set_consumer, track_consumer


def instrument_fastapi(
    app,
    client: ApiLensClient,
    *,
    project_slug: str = "",
    app_id: str = "",
    environment: str | None = None,
    enable_request_logging: bool = True,
    log_request_body: bool = True,
    log_response_body: bool = True,
    max_payload_bytes: int = 8192,
    get_consumer: Callable[..., Any] | None = None,
):
    """FastAPI integration via ASGI middleware.

    **Minimal setup** (use ``ApiLensMiddleware`` for the simplest one-liner)::

        from fastapi import FastAPI
        from apilens.fastapi import ApiLensMiddleware

        app = FastAPI()
        app.add_middleware(ApiLensMiddleware, api_key="apilens_xxx", app_id="my-app")

    **Identifying consumers** — inject via a FastAPI Dependency so it runs
    automatically on every request that calls your auth::

        from fastapi import Depends, FastAPI, Request
        from apilens.fastapi import ApiLensMiddleware, set_consumer

        app = FastAPI()
        app.add_middleware(ApiLensMiddleware, api_key="apilens_xxx", app_id="my-app")

        async def consumer_dep(request: Request):
            user = getattr(request.state, "user", None)   # set by your auth middleware
            if user:
                set_consumer(
                    request,                               # pass Request for ASGI state
                    identifier=user.id,                    # required: stable id
                    name=getattr(user, "username", None),  # optional: display name
                    group=getattr(user, "org_slug", None), # optional: team/tier/org
                )

        @app.get("/orders")
        async def list_orders(_: None = Depends(consumer_dep)):
            ...

    **Centralized resolver** — alternative if you prefer a single callback::

        app.add_middleware(
            ApiLensMiddleware, api_key="apilens_xxx", app_id="my-app",
            get_consumer=lambda scope, headers: headers.get("x-user-id"),
        )
    """
    app.add_middleware(
        ApiLensASGIMiddleware,
        client=client,
        project_slug=project_slug,
        app_id=app_id,
        environment=environment,
        enable_request_logging=enable_request_logging,
        log_request_body=log_request_body,
        log_response_body=log_response_body,
        max_payload_bytes=max_payload_bytes,
        get_consumer=get_consumer,
    )
    return app


__all__ = ["instrument_fastapi", "track_consumer", "set_consumer"]
