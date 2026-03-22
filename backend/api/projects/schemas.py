"""
Schemas for project-scoped API endpoints.
"""

from datetime import datetime
from uuid import UUID

from ninja import Schema


# ── Project Schemas ──────────────────────────────────────────────────

class CreateProjectRequest(Schema):
    name: str
    description: str = ""


class UpdateProjectRequest(Schema):
    name: str | None = None
    description: str | None = None


class ProjectResponse(Schema):
    id: UUID
    name: str
    slug: str
    description: str
    created_at: datetime
    updated_at: datetime

    @staticmethod
    def from_orm(project) -> "ProjectResponse":
        return ProjectResponse(
            id=project.id,
            name=project.name,
            slug=project.slug,
            description=project.description,
            created_at=project.created_at,
            updated_at=project.updated_at,
        )


class ProjectListResponse(Schema):
    id: UUID
    name: str
    slug: str
    description: str
    app_count: int
    created_at: datetime

    @staticmethod
    def from_orm(project, app_count: int = 0) -> "ProjectListResponse":
        return ProjectListResponse(
            id=project.id,
            name=project.name,
            slug=project.slug,
            description=project.description,
            app_count=app_count,
            created_at=project.created_at,
        )


# ── App Schemas ──────────────────────────────────────────────────

class CreateAppRequest(Schema):
    name: str
    slug: str = ""
    description: str = ""
    framework: str = "fastapi"


class UpdateAppRequest(Schema):
    name: str | None = None
    description: str | None = None
    framework: str | None = None


class AppResponse(Schema):
    id: UUID
    project_id: UUID
    name: str
    slug: str
    description: str
    framework: str
    icon: str
    created_at: datetime
    updated_at: datetime

    @staticmethod
    def from_orm(app) -> "AppResponse":
        return AppResponse(
            id=app.id,
            project_id=app.project_id,
            name=app.name,
            slug=app.slug,
            description=app.description,
            framework=app.framework,
            icon=app.icon,
            created_at=app.created_at,
            updated_at=app.updated_at,
        )


class AppListResponse(Schema):
    id: UUID
    name: str
    slug: str
    description: str
    framework: str
    icon: str
    created_at: datetime

    @staticmethod
    def from_orm(app) -> "AppListResponse":
        return AppListResponse(
            id=app.id,
            name=app.name,
            slug=app.slug,
            description=app.description,
            framework=app.framework,
            icon=app.icon,
            created_at=app.created_at,
        )


# ── API Key Schemas ──────────────────────────────────────────────────

class CreateApiKeyRequest(Schema):
    name: str


class CreateApiKeyResponse(Schema):
    key: str
    id: UUID
    name: str
    prefix: str
    created_at: datetime


class ApiKeyResponse(Schema):
    id: UUID
    name: str
    prefix: str
    is_revoked: bool
    last_used_at: datetime | None
    created_at: datetime

    @staticmethod
    def from_orm(api_key) -> "ApiKeyResponse":
        return ApiKeyResponse(
            id=api_key.id,
            name=api_key.name,
            prefix=api_key.prefix,
            is_revoked=api_key.is_revoked,
            last_used_at=api_key.last_used_at,
            created_at=api_key.created_at,
        )


# ── Data Query Schemas ──────────────────────────────────────────────

class LogItemResponse(Schema):
    timestamp: datetime
    app_id: str
    environment: str
    level: str
    message: str
    logger_name: str
    payload: str
    attributes: dict

class LogsQueryResponse(Schema):
    items: list[LogItemResponse]
    total_count: int
    page: int
    page_size: int

class RequestItemResponse(Schema):
    timestamp: datetime
    app_id: str
    environment: str
    method: str
    path: str
    status_code: int
    response_time_ms: float
    request_size: int
    response_size: int
    ip_address: str
    user_agent: str
    consumer_id: str
    consumer_name: str
    consumer_group: str

class RequestsQueryResponse(Schema):
    items: list[RequestItemResponse]
    total_count: int
    page: int
    page_size: int


# ── Generic Response Schemas ──────────────────────────────────────────

class MessageResponse(Schema):
    message: str
