import logging
import math
import threading
import json
from typing import Any
from datetime import datetime, timedelta, timezone as tz
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.text import slugify

from core.exceptions.base import (
    NotFoundError,
    AuthorizationError,
    RateLimitError,
    ValidationError,
    ConflictError,
)

from .models import Project, App, Endpoint, Environment, ProjectMember
from .validators import (
    validate_project_slug,
    validate_app_slug,
    RESERVED_PROJECT_SLUGS,
    RESERVED_APP_SLUGS,
)

logger = logging.getLogger(__name__)

MAX_PROJECTS_PER_USER = 50
MAX_APPS_PER_PROJECT = 50

# For backwards compatibility - now imported from validators
RESERVED_SLUGS = RESERVED_PROJECT_SLUGS


def _resolve_time_range(since: str | None, until: str | None) -> tuple[datetime, datetime]:
    now = datetime.now(tz.utc)
    since_dt = datetime.fromisoformat(since.replace("Z", "+00:00")) if since else now - timedelta(hours=24)
    until_dt = datetime.fromisoformat(until.replace("Z", "+00:00")) if until else now
    return since_dt, until_dt


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=tz.utc)
    return value.astimezone(tz.utc)


def _resolve_bucket_timezone(timezone_name: str | None) -> str:
    if not timezone_name:
        return "UTC"
    try:
        ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        return "UTC"
    return timezone_name


def _unique_project_slug(name: str, exclude_id=None) -> str:
    """Generate a GLOBALLY unique slug for a project.

    Project names are unique across all users, so the slug is checked against
    every active project (not just the caller's). Only active projects reserve a
    slug — a soft-deleted project frees its name for reuse.
    """
    base = slugify(name)[:100]
    if not base:
        base = "project"

    # Check if the base slug is reserved - reject immediately
    validate_project_slug(base)

    candidate = base
    counter = 1

    while True:
        # Slug is protected by a global DB unique constraint on active projects.
        qs = Project.objects.filter(slug=candidate, is_active=True)
        if exclude_id:
            qs = qs.exclude(id=exclude_id)
        if not qs.exists():
            return candidate

        candidate = f"{base}-{counter}"
        counter += 1


def _unique_slug(project, name: str, exclude_id=None) -> str:
    """Generate a unique slug for an app within a project."""
    base = slugify(name)[:100]
    if not base:
        base = "app"

    # Check if the base slug is reserved - reject immediately
    validate_app_slug(base)

    candidate = base
    counter = 1

    while True:
        # Slug is protected by a DB unique constraint on (project, slug),
        # so uniqueness must be checked across all rows, not only active ones.
        qs = App.objects.filter(project=project, slug=candidate)
        if exclude_id:
            qs = qs.exclude(id=exclude_id)
        if not qs.exists():
            return candidate

        candidate = f"{base}-{counter}"
        counter += 1


class ProjectService:
    """Service for managing projects - top-level organizational units."""

    @staticmethod
    def create_project(
        user,
        name: str,
        description: str = "",
    ) -> Project:
        """Create a new project for a user."""
        name = name.strip()
        if not name:
            raise ValidationError("Project name is required")

        if Project.objects.for_user(user).count() >= MAX_PROJECTS_PER_USER:
            raise RateLimitError(f"Maximum of {MAX_PROJECTS_PER_USER} projects allowed")

        # Project names are globally unique across ALL users — once a name is
        # taken it's unavailable to everyone else.
        if Project.objects.filter(name__iexact=name, is_active=True).exists():
            raise ConflictError(
                f"A project named '{name}' is already taken. Please choose a different name."
            )

        # Retry for rare concurrent create collisions
        for attempt in range(5):
            slug = _unique_project_slug(name)
            try:
                with transaction.atomic():
                    project = Project.objects.create(
                        owner=user,
                        name=name,
                        slug=slug,
                        description=description.strip(),
                    )
                    return project
            except IntegrityError as exc:
                if "project_slug" in str(exc):
                    if attempt == 4:
                        raise ConflictError("Project name already exists. Try a different name.")
                    continue
                raise

        raise ConflictError("Unable to create project with that name. Try a different name.")

    @staticmethod
    def list_projects(user) -> list[Project]:
        """List all active projects for a user."""
        return list(Project.objects.for_user(user).order_by("-created_at"))

    @staticmethod
    def get_role(user, project: Project) -> str | None:
        """The user's effective role on a project (RBAC subject role).

        Prefers the authoritative owner FK, then a ProjectMember row. Returns
        None when the user has no relationship to the project.
        """
        if project.owner_id == user.id:
            return ProjectMember.Role.OWNER
        member = ProjectMember.objects.filter(project=project, user=user).only("role").first()
        return member.role if member else None

    @staticmethod
    def authorize(user, project: Project, action: str) -> str:
        """Authorize an action on a project via OPA (role -> action RBAC).

        The role is resolved here (PIP) and passed to OPA (PDP). On deny we raise
        AuthorizationError (403) — the project exists, the caller just lacks
        access — distinguishing "no access" (not a member) from "insufficient
        permission" (a member whose role can't do this action). OPA's None (OPA
        unreachable) falls back to "has any role" so the dashboard degrades
        rather than 500s. Returns the resolved role.
        """
        role = ProjectService.get_role(user, project)

        # The project owner is authoritative and has every permission by
        # definition. Short-circuit before OPA so a stale or unreachable policy
        # can never lock an owner out of their own project.
        if role == ProjectMember.Role.OWNER:
            return role

        from core.authz import opa

        decision = opa.check(
            user_id=str(user.id),
            action=action,
            resource_type="project",
            owner_id=str(project.owner_id),
            role=role or "",
        )
        if decision is True:
            return role
        # Not a member of the project at all.
        if role is None:
            raise AuthorizationError("You don't have access to this project")
        # A member, but their role isn't permitted to perform this action.
        if decision is False:
            raise AuthorizationError("You don't have permission to perform this action")
        # OPA unavailable but the user has a role: degrade gracefully (allow).
        return role

    @staticmethod
    def get_project_by_slug(user, slug: str, action: str = "read") -> Project:
        """Get a project, enforcing `action` via OPA RBAC.

        Existence and access are reported distinctly: an unknown slug raises
        NotFoundError (404), while a real project the caller can't access raises
        AuthorizationError (403, via `authorize`).
        """
        project = Project.objects.filter(slug=slug, is_active=True).first()
        if project is None:
            raise NotFoundError(f"Project '{slug}' not found")

        ProjectService.authorize(user, project, action)
        return project

    @staticmethod
    @transaction.atomic
    def update_project(
        user,
        slug: str,
        name: str | None = None,
        description: str | None = None,
    ) -> Project:
        """Update a project's details. Requires the `admin` role."""
        project = ProjectService.get_project_by_slug(user, slug, action="admin")

        if name is not None:
            name = name.strip()
            if not name:
                raise ValidationError("Project name is required")
            # Project names are globally unique — block names already taken by
            # any other active project.
            if (
                Project.objects.filter(name__iexact=name, is_active=True)
                .exclude(id=project.id)
                .exists()
            ):
                raise ConflictError(
                    f"A project named '{name}' is already taken. Please choose a different name."
                )
            project.name = name
            # Slug is globally unique across all users.
            project.slug = _unique_project_slug(name, exclude_id=project.id)

        if description is not None:
            project.description = description.strip()

        project.save()
        return project

    @staticmethod
    @transaction.atomic
    def delete_project(user, slug: str) -> None:
        """
        Soft delete a project.
        Also soft-deletes all apps in the project and revokes all API keys.
        Requires the `delete` role (owner only).
        """
        project = ProjectService.get_project_by_slug(user, slug, action="delete")

        # Soft delete all apps in this project
        from apps.projects.models import App
        App.objects.filter(project=project, is_active=True).update(is_active=False)

        # Revoke all API keys for this project
        from apps.auth.services import ApiKeyService
        ApiKeyService.revoke_all_for_project(project)

        # Soft delete the project
        project.is_active = False
        project.save(update_fields=["is_active", "updated_at"])


class AppService:
    @staticmethod
    def create_app(
        project: Project,
        name: str,
        description: str = "",
        framework: str = "fastapi",
        custom_slug: str = "",
    ) -> App:
        """Create a new app within a project."""
        name = name.strip()
        if not name:
            raise ValidationError("App name is required")
        framework = (framework or "fastapi").strip().lower()
        if framework not in App.Framework.values:
            raise ValidationError("Invalid framework")

        if App.objects.for_project(project).count() >= MAX_APPS_PER_PROJECT:
            raise RateLimitError(f"Maximum of {MAX_APPS_PER_PROJECT} apps allowed per project")

        # Use custom slug if provided, otherwise auto-generate from name
        custom_slug = custom_slug.strip()
        if custom_slug:
            # Validate the custom slug
            validate_app_slug(custom_slug)
            slug = custom_slug
            # Check for uniqueness
            if App.objects.filter(project=project, slug=slug).exists():
                raise ConflictError(f"App slug '{slug}' already exists in this project")

            try:
                with transaction.atomic():
                    app = App.objects.create(
                        project=project,
                        name=name,
                        slug=slug,
                        description=description.strip(),
                        framework=framework,
                    )
                    return app
            except IntegrityError:
                raise ConflictError(f"App slug '{slug}' already exists in this project")

        # Retry for rare concurrent create collisions with auto-generated slug.
        for attempt in range(5):
            slug = _unique_slug(project, name)
            try:
                with transaction.atomic():
                    app = App.objects.create(
                        project=project,
                        name=name,
                        slug=slug,
                        description=description.strip(),
                        framework=framework,
                    )
                    return app
            except IntegrityError as exc:
                if "unique_app_slug" in str(exc):
                    if attempt == 4:
                        raise ConflictError("App name already exists. Try a different name.")
                    continue
                raise

        raise ConflictError("Unable to create app with that name. Try a different name.")

    @staticmethod
    def list_apps(project: Project) -> list[App]:
        """List all active apps in a project."""
        return list(App.objects.for_project(project).order_by("-created_at"))

    @staticmethod
    def get_apps_by_slugs(project: Project, slugs: list[str]) -> list[App]:
        """Get multiple apps by slug within a project; raises if none found."""
        cleaned = [s.strip() for s in slugs if s.strip()]
        if not cleaned:
            raise ValidationError("At least one app slug is required")
        apps = list(App.objects.filter(project=project, slug__in=cleaned, is_active=True))
        if not apps:
            raise NotFoundError("No matching apps found for the provided slugs")
        return apps

    @staticmethod
    def get_app_by_slug(project: Project, slug: str) -> App:
        """Get an app by slug within a project."""
        try:
            return App.objects.get(project=project, slug=slug, is_active=True)
        except App.DoesNotExist:
            raise NotFoundError(f"App '{slug}' not found")

    @staticmethod
    @transaction.atomic
    def update_app(
        project: Project,
        slug: str,
        name: str | None = None,
        description: str | None = None,
        framework: str | None = None,
    ) -> App:
        """Update an app's details."""
        app = AppService.get_app_by_slug(project, slug)

        if name is not None:
            name = name.strip()
            if not name:
                raise ValidationError("App name is required")
            app.name = name
            app.slug = _unique_slug(project, name, exclude_id=app.id)

        if description is not None:
            app.description = description.strip()

        if framework is not None:
            normalized = framework.strip().lower()
            if normalized not in App.Framework.values:
                raise ValidationError("Invalid framework")
            app.framework = normalized

        app.save()
        return app

    @staticmethod
    @transaction.atomic
    def delete_app(project: Project, slug: str) -> None:
        """Soft delete an app within a project."""
        app = AppService.get_app_by_slug(project, slug)

        app.is_active = False
        app.save(update_fields=["is_active", "updated_at"])


class EndpointService:
    @staticmethod
    @transaction.atomic
    def create_endpoint(app, path: str, method: str = "GET", description: str = "") -> Endpoint:
        path = path.strip()
        if not path:
            raise ValidationError("Endpoint path is required")

        method = method.upper()
        if method not in Endpoint.Method.values:
            raise ValidationError(f"Invalid method: {method}")

        if Endpoint.objects.filter(app=app, path=path, method=method, is_active=True).exists():
            raise ConflictError(f"{method} {path} already exists")

        return Endpoint.objects.create(
            app=app,
            path=path,
            method=method,
            description=description.strip(),
        )

    @staticmethod
    def list_endpoints(app) -> list[Endpoint]:
        return list(Endpoint.objects.for_app(app))

    @staticmethod
    def get_endpoint(app, endpoint_id: str) -> Endpoint:
        try:
            return Endpoint.objects.get(id=endpoint_id, app=app, is_active=True)
        except Endpoint.DoesNotExist:
            raise NotFoundError("Endpoint not found")

    @staticmethod
    @transaction.atomic
    def update_endpoint(
        app, endpoint_id: str, path: str | None = None,
        method: str | None = None, description: str | None = None,
    ) -> Endpoint:
        endpoint = EndpointService.get_endpoint(app, endpoint_id)

        if path is not None:
            path = path.strip()
            if not path:
                raise ValidationError("Endpoint path is required")
            endpoint.path = path

        if method is not None:
            method = method.upper()
            if method not in Endpoint.Method.values:
                raise ValidationError(f"Invalid method: {method}")
            endpoint.method = method

        if description is not None:
            endpoint.description = description.strip()

        endpoint.save()
        return endpoint

    @staticmethod
    @transaction.atomic
    def delete_endpoint(app, endpoint_id: str) -> None:
        endpoint = EndpointService.get_endpoint(app, endpoint_id)
        endpoint.is_active = False
        endpoint.save(update_fields=["is_active", "updated_at"])


