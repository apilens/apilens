from collections import defaultdict

from django.http import HttpRequest
from ninja import Router

from apps.projects.models import App
from apps.projects.services import IngestService
from core.auth.authentication import api_key_auth
from core.exceptions.base import AuthenticationError, ValidationError

from .schemas import IngestRequest, IngestResponse

router = Router(auth=[api_key_auth])

MAX_BATCH_SIZE = 1000


@router.post("/requests", response=IngestResponse)
def ingest_requests(request: HttpRequest, data: IngestRequest):
    """
    Ingest API request records.
    API key provides project_id, payload provides app_id for each record.
    """
    if len(data.requests) > MAX_BATCH_SIZE:
        raise ValidationError(f"Batch size exceeds maximum of {MAX_BATCH_SIZE}")

    project_id = request.tenant_context.project_id
    if not project_id:
        raise AuthenticationError("API key must be scoped to a project")

    # Validate all app_ids belong to this project
    app_ids = {record.app_id for record in data.requests}
    valid_app_ids = set(
        App.objects.filter(
            project_id=project_id,
            id__in=app_ids,
            is_active=True
        ).values_list("id", flat=True)
    )

    invalid_app_ids = app_ids - {str(aid) for aid in valid_app_ids}
    if invalid_app_ids:
        raise ValidationError(f"Invalid app_ids: {invalid_app_ids}")

    # Group records by app_id for batch processing
    records_by_app = defaultdict(list)
    for record in data.requests:
        records_by_app[record.app_id].append(record)

    total_accepted = 0
    for app_id, records in records_by_app.items():
        accepted = IngestService.ingest(app_id, records)
        total_accepted += accepted

    return IngestResponse(accepted=total_accepted)
