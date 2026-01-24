"""
ObserveX API v1 Router

Main entry point for the v1 API using Django Ninja.
"""

from django.http import JsonResponse
from ninja import NinjaAPI

# Create the main API instance
api = NinjaAPI(
    title="ObserveX API",
    version="1.0.0",
    description="ObserveX Observability Platform API",
    docs_url="/docs",
    openapi_url="/openapi.json",
)


# =============================================================================
# Health Check Endpoints
# =============================================================================

@api.get("/health/", tags=["Health"])
def health_check(request):
    """Health check endpoint for load balancers and monitoring."""
    return {"status": "healthy", "version": "1.0.0"}


@api.get("/health/ready/", tags=["Health"])
def readiness_check(request):
    """
    Readiness check - verifies all dependencies are available.
    """
    from django.db import connection

    checks = {
        "database": False,
        "cache": False,
    }

    # Check database
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        checks["database"] = True
    except Exception:
        pass

    # Check cache/Redis
    try:
        from django.core.cache import cache
        cache.set("health_check", "ok", 10)
        if cache.get("health_check") == "ok":
            checks["cache"] = True
    except Exception:
        pass

    all_healthy = all(checks.values())
    status_code = 200 if all_healthy else 503

    return JsonResponse(
        {
            "status": "ready" if all_healthy else "not_ready",
            "checks": checks,
        },
        status=status_code,
    )


@api.get("/hello/", tags=["Demo"])
def hello_world(request):
    """Simple hello world endpoint."""
    return {"hello": "world"}


# =============================================================================
# Add Domain Routers Here
# =============================================================================
# Example:
# from api.v1.metrics import router as metrics_router
# api.add_router("/metrics/", metrics_router, tags=["Metrics"])

# from api.v1.logs import router as logs_router
# api.add_router("/logs/", logs_router, tags=["Logs"])

# from api.v1.traces import router as traces_router
# api.add_router("/traces/", traces_router, tags=["Traces"])


# =============================================================================
# URL Patterns for Django
# =============================================================================
# This allows the router to be included in Django's URL configuration

urlpatterns = api.urls