MAX_ENVIRONMENTS_PER_APP = 10

DEFAULT_ENVIRONMENTS = [
    {"name": "Production", "slug": "production", "color": "#ef4444", "order": 0},
    {"name": "Staging", "slug": "staging", "color": "#f59e0b", "order": 1},
    {"name": "Development", "slug": "development", "color": "#22c55e", "order": 2},
]


class EnvironmentService:
    @staticmethod
    def create_default_environments(app) -> list[Environment]:
        envs = []
        for env_data in DEFAULT_ENVIRONMENTS:
            envs.append(Environment.objects.create(app=app, **env_data))
        return envs

    @staticmethod
    @transaction.atomic
    def create_environment(app, name: str, color: str = "#6b7280") -> Environment:
        name = name.strip()
        if not name:
            raise ValidationError("Environment name is required")

        if Environment.objects.for_app(app).count() >= MAX_ENVIRONMENTS_PER_APP:
            raise RateLimitError(f"Maximum of {MAX_ENVIRONMENTS_PER_APP} environments per app")

        slug = slugify(name)
        if not slug:
            slug = "env"

        if Environment.objects.filter(app=app, slug=slug).exists():
            raise ConflictError(f"Environment '{name}' already exists")

        order = Environment.objects.filter(app=app).count()
        return Environment.objects.create(
            app=app, name=name, slug=slug, color=color, order=order,
        )

    @staticmethod
    def list_environments(app) -> list[Environment]:
        return list(Environment.objects.for_app(app))

    @staticmethod
    def get_environment(app, env_slug: str) -> Environment:
        try:
            return Environment.objects.get(app=app, slug=env_slug, is_active=True)
        except Environment.DoesNotExist:
            raise NotFoundError("Environment not found")

    @staticmethod
    @transaction.atomic
    def update_environment(
        app, env_slug: str, name: str | None = None, color: str | None = None,
    ) -> Environment:
        env = EnvironmentService.get_environment(app, env_slug)

        if name is not None:
            name = name.strip()
            if not name:
                raise ValidationError("Environment name is required")
            new_slug = slugify(name)
            if new_slug != env.slug and Environment.objects.filter(app=app, slug=new_slug).exists():
                raise ConflictError(f"Environment '{name}' already exists")
            env.name = name
            env.slug = new_slug

        if color is not None:
            env.color = color

        env.save()
        return env

    @staticmethod
    @transaction.atomic
    def delete_environment(app, env_slug: str) -> None:
        env = EnvironmentService.get_environment(app, env_slug)
        env.is_active = False
        env.save(update_fields=["is_active", "updated_at"])


class IngestService:
    MAX_PAYLOAD_CHARS = 16_384
    MAX_LOG_MESSAGE_CHARS = 8_192
    MAX_LOG_PAYLOAD_CHARS = 16_384
    MAX_LOG_ATTRIBUTE_KEY_CHARS = 64
    MAX_LOG_ATTRIBUTE_VALUE_CHARS = 512
    MAX_LOG_ATTRIBUTES = 64
    _payload_columns_ready = False
    _payload_columns_lock = threading.Lock()
    _header_columns_ready = False
    _header_columns_lock = threading.Lock()
    _consumer_columns_ready = False
    _consumer_columns_lock = threading.Lock()
    _base_url_column_ready = False
    _base_url_column_lock = threading.Lock()
    _trace_columns_ready = False
    _trace_columns_lock = threading.Lock()
    _api_logs_table_ready = False
    _api_logs_table_lock = threading.Lock()
    _api_spans_table_ready = False
    _api_spans_table_lock = threading.Lock()

    @staticmethod
    def ensure_payload_columns(client) -> None:
        if IngestService._payload_columns_ready:
            return
        with IngestService._payload_columns_lock:
            if IngestService._payload_columns_ready:
                return
            try:
                client.execute(
                    "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS request_payload String CODEC(ZSTD(3))"
                )
                client.execute(
                    "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS response_payload String CODEC(ZSTD(3))"
                )
            except Exception as exc:
                logger.warning("Unable to ensure payload columns on api_requests: %s", exc)
                return
            IngestService._payload_columns_ready = True

    @staticmethod
    def ensure_header_columns(client) -> None:
        if IngestService._header_columns_ready:
            return
        with IngestService._header_columns_lock:
            if IngestService._header_columns_ready:
                return
            try:
                client.execute(
                    "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS request_headers String CODEC(ZSTD(3))"
                )
                client.execute(
                    "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS response_headers String CODEC(ZSTD(3))"
                )
            except Exception as exc:
                logger.warning("Unable to ensure header columns on api_requests: %s", exc)
                return
            IngestService._header_columns_ready = True

    @staticmethod
    def ensure_base_url_column(client) -> None:
        if IngestService._base_url_column_ready:
            return
        with IngestService._base_url_column_lock:
            if IngestService._base_url_column_ready:
                return
            try:
                client.execute(
                    "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS base_url String DEFAULT '' CODEC(ZSTD(1))"
                )
            except Exception as exc:
                logger.warning("Unable to ensure base_url column on api_requests: %s", exc)
                return
            IngestService._base_url_column_ready = True

    @staticmethod
    def ensure_consumer_columns(client) -> None:
        if IngestService._consumer_columns_ready:
            return
        with IngestService._consumer_columns_lock:
            if IngestService._consumer_columns_ready:
                return
            try:
                client.execute(
                    "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS consumer_id String CODEC(ZSTD(3))"
                )
                client.execute(
                    "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS consumer_name String CODEC(ZSTD(3))"
                )
                client.execute(
                    "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS consumer_group String CODEC(ZSTD(3))"
                )
            except Exception as exc:
                logger.warning("Unable to ensure consumer columns on api_requests: %s", exc)
                return
            IngestService._consumer_columns_ready = True

    @staticmethod
    def ensure_trace_columns(client) -> None:
        if IngestService._trace_columns_ready:
            return
        with IngestService._trace_columns_lock:
            if IngestService._trace_columns_ready:
                return
            try:
                client.execute(
                    "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS trace_id String DEFAULT '' CODEC(ZSTD(1))"
                )
                client.execute(
                    "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS span_id String DEFAULT '' CODEC(ZSTD(1))"
                )
                client.execute(
                    "ALTER TABLE api_requests ADD INDEX IF NOT EXISTS idx_api_requests_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 1"
                )
            except Exception as exc:
                logger.warning("Unable to ensure trace columns on api_requests: %s", exc)
                return
            IngestService._trace_columns_ready = True

    @staticmethod
    def _safe_payload(value: str) -> str:
        if not value:
            return ""
        text = str(value)
        if len(text) <= IngestService.MAX_PAYLOAD_CHARS:
            return text
        return text[: IngestService.MAX_PAYLOAD_CHARS]

    @staticmethod
    def ensure_api_logs_table(client) -> None:
        if IngestService._api_logs_table_ready:
            return
        with IngestService._api_logs_table_lock:
            if IngestService._api_logs_table_ready:
                return
            try:
                client.execute(
                    """
                    CREATE TABLE IF NOT EXISTS api_logs (
                        timestamp DateTime64(3) CODEC(DoubleDelta, ZSTD(1)),
                        app_id String CODEC(ZSTD(1)),
                        environment LowCardinality(String) CODEC(ZSTD(1)),
                        level LowCardinality(String) CODEC(ZSTD(1)),
                        message String CODEC(ZSTD(3)),
                        logger_name LowCardinality(String) CODEC(ZSTD(1)),
                        payload String CODEC(ZSTD(3)),
                        attributes_json String CODEC(ZSTD(3))
                    ) ENGINE = MergeTree()
                    PARTITION BY toYYYYMM(timestamp)
                    ORDER BY (app_id, environment, level, timestamp)
                    TTL toDateTime(timestamp) + INTERVAL 30 DAY
                    SETTINGS index_granularity = 8192
                    """
                )
                client.execute(
                    "ALTER TABLE api_logs ADD INDEX IF NOT EXISTS idx_api_logs_app_id app_id TYPE bloom_filter(0.01) GRANULARITY 1"
                )
                client.execute(
                    "ALTER TABLE api_logs ADD INDEX IF NOT EXISTS idx_api_logs_environment environment TYPE bloom_filter(0.01) GRANULARITY 1"
                )
                client.execute(
                    "ALTER TABLE api_logs ADD INDEX IF NOT EXISTS idx_api_logs_level level TYPE set(10) GRANULARITY 1"
                )
                client.execute(
                    "ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS attributes_json String CODEC(ZSTD(3))"
                )
                # Correlation columns from migration 004; the legacy runtime
                # CREATE above lacks them, so ensure before selecting them.
                for stmt in (
                    "ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS endpoint_method LowCardinality(String) CODEC(ZSTD(1))",
                    "ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS endpoint_path String CODEC(ZSTD(1))",
                    "ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS status_code UInt16 CODEC(ZSTD(1))",
                    "ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS consumer_id String CODEC(ZSTD(1))",
                    "ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS consumer_name String CODEC(ZSTD(1))",
                    "ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS consumer_group String CODEC(ZSTD(1))",
                    "ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS trace_id String CODEC(ZSTD(1))",
                    "ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS span_id String CODEC(ZSTD(1))",
                    "ALTER TABLE api_logs ADD INDEX IF NOT EXISTS idx_api_logs_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 1",
                ):
                    client.execute(stmt)
            except Exception as exc:
                logger.warning("Unable to ensure api_logs table: %s", exc)
                return
            IngestService._api_logs_table_ready = True

    @staticmethod
    def ensure_api_spans_table(client) -> None:
        # Keep in lock-step with apps/ingest ensure_clickhouse_schema.
        if IngestService._api_spans_table_ready:
            return
        with IngestService._api_spans_table_lock:
            if IngestService._api_spans_table_ready:
                return
            try:
                client.execute(
                    """
                    CREATE TABLE IF NOT EXISTS api_spans (
                        timestamp DateTime64(3) CODEC(DoubleDelta, ZSTD(1)),
                        app_id String CODEC(ZSTD(1)),
                        project_id String CODEC(ZSTD(1)),
                        environment LowCardinality(String) CODEC(ZSTD(1)),
                        trace_id String CODEC(ZSTD(1)),
                        span_id String CODEC(ZSTD(1)),
                        parent_span_id String CODEC(ZSTD(1)),
                        name String CODEC(ZSTD(1)),
                        kind LowCardinality(String) CODEC(ZSTD(1)),
                        service_name LowCardinality(String) CODEC(ZSTD(1)),
                        duration_ms Float64 CODEC(Gorilla, ZSTD(1)),
                        status LowCardinality(String) CODEC(ZSTD(1)),
                        status_code UInt16 CODEC(ZSTD(1)),
                        attributes_json String CODEC(ZSTD(3))
                    ) ENGINE = MergeTree()
                    PARTITION BY toYYYYMM(timestamp)
                    ORDER BY (app_id, trace_id, timestamp)
                    TTL toDateTime(timestamp) + INTERVAL 30 DAY
                    SETTINGS index_granularity = 8192
                    """
                )
                client.execute(
                    "ALTER TABLE api_spans ADD INDEX IF NOT EXISTS idx_api_spans_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 1"
                )
                client.execute(
                    "ALTER TABLE api_spans ADD INDEX IF NOT EXISTS idx_api_spans_project_id project_id TYPE bloom_filter(0.01) GRANULARITY 1"
                )
            except Exception as exc:
                logger.warning("Unable to ensure api_spans table: %s", exc)
                return
            IngestService._api_spans_table_ready = True

    @staticmethod
    def _safe_log_text(value: str, *, limit: int) -> str:
        if not value:
            return ""
        text = str(value)
        if len(text) <= limit:
            return text
        return text[:limit]

    @staticmethod
    def _normalize_log_level(value: str) -> str:
        level = (value or "INFO").strip().upper()
        if level in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            return level
        if level == "WARN":
            return "WARNING"
        return "INFO"

    @staticmethod
    def _sanitize_log_attributes(attributes: Any) -> dict[str, str]:
        if not isinstance(attributes, dict):
            return {}
        output: dict[str, str] = {}
        for key, raw_value in attributes.items():
            if len(output) >= IngestService.MAX_LOG_ATTRIBUTES:
                break
            clean_key = str(key or "").strip()
            if not clean_key:
                continue
            clean_key = clean_key[: IngestService.MAX_LOG_ATTRIBUTE_KEY_CHARS]
            # Keep attributes flat and scalar only (no nested objects/lists).
            if isinstance(raw_value, (dict, list, tuple, set)):
                continue
            output[clean_key] = IngestService._safe_log_text(
                str(raw_value or ""),
                limit=IngestService.MAX_LOG_ATTRIBUTE_VALUE_CHARS,
            )
        return output


