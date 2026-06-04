"""
URL configuration for apilens project.
"""

from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.http import JsonResponse
from django.urls import path, include

from routers.router import api, identity_api


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
]

if settings.DEBUG:
    # Local-dev convenience: serve the identity/auth surface (magic-link,
    # passkey, 2FA, tokens, JWKS, OIDC discovery) at /api/v1/auth/* so a single
    # `manage.py runserver` runs the WHOLE app on :8000 and the frontend's
    # default AUTH_API_URL (= ${DJANGO_API_URL}/auth) resolves here. Listed
    # BEFORE the core mount so /api/v1/auth/* routes to identity. In production
    # auth is a SEPARATE service (config.urls_identity / auth.apilens.ai) and
    # the core API does NOT expose /auth.
    urlpatterns += [path("api/v1/auth/", identity_api.urls)]

# Control plane (dashboard backend) — served on api.apilens.ai.
# Telemetry ingestion lives in the separate apps/ingest service.
urlpatterns += [path("api/v1/", api.urls)]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
