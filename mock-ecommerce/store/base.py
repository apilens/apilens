"""Shared plumbing for the mock e-commerce microservices.

Every service is an independent FastAPI app instrumented with the APILens
SDK. One project-level API key works for all of them; each service passes its
own ``app_id`` so traffic is attributed to the right microservice in the
"Neel's Store" project.
"""

from __future__ import annotations

import os

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from apilens.fastapi import ApiLensMiddleware, set_consumer

# A chunky blob used to exercise large request/response sizes in the dashboard.
LONG_TEXT = (
    "Neel's Store diagnostics — this is a deliberately verbose payload used to "
    "produce large responses so the dashboard shows a wide spread of response "
    "sizes alongside the short ones. "
) * 60  # ~ 8 KB

APILENS_API_KEY = os.environ.get("APILENS_API_KEY", "")
APILENS_BASE_URL = os.environ.get("APILENS_BASE_URL", "http://localhost:8001/v1")
APILENS_PROJECT_SLUG = os.environ.get("APILENS_PROJECT_SLUG", "neels-store")
APILENS_ENVIRONMENT = os.environ.get("APILENS_ENVIRONMENT", "development")

# Where each microservice listens — used both to run them and for the
# service-to-service calls that produce cross-service traces.
SERVICE_PORTS = {
    "catalog-service": 9101,
    "user-service": 9102,
    "cart-service": 9103,
    "order-service": 9104,
    "payment-service": 9105,
    "inventory-service": 9106,
}


def service_url(app_id: str) -> str:
    host = os.environ.get(f"{app_id.replace('-', '_').upper()}_URL")
    if host:
        return host.rstrip("/")
    return f"http://localhost:{SERVICE_PORTS[app_id]}"


def make_app(app_id: str) -> FastAPI:
    """Create a FastAPI app wired to APILens for one microservice."""
    app = FastAPI(title=f"Neel's Store — {app_id}")
    if APILENS_API_KEY:
        app.add_middleware(
            ApiLensMiddleware,
            base_url=APILENS_BASE_URL,
            project_slug=APILENS_PROJECT_SLUG,
            api_key=APILENS_API_KEY,
            app_id=app_id,
            env=APILENS_ENVIRONMENT,
            # Deploy correlation demo — every record carries the store release.
            release=os.environ.get("STORE_RELEASE", "v1.0.0"),
            commit=os.environ.get("STORE_COMMIT", ""),
            # PII never leaves the service: values whose NAME matches one of
            # these regexes are stored as [redacted] (names stay visible).
            redact_query_params=[r"^card_number$", r"token"],
            redact_headers=[r"^x-internal-secret$"],
            redact_body_fields=[r"^card_number$", r"^cvv$", r"password"],
        )

    @app.get("/health", tags=["system"])
    async def health():
        return {"status": "ok", "service": app_id}

    @app.get("/debug/simulate", tags=["debug"])
    async def simulate(status: int = Query(200), size: str = Query("short")):
        """Return an arbitrary status code with a short or long body — lets the
        traffic generator produce a controlled spread of 4xx/5xx and payload
        sizes."""
        body = LONG_TEXT if size == "long" else "ok"
        if status >= 400:
            detail = (LONG_TEXT if size == "long" else "simulated error")
            raise HTTPException(status_code=status, detail=detail)
        return {"service": app_id, "status": status, "size": size, "message": body}

    @app.get("/debug/boom", tags=["debug"])
    async def boom():
        """Raise an unhandled error → a real 500 Internal Server Error."""
        raise RuntimeError("boom: unhandled server error in " + app_id)

    return app


def identify_consumer(request: Request) -> None:
    """Attribute the request to a caller from X-User-* headers (set by the
    traffic generator). APILens never infers identity on its own."""
    email = request.headers.get("X-User-Email")
    if email:
        set_consumer(
            request,
            identifier=email,
            name=request.headers.get("X-User-Name"),
            group=request.headers.get("X-User-Tier"),
        )


async def call_service(app_id: str, method: str, path: str, *, request: Request | None = None, **kwargs):
    """Call another microservice. Forwards the caller identity so the whole
    call chain is attributed consistently, and (because APILens auto-
    instruments httpx) shows up as a cross-service trace."""
    headers = dict(kwargs.pop("headers", {}) or {})
    if request is not None:
        for h in ("X-User-Email", "X-User-Name", "X-User-Tier"):
            if h in request.headers:
                headers[h] = request.headers[h]
    url = f"{service_url(app_id)}{path}"
    async with httpx.AsyncClient(timeout=5.0) as client:
        return await client.request(method, url, headers=headers, **kwargs)
