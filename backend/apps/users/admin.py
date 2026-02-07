"""
Admin configuration for User model.
"""

from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin

from .models import User


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    """Admin configuration for custom User model."""

    list_display = [
        "email",
        "first_name",
        "last_name",
        "auth0_connection",
        "email_verified",
        "is_active",
        "created_at",
    ]
    list_filter = [
        "is_active",
        "is_staff",
        "email_verified",
        "auth0_connection",
        "created_at",
    ]
    search_fields = ["email", "first_name", "last_name", "auth0_id"]
    ordering = ["-created_at"]
    readonly_fields = [
        "id",
        "auth0_id",
        "auth0_connection",
        "created_at",
        "updated_at",
        "last_synced_at",
    ]

    fieldsets = (
        (None, {"fields": ("id", "auth0_id", "email", "password")}),
        (
            "Personal info",
            {"fields": ("first_name", "last_name", "picture")},
        ),
        (
            "Auth0 Info",
            {
                "fields": (
                    "auth0_connection",
                    "email_verified",
                    "last_login_at",
                    "last_synced_at",
                )
            },
        ),
        (
            "Permissions",
            {
                "fields": (
                    "is_active",
                    "is_staff",
                    "is_superuser",
                    "groups",
                    "user_permissions",
                ),
            },
        ),
        ("Timestamps", {"fields": ("created_at", "updated_at")}),
    )

    add_fieldsets = (
        (
            None,
            {
                "classes": ("wide",),
                "fields": ("email", "auth0_id", "password1", "password2"),
            },
        ),
    )
