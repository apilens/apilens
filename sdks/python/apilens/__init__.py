from .client import ApiLensClient, ApiLensConfig
from .client import RequestRecord
from .django import ApiLensDjangoMiddleware
from .fastapi import ApiLensGatewayMiddleware, ApiLensMiddleware, set_consumer, track_consumer
from .litestar import ApiLensPlugin

__version__ = "0.1.3"


def install_apilens_exporter(*args, **kwargs):
    # Lazy import keeps core middleware usable without OTel dependency.
    from .client.otel import install_apilens_exporter as _install_apilens_exporter

    return _install_apilens_exporter(*args, **kwargs)

__all__ = [
    "ApiLensClient",
    "ApiLensConfig",
    "RequestRecord",
    "install_apilens_exporter",
    "ApiLensDjangoMiddleware",
    "ApiLensPlugin",
    "ApiLensGatewayMiddleware",
    "ApiLensMiddleware",
    "track_consumer",
    "set_consumer",
]
