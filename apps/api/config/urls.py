"""
URL configuration for apilens project.
"""

from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.http import JsonResponse
from django.urls import path, include

from routers.router import api, ingest_api


def root(request):
    return JsonResponse(
        {
            "name": "APILens Backend",
            "status": "ok",
            "version": "v1",
            "admin_url": "/admin/",
        }
    )


urlpatterns = [
    path("", root),
    path("admin/", admin.site.urls),
    # Control plane (dashboard backend) — served on api.apilens.ai.
    path("api/v1/", api.urls),
    # Data plane (telemetry ingestion) — served on ingest.apilens.ai, where
    # Caddy rewrites the public /v1/* path onto this /ingest/v1/* mount.
    path("ingest/v1/", ingest_api.urls),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
