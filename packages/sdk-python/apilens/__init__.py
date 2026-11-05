from ._version import __version__
from .client import ApiLensClient, ApiLensConfig, ClientStats
from .client import LogRecord, RequestRecord
from .client._sanitize import RequestInfo, ResponseInfo
from .client.middleware import normalize_consumer
from .client.spans import instrument_outbound_http
from .client.trace import current_span_id, current_trace_id, current_traceparent
from .django import ApiLensDjangoMiddleware
from .fastapi import ApiLensGatewayMiddleware, ApiLensMiddleware, set_consumer, track_consumer
from .litestar import ApiLensPlugin


def install_apilens_exporter(*args, **kwargs):
    # Lazy import keeps core middleware usable without OTel dependency.
    from .client.otel import install_apilens_exporter as _install_apilens_exporter

    return _install_apilens_exporter(*args, **kwargs)

__all__ = [
    "ApiLensClient",
    "ApiLensConfig",
    "ClientStats",
    "RequestRecord",
    "LogRecord",
    "RequestInfo",
    "ResponseInfo",
    "install_apilens_exporter",
    "ApiLensDjangoMiddleware",
    "ApiLensPlugin",
    "ApiLensGatewayMiddleware",
    "ApiLensMiddleware",
    "track_consumer",
    "set_consumer",
    "normalize_consumer",
    "current_trace_id",
    "current_span_id",
    "current_traceparent",
    "instrument_outbound_http",
    "__version__",
]
