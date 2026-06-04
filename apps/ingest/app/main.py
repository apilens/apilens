"""APILens ingestion service (standalone FastAPI).

Serves the data plane on its own host (ingest.apilens.ai) — separate from the
dashboard API (apps/api). Auth is a project-level API key (X-API-Key); records
carry app_id. Writes to the shared Postgres (endpoints) + ClickHouse stores.
"""

from __future__ import annotations

import logging

from fastapi import Depends, FastAPI, Header
from fastapi.responses import JSONResponse

from .auth import authenticate
from .db import clickhouse, init_postgres_pool
from .ingest import IngestError, ensure_clickhouse_schema, handle_logs, handle_requests
from .schemas import (
    IngestLogsRequest,
    IngestLogsResponse,
    IngestRequest,
    IngestResponse,
)

logger = logging.getLogger("apilens.ingest")

app = FastAPI(
    title="APILens Ingest API",
    version="1.0.0",
    description="APILens telemetry ingestion endpoint",
    docs_url="/v1/docs",
    openapi_url="/v1/openapi.json",
)


@app.on_event("startup")
def _startup() -> None:
    init_postgres_pool()
    try:
        ensure_clickhouse_schema(clickhouse())
    except Exception as exc:  # non-fatal: base schema is owned by apps/api
        logger.warning("ClickHouse schema ensure skipped at startup: %s", exc)


def require_project(x_api_key: str | None = Header(default=None, alias="X-API-Key")) -> tuple[str, str]:
    ctx = authenticate(x_api_key or "")
    if ctx is None:
        raise IngestError(401, "authentication_error", "Authentication required")
    return ctx


@app.exception_handler(IngestError)
def _ingest_error_handler(_request, exc: IngestError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": exc.error, "detail": exc.detail})


@app.exception_handler(Exception)
def _unhandled_handler(_request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled ingest error: %s", exc)
    return JSONResponse(status_code=500, content={"error": "internal_error", "detail": "Something went wrong"})


@app.get("/v1/health", tags=["System"])
def health() -> dict:
    return {"status": "healthy", "service": "apilens-ingest"}


@app.post("/v1/requests", response_model=IngestResponse, tags=["Ingest"])
def ingest_requests(data: IngestRequest, ctx: tuple[str, str] = Depends(require_project)) -> IngestResponse:
    project_id, project_slug = ctx
    accepted = handle_requests(project_id, project_slug, data.requests)
    return IngestResponse(accepted=accepted)


@app.post("/v1/logs", response_model=IngestLogsResponse, tags=["Ingest"])
def ingest_logs(data: IngestLogsRequest, ctx: tuple[str, str] = Depends(require_project)) -> IngestLogsResponse:
    project_id, project_slug = ctx
    accepted = handle_logs(project_id, project_slug, data.logs)
    return IngestLogsResponse(accepted=accepted)
