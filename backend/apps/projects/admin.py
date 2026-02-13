from django.contrib import admin

from .models import App, Endpoint, Environment


@admin.register(App)
class AppAdmin(admin.ModelAdmin):
    list_display = ("name", "slug", "owner", "is_active", "created_at")
    list_filter = ("is_active",)
    search_fields = ("name", "slug", "owner__email")
    readonly_fields = ("id", "created_at", "updated_at")


@admin.register(Endpoint)
class EndpointAdmin(admin.ModelAdmin):
    list_display = ("method", "path", "app", "is_active", "last_seen_at", "created_at")
    list_filter = ("method", "is_active")
    search_fields = ("path", "app__name")
    readonly_fields = ("id", "created_at", "updated_at")


@admin.register(Environment)
class EnvironmentAdmin(admin.ModelAdmin):
    list_display = ("name", "slug", "app", "color", "order", "is_active", "created_at")
    list_filter = ("is_active",)
    search_fields = ("name", "slug", "app__name")
    readonly_fields = ("id", "created_at", "updated_at")
