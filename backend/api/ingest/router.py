from django.http import HttpRequest
from ninja import Router

from apps.projects.services import IngestService
from core.auth.authentication import api_key_auth
from core.exceptions.base import ValidationError

from .schemas import IngestLogsRequest, IngestLogsResponse, IngestRequest, IngestResponse

router = Router(auth=[api_key_auth])

MAX_BATCH_SIZE = 1000
MAX_LOG_BATCH_SIZE = 2000


@router.post("/requests", response=IngestResponse)
def ingest_requests(request: HttpRequest, data: IngestRequest):
    if len(data.requests) > MAX_BATCH_SIZE:
        raise ValidationError(f"Batch size exceeds maximum of {MAX_BATCH_SIZE}")

    app_id = request.tenant_context.app_id
    if not app_id:
        raise ValidationError("API key must be scoped to an app")

    accepted = IngestService.ingest(app_id, data.requests)
    return IngestResponse(accepted=accepted)


@router.post("/logs", response=IngestLogsResponse)
def ingest_logs(request: HttpRequest, data: IngestLogsRequest):
    if len(data.logs) > MAX_LOG_BATCH_SIZE:
        raise ValidationError(f"Batch size exceeds maximum of {MAX_LOG_BATCH_SIZE}")

    app_id = request.tenant_context.app_id
    if not app_id:
        raise ValidationError("API key must be scoped to an app")

    accepted = IngestService.ingest_logs(app_id, data.logs)
    return IngestLogsResponse(accepted=accepted)
