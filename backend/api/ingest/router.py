from collections import defaultdict
from uuid import UUID

from django.db.models import Q
from django.http import HttpRequest
from ninja import Router

from apps.projects.models import App
from apps.projects.services import IngestService
from core.auth.authentication import api_key_auth
from core.exceptions.base import AuthenticationError, ValidationError

from .schemas import IngestRequest, IngestResponse, IngestLogsRequest, IngestLogsResponse

router = Router(auth=[api_key_auth])

MAX_BATCH_SIZE = 1000


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


@router.post("/requests", response=IngestResponse)
def ingest_requests(request: HttpRequest, data: IngestRequest):
    """
    Ingest API request records.
    API key provides project_id, payload provides app_id (UUID or slug) for each record.
    """
    if len(data.requests) > MAX_BATCH_SIZE:
        raise ValidationError(f"Batch size exceeds maximum of {MAX_BATCH_SIZE}")

    project_id = request.tenant_context.project_id
    if not project_id:
        raise AuthenticationError("API key must be scoped to a project")

    # Resolve app identifiers (UUID or slug) to UUIDs
    app_identifiers = {record.app_id for record in data.requests}
    identifier_to_uuid = resolve_app_identifiers(project_id, app_identifiers)

    # Group records by resolved app UUID for batch processing
    records_by_app = defaultdict(list)
    for record in data.requests:
        app_uuid = identifier_to_uuid[record.app_id]
        records_by_app[app_uuid].append(record)

    total_accepted = 0
    for app_uuid, records in records_by_app.items():
        accepted = IngestService.ingest(app_uuid, records)
        total_accepted += accepted

    return IngestResponse(accepted=total_accepted)


@router.post("/logs", response=IngestLogsResponse)
def ingest_logs(request: HttpRequest, data: IngestLogsRequest):
    """
    Ingest application log records.
    API key provides project_id, payload provides app_id (UUID or slug) for each log.
    """
    if len(data.logs) > MAX_BATCH_SIZE:
        raise ValidationError(f"Batch size exceeds maximum of {MAX_BATCH_SIZE}")

    project_id = request.tenant_context.project_id
    if not project_id:
        raise AuthenticationError("API key must be scoped to a project")

    # Resolve app identifiers (UUID or slug) to UUIDs
    app_identifiers = {log.app_id for log in data.logs}
    identifier_to_uuid = resolve_app_identifiers(project_id, app_identifiers)

    # Group logs by resolved app UUID for batch processing
    logs_by_app = defaultdict(list)
    for log in data.logs:
        app_uuid = identifier_to_uuid[log.app_id]
        logs_by_app[app_uuid].append(log)

    total_accepted = 0
    for app_uuid, logs in logs_by_app.items():
        accepted = IngestService.ingest_logs(app_uuid, logs)
        total_accepted += accepted

    return IngestLogsResponse(accepted=total_accepted)
