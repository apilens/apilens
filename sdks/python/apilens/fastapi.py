from __future__ import annotations

from .client import ApiLensClient, ApiLensConfig
from .client.middleware import ApiLensASGIMiddleware
from .frameworks.fastapi import instrument_fastapi, set_consumer, track_consumer


class ApiLensGatewayMiddleware(ApiLensASGIMiddleware):
    """
    FastAPI middleware with a simple constructor.

    Usage:
        app.add_middleware(
            ApiLensGatewayMiddleware,
            api_key="your_app_api_key",
            base_url="https://api.apilens.ai/api/v1",
            env="production",
        )
    """

    def __init__(
        self,
        app,
        *,
        api_key: str | None = None,
        client_id: str | None = None,
        base_url: str = "https://api.apilens.ai/api/v1",
        env: str = "production",
        verify_tls: bool = True,
        ca_bundle_path: str = "",
        client: ApiLensClient | None = None,
        enable_request_logging: bool = True,
        log_request_body: bool = True,
        log_response_body: bool = True,
        max_payload_bytes: int = 8192,
    ) -> None:
        resolved_key = (api_key or client_id or "").strip()
        if client is None:
            if not resolved_key:
                raise ValueError("api_key (or client_id) is required")
            client = ApiLensClient(
                ApiLensConfig(
                    api_key=resolved_key,
                    base_url=base_url,
                    environment=env,
                    verify_tls=verify_tls,
                    ca_bundle_path=ca_bundle_path,
                )
            )

        # Keep strong reference for the app lifecycle.
        self.apilens_client = client
        super().__init__(
            app,
            client=client,
            environment=env,
            enable_request_logging=enable_request_logging,
            log_request_body=log_request_body,
            log_response_body=log_response_body,
            max_payload_bytes=max_payload_bytes,
        )


class ApiLensMiddleware(ApiLensGatewayMiddleware):
    """Backward-compatible alias for ApiLensGatewayMiddleware."""


def instrument_app(
    app,
    client: ApiLensClient,
    *,
    environment: str | None = None,
    enable_request_logging: bool = True,
    log_request_body: bool = True,
    log_response_body: bool = True,
    max_payload_bytes: int = 8192,
):
    """Compatibility wrapper: prefer apilens.frameworks.fastapi.instrument_fastapi."""
    return instrument_fastapi(
        app,
        client,
        environment=environment,
        enable_request_logging=enable_request_logging,
        log_request_body=log_request_body,
        log_response_body=log_response_body,
        max_payload_bytes=max_payload_bytes,
    )


__all__ = [
    "ApiLensGatewayMiddleware",
    "ApiLensMiddleware",
    "instrument_app",
    "track_consumer",
    "set_consumer",
]
