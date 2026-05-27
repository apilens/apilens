from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin

from .models import User


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    list_display = [
        "email",
        "first_name",
        "last_name",
        "auth_provider",
        "email_verified",
        "is_active",
        "created_at",
    ]
    list_filter = [
        "is_active",
        "is_staff",
        "email_verified",
        "auth_provider",
        "created_at",
    ]
    search_fields = ["email", "first_name", "last_name"]
    ordering = ["-created_at"]
    readonly_fields = ["id", "created_at", "updated_at"]

    fieldsets = (
        (None, {"fields": ("id", "email", "password")}),
        ("Personal info", {"fields": ("first_name", "last_name", "picture")}),
        (
            "Auth",
            {"fields": ("auth_provider", "email_verified", "last_login_at")},
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
                "fields": ("email", "password1", "password2"),
            },
        ),
    )
