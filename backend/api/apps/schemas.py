from datetime import datetime
from typing import Optional
from uuid import UUID

import os

from django.conf import settings
from ninja import Schema

from apps.projects.models import App


def _build_app_icon_url(app: App) -> str:
    if not app.icon_image:
        return ""
    base = os.environ.get("DJANGO_BASE_URL", "http://localhost:8000")
    cache_bust = int(app.updated_at.timestamp()) if app.updated_at else ""
    return f"{base}{settings.MEDIA_URL}{app.icon_image.name}?v={cache_bust}"


class CreateAppRequest(Schema):
    name: str
    description: str = ""
    framework: str = "fastapi"


class UpdateAppRequest(Schema):
    name: Optional[str] = None
    description: Optional[str] = None
    framework: Optional[str] = None


class AppResponse(Schema):
    id: UUID
    name: str
    slug: str
    icon_url: str
    description: str
    framework: str
    created_at: datetime
    updated_at: datetime


class AppListResponse(Schema):
    id: UUID
    name: str
    slug: str
    icon_url: str
    description: str
    framework: str
    api_key_count: int
    created_at: datetime


class CreateApiKeyRequest(Schema):
    name: str


class ApiKeyResponse(Schema):
    id: UUID
    name: str
    prefix: str
    last_used_at: Optional[datetime] = None
    created_at: datetime


class CreateApiKeyResponse(Schema):
    key: str
    id: UUID
    name: str
    prefix: str
    created_at: datetime


class MessageResponse(Schema):
    message: str


class AppIconResponse(Schema):
    icon_url: str
    message: str


# ── Endpoint schemas ─────────────────────────────────────────────────


class CreateEndpointRequest(Schema):
    path: str
    method: str = "GET"
    description: str = ""


class UpdateEndpointRequest(Schema):
    path: Optional[str] = None
    method: Optional[str] = None
    description: Optional[str] = None


class EndpointResponse(Schema):
    id: UUID
    path: str
    method: str
    description: str
    is_active: bool
    last_seen_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


# ── Environment schemas ──────────────────────────────────────────────


class CreateEnvironmentRequest(Schema):
    name: str
    color: str = "#6b7280"


class UpdateEnvironmentRequest(Schema):
    name: Optional[str] = None
    color: Optional[str] = None


class EnvironmentResponse(Schema):
    id: UUID
    name: str
    slug: str
    color: str
    order: int
    created_at: datetime
    updated_at: datetime


# ── Endpoint Stats schemas ───────────────────────────────────────────


class EndpointStatsResponse(Schema):
    method: str
    path: str
    total_requests: int
    error_count: int
    error_rate: float
    avg_response_time_ms: float
    p95_response_time_ms: float
    total_request_bytes: int
    total_response_bytes: int
    last_seen_at: Optional[datetime] = None


class EndpointStatsListResponse(Schema):
    items: list[EndpointStatsResponse]
    total_count: int
    page: int
    page_size: int


class EndpointOptionResponse(Schema):
    method: str
    path: str
    total_requests: int


class ConsumerStatsResponse(Schema):
    consumer: str
    total_requests: int
    error_count: int
    error_rate: float
    avg_response_time_ms: float
    last_seen_at: Optional[datetime] = None


class AnalyticsSummaryResponse(Schema):
    total_requests: int
    error_count: int
    error_rate: float
    avg_response_time_ms: float
    p95_response_time_ms: float
    total_request_bytes: int
    total_response_bytes: int
    unique_endpoints: int
    unique_consumers: int


class AnalyticsTimeseriesPointResponse(Schema):
    bucket: datetime
    total_requests: int
    error_count: int
    error_rate: float
    avg_response_time_ms: float
    p95_response_time_ms: float
    total_request_bytes: int
    total_response_bytes: int


class RelatedApiResponse(Schema):
    family: str
    endpoint_count: int
    total_requests: int
    error_count: int
    error_rate: float
    avg_response_time_ms: float


class EndpointDetailResponse(Schema):
    method: str
    path: str
    total_requests: int
    error_count: int
    error_rate: float
    avg_response_time_ms: float
    p95_response_time_ms: float
    total_request_bytes: int
    total_response_bytes: int
    last_seen_at: Optional[datetime] = None


class EndpointTimeseriesPointResponse(Schema):
    bucket: datetime
    total_requests: int
    error_count: int
    avg_response_time_ms: float


class EndpointConsumerResponse(Schema):
    consumer: str
    total_requests: int
    error_count: int
    error_rate: float
    avg_response_time_ms: float


class EndpointStatusCodeResponse(Schema):
    status_code: int
    total_requests: int


class EndpointPayloadSampleResponse(Schema):
    timestamp: datetime
    method: str
    path: str
    status_code: int
    response_time_ms: float = 0.0
    environment: str
    ip_address: str
    user_agent: str
    consumer_id: str = ""
    consumer_name: str = ""
    consumer_group: str = ""
    request_payload: str
    response_payload: str


class EnvironmentOptionResponse(Schema):
    environment: str
    total_requests: int
