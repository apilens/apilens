"""
Project-scoped API router.

This router provides all project-level operations including:
- Project CRUD
- Project-scoped apps
- Project-scoped API keys
- Project-level analytics (aggregated across apps)
"""

from django.http import HttpRequest
from ninja import Router

from apps.auth.services import ApiKeyService
from apps.projects.models import App
from apps.projects.services import ProjectService, AppService, AnalyticsService
from apps.users.models import User
from core.auth.authentication import jwt_auth

from .schemas import (
    CreateProjectRequest,
    UpdateProjectRequest,
    ProjectResponse,
    ProjectListResponse,
    CreateAppRequest,
    UpdateAppRequest,
    AppResponse,
    AppListResponse,
    CreateApiKeyRequest,
    CreateApiKeyResponse,
    ApiKeyResponse,
    MessageResponse,
)

router = Router(auth=[jwt_auth])


# ── Project CRUD ──────────────────────────────────────────────────────


@router.post("/", response={201: ProjectResponse})
def create_project(request: HttpRequest, data: CreateProjectRequest):
    """Create a new project."""
    user: User = request.auth
    project = ProjectService.create_project(user, data.name, data.description)
    return 201, ProjectResponse.from_orm(project)


@router.get("/", response=list[ProjectListResponse])
def list_projects(request: HttpRequest):
    """List all projects for the authenticated user."""
    user: User = request.auth
    projects = ProjectService.list_projects(user)

    # Include app count for each project
    result = []
    for project in projects:
        app_count = App.objects.filter(project=project, is_active=True).count()
        result.append(ProjectListResponse.from_orm(project, app_count=app_count))

    return result


@router.get("/{project_slug}", response=ProjectResponse)
def get_project(request: HttpRequest, project_slug: str):
    """Get a specific project by slug."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    return ProjectResponse.from_orm(project)


@router.patch("/{project_slug}", response=ProjectResponse)
def update_project(request: HttpRequest, project_slug: str, data: UpdateProjectRequest):
    """Update a project's details."""
    user: User = request.auth
    project = ProjectService.update_project(user, project_slug, data.name, data.description)
    return ProjectResponse.from_orm(project)


@router.delete("/{project_slug}", response=MessageResponse)
def delete_project(request: HttpRequest, project_slug: str):
    """Soft delete a project (also soft-deletes all apps and revokes all API keys)."""
    user: User = request.auth
    ProjectService.delete_project(user, project_slug)
    return MessageResponse(message="Project deleted successfully")


# ── Project-scoped Apps ──────────────────────────────────────────────


@router.post("/{project_slug}/apps", response={201: AppResponse})
def create_app(request: HttpRequest, project_slug: str, data: CreateAppRequest):
    """Create a new app within a project."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    app = AppService.create_app(project, data.name, data.description, data.framework)
    return 201, AppResponse.from_orm(app)


@router.get("/{project_slug}/apps", response=list[AppListResponse])
def list_apps(request: HttpRequest, project_slug: str):
    """List all apps in a project."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    apps = AppService.list_apps(project)
    return [AppListResponse.from_orm(app) for app in apps]


@router.get("/{project_slug}/apps/{app_slug}", response=AppResponse)
def get_app(request: HttpRequest, project_slug: str, app_slug: str):
    """Get a specific app within a project."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    app = AppService.get_app_by_slug(project, app_slug)
    return AppResponse.from_orm(app)


@router.patch("/{project_slug}/apps/{app_slug}", response=AppResponse)
def update_app(request: HttpRequest, project_slug: str, app_slug: str, data: UpdateAppRequest):
    """Update an app's details."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    app = AppService.update_app(project, app_slug, data.name, data.description, data.framework)
    return AppResponse.from_orm(app)


