from datetime import datetime
from typing import Any, Optional

from ninja import Schema


class RequestRecord(Schema):
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


class IngestRequest(Schema):
    requests: list[RequestRecord]


class IngestResponse(Schema):
    accepted: int


class LogRecord(Schema):
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
    attributes: dict[str, Any] = {}


class IngestLogsRequest(Schema):
    logs: list[LogRecord]


class IngestLogsResponse(Schema):
    accepted: int
