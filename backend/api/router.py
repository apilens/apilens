"""
Main API router for APILens.

This module sets up the Django Ninja API with authentication
and registers all route handlers.
"""

from ninja import NinjaAPI
from ninja.errors import AuthenticationError, ValidationError
from django.http import HttpRequest, HttpResponse

from core.auth.authentication import auth0_auth


# Create the main API instance
api = NinjaAPI(
    title="APILens API",
    version="1.0.0",
    description="API Observability Platform",
    docs_url="/docs",
    openapi_url="/openapi.json",
)


# Custom exception handlers
@api.exception_handler(AuthenticationError)
def authentication_error_handler(request: HttpRequest, exc: AuthenticationError) -> HttpResponse:
    return api.create_response(
        request,
        {"error": "Authentication required", "detail": str(exc)},
        status=401,
    )


@api.exception_handler(ValidationError)
def validation_error_handler(request: HttpRequest, exc: ValidationError) -> HttpResponse:
    return api.create_response(
        request,
        {"error": "Validation error", "detail": exc.errors},
        status=422,
    )


@api.exception_handler(Exception)
def generic_error_handler(request: HttpRequest, exc: Exception) -> HttpResponse:
    # Log the error
    import logging
    logger = logging.getLogger(__name__)
    logger.exception(f"Unhandled exception: {exc}")

    # Don't expose internal errors in production
    from django.conf import settings
    if settings.DEBUG:
        return api.create_response(
            request,
            {"error": "Internal server error", "detail": str(exc)},
            status=500,
        )
    return api.create_response(
        request,
        {"error": "Internal server error"},
        status=500,
    )


# Health check endpoint (no auth required)
@api.get("/health", tags=["System"])
def health_check(request: HttpRequest):
    """Health check endpoint for load balancers."""
    return {"status": "healthy", "service": "apilens-api"}


# Import and register routers
from api.users.router import router as users_router
from api.webhooks.router import router as webhooks_router

api.add_router("/users", users_router, tags=["Users"])
api.add_router("/webhooks", webhooks_router, tags=["Webhooks"])
