"""
URL configuration for apilens project.
"""

from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.http import JsonResponse
from django.urls import path, include

from api.router import api


def root(request):
    return JsonResponse(
        {
            "name": "APILens Backend",
            "status": "ok",
            "version": "v1",
            "docs_url": "/api/v1/docs",
            "openapi_url": "/api/v1/openapi.json",
            "admin_url": "/admin/",
        }
    )


urlpatterns = [
    path("", root),
    path("admin/", admin.site.urls),
    path("api/v1/", api.urls),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
