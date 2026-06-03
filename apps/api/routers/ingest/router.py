from collections import defaultdict
from uuid import UUID

from django.db.models import Q
from django.http import HttpRequest
from ninja import Router

from apps.projects.models import App
from apps.projects.services import IngestService
from apps.auth.authentication import api_key_auth
from core.exceptions.base import AuthenticationError, ValidationError

from .schemas import IngestRequest, IngestResponse, IngestLogsRequest, IngestLogsResponse

router = Router(auth=[api_key_auth])

MAX_BATCH_SIZE = 1000


def validate_project_slug(authenticated_project_slug: str, payload_project_slugs: set[str]) -> None:
    normalized = {slug.strip() for slug in payload_project_slugs}
    if not authenticated_project_slug:
        raise AuthenticationError("API key must be scoped to a project")
    if not normalized or "" in normalized:
        raise ValidationError("project_slug is required for every record")
    if normalized != {authenticated_project_slug}:
        raise ValidationError(
            f"project_slug must match the API key project '{authenticated_project_slug}'"
        )


def resolve_app_identifiers(project_id: str, app_identifiers: set[str]) -> dict[str, str]:
    """
    Resolve app identifiers (UUID or slug) to UUIDs.
    Returns a mapping of {identifier: uuid_string}.
    Raises ValidationError if any identifiers are invalid.
    """
    # Separate UUIDs from slugs
    uuids = set()
    slugs = set()

    for identifier in app_identifiers:
        try:
            UUID(identifier)
            uuids.add(identifier)
        except (ValueError, AttributeError):
            slugs.add(identifier)

    # Build query to match either UUID or slug
    query = Q()
    if uuids:
        query |= Q(id__in=uuids)
    if slugs:
        query |= Q(slug__in=slugs)

    # Fetch apps that match
    apps = App.objects.filter(
        project_id=project_id,
        is_active=True
    ).filter(query).values('id', 'slug')

    # Build mapping: both UUID and slug map to UUID
    identifier_to_uuid = {}
    found_uuids = set()
    found_slugs = set()

    for app in apps:
        app_uuid = str(app['id'])
        app_slug = app['slug']
        identifier_to_uuid[app_uuid] = app_uuid
        identifier_to_uuid[app_slug] = app_uuid
        found_uuids.add(app_uuid)
        found_slugs.add(app_slug)

    # Check for invalid identifiers
    invalid = (uuids - found_uuids) | (slugs - found_slugs)
    if invalid:
        raise ValidationError(f"Invalid app identifiers: {invalid}")

    return identifier_to_uuid


def group_records_by_app(request: HttpRequest, records: list) -> dict[str, list]:
    """Map each record to its target app UUID, grouped for batch insert.

    - App-scoped API key: every record goes to the key's app (the SDK can omit
      app_id/project_slug entirely). Any explicit id provided must still match.
    - Legacy project-scoped key: each record must carry an app_id (UUID or slug)
      resolved within the key's project, and project_slug must match.
    """
    ctx = request.tenant_context
    if not ctx.project_id:
        raise AuthenticationError("API key must be scoped to a project")

    grouped: dict[str, list] = defaultdict(list)

    if ctx.app_id:
        for record in records:
            rec_app = (record.app_id or "").strip()
            if rec_app and rec_app not in (ctx.app_id, ctx.app_slug):
                raise ValidationError(
                    f"app_id must match the API key's app '{ctx.app_slug}'"
                )
            rec_project = (record.project_slug or "").strip()
            if rec_project and rec_project != ctx.project_slug:
                raise ValidationError(
                    f"project_slug must match the API key project '{ctx.project_slug}'"
                )
            grouped[ctx.app_id].append(record)
        return grouped

    # Legacy project-scoped key: the app must be identified per record.
    validate_project_slug(ctx.project_slug, {r.project_slug for r in records})
    app_identifiers = {(r.app_id or "").strip() for r in records}
    if "" in app_identifiers:
        raise ValidationError("app_id is required for every record with a project-scoped key")
    identifier_to_uuid = resolve_app_identifiers(ctx.project_id, app_identifiers)
    for record in records:
        grouped[identifier_to_uuid[record.app_id]].append(record)
    return grouped


@router.post("/requests", response=IngestResponse)
def ingest_requests(request: HttpRequest, data: IngestRequest):
    """Ingest API request records.

    App-scoped keys derive project + app from the key; project-scoped keys
    identify the app per-record via app_id.
    """
    if len(data.requests) > MAX_BATCH_SIZE:
        raise ValidationError(f"Batch size exceeds maximum of {MAX_BATCH_SIZE}")

    records_by_app = group_records_by_app(request, data.requests)

    total_accepted = 0
    for app_uuid, records in records_by_app.items():
        total_accepted += IngestService.ingest(app_uuid, records)

    return IngestResponse(accepted=total_accepted)


@router.post("/logs", response=IngestLogsResponse)
def ingest_logs(request: HttpRequest, data: IngestLogsRequest):
    """Ingest application log records.

    App-scoped keys derive project + app from the key; project-scoped keys
    identify the app per-record via app_id.
    """
    if len(data.logs) > MAX_BATCH_SIZE:
        raise ValidationError(f"Batch size exceeds maximum of {MAX_BATCH_SIZE}")

    logs_by_app = group_records_by_app(request, data.logs)

    total_accepted = 0
    for app_uuid, logs in logs_by_app.items():
        total_accepted += IngestService.ingest_logs(app_uuid, logs)

    return IngestLogsResponse(accepted=total_accepted)
