"""Wire schemas — mirror apps/api/routers/ingest/schemas.py exactly so the
existing SDKs (apilenss / apilens-js-sdk) post the same payloads unchanged.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class RequestRecord(BaseModel):
    # project_slug is optional (the project-level API key identifies the project);
    # app_id selects which app in that project.
    project_slug: str = ""
    app_id: str
    timestamp: datetime
    environment: str
    method: str
    path: str
    status_code: int
    response_time_ms: float
    request_size: int = 0
    response_size: int = 0
    ip_address: str = ""
    user_agent: str = ""
    consumer_id: str = ""
    consumer_name: str = ""
    consumer_group: str = ""
    request_payload: str = ""
    response_payload: str = ""
    request_headers: str = ""
    response_headers: str = ""
    base_url: str = ""
    trace_id: str = ""
    span_id: str = ""


class IngestRequest(BaseModel):
    requests: list[RequestRecord]


class IngestResponse(BaseModel):
    accepted: int


class LogRecord(BaseModel):
    project_slug: str = ""
    app_id: str
    timestamp: datetime
    environment: str
    level: str
    message: str
    logger_name: str = ""
    endpoint_method: str = ""
    endpoint_path: str = ""
    status_code: int = 0
    consumer_id: str = ""
    consumer_name: str = ""
    consumer_group: str = ""
    trace_id: str = ""
    span_id: str = ""
    payload: str = ""
    attributes: dict = Field(default_factory=dict)


class IngestLogsRequest(BaseModel):
    logs: list[LogRecord]


class IngestLogsResponse(BaseModel):
    accepted: int


class SpanRecord(BaseModel):
    project_slug: str = ""
    app_id: str
    timestamp: datetime  # span start, UTC
    environment: str = "production"
    trace_id: str
    span_id: str
    parent_span_id: str = ""
    name: str = ""
    kind: str = "internal"  # server | client | http | db | internal | ...
    service_name: str = ""
    duration_ms: float = 0.0
    status: str = "ok"  # ok | error
    status_code: int = 0
    attributes: dict = Field(default_factory=dict)


class IngestSpansRequest(BaseModel):
    spans: list[SpanRecord]


class IngestSpansResponse(BaseModel):
    accepted: int
