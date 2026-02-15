from __future__ import annotations

from ..client import ApiLensClient
from ..client.middleware import ApiLensASGIMiddleware, set_consumer, track_consumer


def instrument_fastapi(
    app,
    client: ApiLensClient,
    *,
    environment: str | None = None,
    enable_request_logging: bool = True,
    log_request_body: bool = True,
    log_response_body: bool = True,
    max_payload_bytes: int = 8192,
):
    """FastAPI integration via ASGI middleware."""
    app.add_middleware(
        ApiLensASGIMiddleware,
        client=client,
        environment=environment,
        enable_request_logging=enable_request_logging,
        log_request_body=log_request_body,
        log_response_body=log_response_body,
        max_payload_bytes=max_payload_bytes,
    )
    return app


__all__ = ["instrument_fastapi", "track_consumer", "set_consumer"]