class EndpointStatsService:
    @staticmethod
    def get_endpoint_meta(app_id: str, endpoint_id: str) -> dict:
        try:
            endpoint = Endpoint.objects.get(id=endpoint_id, app_id=app_id, is_active=True)
        except Endpoint.DoesNotExist as exc:
            raise NotFoundError("Endpoint not found") from exc
        return {
            "id": str(endpoint.id),
            "method": endpoint.method,
            "path": endpoint.path,
        }

    @staticmethod
    def get_endpoint_stats(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        status_classes: list[str] | None = None,
        status_codes: list[int] | None = None,
        methods: list[str] | None = None,
        paths: list[str] | None = None,
        endpoint_pairs: list[tuple[str, str]] | None = None,
        search: str | None = None,
        sort_by: str = "total_requests",
        sort_dir: str = "desc",
        page: int = 1,
        page_size: int = 25,
        status_class: str | None = None,
        status_code: int | None = None,
    ) -> dict:
        from core.database.clickhouse.client import get_clickhouse_client

        safe_page = max(1, int(page))
        safe_size = max(1, min(int(page_size), 200))

        client = None
        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; continuing with endpoint-only stats: %s", exc)

        since_dt, until_dt = _resolve_time_range(since, until)

        params = {
            "app_id": app_id,
            "since": since_dt,
            "until": until_dt,
        }

        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        normalized_classes: list[str] = []
        if status_classes:
            for item in status_classes:
                if item in {"2xx", "3xx", "4xx", "5xx"} and item not in normalized_classes:
                    normalized_classes.append(item)
        if status_class in {"2xx", "3xx", "4xx", "5xx"} and status_class not in normalized_classes:
            normalized_classes.append(status_class)

        normalized_codes: list[int] = []
        if status_codes:
            for item in status_codes:
                code = int(item)
                if 100 <= code <= 599 and code not in normalized_codes:
                    normalized_codes.append(code)
        if status_code is not None:
            code = int(status_code)
            if 100 <= code <= 599 and code not in normalized_codes:
                normalized_codes.append(code)

        status_predicates: list[str] = []
        for idx, cls in enumerate(normalized_classes):
            min_key = f"status_class_{idx}_min"
            max_key = f"status_class_{idx}_max"
            base = int(cls[0]) * 100
            params[min_key] = base
            params[max_key] = base + 100
            status_predicates.append(f"(status_code >= %({min_key})s AND status_code < %({max_key})s)")

        if normalized_codes:
            code_keys: list[str] = []
            for idx, code in enumerate(normalized_codes):
                key = f"status_code_{idx}"
                params[key] = code
                code_keys.append(f"%({key})s")
            status_predicates.append(f"(status_code IN ({', '.join(code_keys)}))")

        status_filter = ""
        if status_predicates:
            status_filter = f"AND ({' OR '.join(status_predicates)})"

        methods_filter = ""
        normalized_methods: list[str] = []
        if methods:
            for method in methods:
                m = method.upper().strip()
                if m and m not in normalized_methods:
                    normalized_methods.append(m)
            if normalized_methods:
                method_keys: list[str] = []
                for idx, method in enumerate(normalized_methods):
                    key = f"method_{idx}"
                    params[key] = method
                    method_keys.append(f"%({key})s")
                methods_filter = f"AND method IN ({', '.join(method_keys)})"

        paths_filter = ""
        normalized_paths: list[str] = []
        if paths:
            for p in paths:
                path = p.strip()
                if path and path not in normalized_paths:
                    normalized_paths.append(path)
            if normalized_paths:
                path_keys: list[str] = []
                for idx, p in enumerate(normalized_paths):
                    key = f"path_{idx}"
                    params[key] = p
                    path_keys.append(f"%({key})s")
                paths_filter = f"AND path IN ({', '.join(path_keys)})"

        endpoint_pairs_filter = ""
        normalized_pairs: list[tuple[str, str]] = []
        if endpoint_pairs:
            for method, path in endpoint_pairs:
                clean_method = (method or "").strip().upper()
                clean_path = (path or "").strip()
                if not clean_method or not clean_path:
                    continue
                pair = (clean_method, clean_path)
                if pair not in normalized_pairs:
                    normalized_pairs.append(pair)

            if normalized_pairs:
                pair_predicates: list[str] = []
                for idx, (method, path) in enumerate(normalized_pairs):
                    method_key = f"pair_method_{idx}"
                    path_key = f"pair_path_{idx}"
                    params[method_key] = method
                    params[path_key] = path
                    pair_predicates.append(f"(method = %({method_key})s AND path = %({path_key})s)")
                endpoint_pairs_filter = f"AND ({' OR '.join(pair_predicates)})"

        search_filter = ""
        normalized_search = (search or "").strip().lower()
        if normalized_search:
            params["search"] = f"%{normalized_search}%"
            search_filter = "AND (lower(path) LIKE %(search)s OR lower(method) LIKE %(search)s)"

        query = f"""
            SELECT
                method,
                path,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms,
                quantile(0.95)(response_time_ms) AS p95_response_time_ms,
                sum(request_size) AS total_request_bytes,
                sum(response_size) AS total_response_bytes,
                max(timestamp) AS last_seen_at
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
              {status_filter}
              {methods_filter}
              {paths_filter}
              {endpoint_pairs_filter}
              {search_filter}
            GROUP BY method, path
        """

        try:
            stats_rows = client.execute(query, params) if client is not None else []
            for row in stats_rows:
                row["last_seen_at"] = _as_utc(row.get("last_seen_at"))
            stats_map: dict[tuple[str, str], dict] = {
                (row["method"], row["path"]): row for row in stats_rows
            }

            endpoint_qs = Endpoint.objects.filter(app_id=app_id, is_active=True)
            if normalized_methods:
                endpoint_qs = endpoint_qs.filter(method__in=normalized_methods)
            if normalized_paths:
                endpoint_qs = endpoint_qs.filter(path__in=normalized_paths)
            if normalized_pairs:
                pair_query = Q()
                for pair_method, pair_path in normalized_pairs:
                    pair_query |= Q(method=pair_method, path=pair_path)
                endpoint_qs = endpoint_qs.filter(pair_query)
            if normalized_search:
                endpoint_qs = endpoint_qs.filter(
                    Q(path__icontains=normalized_search) | Q(method__icontains=normalized_search)
                )

            endpoints = list(endpoint_qs)
            endpoint_model_map: dict[tuple[str, str], Endpoint] = {
                (endpoint.method, endpoint.path): endpoint for endpoint in endpoints
            }

            items: list[dict] = []
            endpoint_keys: set[tuple[str, str]] = set()
            for endpoint in endpoints:
                key = (endpoint.method, endpoint.path)
                endpoint_keys.add(key)
                row = stats_map.get(key)
                if row:
                    row["endpoint_id"] = str(endpoint.id)
                    items.append(row)
                    continue
                items.append(
                    {
                        "endpoint_id": str(endpoint.id),
                        "method": endpoint.method,
                        "path": endpoint.path,
                        "total_requests": 0,
                        "error_count": 0,
                        "error_rate": 0.0,
                        "avg_response_time_ms": 0.0,
                        "p95_response_time_ms": 0.0,
                        "total_request_bytes": 0,
                        "total_response_bytes": 0,
                        "last_seen_at": _as_utc(endpoint.last_seen_at),
                    }
                )

            for key, row in stats_map.items():
                if key not in endpoint_keys:
                    row["endpoint_id"] = None
                    items.append(row)

            reverse = str(sort_dir).lower() != "asc"
            if sort_by == "endpoint":
                items.sort(key=lambda row: (str(row.get("method", "")), str(row.get("path", ""))), reverse=reverse)
            elif sort_by == "error_rate":
                items.sort(key=lambda row: float(row.get("error_rate") or 0.0), reverse=reverse)
            elif sort_by == "avg_response_time_ms":
                items.sort(key=lambda row: float(row.get("avg_response_time_ms") or 0.0), reverse=reverse)
            elif sort_by == "p95_response_time_ms":
                items.sort(key=lambda row: float(row.get("p95_response_time_ms") or 0.0), reverse=reverse)
            elif sort_by == "data_transfer":
                items.sort(
                    key=lambda row: int(row.get("total_request_bytes") or 0) + int(row.get("total_response_bytes") or 0),
                    reverse=reverse,
                )
            elif sort_by == "last_seen_at":
                items.sort(
                    key=lambda row: _as_utc(row.get("last_seen_at")) or datetime.min.replace(tzinfo=tz.utc),
                    reverse=reverse,
                )
            else:
                items.sort(key=lambda row: int(row.get("total_requests") or 0), reverse=reverse)

            total_count = len(items)
            offset = (safe_page - 1) * safe_size
            page_items = items[offset: offset + safe_size]
            return {
                "items": page_items,
                "total_count": total_count,
                "page": safe_page,
                "page_size": safe_size,
            }
        except Exception as exc:
            logger.warning("ClickHouse query failed for endpoint stats; returning empty list: %s", exc)
            return {"items": [], "total_count": 0, "page": safe_page, "page_size": safe_size}

    @staticmethod
    def get_endpoint_options(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        status_classes: list[str] | None = None,
        status_codes: list[int] | None = None,
        methods: list[str] | None = None,
        search: str | None = None,
        limit: int = 500,
    ) -> list[dict]:
        # Reuse get_endpoint_stats filtering and request first page with large size,
        # but return only endpoint keys for dropdown options.
        data = EndpointStatsService.get_endpoint_stats(
            app_id=app_id,
            environment=environment,
            since=since,
            until=until,
            status_classes=status_classes,
            status_codes=status_codes,
            methods=methods,
            search=search,
            sort_by="total_requests",
            sort_dir="desc",
            page=1,
            page_size=max(1, min(limit, 1000)),
        )
        return [
            {
                "method": row["method"],
                "path": row["path"],
                "total_requests": row["total_requests"],
            }
            for row in data.get("items", [])
        ]

    @staticmethod
    def get_environment_options(
        app_id: str,
        since: str | None = None,
        until: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty environment options: %s", exc)
            return []

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "app_id": app_id,
            "since": since_dt,
            "until": until_dt,
            "limit": max(1, min(limit, 100)),
        }
        query = """
            SELECT
                environment,
                count() AS total_requests
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              AND length(environment) > 0
            GROUP BY environment
            ORDER BY total_requests DESC
            LIMIT %(limit)s
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for environment options; returning empty list: %s", exc)
            return []


class ConsumerStatsService:
    @staticmethod
    def get_consumer_stats(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 20,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty consumer stats: %s", exc)
            return []
        IngestService.ensure_consumer_columns(client)

        since_dt, until_dt = _resolve_time_range(since, until)

        params = {
            "app_id": app_id,
            "since": since_dt,
            "until": until_dt,
            "limit": max(1, min(limit, 100)),
        }

        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                if(
                    consumer_name != '',
                    consumer_name,
                    if(
                        consumer_id != '',
                        consumer_id,
                        'unknown'
                    )
                ) AS consumer,
                if(consumer_id != '', consumer_id, '') AS consumer_identifier,
                if(consumer_name != '', consumer_name, '') AS consumer_name,
                if(consumer_group != '', consumer_group, '') AS consumer_group,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms,
                max(timestamp) AS last_seen_at
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
            GROUP BY consumer, consumer_identifier, consumer_name, consumer_group
            ORDER BY total_requests DESC
            LIMIT %(limit)s
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for consumer stats; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_consumer_request_stats(
        app_id: str,
        consumer: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 100,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        if not consumer or not consumer.strip():
            return []

    @staticmethod
    def get_consumer_activity(
        app_id: str,
        consumer: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        method: str | None = None,
        path: str | None = None,
        limit: int = 100,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        if not consumer or not consumer.strip():
            return []

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning(
                "ClickHouse client initialization failed; returning empty consumer activity: %s",
                exc,
            )
            return []
        IngestService.ensure_payload_columns(client)
        IngestService.ensure_consumer_columns(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "app_id": app_id,
            "consumer": consumer.strip(),
            "since": since_dt,
            "until": until_dt,
            "limit": max(1, min(limit, 500)),
        }

        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        method_filter = ""
        if method:
            method_filter = "AND method = %(method)s"
            params["method"] = method.upper().strip()

        path_filter = ""
        if path:
            path_filter = "AND path = %(path)s"
            params["path"] = path.strip()

        query = f"""
            SELECT
                timestamp,
                method,
                path,
                status_code,
                response_time_ms,
                environment,
                consumer_id,
                consumer_name,
                consumer_group,
                request_payload,
                response_payload
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
              {method_filter}
              {path_filter}
              AND if(
                    consumer_name != '',
                    consumer_name,
                    if(
                        consumer_id != '',
                        consumer_id,
                        'unknown'
                    )
                  ) = %(consumer)s
            ORDER BY timestamp DESC
            LIMIT %(limit)s
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning(
                "ClickHouse query failed for consumer activity; returning empty list: %s",
                exc,
            )
            return []

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning(
                "ClickHouse client initialization failed; returning empty consumer request stats: %s",
                exc,
            )
            return []
        IngestService.ensure_consumer_columns(client)

        since_dt, until_dt = _resolve_time_range(since, until)

        params = {
            "app_id": app_id,
            "consumer": consumer.strip(),
            "since": since_dt,
            "until": until_dt,
            "limit": max(1, min(limit, 500)),
        }

        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                %(consumer)s AS consumer,
                method,
                path,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms,
                max(timestamp) AS last_seen_at
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
              AND if(
                    consumer_name != '',
                    consumer_name,
                    if(
                        consumer_id != '',
                        consumer_id,
                        'unknown'
                    )
                  ) = %(consumer)s
            GROUP BY method, path
            ORDER BY total_requests DESC
            LIMIT %(limit)s
        """
        try:
            rows = client.execute(query, params)
            for row in rows:
                row["last_seen_at"] = _as_utc(row.get("last_seen_at"))
            return rows
        except Exception as exc:
            logger.warning(
                "ClickHouse query failed for consumer request stats; returning empty list: %s",
                exc,
            )
            return []


class LogsService:
    @staticmethod
    def _build_log_filters(
        params: dict[str, Any],
        environment: str | None = None,
        levels: list[str] | None = None,
        search: str | None = None,
        attribute_filters: list[tuple[str, str]] | None = None,
        logger_filters: list[str] | None = None,
    ) -> str:
        filters: list[str] = []
        if environment:
            filters.append("AND environment = %(environment)s")
            params["environment"] = environment

        normalized_levels: list[str] = []
        if levels:
            for raw in levels:
                value = IngestService._normalize_log_level(raw)
                if value not in normalized_levels:
                    normalized_levels.append(value)
        if normalized_levels:
            level_placeholders: list[str] = []
            for idx, level in enumerate(normalized_levels):
                key = f"level_{idx}"
                params[key] = level
                level_placeholders.append(f"%({key})s")
            filters.append(f"AND level IN ({', '.join(level_placeholders)})")

        if logger_filters:
            logger_placeholders: list[str] = []
            for idx, logger_name in enumerate(logger_filters):
                key = f"logger_{idx}"
                params[key] = logger_name
                logger_placeholders.append(f"%({key})s")
            filters.append(f"AND logger_name IN ({', '.join(logger_placeholders)})")

        if attribute_filters:
            for idx, (attr_key, attr_value) in enumerate(attribute_filters):
                key_name = f"attr_key_{idx}"
                value_name = f"attr_value_{idx}"
                params[key_name] = attr_key
                params[value_name] = attr_value
                filters.append(
                    f"AND JSONExtractString(attributes_json, %({key_name})s) = %({value_name})s"
                )

        if search:
            filters.append(
                "AND (lower(message) LIKE %(search)s OR lower(logger_name) LIKE %(search)s OR lower(attributes_json) LIKE %(search)s)"
            )
            params["search"] = f"%{search.strip().lower()}%"

        return "\n              ".join(filters)

    @staticmethod
    def get_logs(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        levels: list[str] | None = None,
        search: str | None = None,
        attribute_filters: list[tuple[str, str]] | None = None,
        logger_filters: list[str] | None = None,
        page: int = 1,
        page_size: int = 50,
    ) -> dict:
        from core.database.clickhouse.client import get_clickhouse_client

        safe_page = max(1, int(page))
        safe_size = max(1, min(int(page_size), 200))
        offset = (safe_page - 1) * safe_size

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty logs list: %s", exc)
            return {
                "items": [],
                "total_count": 0,
                "page": safe_page,
                "page_size": safe_size,
            }

        IngestService.ensure_api_logs_table(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params: dict[str, Any] = {
            "app_id": app_id,
            "since": since_dt,
            "until": until_dt,
            "limit": safe_size,
            "offset": offset,
        }

        where_filters = LogsService._build_log_filters(
            params,
            environment=environment,
            levels=levels,
            search=search,
            attribute_filters=attribute_filters,
            logger_filters=logger_filters,
        )

        count_query = f"""
            SELECT count() AS total_count
            FROM api_logs
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {where_filters}
        """

        rows_query = f"""
            SELECT
                timestamp,
                environment,
                level,
                message,
                logger_name,
                payload,
                attributes_json
            FROM api_logs
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {where_filters}
            ORDER BY timestamp DESC
            LIMIT %(limit)s
            OFFSET %(offset)s
        """
        try:
            count_rows = client.execute(count_query, params)
            total_count = int(count_rows[0]["total_count"]) if count_rows else 0
            items = client.execute(rows_query, params)
            for item in items:
                item["timestamp"] = _as_utc(item.get("timestamp"))
                raw_attributes = item.get("attributes_json", "") or "{}"
                try:
                    parsed = json.loads(raw_attributes)
                    if not isinstance(parsed, dict):
                        parsed = {}
                except Exception:
                    parsed = {}
                item["attributes"] = {str(k): str(v) for k, v in parsed.items()}
                item.pop("attributes_json", None)
            return {
                "items": items,
                "total_count": total_count,
                "page": safe_page,
                "page_size": safe_size,
            }
        except Exception as exc:
            logger.warning("ClickHouse query failed for logs; returning empty list: %s", exc)
            return {
                "items": [],
                "total_count": 0,
                "page": safe_page,
                "page_size": safe_size,
            }

    @staticmethod
    def get_logs_summary(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        levels: list[str] | None = None,
        search: str | None = None,
        attribute_filters: list[tuple[str, str]] | None = None,
        logger_filters: list[str] | None = None,
    ) -> dict:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty logs summary: %s", exc)
            return {
                "total_logs": 0,
                "error_logs": 0,
                "warning_logs": 0,
                "unique_loggers": 0,
            }

        IngestService.ensure_api_logs_table(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params: dict[str, Any] = {
            "app_id": app_id,
            "since": since_dt,
            "until": until_dt,
        }
        where_filters = LogsService._build_log_filters(
            params,
            environment=environment,
            levels=levels,
            search=search,
            attribute_filters=attribute_filters,
            logger_filters=logger_filters,
        )

        query = f"""
            SELECT
                count() AS total_logs,
                countIf(level IN ('ERROR', 'CRITICAL')) AS error_logs,
                countIf(level = 'WARNING') AS warning_logs,
                uniqExactIf(logger_name, logger_name != '') AS unique_loggers
            FROM api_logs
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {where_filters}
        """
        try:
            rows = client.execute(query, params)
            if rows:
                return rows[0]
        except Exception as exc:
            logger.warning("ClickHouse query failed for logs summary; returning empty summary: %s", exc)

        return {
            "total_logs": 0,
            "error_logs": 0,
            "warning_logs": 0,
            "unique_loggers": 0,
        }

    @staticmethod
    def get_logs_timeseries(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        levels: list[str] | None = None,
        search: str | None = None,
        attribute_filters: list[tuple[str, str]] | None = None,
        logger_filters: list[str] | None = None,
        bucket_minutes: int = 5,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        allowed_buckets = {5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440}
        safe_bucket = int(bucket_minutes) if int(bucket_minutes) in allowed_buckets else 5

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty logs timeseries: %s", exc)
            return []

        IngestService.ensure_api_logs_table(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params: dict[str, Any] = {
            "app_id": app_id,
            "since": since_dt,
            "until": until_dt,
            "bucket_minutes": safe_bucket,
        }

        where_filters = LogsService._build_log_filters(
            params,
            environment=environment,
            levels=levels,
            search=search,
            attribute_filters=attribute_filters,
            logger_filters=logger_filters,
        )

        query = f"""
            SELECT
                toStartOfInterval(timestamp, toIntervalMinute(%(bucket_minutes)s)) AS bucket,
                count() AS count
            FROM api_logs
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {where_filters}
            GROUP BY bucket
            ORDER BY bucket ASC
        """

        try:
            rows = client.execute(query, params)
            for row in rows:
                row["bucket"] = _as_utc(row.get("bucket"))
            return rows
        except Exception as exc:
            logger.warning("ClickHouse query failed for logs timeseries; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_logs_search_options(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        key: str | None = None,
        prefix: str | None = None,
        limit: int = 12,
    ) -> dict:
        from core.database.clickhouse.client import get_clickhouse_client

        safe_limit = max(1, min(int(limit), 50))
        normalized_prefix = (prefix or "").strip().lower()
        normalized_key = (key or "").strip()
        high_cardinality_keys = {
            "trace_id",
            "span_id",
            "request_id",
            "session_id",
            "user_id",
            "device_id",
            "event_id",
            "uuid",
            "id",
        }

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty logs search options: %s", exc)
            return {"keys": [], "values": [], "loggers": []}

        IngestService.ensure_api_logs_table(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params: dict[str, Any] = {
            "app_id": app_id,
            "since": since_dt,
            "until": until_dt,
            "limit": safe_limit,
        }
        filters: list[str] = []
        if environment:
            filters.append("AND environment = %(environment)s")
            params["environment"] = environment
        if normalized_prefix:
            params["prefix_like"] = f"%{normalized_prefix}%"
        where_filters = "\n              ".join(filters)

        try:
            key_rows = client.execute(
                f"""
                SELECT key
                FROM (
                    SELECT arrayJoin(JSONExtractKeys(attributes_json)) AS key
                    FROM api_logs
                    WHERE app_id = %(app_id)s
                      AND timestamp >= %(since)s
                      AND timestamp <= %(until)s
                      {where_filters}
                )
                WHERE key != ''
                  {"AND lower(key) LIKE %(prefix_like)s" if normalized_prefix else ""}
                GROUP BY key
                ORDER BY count() DESC
                LIMIT %(limit)s
                """,
                params,
            )
            logger_rows = client.execute(
                f"""
                SELECT logger_name AS value
                FROM api_logs
                WHERE app_id = %(app_id)s
                  AND timestamp >= %(since)s
                  AND timestamp <= %(until)s
                  {where_filters}
                  AND logger_name != ''
                  {"AND lower(logger_name) LIKE %(prefix_like)s" if normalized_prefix else ""}
                GROUP BY value
                ORDER BY count() DESC
                LIMIT %(limit)s
                """,
                params,
            )

            value_rows: list[dict[str, Any]] = []
            if normalized_key.lower() == "logger":
                value_rows = logger_rows
            elif normalized_key:
                # Prevent expensive scans on likely high-cardinality keys.
                if normalized_key.lower() in high_cardinality_keys and len(normalized_prefix) < 4:
                    return {
                        "keys": [str(row.get("key", "")) for row in key_rows if row.get("key")],
                        "values": [],
                        "loggers": [str(row.get("value", "")) for row in logger_rows if row.get("value")],
                    }
                value_params = dict(params)
                value_params["attr_key"] = normalized_key
                value_rows = client.execute(
                    f"""
                    SELECT value
                    FROM (
                        SELECT JSONExtractString(attributes_json, %(attr_key)s) AS value
                        FROM api_logs
                        WHERE app_id = %(app_id)s
                          AND timestamp >= %(since)s
                          AND timestamp <= %(until)s
                          {where_filters}
                    )
                    WHERE value != ''
                      {"AND lower(value) LIKE %(prefix_like)s" if normalized_prefix else ""}
                    GROUP BY value
                    ORDER BY count() DESC
                    LIMIT %(limit)s
                    """,
                    value_params,
                )

            return {
                "keys": [str(row.get("key", "")) for row in key_rows if row.get("key")],
                "values": [str(row.get("value", "")) for row in value_rows if row.get("value")],
                "loggers": [str(row.get("value", "")) for row in logger_rows if row.get("value")],
            }
        except Exception as exc:
            logger.warning("ClickHouse query failed for logs search options; returning empty options: %s", exc)
            return {"keys": [], "values": [], "loggers": []}


class DataQueryService:
    """Service for querying raw telemetry data at project level."""

    @staticmethod
    def get_trace_spans(project_id: str, trace_id: str) -> dict:
        """All spans of one trace (the request-detail waterfall).

        No time bounds: the trace_id bloom index makes the point lookup cheap
        and spans of one trace can straddle the caller's visible range.
        """
        from core.database.clickhouse.client import get_clickhouse_client

        clean_trace = (trace_id or "").strip().lower()
        if len(clean_trace) != 32 or any(c not in "0123456789abcdef" for c in clean_trace):
            return {"spans": []}

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty trace: %s", exc)
            return {"spans": []}

        IngestService.ensure_api_spans_table(client)

        query = """
            SELECT
                timestamp,
                app_id,
                environment,
                trace_id,
                span_id,
                parent_span_id,
                name,
                kind,
                service_name,
                duration_ms,
                status,
                status_code,
                attributes_json
            FROM api_spans
            WHERE project_id = %(project_id)s
              AND trace_id = %(trace_id)s
            ORDER BY timestamp ASC
            LIMIT 500
        """
        try:
            spans = client.execute(query, {"project_id": project_id, "trace_id": clean_trace})
            for item in spans:
                item["timestamp"] = _as_utc(item.get("timestamp"))
                raw_attributes = item.pop("attributes_json", "") or "{}"
                try:
                    parsed = json.loads(raw_attributes)
                    if not isinstance(parsed, dict):
                        parsed = {}
                except Exception:
                    parsed = {}
                item["attributes"] = {str(k): str(v) for k, v in parsed.items()}
            return {"spans": spans}
        except Exception as exc:
            logger.warning("ClickHouse query failed for trace spans: %s", exc)
            return {"spans": []}

    @staticmethod
    def get_project_logs(
        project_id: str,
        app_ids: list[str] | None = None,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        levels: list[str] | None = None,
        search: str | None = None,
        attribute_filters: list[tuple[str, str]] | None = None,
        logger_filters: list[str] | None = None,
        trace_id: str | None = None,
        page: int = 1,
        page_size: int = 50,
    ) -> dict:
        """
        Query logs across all apps in a project or specific apps.
        Returns paginated log records with filters.
        """
        from core.database.clickhouse.client import get_clickhouse_client

        safe_page = max(1, int(page))
        safe_size = max(1, min(int(page_size), 200))
        offset = (safe_page - 1) * safe_size

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty logs: %s", exc)
            return {
                "items": [],
                "total_count": 0,
                "page": safe_page,
                "page_size": safe_size,
            }

        IngestService.ensure_api_logs_table(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params: dict[str, Any] = {
            "project_id": project_id,
            "since": since_dt,
            "until": until_dt,
            "limit": safe_size,
            "offset": offset,
        }

        # Build app_ids filter
        app_filter = ""
        if app_ids:
            app_placeholders = []
            for idx, app_id in enumerate(app_ids):
                key = f"app_id_{idx}"
                params[key] = app_id
                app_placeholders.append(f"%({key})s")
            app_filter = f"AND app_id IN ({', '.join(app_placeholders)})"

        where_filters = LogsService._build_log_filters(
            params,
            environment=environment,
            levels=levels,
            search=search,
            attribute_filters=attribute_filters,
            logger_filters=logger_filters,
        )

        if trace_id:
            where_filters += " AND trace_id = %(trace_id)s"
            params["trace_id"] = trace_id.strip().lower()

        count_query = f"""
            SELECT count() AS total_count
            FROM api_logs
            WHERE project_id = %(project_id)s
              {app_filter}
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {where_filters}
        """

        rows_query = f"""
            SELECT
                timestamp,
                app_id,
                environment,
                level,
                message,
                logger_name,
                trace_id,
                span_id,
                payload,
                attributes_json
            FROM api_logs
            WHERE project_id = %(project_id)s
              {app_filter}
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {where_filters}
            ORDER BY timestamp DESC
            LIMIT %(limit)s
            OFFSET %(offset)s
        """

        try:
            count_rows = client.execute(count_query, params)
            total_count = int(count_rows[0]["total_count"]) if count_rows else 0
            items = client.execute(rows_query, params)
            for item in items:
                item["timestamp"] = _as_utc(item.get("timestamp"))
                raw_attributes = item.get("attributes_json", "") or "{}"
                try:
                    parsed = json.loads(raw_attributes)
                    if not isinstance(parsed, dict):
                        parsed = {}
                except Exception:
                    parsed = {}
                item["attributes"] = {str(k): str(v) for k, v in parsed.items()}
                item.pop("attributes_json", None)
            return {
                "items": items,
                "total_count": total_count,
                "page": safe_page,
                "page_size": safe_size,
            }
        except Exception as exc:
            logger.warning("ClickHouse query failed for project logs: %s", exc)
            return {
                "items": [],
                "total_count": 0,
                "page": safe_page,
                "page_size": safe_size,
            }

    @staticmethod
    def get_project_requests(
        project_id: str,
        app_ids: list[str] | None = None,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        methods: list[str] | None = None,
        status_codes: list[int] | None = None,
        min_response_time: float | None = None,
        max_response_time: float | None = None,
        path_filter: str | None = None,
        consumer: str | None = None,
        filter: str | None = None,
        page: int = 1,
        page_size: int = 50,
    ) -> dict:
        """
        Query API requests across all apps in a project or specific apps.
        Returns paginated request records with filters.

        ``filter`` is a canonical rich-filter string (see apps.projects.filters)
        applied additively on top of the discrete params above.
        """
        from core.database.clickhouse.client import get_clickhouse_client

        safe_page = max(1, int(page))
        safe_size = max(1, min(int(page_size), 200))
        offset = (safe_page - 1) * safe_size

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty requests: %s", exc)
            return {
                "items": [],
                "total_count": 0,
                "page": safe_page,
                "page_size": safe_size,
            }
        IngestService.ensure_trace_columns(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params: dict[str, Any] = {
            "project_id": project_id,
            "since": since_dt,
            "until": until_dt,
            "limit": safe_size,
            "offset": offset,
        }

        filters: list[str] = []

        # App filter
        if app_ids:
            app_placeholders = []
            for idx, app_id in enumerate(app_ids):
                key = f"app_id_{idx}"
                params[key] = app_id
                app_placeholders.append(f"%({key})s")
            filters.append(f"app_id IN ({', '.join(app_placeholders)})")

        # Environment filter
        if environment:
            filters.append("environment = %(environment)s")
            params["environment"] = environment

        # Methods filter
        if methods:
            method_placeholders = []
            for idx, method in enumerate(methods):
                key = f"method_{idx}"
                params[key] = method.upper()
                method_placeholders.append(f"%({key})s")
            filters.append(f"method IN ({', '.join(method_placeholders)})")

        # Status codes filter
        if status_codes:
            status_placeholders = []
            for idx, code in enumerate(status_codes):
                key = f"status_{idx}"
                params[key] = int(code)
                status_placeholders.append(f"%({key})s")
            filters.append(f"status_code IN ({', '.join(status_placeholders)})")

        # Response time filters
        if min_response_time is not None:
            filters.append("response_time_ms >= %(min_response_time)s")
            params["min_response_time"] = float(min_response_time)

        if max_response_time is not None:
            filters.append("response_time_ms <= %(max_response_time)s")
            params["max_response_time"] = float(max_response_time)

        # Path filter (supports wildcards)
        if path_filter:
            filters.append("path LIKE %(path_filter)s")
            params["path_filter"] = path_filter.replace("*", "%")

        # Consumer filter — match on the stable identifier, not the display name
        # (names aren't unique and can change; consumer_id is the stable key).
        if consumer:
            filters.append("consumer_id = %(consumer)s")
            params["consumer"] = consumer

        # Rich filter string (apps.projects.filters) — additive on top of the
        # discrete params. This list is joined with " AND ", so strip the
        # leading "AND " the builder emits.
        fragment = AnalyticsService.build_filter_clause(project_id, filter, params)
        if fragment:
            filters.append(fragment.removeprefix("AND ").strip())

        where_clause = ""
        if filters:
            where_clause = "AND " + " AND ".join(filters)

        count_query = f"""
            SELECT count() AS total_count
            FROM api_requests
            WHERE project_id = %(project_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {where_clause}
        """

        rows_query = f"""
            SELECT
                timestamp,
                app_id,
                environment,
                method,
                path,
                status_code,
                response_time_ms,
                request_size,
                response_size,
                ip_address,
                user_agent,
                consumer_id,
                consumer_name,
                consumer_group,
                trace_id,
                span_id
            FROM api_requests
            WHERE project_id = %(project_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {where_clause}
            ORDER BY timestamp DESC
            LIMIT %(limit)s
            OFFSET %(offset)s
        """

        try:
            count_rows = client.execute(count_query, params)
            total_count = int(count_rows[0]["total_count"]) if count_rows else 0
            items = client.execute(rows_query, params)
            for item in items:
                item["timestamp"] = _as_utc(item.get("timestamp"))
            return {
                "items": items,
                "total_count": total_count,
                "page": safe_page,
                "page_size": safe_size,
            }
        except Exception as exc:
            logger.warning("ClickHouse query failed for project requests: %s", exc)
            return {
                "items": [],
                "total_count": 0,
                "page": safe_page,
                "page_size": safe_size,
            }


class AnalyticsService:
    @staticmethod
    def _clean_nan_values(data: dict) -> dict:
        """Replace NaN float values with 0.0 to prevent JSON serialization errors."""
        import math
        cleaned = {}
        for key, value in data.items():
            if isinstance(value, float) and math.isnan(value):
                cleaned[key] = 0.0
            else:
                cleaned[key] = value
        return cleaned
    @staticmethod
    def get_summary(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
    ) -> dict:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty analytics summary: %s", exc)
            return {
                "total_requests": 0,
                "error_count": 0,
                "error_rate": 0.0,
                "avg_response_time_ms": 0.0,
                "p95_response_time_ms": 0.0,
                "total_request_bytes": 0,
                "total_response_bytes": 0,
                "unique_endpoints": 0,
                "unique_consumers": 0,
            }
        IngestService.ensure_consumer_columns(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {"app_id": app_id, "since": since_dt, "until": until_dt}
        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms,
                quantile(0.95)(response_time_ms) AS p95_response_time_ms,
                sum(request_size) AS total_request_bytes,
                sum(response_size) AS total_response_bytes,
                uniqExact((method, path)) AS unique_endpoints,
                uniqExact(
                    if(
                        consumer_name != '',
                        consumer_name,
                        if(
                            consumer_id != '',
                            consumer_id,
                            'unknown'
                        )
                    )
                ) AS unique_consumers
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
        """
        try:
            rows = client.execute(query, params)
            if not rows:
                return {
                    "total_requests": 0,
                    "error_count": 0,
                    "error_rate": 0.0,
                    "avg_response_time_ms": 0.0,
                    "p95_response_time_ms": 0.0,
                    "total_request_bytes": 0,
                    "total_response_bytes": 0,
                    "unique_endpoints": 0,
                    "unique_consumers": 0,
                }
            return AnalyticsService._clean_nan_values(rows[0])
        except Exception as exc:
            logger.warning("ClickHouse query failed for analytics summary; returning empty summary: %s", exc)
            return {
                "total_requests": 0,
                "error_count": 0,
                "error_rate": 0.0,
                "avg_response_time_ms": 0.0,
                "p95_response_time_ms": 0.0,
                "total_request_bytes": 0,
                "total_response_bytes": 0,
                "unique_endpoints": 0,
                "unique_consumers": 0,
            }

    @staticmethod
    def get_timeseries(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        timezone_name: str | None = None,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty analytics timeseries: %s", exc)
            return []

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "app_id": app_id,
            "since": since_dt,
            "until": until_dt,
            "timezone": _resolve_bucket_timezone(timezone_name),
        }
        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                toTimeZone(toStartOfHour(toTimeZone(timestamp, %(timezone)s)), 'UTC') AS bucket,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms,
                quantile(0.95)(response_time_ms) AS p95_response_time_ms,
                sum(request_size) AS total_request_bytes,
                sum(response_size) AS total_response_bytes
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
            GROUP BY bucket
            ORDER BY bucket ASC
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for analytics timeseries; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_related_apis(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 20,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty related api stats: %s", exc)
            return []

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "app_id": app_id,
            "since": since_dt,
            "until": until_dt,
            "limit": max(1, min(limit, 100)),
        }
        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                if(
                    length(splitByChar('/', trim(BOTH '/' FROM path))) = 0,
                    '/',
                    concat('/', splitByChar('/', trim(BOTH '/' FROM path))[1])
                ) AS family,
                uniqExact((method, path)) AS endpoint_count,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
            GROUP BY family
            ORDER BY total_requests DESC
            LIMIT %(limit)s
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for related api stats; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_endpoint_detail(
        app_id: str,
        method: str,
        path: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
    ) -> dict:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty endpoint detail: %s", exc)
            return {
                "method": method.upper(),
                "path": path,
                "total_requests": 0,
                "error_count": 0,
                "error_rate": 0.0,
                "avg_response_time_ms": 0.0,
                "p95_response_time_ms": 0.0,
                "total_request_bytes": 0,
                "total_response_bytes": 0,
                "last_seen_at": None,
            }

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "app_id": app_id,
            "method": method.upper(),
            "path": path,
            "since": since_dt,
            "until": until_dt,
        }
        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                method,
                path,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms,
                quantile(0.95)(response_time_ms) AS p95_response_time_ms,
                sum(request_size) AS total_request_bytes,
                sum(response_size) AS total_response_bytes,
                max(timestamp) AS last_seen_at
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND method = %(method)s
              AND path = %(path)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
            GROUP BY method, path
            LIMIT 1
        """
        try:
            rows = client.execute(query, params)
            if rows:
                return rows[0]
        except Exception as exc:
            logger.warning("ClickHouse query failed for endpoint detail; returning empty detail: %s", exc)

        return {
            "method": method.upper(),
            "path": path,
            "total_requests": 0,
            "error_count": 0,
            "error_rate": 0.0,
            "avg_response_time_ms": 0.0,
            "p95_response_time_ms": 0.0,
            "total_request_bytes": 0,
            "total_response_bytes": 0,
            "last_seen_at": None,
        }

    @staticmethod
    def get_endpoint_timeseries(
        app_id: str,
        method: str,
        path: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        timezone_name: str | None = None,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty endpoint timeseries: %s", exc)
            return []

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "app_id": app_id,
            "method": method.upper(),
            "path": path,
            "since": since_dt,
            "until": until_dt,
            "timezone": _resolve_bucket_timezone(timezone_name),
        }
        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                toTimeZone(toStartOfHour(toTimeZone(timestamp, %(timezone)s)), 'UTC') AS bucket,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                avg(response_time_ms) AS avg_response_time_ms
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND method = %(method)s
              AND path = %(path)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
            GROUP BY bucket
            ORDER BY bucket ASC
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for endpoint timeseries; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_endpoint_consumers(
        app_id: str,
        method: str,
        path: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 10,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty endpoint consumers: %s", exc)
            return []
        IngestService.ensure_consumer_columns(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "app_id": app_id,
            "method": method.upper(),
            "path": path,
            "since": since_dt,
            "until": until_dt,
            "limit": max(1, min(limit, 50)),
        }
        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                if(
                    consumer_name != '',
                    consumer_name,
                    if(
                        consumer_id != '',
                        consumer_id,
                        'unknown'
                    )
                ) AS consumer,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND method = %(method)s
              AND path = %(path)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
            GROUP BY consumer
            ORDER BY total_requests DESC
            LIMIT %(limit)s
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for endpoint consumers; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_endpoint_status_codes(
        app_id: str,
        method: str,
        path: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 20,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty endpoint status-code stats: %s", exc)
            return []

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "app_id": app_id,
            "method": method.upper(),
            "path": path,
            "since": since_dt,
            "until": until_dt,
            "limit": max(1, min(limit, 50)),
        }
        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                status_code,
                count() AS total_requests
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND method = %(method)s
              AND path = %(path)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
            GROUP BY status_code
            ORDER BY total_requests DESC
            LIMIT %(limit)s
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for endpoint status-code stats; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_endpoint_payloads(
        app_id: str,
        method: str,
        path: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 20,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty endpoint payloads: %s", exc)
            return []
        IngestService.ensure_payload_columns(client)
        IngestService.ensure_consumer_columns(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "app_id": app_id,
            "method": method.upper(),
            "path": path,
            "since": since_dt,
            "until": until_dt,
            "limit": max(1, min(limit, 100)),
        }
        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                timestamp,
                method,
                path,
                status_code,
                response_time_ms,
                environment,
                ip_address,
                user_agent,
                consumer_id,
                consumer_name,
                consumer_group,
                request_payload,
                response_payload
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND method = %(method)s
              AND path = %(path)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
            ORDER BY timestamp DESC
            LIMIT %(limit)s
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for endpoint payload samples; returning empty list: %s", exc)
            return []

    # ── Project-Level Analytics Methods ──────────────────────────────────

    @staticmethod
    def build_filter_clause(project_id: str, filter: str | None, params: dict, key_prefix: str = "flt") -> str:
        """
        Turn a canonical rich-filter string (apps.projects.filters) into a
        parameterised ``AND (...) AND (...)`` SQL fragment over ``api_requests``.

        `app` predicates carry slugs from the UI; they're resolved to the
        app_id values stored in ClickHouse here (unknown slugs → a sentinel
        that matches nothing). Mutates ``params`` and returns the fragment
        (empty string when there's no filter). Raises ValidationError on a
        malformed filter (mapped to HTTP 422).
        """
        if not filter:
            return ""
        from apps.projects.filters import parse_filter, build_where, Predicate
        from apps.projects.models import App

        remapped: list = []
        for p in parse_filter(filter):
            if p.field == "app":
                ids = [
                    str(i)
                    for i in App.objects.filter(
                        project_id=project_id, slug__in=p.values
                    ).values_list("id", flat=True)
                ]
                remapped.append(Predicate("app", p.op, ids or ["__no_app__"], p.negate))
            else:
                remapped.append(p)
        return build_where(remapped, params, key_prefix=key_prefix)

    @staticmethod
    def get_project_summary(
        project_id: str,
        app_ids: list[str] | None = None,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        consumer: str | None = None,
        filter: str | None = None,
    ) -> dict:
        """
        Get aggregated analytics summary for a project.
        Optionally filter by specific app within the project.
        """
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty analytics summary: %s", exc)
            return {
                "total_requests": 0,
                "error_count": 0,
                "error_rate": 0.0,
                "avg_response_time_ms": 0.0,
                "p95_response_time_ms": 0.0,
                "total_request_bytes": 0,
                "total_response_bytes": 0,
                "unique_endpoints": 0,
                "unique_consumers": 0,
            }

        IngestService.ensure_consumer_columns(client)
        since_dt, until_dt = _resolve_time_range(since, until)
        params = {"project_id": project_id, "since": since_dt, "until": until_dt}

        filters = ["WHERE project_id = %(project_id)s"]
        filters.append("AND timestamp >= %(since)s")
        filters.append("AND timestamp <= %(until)s")

        if app_ids:
            filters.append("AND app_id IN %(app_ids)s")
            params["app_ids"] = app_ids

        if environment:
            filters.append("AND environment = %(environment)s")
            params["environment"] = environment

        if consumer:
            # Filter on the stable identifier, not the display name.
            filters.append("AND consumer_id = %(consumer)s")
            params["consumer"] = consumer

        filters.append(AnalyticsService.build_filter_clause(project_id, filter, params))

        query = f"""
            SELECT
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms,
                quantile(0.95)(response_time_ms) AS p95_response_time_ms,
                sum(request_size) AS total_request_bytes,
                sum(response_size) AS total_response_bytes,
                uniqExact((method, path)) AS unique_endpoints,
                uniqExact(
                    if(
                        consumer_name != '',
                        consumer_name,
                        if(
                            consumer_id != '',
                            consumer_id,
                            'unknown'
                        )
                    )
                ) AS unique_consumers
            FROM api_requests
            {' '.join(filters)}
        """
        try:
            rows = client.execute(query, params)
            if not rows:
                return {
                    "total_requests": 0,
                    "error_count": 0,
                    "error_rate": 0.0,
                    "avg_response_time_ms": 0.0,
                    "p95_response_time_ms": 0.0,
                    "total_request_bytes": 0,
                    "total_response_bytes": 0,
                    "unique_endpoints": 0,
                    "unique_consumers": 0,
                }
            return AnalyticsService._clean_nan_values(rows[0])
        except Exception as exc:
            logger.warning("ClickHouse query failed for project analytics summary; returning empty summary: %s", exc)
            return {
                "total_requests": 0,
                "error_count": 0,
                "error_rate": 0.0,
                "avg_response_time_ms": 0.0,
                "p95_response_time_ms": 0.0,
                "total_request_bytes": 0,
                "total_response_bytes": 0,
                "unique_endpoints": 0,
                "unique_consumers": 0,
            }

    @staticmethod
    def get_project_timeseries(
        project_id: str,
        app_ids: list[str] | None = None,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        timezone_name: str | None = None,
        consumer: str | None = None,
        filter: str | None = None,
    ) -> list[dict]:
        """
        Get time-series analytics for a project.
        Optionally filter by specific app within the project.
        """
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty timeseries: %s", exc)
            return []

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "project_id": project_id,
            "since": since_dt,
            "until": until_dt,
            "timezone": _resolve_bucket_timezone(timezone_name),
        }

        filters = ["WHERE project_id = %(project_id)s"]
        filters.append("AND timestamp >= %(since)s")
        filters.append("AND timestamp <= %(until)s")

        if app_ids:
            filters.append("AND app_id IN %(app_ids)s")
            params["app_ids"] = app_ids

        if environment:
            filters.append("AND environment = %(environment)s")
            params["environment"] = environment

        if consumer:
            # Filter on the stable identifier, not the display name.
            filters.append("AND consumer_id = %(consumer)s")
            params["consumer"] = consumer

        filters.append(AnalyticsService.build_filter_clause(project_id, filter, params))

        # Pick a bucket granularity that fits the window: hourly for short
        # ranges (≤48h), daily beyond that — so a 30-day view shows ~30 daily
        # bars instead of hundreds of sparse hourly ones. WITH FILL backfills
        # empty buckets across the whole range so the timeline is continuous and
        # gaps (days with no traffic) stay visible instead of being collapsed.
        span_hours = (until_dt - since_dt).total_seconds() / 3600.0
        bucket_fn, step_unit = ("toStartOfHour", "HOUR") if span_hours <= 48 else ("toStartOfDay", "DAY")
        bucket_expr = f"toTimeZone({bucket_fn}(toTimeZone(timestamp, %(timezone)s)), 'UTC')"
        fill_from = f"toTimeZone({bucket_fn}(toTimeZone(toDateTime(%(since)s), %(timezone)s)), 'UTC')"
        fill_to = f"toTimeZone({bucket_fn}(toTimeZone(toDateTime(%(until)s), %(timezone)s)), 'UTC') + INTERVAL 1 {step_unit}"

        query = f"""
            SELECT
                {bucket_expr} AS bucket,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms,
                quantile(0.95)(response_time_ms) AS p95_response_time_ms,
                sum(request_size) AS total_request_bytes,
                sum(response_size) AS total_response_bytes
            FROM api_requests
            {' '.join(filters)}
            GROUP BY bucket
            ORDER BY bucket ASC
            WITH FILL FROM {fill_from} TO {fill_to} STEP INTERVAL 1 {step_unit}
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for project timeseries; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_project_endpoint_stats(
        project_id: str,
        app_ids: list[str] | None = None,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        methods: list[str] | None = None,
        status_classes: list[str] | None = None,
        status_codes: list[int] | None = None,
        search_query: str | None = None,
        consumer: str | None = None,
        filter: str | None = None,
        sort_by: str = "total_requests",
        sort_dir: str = "desc",
        page: int = 1,
        page_size: int = 25,
    ) -> dict:
        """
        Get endpoint statistics aggregated across a project with pagination.
        Optionally filter by specific app within the project.

        Returns dict with 'items' (list of stats) and 'total_count' (int).
        """
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty endpoint stats: %s", exc)
            return {"items": [], "total_count": 0}

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {"project_id": project_id, "since": since_dt, "until": until_dt}

        filters = ["WHERE project_id = %(project_id)s"]
        filters.append("AND timestamp >= %(since)s")
        filters.append("AND timestamp <= %(until)s")

        if app_ids:
            filters.append("AND app_id IN %(app_ids)s")
            params["app_ids"] = app_ids

        if environment:
            filters.append("AND environment = %(environment)s")
            params["environment"] = environment

        if methods:
            filters.append("AND method IN %(methods)s")
            params["methods"] = methods

        # Handle status class filters (2xx, 3xx, 4xx, 5xx)
        status_code_ranges = []
        if status_classes:
            for cls in status_classes:
                if cls == "2xx":
                    status_code_ranges.extend([200, 201, 202, 204, 206])
                elif cls == "3xx":
                    status_code_ranges.extend([301, 302, 304, 307, 308])
                elif cls == "4xx":
                    status_code_ranges.extend([400, 401, 403, 404, 409, 422, 429])
                elif cls == "5xx":
                    status_code_ranges.extend([500, 502, 503, 504])

        # Combine status_codes from classes and explicit codes
        all_status_codes = list(set(status_code_ranges + (status_codes or [])))
        if all_status_codes:
            filters.append("AND status_code IN %(status_codes)s")
            params["status_codes"] = all_status_codes

        # Search by path (case-insensitive)
        if search_query:
            filters.append("AND (lower(path) LIKE %(search_pattern)s OR lower(method) LIKE %(search_pattern)s)")
            params["search_pattern"] = f"%{search_query.lower()}%"

        if consumer:
            # Filter on the stable identifier, not the display name.
            filters.append("AND consumer_id = %(consumer)s")
            params["consumer"] = consumer

        filters.append(AnalyticsService.build_filter_clause(project_id, filter, params))

        # Map sort_by to valid column names
        sort_column_map = {
            "endpoint": "path",
            "total_requests": "total_requests",
            "error_rate": "error_rate",
            "avg_response_time_ms": "avg_response_time_ms",
            "p95_response_time_ms": "p95_response_time_ms",
        }
        sort_column = sort_column_map.get(sort_by, "total_requests")
        sort_direction = "DESC" if sort_dir.lower() == "desc" else "ASC"

        # Count total matching endpoints
        count_query = f"""
            SELECT count(DISTINCT (method, path))
            FROM api_requests
            {' '.join(filters)}
        """

        try:
            count_result = client.execute(count_query, params)
            # count_result is a list of dicts, get the first dict's first value
            total_count = list(count_result[0].values())[0] if count_result else 0
        except Exception as exc:
            logger.warning("ClickHouse count query failed for project endpoint stats: %s", exc)
            total_count = 0

        # Calculate offset for pagination
        offset = (page - 1) * page_size
        params["limit"] = page_size
        params["offset"] = offset

        # Main query with pagination
        query = f"""
            SELECT
                method,
                path,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                (countIf(status_code >= 400) / count()) * 100 AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms,
                quantile(0.95)(response_time_ms) AS p95_response_time_ms
            FROM api_requests
            {' '.join(filters)}
            GROUP BY method, path
            ORDER BY {sort_column} {sort_direction}
            LIMIT %(limit)s
            OFFSET %(offset)s
        """

        try:
            rows = client.execute(query, params)
            # Rows are already dicts from the ClickHouse client wrapper
            clickhouse_items = [AnalyticsService._clean_nan_values(row) for row in rows]

            # When a consumer or rich filter is applied, only show endpoints
            # that actually matched — skip the DB overlay (which would re-add
            # registered endpoints with zero traffic) and report ClickHouse's
            # own count.
            if consumer or filter:
                return {"items": clickhouse_items, "total_count": int(total_count or 0)}

            # Get all registered endpoints from PostgreSQL
            db_result = AnalyticsService._get_endpoints_from_db(
                project_id=project_id,
                app_ids=app_ids,
                methods=methods,
                search_query=search_query,
                sort_by=sort_by,
                sort_dir=sort_dir,
                page=page,
                page_size=page_size,
            )

            # Merge ClickHouse stats into PostgreSQL endpoints
            # Create a lookup map for ClickHouse data
            stats_map = {(item["method"], item["path"]): item for item in clickhouse_items}

            # Overlay ClickHouse stats onto DB endpoints
            merged_items = []
            for db_item in db_result["items"]:
                key = (db_item["method"], db_item["path"])
                if key in stats_map:
                    # Use ClickHouse stats if available
                    merged_items.append(stats_map[key])
                else:
                    # Keep DB endpoint with 0 stats
                    merged_items.append(db_item)

            return {"items": merged_items, "total_count": db_result["total_count"]}
        except Exception as exc:
            logger.warning("ClickHouse query failed for project endpoint stats: %s", exc)
            # Fall back to PostgreSQL endpoint records
            return AnalyticsService._get_endpoints_from_db(
                project_id=project_id,
                app_ids=app_ids,
                methods=methods,
                search_query=search_query,
                sort_by=sort_by,
                sort_dir=sort_dir,
                page=page,
                page_size=page_size,
            )

    @staticmethod
    def _get_endpoints_from_db(
        project_id: str,
        app_ids: list[str] | None = None,
        methods: list[str] | None = None,
        search_query: str | None = None,
        sort_by: str = "total_requests",
        sort_dir: str = "desc",
        page: int = 1,
        page_size: int = 25,
    ) -> dict:
        """
        Fallback to PostgreSQL when ClickHouse has no telemetry data.
        Returns endpoint records from the database, grouped by (method, path).
        """
        from apps.projects.models import Endpoint
        from django.db.models import Q, Max

        # Start with base query for endpoints in this project
        queryset = Endpoint.objects.filter(
            app__project_id=project_id,
            app__is_active=True,
            is_active=True
        )

        # Filter by apps if specified
        if app_ids:
            queryset = queryset.filter(app_id__in=app_ids)

        # Filter by methods
        if methods:
            queryset = queryset.filter(method__in=methods)

        # Search filter
        if search_query:
            queryset = queryset.filter(
                Q(path__icontains=search_query) | Q(method__icontains=search_query)
            )

        # Group by (method, path) and get the latest last_seen_at for each group
        queryset = queryset.values("method", "path").annotate(
            latest_seen=Max("last_seen_at")
        )

        # Get total count before pagination
        total_count = queryset.count()

        # Sorting - map analytics sort fields to database fields
        sort_field_map = {
            "endpoint": "path",
            "total_requests": "-latest_seen",  # Most recent as proxy for popular
            "error_rate": "path",
            "avg_response_time_ms": "path",
            "p95_response_time_ms": "path",
        }
        db_sort_field = sort_field_map.get(sort_by, "-latest_seen")
        if sort_dir.lower() == "asc" and db_sort_field.startswith("-"):
            db_sort_field = db_sort_field[1:]
        elif sort_dir.lower() == "desc" and not db_sort_field.startswith("-"):
            db_sort_field = f"-{db_sort_field}"

        queryset = queryset.order_by(db_sort_field, "method", "path")

        # Pagination
        offset = (page - 1) * page_size
        endpoints = queryset[offset:offset + page_size]

        # Format as analytics response (with zeros for metrics)
        items = []
        for endpoint in endpoints:
            items.append({
                "method": endpoint["method"],
                "path": endpoint["path"],
                "total_requests": 0,
                "error_count": 0,
                "error_rate": 0.0,
                "avg_response_time_ms": 0.0,
                "p95_response_time_ms": 0.0,
            })

        return {"items": items, "total_count": total_count}

    @staticmethod
    def get_project_environments(
        project_id: str,
        app_ids: list[str] | None = None,
    ) -> list[str]:
        """
        Get list of distinct environments with data for a project.
        """
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty environments: %s", exc)
            return []

        params = {"project_id": project_id}
        filters = ["WHERE project_id = %(project_id)s"]

        if app_ids:
            filters.append("AND app_id IN %(app_ids)s")
            params["app_ids"] = app_ids

        query = f"""
            SELECT DISTINCT environment
            FROM api_requests
            {' '.join(filters)}
            AND environment != ''
            ORDER BY environment
        """

        try:
            rows = client.execute(query, params)
            return [row["environment"] for row in rows if row.get("environment")]
        except Exception as exc:
            logger.warning("ClickHouse query failed for project environments; returning empty list: %s", exc)
            return []

    # ── Project-Level Endpoint Detail Methods ─────────────────────────────
    # These mirror the per-app endpoint detail methods but aggregate a single
    # (method, path) endpoint across every app in a project (optionally a
    # filtered subset of apps), so they can back the endpoint detail panel on
    # the project endpoints page.

    @staticmethod
    def _project_endpoint_filters(
        project_id: str,
        method: str,
        path: str,
        app_ids: list[str] | None,
        environment: str | None,
        since_dt,
        until_dt,
    ) -> tuple[list[str], dict]:
        params = {
            "project_id": project_id,
            "method": method.upper(),
            "path": path,
            "since": since_dt,
            "until": until_dt,
        }
        filters = [
            "WHERE project_id = %(project_id)s",
            "AND method = %(method)s",
            "AND path = %(path)s",
            "AND timestamp >= %(since)s",
            "AND timestamp <= %(until)s",
        ]
        if app_ids:
            filters.append("AND app_id IN %(app_ids)s")
            params["app_ids"] = app_ids
        if environment:
            filters.append("AND environment = %(environment)s")
            params["environment"] = environment
        return filters, params

    @staticmethod
    def get_project_endpoint_detail(
        project_id: str,
        method: str,
        path: str,
        app_ids: list[str] | None = None,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        threshold_ms: float = 500.0,
    ) -> dict:
        from core.database.clickhouse.client import get_clickhouse_client

        since_dt, until_dt = _resolve_time_range(since, until)
        window_minutes = max(1.0, (until_dt - since_dt).total_seconds() / 60.0)

        # Description comes from the registered endpoint records (PostgreSQL).
        description = ""
        try:
            from apps.projects.models import Endpoint
            ep_qs = Endpoint.objects.filter(
                app__project_id=project_id,
                method=method.upper(),
                path=path,
            )
            if app_ids:
                ep_qs = ep_qs.filter(app_id__in=app_ids)
            ep = ep_qs.exclude(description="").first() or ep_qs.first()
            if ep:
                description = ep.description or ""
        except Exception as exc:
            logger.warning("Failed to load endpoint description: %s", exc)

        empty = {
            "method": method.upper(),
            "path": path,
            "description": description,
            "total_requests": 0,
            "successful_requests": 0,
            "client_errors": 0,
            "server_errors": 0,
            "error_count": 0,
            "error_rate": 0.0,
            "requests_per_minute": 0.0,
            "avg_response_time_ms": 0.0,
            "p50_response_time_ms": 0.0,
            "p75_response_time_ms": 0.0,
            "p95_response_time_ms": 0.0,
            "slow_requests": 0,
            "apdex": 0.0,
            "threshold_ms": threshold_ms,
            "total_request_bytes": 0,
            "total_response_bytes": 0,
            "total_data_transferred": 0,
            "avg_response_size": 0.0,
            "last_seen_at": None,
            "base_url": "",
        }

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty endpoint detail: %s", exc)
            return empty

        IngestService.ensure_base_url_column(client)
        filters, params = AnalyticsService._project_endpoint_filters(
            project_id, method, path, app_ids, environment, since_dt, until_dt
        )
        params["threshold"] = threshold_ms
        params["threshold4"] = threshold_ms * 4

        query = f"""
            SELECT
                count() AS total_requests,
                countIf(status_code < 400) AS successful_requests,
                countIf(status_code >= 400 AND status_code < 500) AS client_errors,
                countIf(status_code >= 500) AS server_errors,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms,
                quantile(0.50)(response_time_ms) AS p50_response_time_ms,
                quantile(0.75)(response_time_ms) AS p75_response_time_ms,
                quantile(0.95)(response_time_ms) AS p95_response_time_ms,
                countIf(response_time_ms > %(threshold)s) AS slow_requests,
                if(
                    count() > 0,
                    (countIf(response_time_ms <= %(threshold)s)
                        + countIf(response_time_ms > %(threshold)s AND response_time_ms <= %(threshold4)s) / 2)
                    / count(),
                    0
                ) AS apdex,
                sum(request_size) AS total_request_bytes,
                sum(response_size) AS total_response_bytes,
                avg(response_size) AS avg_response_size,
                max(timestamp) AS last_seen_at,
                anyIf(base_url, base_url != '') AS base_url
            FROM api_requests
            {' '.join(filters)}
        """
        try:
            rows = client.execute(query, params)
            if rows and rows[0].get("total_requests"):
                row = AnalyticsService._clean_nan_values(rows[0])
                row["method"] = method.upper()
                row["path"] = path
                row["description"] = description
                row["threshold_ms"] = threshold_ms
                row["requests_per_minute"] = (row.get("total_requests") or 0) / window_minutes
                row["total_data_transferred"] = (row.get("total_request_bytes") or 0) + (row.get("total_response_bytes") or 0)
                row["last_seen_at"] = _as_utc(row.get("last_seen_at"))
                return row
        except Exception as exc:
            logger.warning("ClickHouse query failed for project endpoint detail; returning empty detail: %s", exc)

        return empty

    @staticmethod
    def get_project_endpoint_timeseries(
        project_id: str,
        method: str,
        path: str,
        app_ids: list[str] | None = None,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        timezone_name: str | None = None,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty endpoint timeseries: %s", exc)
            return []

        since_dt, until_dt = _resolve_time_range(since, until)
        filters, params = AnalyticsService._project_endpoint_filters(
            project_id, method, path, app_ids, environment, since_dt, until_dt
        )
        params["timezone"] = _resolve_bucket_timezone(timezone_name)

        query = f"""
            SELECT
                toTimeZone(toStartOfHour(toTimeZone(timestamp, %(timezone)s)), 'UTC') AS bucket,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                countIf(status_code >= 400 AND status_code < 500) AS client_errors,
                countIf(status_code >= 500) AS server_errors,
                avg(response_time_ms) AS avg_response_time_ms,
                quantile(0.50)(response_time_ms) AS p50_response_time_ms,
                quantile(0.95)(response_time_ms) AS p95_response_time_ms,
                quantile(0.99)(response_time_ms) AS p99_response_time_ms,
                sum(request_size) AS total_request_bytes,
                sum(response_size) AS total_response_bytes
            FROM api_requests
            {' '.join(filters)}
            GROUP BY bucket
            ORDER BY bucket ASC
        """
        try:
            rows = []
            for r in client.execute(query, params):
                row = AnalyticsService._clean_nan_values(r)
                row["bucket"] = _as_utc(row.get("bucket"))
                rows.append(row)
            return rows
        except Exception as exc:
            logger.warning("ClickHouse query failed for project endpoint timeseries; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_project_endpoint_consumers(
        project_id: str,
        method: str,
        path: str,
        app_ids: list[str] | None = None,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 10,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty endpoint consumers: %s", exc)
            return []
        IngestService.ensure_consumer_columns(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        filters, params = AnalyticsService._project_endpoint_filters(
            project_id, method, path, app_ids, environment, since_dt, until_dt
        )
        params["limit"] = max(1, min(limit, 50))

        query = f"""
            SELECT
                if(
                    consumer_name != '',
                    consumer_name,
                    if(
                        consumer_id != '',
                        consumer_id,
                        'unknown'
                    )
                ) AS consumer,
                if(consumer_id != '', consumer_id, '') AS consumer_identifier,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms
            FROM api_requests
            {' '.join(filters)}
            GROUP BY consumer, consumer_identifier
            ORDER BY total_requests DESC
            LIMIT %(limit)s
        """
        try:
            return [AnalyticsService._clean_nan_values(r) for r in client.execute(query, params)]
        except Exception as exc:
            logger.warning("ClickHouse query failed for project endpoint consumers; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_project_consumers(
        project_id: str,
        app_ids: list[str] | None = None,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 200,
    ) -> list[dict]:
        """
        List the consumers seen across a project (optionally scoped to apps /
        environment / time range), ranked by request volume. Powers the
        consumer filter dropdown. Excludes the synthetic 'unknown' bucket.
        """
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty project consumers: %s", exc)
            return []
        IngestService.ensure_consumer_columns(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "project_id": project_id,
            "since": since_dt,
            "until": until_dt,
            "limit": max(1, min(int(limit), 1000)),
        }

        filters = ["WHERE project_id = %(project_id)s"]
        filters.append("AND timestamp >= %(since)s")
        filters.append("AND timestamp <= %(until)s")

        if app_ids:
            filters.append("AND app_id IN %(app_ids)s")
            params["app_ids"] = app_ids

        if environment:
            filters.append("AND environment = %(environment)s")
            params["environment"] = environment

        query = f"""
            SELECT
                if(
                    consumer_name != '',
                    consumer_name,
                    if(
                        consumer_id != '',
                        consumer_id,
                        'unknown'
                    )
                ) AS consumer,
                if(consumer_id != '', consumer_id, '') AS consumer_identifier,
                count() AS total_requests
            FROM api_requests
            {' '.join(filters)}
            GROUP BY consumer, consumer_identifier
            HAVING consumer != 'unknown'
            ORDER BY total_requests DESC
            LIMIT %(limit)s
        """
        try:
            return [AnalyticsService._clean_nan_values(r) for r in client.execute(query, params)]
        except Exception as exc:
            logger.warning("ClickHouse query failed for project consumers; returning empty list: %s", exc)
            return []

    # Columns exposed to the generic value-autocomplete search. Whitelisted so
    # `field` can never inject SQL — it only ever selects a fixed column.
    _FILTER_VALUE_COLUMNS = {
        "path": "path",
        "ip": "ip_address",
        "ua": "user_agent",
        "method": "method",
    }

    @staticmethod
    def get_filter_values(
        project_id: str,
        field: str,
        q: str | None = None,
        app_ids: list[str] | None = None,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 20,
    ) -> list[dict]:
        """
        Typeahead source for the filter bar: distinct values of a single field,
        substring-matched against ``q`` and ranked by frequency.

        Optimised for autocomplete: the query is time-bounded, filtered by the
        search term (so ClickHouse groups far fewer rows), and hard-capped by a
        small LIMIT — we never load the full cardinality of a field. Returns
        ``[{value, label, count}]``. ``consumer`` is special-cased to return the
        stable identifier as ``value`` and the display name as ``label``.
        """
        from core.database.clickhouse.client import get_clickhouse_client

        if field != "consumer" and field not in AnalyticsService._FILTER_VALUE_COLUMNS:
            return []

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty filter values: %s", exc)
            return []
        IngestService.ensure_consumer_columns(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params: dict[str, Any] = {
            "project_id": project_id,
            "since": since_dt,
            "until": until_dt,
            "limit": max(1, min(int(limit), 50)),
        }

        filters = [
            "WHERE project_id = %(project_id)s",
            "AND timestamp >= %(since)s",
            "AND timestamp <= %(until)s",
        ]
        if app_ids:
            filters.append("AND app_id IN %(app_ids)s")
            params["app_ids"] = app_ids
        if environment:
            filters.append("AND environment = %(environment)s")
            params["environment"] = environment

        term = (q or "").strip()

        if field == "consumer":
            if term:
                filters.append(
                    "AND (positionCaseInsensitive(consumer_name, %(q)s) > 0 "
                    "OR positionCaseInsensitive(consumer_id, %(q)s) > 0)"
                )
                params["q"] = term
            query = f"""
                SELECT
                    if(consumer_name != '', consumer_name,
                       if(consumer_id != '', consumer_id, 'unknown')) AS label,
                    if(consumer_id != '', consumer_id, '') AS value,
                    count() AS count
                FROM api_requests
                {' '.join(filters)}
                GROUP BY label, value
                HAVING label != 'unknown'
                ORDER BY count DESC
                LIMIT %(limit)s
            """
        else:
            column = AnalyticsService._FILTER_VALUE_COLUMNS[field]
            if term:
                filters.append(f"AND positionCaseInsensitive({column}, %(q)s) > 0")
                params["q"] = term
            query = f"""
                SELECT {column} AS value, {column} AS label, count() AS count
                FROM api_requests
                {' '.join(filters)}
                GROUP BY value
                HAVING value != ''
                ORDER BY count DESC
                LIMIT %(limit)s
            """

        try:
            return [AnalyticsService._clean_nan_values(r) for r in client.execute(query, params)]
        except Exception as exc:
            logger.warning("ClickHouse query failed for filter values (%s); returning empty list: %s", field, exc)
            return []

    @staticmethod
    def get_project_consumer_stats(
        project_id: str,
        app_ids: list[str] | None = None,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        search: str | None = None,
        filter: str | None = None,
        limit: int = 200,
    ) -> list[dict]:
        """
        Rich per-consumer stats across a project (optionally scoped to apps /
        environment / time range, filtered by a name/id search). Powers the
        dedicated Consumers page. Excludes the synthetic 'unknown' bucket.
        """
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty project consumer stats: %s", exc)
            return []
        IngestService.ensure_consumer_columns(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "project_id": project_id,
            "since": since_dt,
            "until": until_dt,
            "limit": max(1, min(int(limit), 1000)),
        }

        filters = [
            "WHERE project_id = %(project_id)s",
            "AND timestamp >= %(since)s",
            "AND timestamp <= %(until)s",
        ]
        if app_ids:
            filters.append("AND app_id IN %(app_ids)s")
            params["app_ids"] = app_ids
        if environment:
            filters.append("AND environment = %(environment)s")
            params["environment"] = environment

        filters.append(AnalyticsService.build_filter_clause(project_id, filter, params))

        having = ["consumer != 'unknown'"]
        if search and search.strip():
            having.append("positionCaseInsensitive(consumer, %(search)s) > 0")
            params["search"] = search.strip()

        query = f"""
            SELECT
                if(
                    consumer_name != '',
                    consumer_name,
                    if(consumer_id != '', consumer_id, 'unknown')
                ) AS consumer,
                any(if(consumer_id != '', consumer_id, '')) AS consumer_identifier,
                any(if(consumer_group != '', consumer_group, '')) AS consumer_group,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms,
                max(timestamp) AS last_seen_at
            FROM api_requests
            {' '.join(filters)}
            GROUP BY consumer
            HAVING {' AND '.join(having)}
            ORDER BY total_requests DESC
            LIMIT %(limit)s
        """
        try:
            return [AnalyticsService._clean_nan_values(r) for r in client.execute(query, params)]
        except Exception as exc:
            logger.warning("ClickHouse query failed for project consumer stats; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_project_endpoint_status_codes(
        project_id: str,
        method: str,
        path: str,
        app_ids: list[str] | None = None,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 20,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty endpoint status-code stats: %s", exc)
            return []

        since_dt, until_dt = _resolve_time_range(since, until)
        filters, params = AnalyticsService._project_endpoint_filters(
            project_id, method, path, app_ids, environment, since_dt, until_dt
        )
        params["limit"] = max(1, min(limit, 50))

        query = f"""
            SELECT
                status_code,
                count() AS total_requests
            FROM api_requests
            {' '.join(filters)}
            GROUP BY status_code
            ORDER BY total_requests DESC
            LIMIT %(limit)s
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for project endpoint status-code stats; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_project_endpoint_requests(
        project_id: str,
        method: str,
        path: str,
        app_ids: list[str] | None = None,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 20,
        errors_only: bool = False,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty endpoint requests: %s", exc)
            return []
        IngestService.ensure_consumer_columns(client)
        IngestService.ensure_payload_columns(client)
        IngestService.ensure_header_columns(client)
        IngestService.ensure_base_url_column(client)
        IngestService.ensure_trace_columns(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        filters, params = AnalyticsService._project_endpoint_filters(
            project_id, method, path, app_ids, environment, since_dt, until_dt
        )
        if errors_only:
            filters.append("AND status_code >= 400")
        params["limit"] = max(1, min(limit, 100))

        query = f"""
            SELECT
                timestamp,
                method,
                path,
                status_code,
                response_time_ms,
                environment,
                ip_address,
                user_agent,
                consumer_id,
                consumer_name,
                request_payload,
                response_payload,
                request_headers,
                response_headers,
                base_url,
                trace_id,
                span_id,
                if(
                    consumer_name != '',
                    consumer_name,
                    if(
                        consumer_id != '',
                        consumer_id,
                        'unknown'
                    )
                ) AS consumer
            FROM api_requests
            {' '.join(filters)}
            ORDER BY timestamp DESC
            LIMIT %(limit)s
        """
        try:
            from core.geo import resolve_country

            rows = client.execute(query, params)
            for row in rows:
                row["timestamp"] = _as_utc(row.get("timestamp"))
                country_name, country_code = resolve_country(row.get("ip_address") or "")
                row["country"] = country_name
                row["country_code"] = country_code
            return rows
        except Exception as exc:
            logger.warning("ClickHouse query failed for project endpoint requests; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_project_endpoint_histograms(
        project_id: str,
        method: str,
        path: str,
        app_ids: list[str] | None = None,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        bins: int = 30,
    ) -> dict:
        from core.database.clickhouse.client import get_clickhouse_client

        result = {"response_time": [], "response_size": []}
        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty endpoint histograms: %s", exc)
            return result

        since_dt, until_dt = _resolve_time_range(since, until)
        filters, params = AnalyticsService._project_endpoint_filters(
            project_id, method, path, app_ids, environment, since_dt, until_dt
        )
        bins = max(5, min(bins, 60))

        query = f"""
            SELECT
                histogram({bins})(response_time_ms) AS response_time_hist,
                histogram({bins})(toFloat64(response_size)) AS response_size_hist
            FROM api_requests
            {' '.join(filters)}
        """

        def _to_buckets(raw) -> list[dict]:
            buckets = []
            for item in raw or []:
                try:
                    lower, upper, height = float(item[0]), float(item[1]), float(item[2])
                except (TypeError, IndexError, KeyError, ValueError):
                    continue
                if not (math.isfinite(lower) and math.isfinite(upper) and math.isfinite(height)):
                    continue
                if height <= 0:
                    continue
                buckets.append({"lower": lower, "upper": upper, "count": height})
            return buckets

        try:
            rows = client.execute(query, params)
            if rows:
                result["response_time"] = _to_buckets(rows[0].get("response_time_hist"))
                result["response_size"] = _to_buckets(rows[0].get("response_size_hist"))
        except Exception as exc:
            logger.warning("ClickHouse query failed for project endpoint histograms; returning empty histograms: %s", exc)

        return result

    @staticmethod
    def get_project_logs(
        project_id: str,
        app_ids: list[str] | None = None,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        levels: str | None = None,
        search: str | None = None,
        trace_id: str | None = None,
        page: int = 1,
        page_size: int = 50,
    ) -> dict:
        """
        Get logs for a project with optional app filter.
        """
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty logs: %s", exc)
            return {"logs": [], "total": 0, "page": page, "page_size": page_size}

        IngestService.ensure_api_logs_table(client)
        since_dt, until_dt = _resolve_time_range(since, until)
        offset = (page - 1) * page_size

        params = {
            "project_id": project_id,
            "since": since_dt,
            "until": until_dt,
            "limit": page_size,
            "offset": offset,
        }

        filters = ["WHERE project_id = %(project_id)s"]
        filters.append("AND timestamp >= %(since)s")
        filters.append("AND timestamp <= %(until)s")

        if app_ids:
            filters.append("AND app_id IN %(app_ids)s")
            params["app_ids"] = app_ids

        if environment:
            filters.append("AND environment = %(environment)s")
            params["environment"] = environment

        if levels:
            level_list = [level.strip().upper() for level in levels.split(",")]
            filters.append("AND level IN %(levels)s")
            params["levels"] = level_list

        if search:
            filters.append("AND (message ILIKE %(search)s OR logger_name ILIKE %(search)s)")
            params["search"] = f"%{search}%"

        if trace_id:
            filters.append("AND trace_id = %(trace_id)s")
            params["trace_id"] = trace_id.strip().lower()

        count_query = f"""
            SELECT count() AS total
            FROM api_logs
            {' '.join(filters)}
        """

        logs_query = f"""
            SELECT
                timestamp,
                app_id,
                environment,
                level,
                message,
                logger_name,
                endpoint_method,
                endpoint_path,
                status_code,
                consumer_id,
                consumer_name,
                trace_id,
                span_id
            FROM api_logs
            {' '.join(filters)}
            ORDER BY timestamp DESC
            LIMIT %(limit)s
            OFFSET %(offset)s
        """

        try:
            count_result = client.execute(count_query, params)
            total = count_result[0]["total"] if count_result else 0

            logs = client.execute(logs_query, params)

            return {
                "logs": logs,
                "total": total,
                "page": page,
                "page_size": page_size,
            }
        except Exception as exc:
            logger.warning("ClickHouse query failed for project logs; returning empty logs: %s", exc)
            return {"logs": [], "total": 0, "page": page, "page_size": page_size}
