"""
URL configuration for apilens project.
"""

from django.contrib import admin
from django.urls import path, include

from api.router import api

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/v1/", api.urls),
]
