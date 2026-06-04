import logging

from ninja import NinjaAPI
from ninja.errors import AuthenticationError, ValidationError
from django.conf import settings
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.db import IntegrityError, DatabaseError

from core.exceptions.base import AppError

logger = logging.getLogger(__name__)


def _problem(request: HttpRequest, *, status: int, title: str, detail, type_: str = "about:blank") -> JsonResponse:
    """RFC 9457 ``application/problem+json`` error body.

    Includes a legacy ``error`` alias (= ``title``) so existing clients that read
    ``{error, detail}`` keep working unchanged; ``detail`` carries the same value
    it always did. We just add the standard ``type``/``status``/``instance``
    members and the ``application/problem+json`` content type.
    """
    body = {
        "type": type_,
        "title": title,
        "status": status,
        "detail": detail,
        "instance": request.path,
        "error": title,
    }
    return JsonResponse(body, status=status, content_type="application/problem+json")


def _register_exception_handlers(api: NinjaAPI) -> None:
    """Attach the shared domain -> HTTP exception handlers to a NinjaAPI instance.

    Every NinjaAPI instance keeps its own handler registry, so the control-plane
    AND identity APIs both call this to get identical, RFC 9457-compliant error
    semantics (``application/problem+json``).
    """

    @api.exception_handler(AppError)
    def app_error_handler(request: HttpRequest, exc: AppError) -> HttpResponse:
        return _problem(request, status=exc.status_code, title=exc.error_code, detail=exc.message)

    @api.exception_handler(AuthenticationError)
    def authentication_error_handler(request: HttpRequest, exc: AuthenticationError) -> HttpResponse:
        return _problem(request, status=401, title="authentication_error", detail="Authentication required")

    @api.exception_handler(ValidationError)
    def validation_error_handler(request: HttpRequest, exc: ValidationError) -> HttpResponse:
        return _problem(request, status=422, title="validation_error", detail=exc.errors)

    @api.exception_handler(IntegrityError)
    def integrity_error_handler(request: HttpRequest, exc: IntegrityError) -> HttpResponse:
        logger.warning("IntegrityError: %s", exc, exc_info=True)
        return _problem(request, status=409, title="conflict", detail="Resource conflict")

    @api.exception_handler(DatabaseError)
    def database_error_handler(request: HttpRequest, exc: DatabaseError) -> HttpResponse:
        logger.exception("DatabaseError: %s", exc)
        return _problem(request, status=500, title="internal_error", detail="Something went wrong")

    @api.exception_handler(Exception)
    def generic_error_handler(request: HttpRequest, exc: Exception) -> HttpResponse:
        logger.exception("Unhandled exception: %s", exc)
        return _problem(request, status=500, title="internal_error", detail="Something went wrong")


# ---------------------------------------------------------------------------
# Control-plane API (the dashboard backend, served on api.apilens.ai).
#
# OpenAPI schema + interactive docs are intentionally DISABLED so the API
# surface isn't publicly browsable. Re-enable by setting docs_url/openapi_url.
# ---------------------------------------------------------------------------
api = NinjaAPI(
    title="APILens API",
    version="1.0.0",
    description="API Observability Platform",
    docs_url=None,
    openapi_url=None,
)
_register_exception_handlers(api)


@api.get("/health", tags=["System"])
def health_check(request: HttpRequest):
    return {"status": "healthy", "service": "apilens-api"}


from routers.auth.router import router as auth_router
from routers.users.router import router as users_router
from routers.projects.router import router as projects_router

api.add_router("/users", users_router, tags=["Users"])
api.add_router("/projects", projects_router, tags=["Projects"])

# Legacy /apps routes removed - use /projects instead

# Telemetry ingestion is NOT served here anymore — it's a separate service
# (apps/ingest, served on ingest.apilens.ai). See infra/gcp/vm/startup.sh.
# Authentication is NOT served here anymore either — it's the identity service
# (apps auth surface, served on auth.apilens.ai). See identity_api below.


# ---------------------------------------------------------------------------
# Identity (IAM) API — the bounded auth-only surface served by the identity
# service on auth.apilens.ai (config.urls_identity). Its own OpenAPI; shares the
# same RFC 9457 application/problem+json handlers as the control plane via
# _register_exception_handlers. Mounts ONLY the auth router.
# ---------------------------------------------------------------------------
identity_api = NinjaAPI(
    title="APILens Identity API",
    version="1.0.0",
    description="Authentication & identity (magic-link, passkey, 2FA, tokens, JWKS).",
    urls_namespace="identity",
    docs_url="/docs",
    openapi_url="/openapi.json",
)
_register_exception_handlers(identity_api)


@identity_api.get("/.well-known/openid-configuration", tags=["Discovery"])
def openid_configuration(request: HttpRequest):
    from core.auth import keys
    return keys.openid_configuration(getattr(settings, "JWT_ISSUER", "https://auth.apilens.ai"))


@identity_api.get("/livez", tags=["System"])
def livez(request: HttpRequest):
    return {"status": "ok"}


@identity_api.get("/readyz", tags=["System"])
def readyz(request: HttpRequest):
    from django.db import connections
    try:
        connections["default"].cursor().execute("SELECT 1")
    except Exception:
        return identity_api.create_response(request, {"status": "not-ready"}, status=503)
    return {"status": "ready"}


identity_api.add_router("", auth_router, tags=["Auth"])