@router.delete("/{project_slug}/apps/{app_slug}", response=MessageResponse)
def delete_app(request: HttpRequest, project_slug: str, app_slug: str):
    """Soft delete an app within a project."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    AppService.delete_app(project, app_slug)
    return MessageResponse(message="App deleted successfully")


# ── Project-scoped API Keys ──────────────────────────────────────────


@router.post("/{project_slug}/api-keys", response={201: CreateApiKeyResponse})
def create_api_key(request: HttpRequest, project_slug: str, data: CreateApiKeyRequest):
    """Create a new API key for a project (works across all apps in project)."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    raw_key, api_key = ApiKeyService.create_key(project, data.name.strip())
    return 201, CreateApiKeyResponse(
        key=raw_key,
        id=api_key.id,
        name=api_key.name,
        prefix=api_key.prefix,
        created_at=api_key.created_at,
    )


@router.get("/{project_slug}/api-keys", response=list[ApiKeyResponse])
def list_api_keys(request: HttpRequest, project_slug: str):
    """List all API keys for a project."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    keys = ApiKeyService.list_keys(project)
    return [ApiKeyResponse.from_orm(k) for k in keys]


@router.delete("/{project_slug}/api-keys/{key_id}", response=MessageResponse)
def revoke_api_key(request: HttpRequest, project_slug: str, key_id: str):
    """Revoke a specific API key."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    success = ApiKeyService.revoke_key(project, key_id)
    if not success:
        return MessageResponse(message="API key not found or already revoked")
    return MessageResponse(message="API key revoked successfully")


# ── Project-level Analytics (aggregated) ─────────────────────────────


@router.get("/{project_slug}/analytics/summary", response=dict)
def get_analytics_summary(
    request: HttpRequest,
    project_slug: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
):
    """
    Get aggregated analytics summary for a project.
    Optionally filter by a specific app within the project.
    """
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)

    app_ids: list[str] | None = None
    if app_slugs:
        slugs = [s.strip() for s in app_slugs.split(",") if s.strip()]
        if slugs:
            apps = AppService.get_apps_by_slugs(project, slugs)
            app_ids = [str(app.id) for app in apps]

    return AnalyticsService.get_project_summary(
        project_id=str(project.id),
        app_ids=app_ids,
        environment=environment,
        since=since,
        until=until,
    )


@router.get("/{project_slug}/analytics/timeseries", response=list[dict])
def get_analytics_timeseries(
    request: HttpRequest,
    project_slug: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
):
    """
    Get time-series analytics for a project.
    Optionally filter by a specific app within the project.
    """
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)

    app_ids: list[str] | None = None
    if app_slugs:
        slugs = [s.strip() for s in app_slugs.split(",") if s.strip()]
        if slugs:
            apps = AppService.get_apps_by_slugs(project, slugs)
            app_ids = [str(app.id) for app in apps]

    return AnalyticsService.get_project_timeseries(
        project_id=str(project.id),
        app_ids=app_ids,
        environment=environment,
        since=since,
        until=until,
    )


@router.get("/{project_slug}/analytics/endpoints", response=list[dict])
def get_endpoint_stats(
    request: HttpRequest,
    project_slug: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    limit: int = 100,
):
    """
    Get endpoint statistics aggregated across a project.
    Optionally filter by a specific app within the project.
    """
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)

    app_ids: list[str] | None = None
    if app_slugs:
        slugs = [s.strip() for s in app_slugs.split(",") if s.strip()]
        if slugs:
            apps = AppService.get_apps_by_slugs(project, slugs)
            app_ids = [str(app.id) for app in apps]

    return AnalyticsService.get_project_endpoint_stats(
        project_id=str(project.id),
        app_ids=app_ids,
        environment=environment,
        since=since,
        until=until,
        limit=limit,
    )


@router.get("/{project_slug}/analytics/environments", response=dict)
def get_environments(
    request: HttpRequest,
    project_slug: str,
    app_slugs: str = None,
):
    """
    Get list of environments with data for a project.
    """
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)

    app_ids = []
    if app_slugs:
        slugs = [s.strip() for s in app_slugs.split(",") if s.strip()]
        for slug in slugs:
            app = AppService.get_app_by_slug(project, slug)
            app_ids.append(str(app.id))

    environments = AnalyticsService.get_project_environments(
        project_id=str(project.id),
        app_ids=app_ids if app_ids else None,
    )

    return {"environments": environments}
