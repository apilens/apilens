import logging

from ninja import NinjaAPI
from ninja.errors import AuthenticationError, ValidationError
from django.http import HttpRequest, HttpResponse

from core.exceptions.base import AppError

logger = logging.getLogger(__name__)

api = NinjaAPI(
    title="APILens API",
    version="1.0.0",
    description="API Observability Platform",
    docs_url="/docs",
    openapi_url="/openapi.json",
)


@api.exception_handler(AppError)
def app_error_handler(request: HttpRequest, exc: AppError) -> HttpResponse:
    return api.create_response(
        request,
        {"error": exc.error_code, "detail": exc.message},
        status=exc.status_code,
    )


@api.exception_handler(AuthenticationError)
def authentication_error_handler(request: HttpRequest, exc: AuthenticationError) -> HttpResponse:
    return api.create_response(
        request,
        {"error": "authentication_error", "detail": "Authentication required"},
        status=401,
    )


@api.exception_handler(ValidationError)
def validation_error_handler(request: HttpRequest, exc: ValidationError) -> HttpResponse:
    return api.create_response(
        request,
        {"error": "validation_error", "detail": exc.errors},
        status=422,
    )


@api.exception_handler(Exception)
def generic_error_handler(request: HttpRequest, exc: Exception) -> HttpResponse:
    logger.exception(f"Unhandled exception: {exc}")

    from django.conf import settings
    if settings.DEBUG:
        return api.create_response(
            request,
            {"error": "internal_error", "detail": str(exc)},
            status=500,
        )
    return api.create_response(
        request,
        {"error": "internal_error"},
        status=500,
    )


@api.get("/health", tags=["System"])
def health_check(request: HttpRequest):
    return {"status": "healthy", "service": "apilens-api"}


from api.auth.router import router as auth_router
from api.users.router import router as users_router
from api.apps.router import router as apps_router
from api.ingest.router import router as ingest_router

api.add_router("/auth", auth_router, tags=["Auth"])
api.add_router("/users", users_router, tags=["Users"])
api.add_router("/apps", apps_router, tags=["Apps"])
api.add_router("/ingest", ingest_router, tags=["Ingest"])
